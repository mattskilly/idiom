import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  captureTupleKey,
  expectedCaptureTupleKeys,
  expectedStatusByState,
  selectColorSchemes,
  selectViewports,
} from "../capture/resolve.js";
import type {
  CheckTuple,
  ObservedElement,
  ObservedElementV2,
} from "../checks/types.js";
import { collectStandingProhibitions } from "../decisions/prohibitions.js";
import { readDecisions } from "../decisions/read.js";
import { IdiomError } from "../errors.js";
import { buildReviewCoverage } from "../report/coverage.js";
import { pngDataUri } from "../report/html.js";
import { reachableProjectStores } from "../report/roots.js";
import { loadCaptureRun } from "../review/artifacts.js";
import { loadReviewCatalog, reportRootsFor } from "../review/catalog.js";
import { parseRulingBlocks } from "../rulings/law.js";
import type { Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import {
  type FlowRecord,
  loadProjectContext,
  type ProjectContext,
  validateNamedFlow,
} from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";
import { collectDrift } from "./drift.js";
import { collectSystemTokens } from "./tokens.js";
import type {
  EvidenceCoordinate,
  ObservedValue,
  SystemCoverage,
  SystemObserved,
  SystemPageModel,
  SystemProhibition,
} from "./types.js";

export type SystemDependencies = { gitTopology?: GitTopology | undefined };

type StoredRun = { runId: string; runDirectory: string };
type CompleteCapture = StoredRun & {
  flow: FlowRecord;
  tuples: CheckTuple[];
  commit: string;
  capturedAt: string;
};

async function requiredText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot read ${JSON.stringify(label)} for the system page: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadAllFlows(context: ProjectContext): Promise<FlowRecord[]> {
  const directory = join(context.projectDirectory, ".idiom", "flows");
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IdiomError(
      `cannot enumerate flow manifests ${directory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -5))
    .sort();
  const records: FlowRecord[] = [];
  for (const id of ids) records.push(await validateNamedFlow(context, id));
  return records;
}

async function storedRuns(roots: readonly string[]): Promise<StoredRun[]> {
  const runs = new Map<string, StoredRun>();
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new IdiomError(
        `cannot enumerate stored reports ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!runs.has(entry.name))
        runs.set(entry.name, {
          runId: entry.name,
          runDirectory: resolve(root, entry.name),
        });
    }
  }
  return [...runs.values()];
}

async function firstMetadata(runDirectory: string): Promise<
  | {
      flow: string;
      startedAt: string;
    }
  | undefined
> {
  let states: Dirent[];
  try {
    states = await readdir(runDirectory, { withFileTypes: true });
  } catch (error) {
    throw new IdiomError(
      `cannot inspect stored run ${runDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const candidates: string[] = [];
  for (const state of states.filter((entry) => entry.isDirectory())) {
    const stateDirectory = join(runDirectory, state.name);
    for (const viewport of (
      await readdir(stateDirectory, { withFileTypes: true })
    ).filter((entry) => entry.isDirectory())) {
      const viewportDirectory = join(stateDirectory, viewport.name);
      candidates.push(join(viewportDirectory, "metadata.json"));
      for (const scheme of (
        await readdir(viewportDirectory, { withFileTypes: true })
      ).filter((entry) => entry.isDirectory()))
        candidates.push(join(viewportDirectory, scheme.name, "metadata.json"));
    }
  }
  for (const path of candidates.sort()) {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new IdiomError(
        `cannot read capture artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const record = value as {
      flow?: { id?: unknown };
      timestamps?: { startedAt?: unknown };
    };
    if (
      typeof record.flow?.id !== "string" ||
      typeof record.timestamps?.startedAt !== "string"
    )
      throw new IdiomError(`invalid metadata in ${path}`);
    return { flow: record.flow.id, startedAt: record.timestamps.startedAt };
  }
  return undefined;
}

function exactCompleteGrid(
  project: Project,
  flow: Flow,
  tuples: readonly CheckTuple[],
  collapsed: string[],
): boolean {
  const expected = new Set(
    expectedCaptureTupleKeys({ project, flow, collapsed }),
  );
  const actual = tuples.map((tuple) =>
    captureTupleKey({
      state: tuple.state,
      viewport: tuple.viewport,
      colorScheme: tuple.colorScheme ?? project.capture.colorScheme,
    }),
  );
  return (
    actual.length === expected.size &&
    new Set(actual).size === expected.size &&
    actual.every((key) => expected.has(key)) &&
    tuples.every(
      (tuple) =>
        tuple.failure === undefined &&
        tuple.mismatches.length === 0 &&
        tuple.observations !== undefined,
    )
  );
}

async function loadRunForFlow(
  run: StoredRun,
  flow: FlowRecord,
  project: Project,
): Promise<{
  tuples: CheckTuple[];
  commit: string;
  collapsedTupleKeys: string[];
}> {
  const loaded = await loadCaptureRun({
    runDirectory: run.runDirectory,
    expectedFlow: flow.flow.id,
    expectedStatusByState: expectedStatusByState(flow.flow),
    stateOrder: flow.flow.states.map((state) => state.id),
    viewportOrder: selectViewports(project, flow.flow).map(
      (viewport) => viewport.name,
    ),
    colorSchemeOrder: selectColorSchemes(project, flow.flow),
    legacyColorScheme: project.capture.colorScheme,
  });
  return loaded;
}

async function newestCompleteCapture(options: {
  runs: StoredRun[];
  flows: FlowRecord[];
  project: Project;
}): Promise<CompleteCapture | undefined> {
  const byId = new Map(options.flows.map((flow) => [flow.flow.id, flow]));
  const candidates: CompleteCapture[] = [];
  for (const run of options.runs) {
    const probe = await firstMetadata(run.runDirectory);
    if (probe === undefined) continue;
    const flow = byId.get(probe.flow);
    if (flow === undefined) continue;
    const loaded = await loadRunForFlow(run, flow, options.project);
    if (
      !exactCompleteGrid(
        options.project,
        flow.flow,
        loaded.tuples,
        loaded.collapsedTupleKeys,
      )
    )
      continue;
    const times = loaded.tuples.map((tuple) => ({
      value: tuple.createdAt,
      milliseconds: Date.parse(tuple.createdAt),
    }));
    if (times.some(({ milliseconds }) => !Number.isFinite(milliseconds)))
      throw new IdiomError(
        `stored capture ${run.runId} has an invalid capture timestamp`,
      );
    times.sort(
      (left, right) =>
        right.milliseconds - left.milliseconds ||
        right.value.localeCompare(left.value),
    );
    const capturedAt = times[0]?.value ?? probe.startedAt;
    if (!Number.isFinite(Date.parse(capturedAt)))
      throw new IdiomError(
        `stored capture ${run.runId} has an invalid capture timestamp`,
      );
    candidates.push({
      ...run,
      flow,
      ...loaded,
      capturedAt,
    });
  }
  candidates.sort(
    (left, right) =>
      Date.parse(right.capturedAt) - Date.parse(left.capturedAt) ||
      right.runId.localeCompare(left.runId),
  );
  return candidates[0];
}

function opaqueColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "" ||
    normalized === "none" ||
    normalized === "transparent"
  )
    return false;
  if (/^rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/u.test(normalized)) return false;
  if (/^rgb\([^)]*\/\s*0(?:%|\.0+)?\s*\)$/u.test(normalized)) return false;
  if (/^hsla?\([^)]*[,/]\s*0(?:%|\.0+)?\s*\)$/u.test(normalized)) return false;
  return true;
}

function positiveWidth(value: string): boolean {
  const width = Number.parseFloat(value);
  return Number.isFinite(width) && width > 0;
}

function isObservedElementV2(
  element: ObservedElement,
): element is ObservedElementV2 {
  return (
    "directText" in element &&
    typeof (element as { directText?: unknown }).directText === "string"
  );
}

function visibleText(element: ObservedElement): boolean {
  if (!element.visible || element.rect.width <= 0 || element.rect.height <= 0)
    return false;
  if (
    isObservedElementV2(element) &&
    Number.parseFloat(element.styles.opacity) <= 0
  )
    return false;
  const text = isObservedElementV2(element) ? element.directText : element.text;
  return text.trim() !== "";
}

function coordinate(tuple: CheckTuple): EvidenceCoordinate {
  return {
    flow: tuple.flow,
    state: tuple.state,
    viewport: tuple.viewport,
    colorScheme: tuple.colorScheme ?? "light",
  };
}

function addObserved(
  target: Map<string, EvidenceCoordinate[]>,
  value: string,
  point: EvidenceCoordinate,
): void {
  const normalized = value.trim();
  if (normalized === "") return;
  const coordinates = target.get(normalized) ?? [];
  const key = `${point.flow}/${point.state}/${point.viewport}/${point.colorScheme}`;
  if (
    coordinates.length < 4 &&
    !coordinates.some(
      (item) =>
        `${item.flow}/${item.state}/${item.viewport}/${item.colorScheme}` ===
        key,
    )
  )
    coordinates.push(point);
  target.set(normalized, coordinates);
}

function observedValues(
  source: Map<string, EvidenceCoordinate[]>,
): ObservedValue[] {
  return [...source.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, coordinates]) => ({ value, coordinates }));
}

export function aggregateObservedTuples(
  capture: CompleteCapture,
): SystemObserved {
  const colors = new Map<string, EvidenceCoordinate[]>();
  const fontFamilies = new Map<string, EvidenceCoordinate[]>();
  const fontSizes = new Map<string, EvidenceCoordinate[]>();
  const fontWeights = new Map<string, EvidenceCoordinate[]>();
  const typographyAvailable = capture.tuples.every(
    (tuple) => tuple.observations?.version === 2,
  );
  for (const tuple of capture.tuples) {
    const point = coordinate(tuple);
    for (const element of tuple.observations?.elements ?? []) {
      if (
        !element.visible ||
        element.rect.width <= 0 ||
        element.rect.height <= 0
      )
        continue;
      const styles = element.styles;
      const candidates = [
        ...(visibleText(element) ? [styles.color] : []),
        styles.backgroundColor,
        ...(positiveWidth(styles.borderTopWidth)
          ? [styles.borderTopColor]
          : []),
        ...(positiveWidth(styles.borderRightWidth)
          ? [styles.borderRightColor]
          : []),
        ...(positiveWidth(styles.borderBottomWidth)
          ? [styles.borderBottomColor]
          : []),
        ...(positiveWidth(styles.borderLeftWidth)
          ? [styles.borderLeftColor]
          : []),
        ...(positiveWidth(styles.outlineWidth) ? [styles.outlineColor] : []),
        ...([
          "svg",
          "path",
          "circle",
          "ellipse",
          "line",
          "polygon",
          "polyline",
          "rect",
          "text",
          "use",
        ].includes(element.tag.toLowerCase())
          ? [styles.fill, styles.stroke]
          : []),
      ];
      for (const value of candidates)
        if (opaqueColor(value)) addObserved(colors, value, point);
      if (isObservedElementV2(element) && visibleText(element)) {
        const expanded = element.styles;
        addObserved(fontFamilies, expanded.fontFamily, point);
        addObserved(fontSizes, expanded.fontSize, point);
        addObserved(fontWeights, expanded.fontWeight, point);
      }
    }
  }
  return {
    status: "available",
    runId: capture.runId,
    capturedAt: capture.capturedAt,
    colors: observedValues(colors),
    fontFamilies: observedValues(fontFamilies),
    fontSizes: observedValues(fontSizes),
    fontWeights: observedValues(fontWeights),
    typographyAvailable,
  };
}

function safeEvidencePath(
  runDirectory: string,
  path: string,
): string | undefined {
  if (path === "" || isAbsolute(path) || path.includes("\\")) return undefined;
  const target = resolve(runDirectory, path);
  const rel = relative(runDirectory, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return target;
}

async function embedProhibitions(
  prohibitions: ReturnType<typeof collectStandingProhibitions>,
): Promise<SystemProhibition[]> {
  return await Promise.all(
    prohibitions.map(async (prohibition) => {
      if (prohibition.kind === "degraded") return prohibition;
      const images: Array<{ path: string; dataUri: string }> = [];
      for (const path of prohibition.evidence.screenshots) {
        const target = safeEvidencePath(
          prohibition.evidence.runDirectory,
          path,
        );
        if (target === undefined) continue;
        try {
          const stat = await lstat(target);
          if (!stat.isFile()) continue;
          images.push({ path, dataUri: pngDataUri(await readFile(target)) });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return { ...prohibition, images };
    }),
  );
}

async function newestCoverage(options: {
  catalog: Awaited<ReturnType<typeof loadReviewCatalog>>;
  flows: FlowRecord[];
  project: Project;
}): Promise<SystemCoverage> {
  const byId = new Map(options.flows.map((flow) => [flow.flow.id, flow]));
  const ranked = await Promise.all(
    options.catalog.runs.map(async (run) => ({
      ...run,
      reviewedAt: (await lstat(run.findingsPath)).mtime.toISOString(),
    })),
  );
  ranked.sort(
    (left, right) =>
      right.reviewedAt.localeCompare(left.reviewedAt) ||
      right.runId.localeCompare(left.runId),
  );
  for (const selected of ranked) {
    // A findings artifact can outlive or predate its flow manifest. It is a
    // completed review, but no longer qualifies as current-project coverage.
    // Tuple metadata is also required even when a finding names the flow: an
    // empty retained review directory is missing evidence, not corruption.
    const probe = await firstMetadata(selected.runDirectory);
    if (probe === undefined) continue;
    const findingFlow = selected.findings[0]?.finding.flow;
    const flowId = findingFlow ?? probe.flow;
    const flow = byId.get(flowId);
    if (flow === undefined) continue;
    const loaded = await loadRunForFlow(selected, flow, options.project);
    const coverage = buildReviewCoverage({
      collapsedTupleKeys: loaded.collapsedTupleKeys,
      flow: flow.flow,
      project: options.project,
      allFlows: options.flows.map((record) => record.flow),
      tuples: loaded.tuples,
      commit: loaded.commit,
    });
    coverage.surfaceCoverage ??= {
      judged: [],
      governedNotJudged: [],
      ungoverned: [],
    };
    return {
      status: "available",
      runId: selected.runId,
      reviewedAt: selected.reviewedAt,
      value: coverage,
    };
  }
  return {
    status: "unavailable",
    reason: "No qualifying stored review is available.",
  };
}

export async function collectSystemPage(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  dependencies?: SystemDependencies | undefined;
  now?: (() => Date) | undefined;
}): Promise<SystemPageModel> {
  const context = await loadProjectContext(options);
  const flows = await loadAllFlows(context);
  const lawSource = await requiredText(
    join(context.projectDirectory, context.project.design.designFile),
    context.project.design.designFile,
  );
  const law = parseRulingBlocks(lawSource);
  const stores = await reachableProjectStores(
    context.projectDirectory,
    options.dependencies?.gitTopology,
  );
  const roots = reportRootsFor(
    context.projectDirectory,
    stores.additionalReportRoots,
  );
  const catalog = await loadReviewCatalog({
    project: context.projectDirectory,
    additionalReportRoots: stores.additionalReportRoots,
    additionalTrackerRoots: stores.additionalTrackerRoots,
  });
  const decisions = await readDecisions(context.projectDirectory);
  const runs = await storedRuns(roots);
  const capture = await newestCompleteCapture({
    runs,
    flows,
    project: context.project,
  });
  const tokens = await collectSystemTokens(
    context.projectDirectory,
    context.project.design.tokensFile,
    context.project.design.tokens,
  );
  const declarations =
    tokens.status === "configured"
      ? (tokens.declarations ??
        tokens.tokens.map((t) => ({
          name: t.name,
          value: t.value,
          kind: t.kind ?? ("other" as const),
          source: t.source ?? { path: tokens.source, key: t.name },
          theme: t.theme,
          base: t.base,
          resolved: t.resolved,
          environment: t.environment ?? tokens.environment,
          ...(t.resolution.status === "unavailable"
            ? { reason: t.resolution.reason }
            : {}),
        })))
      : [];
  return {
    drift:
      capture === undefined
        ? {
            status: "unavailable",
            reason:
              "No complete stored capture is available. Drift unavailable.",
            declarations,
            facts: [],
            contexts: [],
            limitations: [],
          }
        : collectDrift({
            tuples: capture.tuples,
            project: context.project,
            declarations,
            runId: capture.runId,
            capturedAt: capture.capturedAt,
          }),
    projectName: context.project.app.name,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    tokens,
    observed:
      capture === undefined
        ? {
            status: "unavailable",
            reason: "No complete stored capture is available.",
          }
        : aggregateObservedTuples(capture),
    designLaw: law.prose,
    rulings: law.resolutions,
    decisionsAvailable: decisions.length > 0,
    prohibitions: await embedProhibitions(
      collectStandingProhibitions(catalog, decisions),
    ),
    coverage: await newestCoverage({
      catalog,
      flows,
      project: context.project,
    }),
  };
}
