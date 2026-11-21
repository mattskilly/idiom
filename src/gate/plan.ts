import { resolve } from "node:path";
import {
  type BaseResolution,
  fallbackComparison,
  resolveBaseComparison,
  type SettledComparison,
  settleBaseComparison,
} from "../baseline/base.js";
import { checksConfigHash } from "../baseline/config-hash.js";
import { assertedStates, readDesignAssets } from "../brief/design-asset.js";
import { readHost } from "../capture/host-pressure.js";
import { captureConcurrency } from "../capture/lanes.js";
import type { ProbeRegion } from "../capture/probe.js";
import {
  type SurfaceMatchToken,
  surfaceMatches,
} from "../capture/rendered-surface.js";
import { PROBE_WALL_TARGET_MS } from "../capture/run.js";
import {
  type CaptureScope,
  probeCoordinates,
  resolveCaptureScope,
} from "../capture/scope.js";
import { formatDuration } from "../capture/timings.js";
import { projectPrefix } from "../changed/design-context.js";
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
  designContextPaths,
  detectStyleScope,
  type FileClass,
  orderSchemes,
  orderViewports,
} from "./classify.js";
import {
  costModel,
  estimateGate,
  GATE_DEFAULTS,
  hostFactor,
  loadFlowHistory,
  scaleCostModel,
  tupleKey,
} from "./estimate.js";
import {
  controlsNearSurface,
  loadRenderedEvidence,
  type StateEvidence,
} from "./evidence.js";
import { reflectsBase, regionReference } from "./region.js";
import { serverLeaseEligible } from "./server-lease.js";
import { planServerReuse } from "./server-reuse.js";
import {
  extractChangedSurface,
  formatToken,
  type SurfaceFile,
} from "./surface.js";
import { CHECK_CANDIDATE_FLOOR, trimToBudget } from "./trim.js";
import type {
  GateComparisonPlan,
  GateCoverageGap,
  GateFile,
  GatePlan,
  GateRank,
  GateSkipResult,
  GateStatePlan,
  GateStateSurface,
  GateSurface,
} from "./types.js";

/** Controls within this many CSS pixels of the changed surface are probed. */
export const SURFACE_NEAR_PX = 48;

/** One state's surface status from its newest capture. */
export function classifyStateSurface(options: {
  files: SurfaceFile[];
  evidence: StateEvidence | undefined;
  asserted?: boolean | undefined;
}): GateStateSurface & { tokens: SurfaceMatchToken[] } {
  if (options.asserted)
    return {
      status: "shows",
      matched: [],
      reason: "a design asset asserts it",
      tokens: [],
    };
  const identified = options.files.filter((file) => file.identified);
  const unidentified = options.files.some((file) => !file.identified);
  const evidence = options.evidence;
  if (!evidence)
    return {
      status: "unknown",
      matched: [],
      reason: "no stored capture of this state",
      tokens: [],
    };
  const base = {
    runId: evidence.runId,
    ...(evidence.derived ? { derived: true } : {}),
  };
  const matched: string[] = [];
  const tokens: SurfaceMatchToken[] = [];
  let checkable = false;
  // A component name is only checkable against an inventory that can see
  // component names: a derived inventory never can, and a rendered one sees
  // none on production builds, Svelte/Astro, or unnamed forwardRef/memo.
  const seesComponents =
    !evidence.derived && evidence.surface.components.length > 0;
  for (const file of identified) {
    // A stylesheet that loads says little on its own: global sheets load
    // everywhere. The file's classes, ids and components decide.
    const own = file.tokens.filter(
      (token) =>
        token.kind !== "sheet" &&
        !(token.kind === "component" && !seesComponents),
    );
    if (own.length) checkable = true;
    const hits = surfaceMatches(evidence.surface, own);
    if (!hits.length) continue;
    matched.push(
      ...hits,
      ...surfaceMatches(
        evidence.surface,
        file.tokens.filter((token) => token.kind === "sheet"),
      ),
    );
    tokens.push(...own.filter((token) => hits.includes(formatToken(token))));
  }
  if (matched.length)
    return { status: "shows", matched: [...new Set(matched)], ...base, tokens };
  if (unidentified || !checkable)
    return {
      status: "unknown",
      matched: [],
      ...base,
      reason: unidentified
        ? "part of the change has no identified surface"
        : evidence.derived
          ? "the capture predates the component inventory"
          : "the capture's inventory carries no component names",
      tokens: [],
    };
  return { status: "absent", matched: [], ...base, tokens: [] };
}

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
        /** Host load now; the estimate scales by it (tests pin it). */
        readHost?: typeof readHost | undefined;
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
  /** Per gated flow: the resolution, settled unless the base is captured. */
  baseComparisons: Map<string, GateBaseComparison>;
  configHash: string;
  /** One server for every gated flow's head capture (and one at the base). */
  serverLease: boolean;
};

export type GateBaseComparison = {
  resolution: BaseResolution;
  /** Undefined: capture the missing tuples at the base, then settle. */
  settled?: SettledComparison | undefined;
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
  const prefix = await projectPrefix(changes.repository, projectDirectory);
  const local = (path: string) =>
    prefix && path.startsWith(`${prefix}/`)
      ? path.slice(prefix.length + 1)
      : path;
  // Only the project's own design context is UI; matched repo-relative so a
  // repo-root DESIGN.md never stands in for a subdirectory project's own.
  const context = designContextPaths(project.design, prefix);
  const designContextFiles = new Set(
    changes.files
      .map((file) => file.path)
      .filter((path) => path === context.design || path === context.product),
  );
  const designFiles = [...designContextFiles].filter(
    (path) => path === context.design,
  );
  const byPath = classifyByPath(
    changes.files.map((file) => ({
      path: local(file.path),
      repoPath: file.path,
    })),
    gate.nonUi,
    [context.design, context.product],
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
    ? await select(projectDirectory, flows, uiChanges, {
        design: project.design,
        nonUi: gate.nonUi,
      })
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
  // No route imports the design context, yet it is the project's design: the
  // graph pass never demotes it.
  const byGraph = classifySelection(selection, htmlDirectories).filter(
    (file) => !designContextFiles.has(file.path),
  );
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
          ...(await select(
            projectDirectory,
            flows,
            { ...uiChanges, files: remaining },
            { design: project.design, nonUi: gate.nonUi },
          )),
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
    globalFiles: [
      ...new Set([
        ...selection.files
          .filter((file) => file.kind === "global")
          .map((file) => file.path),
        ...designFiles.filter((path) =>
          uiFiles.some((file) => file.path === path),
        ),
      ]),
    ],
    colorSchemeAttribute: project.capture.colorSchemeAttribute,
    git,
  });
  const changedSurface = await extractChangedSurface({
    repository: changes.repository,
    base: changes.resolvedBase,
    files: uiFiles,
    untracked,
    git,
  });
  const surface: GateSurface = {
    identified: changedSurface.files
      .filter((file) => file.identified)
      .map((file) => ({
        path: file.path,
        tokens: file.tokens.map(formatToken),
      })),
    unidentified: changedSurface.files
      .filter((file) => !file.identified)
      .map((file) => ({
        path: file.path,
        reason: file.reason ?? "no identified surface",
      })),
  };
  /** Per state key: its evidence, for the coverage gap. */
  const evidenceByState = new Map<string, StateEvidence | undefined>();
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
    const viewportObjects = [
      ...new Map(
        selected.map((tuple) => [tuple.viewport.name, tuple.viewport]),
      ).values(),
    ];
    const allViewports = viewportObjects.map((viewport) => viewport.name);
    const allSchemes = [
      ...new Set(selected.map((tuple) => tuple.colorScheme)),
    ] as ColorScheme[];
    const viewports = explicitViewports
      ? allViewports
      : styleScope.responsive.length
        ? orderViewports(viewportObjects, styleScope.breakpoints ?? [])
        : allViewports.slice(0, 1);
    const defaultScheme = allSchemes.includes(project.capture.colorScheme)
      ? project.capture.colorScheme
      : allSchemes[0];
    const schemes = explicitSchemes
      ? allSchemes
      : styleScope.theme.length
        ? orderSchemes(allSchemes, defaultScheme, styleScope)
        : defaultScheme === undefined
          ? []
          : [defaultScheme];
    const evidence = await loadRenderedEvidence(
      projectDirectory,
      flow.id,
      chosen,
      {
        viewport: allViewports[0],
        scheme: defaultScheme,
      },
    );
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
      const asserted = assetStates.some(
        (entry) => entry.flow === flow.id && entry.state === id,
      );
      const stateEvidence = evidence.get(id);
      evidenceByState.set(
        stateKey({ flow: flow.id, state: id }),
        stateEvidence,
      );
      const { tokens: surfaceTokens, ...stateSurface } = classifyStateSurface({
        files: changedSurface.files,
        evidence: stateEvidence,
        asserted,
      });
      const scopeLabel =
        surfaceTokens.length > 0
          ? [...new Set(surfaceTokens.map(formatToken))].slice(0, 3).join(" ")
          : undefined;
      if (probeTuple && (reference || scopeLabel !== undefined))
        flowRegions.set(
          tupleKey(id, probeTuple.viewport.name, probeTuple.colorScheme),
          {
            ...(reference
              ? { reference: reference.reference, runId: reference.runId }
              : {}),
            ...(scopeLabel === undefined
              ? {}
              : {
                  surface: {
                    tokens: surfaceTokens.map(({ kind, value, stem }) => ({
                      kind,
                      value,
                      ...(stem === undefined ? {} : { stem }),
                    })),
                    nearPx: SURFACE_NEAR_PX,
                    label: scopeLabel,
                  },
                }),
          },
        );
      const nearControls =
        scopeLabel !== undefined && stateEvidence
          ? controlsNearSurface(
              stateEvidence.elements,
              surfaceTokens,
              SURFACE_NEAR_PX,
            )
          : undefined;
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
        probeControls: (() => {
          const controls =
            region?.controls ??
            model.probedControls(id) ??
            project.checks.probe.maxControls;
          return nearControls === undefined
            ? controls
            : Math.min(controls, nearControls + CHECK_CANDIDATE_FLOOR);
        })(),
        ...(region ? { region } : {}),
        surface: {
          ...stateSurface,
          ...(scopeLabel !== undefined && probeTuple
            ? { probeScope: scopeLabel }
            : {}),
        },
      });
    }
    referenceMaps.set(flow.id, flowRegions);
  }
  if (!states.length) return skip(files);
  const coverageGap = surfaceCoverage(
    changedSurface.files,
    states,
    evidenceByState,
    notes,
  );
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
  const host = (options.dependencies?.readHost ?? readHost)();
  const factor = hostFactor([...histories.values()].flat(), host);
  if (factor > 1.05)
    notes.push(
      `host busy: load ${host.load?.[0].toFixed(1)} on ${host.coreCount} cores; estimates scaled ×${factor.toFixed(1)} over their history`,
    );
  const unscaled: ReturnType<typeof costModel> = {
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
  const model = scaleCostModel(unscaled, factor);
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
  const comparisons: GatePlan["comparisons"] = {};
  const baseComparisons = new Map<string, GateBaseComparison>();
  const configHash = checksConfigHash(project.checks);
  let baseSpentMs = 0;
  for (const flow of flows) {
    const members = trimmed.states.filter((state) => state.flow === flow.id);
    if (!members.length) continue;
    const resolution = await resolveBaseComparison({
      validated,
      flow: flow.id,
      base: changes.resolvedBase,
      tuples: members.flatMap((state) =>
        state.viewports.flatMap((viewport) =>
          state.schemes.map((scheme) => ({
            state: state.state,
            viewport,
            scheme,
          })),
        ),
      ),
      nonUi: gate.nonUi,
      git,
    });
    notes.push(...resolution.notes);
    let settled: SettledComparison | undefined;
    let estimateMs: number | undefined;
    if (resolution.missing.length === 0) {
      settled = await settleBaseComparison({
        resolution,
        flow: flow.id,
        configHash,
      });
    } else {
      // Price the base like the head: same model and probe, owned server,
      // plus the worktree and dependency install.
      const missingStates = members.flatMap((state) => {
        const tuples = resolution.missing.filter(
          (tuple) => tuple.state === state.state,
        );
        if (!tuples.length) return [];
        return [
          {
            ...state,
            viewports: [...new Set(tuples.map((tuple) => tuple.viewport))],
            schemes: [...new Set(tuples.map((tuple) => tuple.scheme))],
          },
        ];
      });
      estimateMs =
        estimateGate({
          states: missingStates,
          model,
          server: {
            mode: "fresh",
            reason: "the base runs in its own worktree",
          },
          concurrency,
          probeBudgetMs: trimmed.probeBudgetMs,
          probeTargetMs,
        }).totalMs + GATE_DEFAULTS.refPrepareMs;
      const over =
        trimmed.estimate.totalMs + baseSpentMs + estimateMs - budgetMs;
      if (over > 0) {
        settled = fallbackComparison(
          resolution,
          `base capture skipped (~${formatDuration(over)} over the ${formatDuration(budgetMs)} budget)`,
          flow.id,
        );
        if (settled.warning) notes.push(settled.warning);
      } else baseSpentMs += estimateMs;
    }
    const comparison = settled?.comparison;
    const mode: GateComparisonPlan["mode"] =
      settled === undefined
        ? "base-capture"
        : comparison === undefined
          ? "none"
          : comparison.source === "base-capture"
            ? "base-capture"
            : comparison.source;
    comparisons[flow.id] = {
      mode,
      base: changes.resolvedBase,
      ...(comparison?.baselineCommit === undefined
        ? {}
        : {
            baselineCommit: comparison.baselineCommit,
            behindBase: comparison.behindBase,
          }),
      missingTuples: resolution.missing.length,
      ...(estimateMs === undefined ? {} : { estimateMs }),
    };
    baselines[flow.id] = mode !== "none";
    baseComparisons.set(flow.id, { resolution, settled });
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
  const gatedFlows = flows.filter((flow) => scopes.has(flow.id));
  const lease = serverLeaseEligible(project, gatedFlows, {
    production,
    reused: server.mode === "reused",
  });
  if (!lease.eligible && gatedFlows.length > 1 && server.mode !== "reused")
    notes.push(`server: one per flow (${lease.reason})`);
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
    surface,
    ...(coverageGap === undefined ? {} : { coverageGap }),
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
    comparisons,
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
      baseComparisons,
      configHash,
      serverLease: lease.eligible,
    },
  };
}

/**
 * Identified changed surface that no candidate state's capture renders: the
 * gate says so (a `warning:` note) instead of passing silently. Unidentified
 * files get one note each. Returns the headline gap when nothing shows.
 */
function surfaceCoverage(
  files: SurfaceFile[],
  states: GateStatePlan[],
  evidence: Map<string, StateEvidence | undefined>,
  notes: string[],
): GateCoverageGap | undefined {
  for (const file of files)
    if (!file.identified)
      notes.push(
        `surface unknown for ${file.path}: ${file.reason ?? "no identified surface"}; ranked by route`,
      );
  const identified = files.filter((file) => file.identified);
  if (!identified.length) return undefined;
  const withEvidence = states.filter(
    (state) => evidence.get(stateKey(state)) !== undefined,
  );
  const without = states
    .filter((state) => evidence.get(stateKey(state)) === undefined)
    .map((state) => `${state.flow}/${state.state}`);
  // A file is a gap only when every state with a capture checked its
  // surface and found it absent. A state that could not tell (an inventory
  // without component names, or one derived from an older capture) leaves
  // the surface unconfirmed: that is reported, but not as "renders nothing".
  const gapFiles: SurfaceFile[] = [];
  for (const file of identified) {
    const classified = withEvidence.map((state) =>
      classifyStateSurface({
        files: [file],
        evidence: evidence.get(stateKey(state)),
      }),
    );
    if (classified.some((entry) => entry.status === "shows")) continue;
    const unknown = classified.find((entry) => entry.status === "unknown");
    if (!unknown) {
      gapFiles.push(file);
      continue;
    }
    const fileTokens = file.tokens
      .filter((token) => token.kind !== "sheet")
      .map(formatToken);
    notes.push(
      `surface unconfirmed for ${file.path} (${fileTokens.slice(0, 6).join(" ")}${fileTokens.length > 6 ? " …" : ""}): ${unknown.reason ?? "no state could tell"}; ranked by route`,
    );
  }
  if (!gapFiles.length) return undefined;
  const tokens = [
    ...new Set(
      gapFiles.flatMap((file) =>
        file.tokens.filter((token) => token.kind !== "sheet").map(formatToken),
      ),
    ),
  ];
  const line = (subject: SurfaceFile[]) =>
    `warning: coverage gap: no captured state renders the changed surface of ${subject.map((file) => file.path).join(", ")} (${tokens.slice(0, 6).join(" ")}${tokens.length > 6 ? " …" : ""}); ${withEvidence.length} state(s) had captures${without.length ? `, ${without.length} had none: ${without.slice(0, 6).join(", ")}${without.length > 6 ? ", …" : ""}` : ""}. Add a state that shows it, or capture the states without one.`;
  const anyShows = states.some((state) => state.surface?.status === "shows");
  if (gapFiles.length === identified.length && !anyShows) {
    notes.push(line(gapFiles));
    return {
      files: gapFiles.map((file) => file.path),
      tokens,
      statesWithEvidence: withEvidence.length,
      statesWithoutEvidence: without,
    };
  }
  notes.push(line(gapFiles));
  return undefined;
}
