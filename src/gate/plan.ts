import { relative, resolve, sep } from "node:path";
import { resolveRunBaseline } from "../baseline/compare.js";
import { assertedStates, readDesignAssets } from "../brief/design-asset.js";
import { captureConcurrency } from "../capture/lanes.js";
import type { ProbeRegion } from "../capture/probe.js";
import { PROBE_WALL_TARGET_MS } from "../capture/run.js";
import {
  type CaptureScope,
  probeCoordinates,
  resolveCaptureScope,
} from "../capture/scope.js";
import { collectChanges, type GitRead, readGit } from "../changed/git.js";
import {
  type ChangedSelection,
  selectChangedStates,
  stateKey,
} from "../changed/select.js";
import { isWebFlow } from "../schemas/flow.js";
import { type ColorScheme, resolveGateConfig } from "../schemas/project.js";
import { type ValidationResult, validateProject } from "../validation.js";
import {
  classifyByPath,
  classifySelection,
  detectStyleScope,
  type FileClass,
} from "./classify.js";
import { costModel, loadFlowHistory, tupleKey } from "./estimate.js";
import { reflectsBase, regionReference } from "./region.js";
import { planServerReuse } from "./server-reuse.js";
import { trimToBudget } from "./trim.js";
import type {
  GateFile,
  GatePlan,
  GateRank,
  GateSkipResult,
  GateStatePlan,
} from "./types.js";

export type GatePlanOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
  /** Restrict the gate to one flow (`idiom check <flow> --gate`). */
  flow?: string | undefined;
  /** `--changed <base>` alongside `--gate`; default: the merge base. */
  base?: string | undefined;
  scope?: CaptureScope | undefined;
  prod?: boolean | undefined;
  probeBudgetMs?: number | undefined;
  budgetMs?: number | undefined;
  reuseServer?: boolean | undefined;
  dependencies?:
    | {
        git?: GitRead | undefined;
        fetch?: typeof globalThis.fetch | undefined;
        select?: typeof selectChangedStates | undefined;
        environment?: NodeJS.ProcessEnv | undefined;
      }
    | undefined;
};

/** What the controller needs to run the plan, beyond what it prints. */
export type GateExecution = {
  validated: ValidationResult;
  selection: ChangedSelection;
  scopes: Map<string, CaptureScope>;
  probeRegions: Map<string, Map<string, ProbeRegion>>;
  probeDisabled: boolean;
  reuseServer: boolean;
  production: boolean;
};

const shortBase = (base: string) => base.slice(0, 12);

/**
 * The gate's policy, before any server or browser: which states, tuples and
 * controls, what it costs, and what it trims to fit the budget.
 */
export async function planGate(
  options: GatePlanOptions,
): Promise<GateSkipResult | (GatePlan & { execution: GateExecution })> {
  const git = options.dependencies?.git ?? readGit;
  const validated = await validateProject(options);
  const { project, projectDirectory } = validated;
  const gate = resolveGateConfig(project);
  const changes = await collectChanges(projectDirectory, options.base, git);
  const base = shortBase(changes.resolvedBase);
  const allFlows = validated.flows.map((record) => record.flow.id);
  // Globs are project-relative; changed paths are repository-relative.
  const prefix = relative(changes.repository, projectDirectory)
    .split(sep)
    .join("/");
  const local = (path: string) =>
    prefix && path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length + 1)
      : path;
  const byPath = classifyByPath(
    changes.files.map((file) => ({ path: local(file.path) })),
    gate.nonUi,
  ).map((file, index) => ({
    ...file,
    path: changes.files[index]?.path ?? file.path,
  }));
  const skip = (files: GateFile[]): GateSkipResult => ({
    skipped: true,
    base,
    reason: files.length ? "no UI changes" : "no changes",
    line: `no UI changes since ${base}; skipped`,
    files,
    allFlows,
  });
  const flows = validated.flows.map((record) => record.flow);
  // A design asset pinned to the build is its contract: its asserted states
  // are always checked, whatever the diff touched.
  const assetStates = assertedStates(
    await readDesignAssets(projectDirectory),
  ).filter(({ flow, state }) =>
    flows.some(
      (candidate) =>
        candidate.id === flow &&
        (options.flow === undefined || options.flow === flow) &&
        candidate.states.some((declared) => declared.id === state),
    ),
  );
  const assetsAssert = assetStates.length > 0;
  const uiChanged = byPath.some((file) => file.ui);
  if (!uiChanged && !assetsAssert) return skip(byPath);
  const select = options.dependencies?.select ?? selectChangedStates;
  const uiPaths = new Set(
    byPath.filter((file) => file.ui).map((file) => file.path),
  );
  const uiChanges = {
    ...changes,
    files: changes.files.filter((file) => uiPaths.has(file.path)),
  };
  const { files: _files, ...changeGit } = changes;
  let selection: ChangedSelection = uiChanged
    ? await select(projectDirectory, flows, uiChanges)
    : {
        git: changeGit,
        files: [],
        candidates: [],
        selected: [],
        skipped: [],
        fallbackFiles: [],
      };
  const graph = selection.graph ?? {
    complete: false,
    reasons: ["no import graph"],
  };
  const htmlDirectories = (
    await git(changes.repository, ["ls-files", "-z", "--", "*.html"]).catch(
      () => "",
    )
  )
    .split("\0")
    .filter(Boolean)
    .map((path) => path.split("/").slice(0, -1).join("/"));
  const byGraph = classifySelection(selection, htmlDirectories);
  const serverOnly = new Set(
    byGraph.filter((file) => !file.ui).map((file) => file.path),
  );
  if (serverOnly.size) {
    const remaining = uiChanges.files.filter(
      (file) => !serverOnly.has(file.path),
    );
    if (!remaining.length && !assetsAssert)
      return skip([
        ...byPath.filter((file) => !file.ui),
        ...byGraph.filter((file) => !file.ui),
      ]);
    selection = remaining.length
      ? {
          ...(await select(projectDirectory, flows, {
            ...uiChanges,
            files: remaining,
          })),
          graph,
        }
      : { ...selection, files: [], selected: [], candidates: [], graph };
  }
  const missingAsserted = assetStates
    .filter(
      (entry) =>
        !selection.selected.some(
          (state) => state.flow === entry.flow && state.state === entry.state,
        ),
    )
    .map(({ flow, state }) => ({ flow, state }));
  if (missingAsserted.length)
    selection = {
      ...selection,
      candidates: [
        ...selection.candidates,
        ...missingAsserted.filter(
          (entry) =>
            !selection.candidates.some(
              (state) => stateKey(state) === stateKey(entry),
            ),
        ),
      ],
      selected: [...selection.selected, ...missingAsserted],
    };
  const graphClass = new Map(byGraph.map((file) => [file.path, file]));
  const files: GateFile[] = byPath.map((file) => {
    const graphFile = graphClass.get(file.path);
    const mapping = selection.files.find((entry) => entry.path === file.path);
    const decided: FileClass = graphFile && !graphFile.ui ? graphFile : file;
    return {
      ...decided,
      ...(mapping
        ? {
            kind: mapping.kind,
            routes: mapping.routes,
            states: mapping.states.map(
              (state) => `${state.flow}/${state.state}`,
            ),
          }
        : {}),
    };
  });
  const uiFiles = files.filter((file) => file.ui);
  const untracked = (
    await git(changes.repository, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]).catch(() => "")
  )
    .split("\0")
    .filter(Boolean);
  const styleScope = await detectStyleScope({
    repository: changes.repository,
    base: changes.resolvedBase,
    files: uiFiles,
    untracked,
    globalFiles: selection.files
      .filter((file) => file.kind === "global")
      .map((file) => file.path),
    colorSchemeAttribute: project.capture.colorSchemeAttribute,
    git,
  });
  const explicitViewports = options.scope?.viewports !== undefined;
  const explicitSchemes = options.scope?.schemes !== undefined;
  const states: GateStatePlan[] = [];
  const histories = new Map<
    string,
    Awaited<ReturnType<typeof loadFlowHistory>>
  >();
  const models = new Map<string, ReturnType<typeof costModel>>();
  const notes: string[] = [];
  if (selection.git.fallbackReason) notes.push(selection.git.fallbackReason);
  const rankOf = (flow: string, state: string): GateRank => {
    // Asserted states are trimmed last: the build is held to them.
    if (
      assetStates.some((entry) => entry.flow === flow && entry.state === state)
    )
      return "route";
    const owning = selection.files.filter((file) =>
      file.states.some((entry) => entry.flow === flow && entry.state === state),
    );
    if (owning.some((file) => file.kind === "route")) return "route";
    if (owning.some((file) => file.kind === "import")) return "import";
    return "fallback";
  };
  const regions = new Map<string, GateStatePlan["region"]>();
  const atBase = reflectsBase(git, changes.repository, changes.resolvedBase);
  const referenceMaps = new Map<string, Map<string, ProbeRegion>>();
  const affectedFlows: string[] = [];
  for (const flow of flows) {
    const asserted = assetStates.filter((entry) => entry.flow === flow.id);
    const ids = selection.selected
      .filter((state) => state.flow === flow.id)
      .map((state) => state.state);
    const requested = options.scope?.states
      ?.split(",")
      .map((value) => value.trim());
    const chosen = ids.filter(
      (id) => requested === undefined || requested.includes(id),
    );
    if (!chosen.length) continue;
    for (const entry of asserted)
      if (chosen.includes(entry.state))
        notes.push(
          `design asset ${entry.brief.source?.name ?? entry.brief.slug}: brief ${entry.brief.slug} asserts ${flow.id}/${entry.state}`,
        );
    affectedFlows.push(flow.id);
    const history = await loadFlowHistory(projectDirectory, flow.id);
    histories.set(flow.id, history);
    const model = costModel(history);
    models.set(flow.id, model);
    // Timings may come from any run; the region only from one at the base.
    const references = await loadFlowHistory(
      projectDirectory,
      flow.id,
      5,
      atBase,
    );
    const { selected } = resolveCaptureScope({
      project,
      flow,
      scope: { ...options.scope, states: chosen.join(",") },
    });
    const allViewports = [
      ...new Set(selected.map((tuple) => tuple.viewport.name)),
    ];
    const allSchemes = [
      ...new Set(selected.map((tuple) => tuple.colorScheme)),
    ] as ColorScheme[];
    const viewports =
      explicitViewports || styleScope.responsive.length
        ? allViewports
        : allViewports.slice(0, 1);
    const defaultScheme = allSchemes.includes(project.capture.colorScheme)
      ? project.capture.colorScheme
      : allSchemes[0];
    const schemes =
      explicitSchemes || styleScope.theme.length
        ? allSchemes
        : defaultScheme === undefined
          ? []
          : [defaultScheme];
    const narrowed = selected.filter(
      (tuple) =>
        viewports.includes(tuple.viewport.name) &&
        schemes.includes(tuple.colorScheme),
    );
    const probed = new Set(
      probeCoordinates(project, flow, narrowed).intended.map((coordinate) =>
        tupleKey(coordinate.state, coordinate.viewport, coordinate.colorScheme),
      ),
    );
    const flowRegions = new Map<string, ProbeRegion>();
    for (const id of chosen) {
      const probeTuple = narrowed.find(
        (tuple) =>
          tuple.state.id === id &&
          probed.has(tupleKey(id, tuple.viewport.name, tuple.colorScheme)),
      );
      const reference =
        probeTuple === undefined
          ? undefined
          : regionReference(
              references,
              id,
              probeTuple.viewport.name,
              probeTuple.colorScheme,
            );
      if (probeTuple && reference)
        flowRegions.set(
          tupleKey(id, probeTuple.viewport.name, probeTuple.colorScheme),
          { reference: reference.reference, runId: reference.runId },
        );
      const region = reference
        ? { runId: reference.runId, controls: reference.controls }
        : undefined;
      regions.set(stateKey({ flow: flow.id, state: id }), region);
      states.push({
        flow: flow.id,
        state: id,
        rank: rankOf(flow.id, id),
        order: flow.states.findIndex((state) => state.id === id),
        viewports: [...viewports],
        schemes: [...schemes],
        expandedViewports: viewports.slice(1),
        expandedSchemes: schemes.slice(1),
        probe: probeTuple !== undefined,
        probeControls:
          region?.controls ??
          model.probedControls(id) ??
          project.checks.probe.maxControls,
        ...(region ? { region } : {}),
      });
    }
    referenceMaps.set(flow.id, flowRegions);
  }
  if (!states.length) return skip(files);
  const production = flows.some(
    (flow) =>
      states.some((state) => state.flow === flow.id) &&
      (options.prod === true ||
        (isWebFlow(flow) && flow.server === "production")),
  );
  const reuse = options.reuseServer === true || project.server.reuse === true;
  const server = await planServerReuse({
    projectDirectory,
    project,
    reuse,
    production,
    changedFiles: uiFiles.map((file) => resolve(changes.repository, file.path)),
    fetch: options.dependencies?.fetch,
  });
  const budgetMs = options.budgetMs ?? gate.budgetMs;
  const concurrency = captureConcurrency(
    project,
    options.dependencies?.environment ?? process.env,
  );
  // One flow's history prices every state; multi-flow gates use each flow's own
  // through the first-flow model for tuples it has not seen.
  const firstModel = models.values().next().value as ReturnType<
    typeof costModel
  >;
  const model: ReturnType<typeof costModel> = {
    ...firstModel,
    tupleCaptureMs: (state, viewport, scheme) => {
      const owner = states.find((entry) => entry.state === state)?.flow;
      return (models.get(owner ?? "") ?? firstModel).tupleCaptureMs(
        state,
        viewport,
        scheme,
      );
    },
    noHistory: [...models.values()].some((entry) => entry.noHistory),
  };
  const probeTargetMs =
    options.probeBudgetMs ??
    project.checks.probe.flowBudgetMs ??
    PROBE_WALL_TARGET_MS;
  const trimmed = trimToBudget({
    states,
    model,
    server,
    concurrency,
    budgetMs,
    probeTargetMs,
    probeBudgetMs: options.probeBudgetMs,
  });
  const baselines: Record<string, boolean> = {};
  for (const flow of flows) {
    if (!trimmed.states.some((state) => state.flow === flow.id)) continue;
    const { selected } = await resolveRunBaseline({
      validated,
      flow,
      cwd: options.cwd,
    });
    baselines[flow.id] = selected !== undefined;
    if (!selected)
      notes.push(
        `no recorded baseline for ${flow.id}; gating open findings — run idiom baseline record ${flow.id}`,
      );
  }
  const scopes = new Map<string, CaptureScope>();
  for (const flow of flows) {
    const members = trimmed.states.filter((state) => state.flow === flow.id);
    const first = members[0];
    if (!first) continue;
    scopes.set(flow.id, {
      states: members.map((state) => state.state).join(","),
      viewports: first.viewports.join(","),
      schemes: first.schemes.join(","),
    });
  }
  const kept = new Set(trimmed.states.map((state) => stateKey(state)));
  const tuples = trimmed.states.flatMap((state) =>
    state.viewports.flatMap((viewport) =>
      state.schemes.map((scheme) => ({
        flow: state.flow,
        state: state.state,
        viewport,
        scheme,
      })),
    ),
  );
  const finalSelection: ChangedSelection = {
    ...selection,
    selected: selection.selected.filter((state) => kept.has(stateKey(state))),
    skipped: selection.candidates.filter((state) => !kept.has(stateKey(state))),
  };
  return {
    skipped: false,
    base,
    baseReason: changes.baseReason,
    graph,
    files,
    styleScope,
    states: trimmed.states,
    tuples,
    server,
    estimate: trimmed.estimate,
    budgetMs,
    skippedWork: trimmed.skippedWork,
    ...(trimmed.probeBudgetMs === undefined
      ? {}
      : { probeBudgetMs: trimmed.probeBudgetMs }),
    minimumExceedsBudget: trimmed.minimumExceedsBudget,
    baselines,
    notes,
    flows: affectedFlows,
    allFlows,
    execution: {
      validated,
      selection: finalSelection,
      scopes,
      probeRegions: referenceMaps,
      probeDisabled: trimmed.probeDisabled,
      reuseServer: server.mode === "reused",
      production,
    },
  };
}
