import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { tupleCoordinate } from "../baseline/coordinate.js";
import { baselineDirectory, pixelBaselinePath } from "../baseline/store.js";
import { replaceOrigin } from "../capture/port.js";
import {
  captureTupleKey,
  expectedCaptureTupleKeys,
  expectedStatusByState,
  selectColorSchemes,
} from "../capture/resolve.js";
import { loadRunRecord } from "../capture/run-record.js";
import type {
  ConsoleRecord,
  ExpectationMismatch,
  ProductionBuild,
} from "../capture/types.js";
import {
  actionTimelineArtifactSchema,
  observationArtifactSchema,
} from "../checks/artifact-schema.js";
import { filmstripManifestSchema } from "../checks/filmstrip-schema.js";
import type { CheckTuple } from "../checks/types.js";
import { loadDesignArtifacts } from "../design/artifacts.js";
import { IdiomError } from "../errors.js";
import { annotateDeclaredExpectations } from "../findings/settings.js";
import { type Flow, isPublishedFlow, type WebFlow } from "../schemas/flow.js";
import type { ColorScheme } from "../schemas/project.js";
import type { ValidationResult } from "../validation.js";
import { diffImages } from "../verify/compare.js";

const storedCombinationSchema = z
  .object({
    base: z.string().min(1),
    label: z.string().min(1),
    options: z.record(z.string(), z.string()),
    equivalent: z.array(z.string()),
  })
  .strict();

const combinationsReportSchema = z
  .object({
    version: z.literal(1),
    evidence: z.literal("per-combination").optional(),
    captured: z.number().int().nonnegative(),
    collapsed: z.array(
      z
        .object({
          state: z.string().min(1),
          viewport: z.string().min(1),
          colorScheme: z.enum(["light", "dark"]),
          colorSchemeAxis: z.boolean(),
          combination: z.string().min(1),
          sameAs: z
            .object({
              state: z.string().min(1),
              combination: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    ),
    cap: z
      .object({ combined: z.array(z.string()), held: z.array(z.string()) })
      .strict()
      .optional(),
    notes: z.array(z.string()),
  })
  .strict();

type StoredMetadata = {
  design?: unknown;
  designs?: unknown[];
  designNotApplicable?: string;
  layoutRepresentative?: string;
  combination?: z.infer<typeof storedCombinationSchema>;
  build?: ProductionBuild;
  source: { commit: string; dirty?: boolean };
  flow: { id: string };
  state: { id: string; siblingGroup?: string; group?: string };
  viewport: { name: string; width: number; height: number };
  colorScheme?: ColorScheme;
  colorSchemeAxis?: boolean;
  timestamps: { startedAt: string };
  status?: number | null;
  url?:
    | { kind: "literal"; origin: string; url: string; canonicalOrigin?: string }
    | {
        kind: "setup-stdout";
        origin: string;
        source: "setup-stdout";
        pattern: string;
        append: string;
        template: string;
        canonicalOrigin?: string;
      }
    | { kind: "unresolved"; declaration: unknown };
  expectations: { mismatches: ExpectationMismatch[] };
  failure: { stage: string; message: string } | null;
  platform?: { platform: string; architecture: string; release: string };
  browserVersion?: string;
};

function validBuild(value: unknown): value is ProductionBuild {
  if (value === null || typeof value !== "object") return false;
  const build = value as Record<string, unknown>;
  return (
    build.kind === "production" &&
    typeof build.id === "string" &&
    build.id.trim().length > 0 &&
    Object.keys(build).every((key) => key === "kind" || key === "id")
  );
}

function validStoredUrl(
  value: unknown,
): value is NonNullable<StoredMetadata["url"]> {
  if (value === null || typeof value !== "object") return false;
  const url = value as Record<string, unknown>;
  const canonical =
    url.canonicalOrigin === undefined ||
    typeof url.canonicalOrigin === "string";
  if (url.kind === "literal") {
    return (
      typeof url.origin === "string" && typeof url.url === "string" && canonical
    );
  }
  if (url.kind === "setup-stdout") {
    return (
      canonical &&
      typeof url.origin === "string" &&
      url.source === "setup-stdout" &&
      typeof url.pattern === "string" &&
      typeof url.append === "string" &&
      typeof url.template === "string"
    );
  }
  return url.kind === "unresolved" && "declaration" in url;
}

/** The document URL in the same coordinates as captured console locations. */
function documentUrl(url: StoredMetadata["url"]): string | undefined {
  if (url === undefined || url.kind === "unresolved") return undefined;
  const raw = url.kind === "literal" ? url.url : url.template;
  return url.canonicalOrigin === undefined
    ? raw
    : replaceOrigin(raw, url.origin, url.canonicalOrigin);
}

async function parseJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new IdiomError(
      `cannot read capture artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function metadata(value: unknown, path: string): StoredMetadata {
  if (value === null || typeof value !== "object")
    throw new IdiomError(`invalid metadata in ${path}`);
  const item = value as Partial<StoredMetadata>;
  const raw = value as Record<string, unknown>;
  if (
    ("layoutRepresentative" in raw &&
      (typeof raw.layoutRepresentative !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.layoutRepresentative))) ||
    ("combination" in raw &&
      !storedCombinationSchema.safeParse(raw.combination).success) ||
    ("build" in raw && !validBuild(raw.build)) ||
    typeof item.source?.commit !== "string" ||
    typeof item.flow?.id !== "string" ||
    typeof item.state?.id !== "string" ||
    (item.state.siblingGroup !== undefined &&
      typeof item.state.siblingGroup !== "string") ||
    (item.state.group !== undefined && typeof item.state.group !== "string") ||
    typeof item.viewport?.name !== "string" ||
    typeof item.viewport.width !== "number" ||
    typeof item.viewport.height !== "number" ||
    (item.colorScheme !== undefined &&
      item.colorScheme !== "light" &&
      item.colorScheme !== "dark") ||
    (item.colorSchemeAxis !== undefined &&
      typeof item.colorSchemeAxis !== "boolean") ||
    (item.colorSchemeAxis === true && item.colorScheme === undefined) ||
    typeof item.timestamps?.startedAt !== "string" ||
    ("status" in raw &&
      !(typeof raw.status === "number" || raw.status === null)) ||
    ("url" in raw && !validStoredUrl(raw.url)) ||
    !Array.isArray(item.expectations?.mismatches) ||
    (item.platform !== undefined &&
      (typeof item.platform.platform !== "string" ||
        typeof item.platform.architecture !== "string" ||
        typeof item.platform.release !== "string")) ||
    (item.browserVersion !== undefined &&
      typeof item.browserVersion !== "string") ||
    !(
      item.failure === null ||
      (typeof item.failure?.stage === "string" &&
        typeof item.failure.message === "string")
    )
  ) {
    throw new IdiomError(`invalid metadata in ${path}`);
  }
  return item as StoredMetadata;
}

function reportPath(runDirectory: string, path: string): string {
  return relative(runDirectory, path).split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseConsole(source: string, path: string): ConsoleRecord[] {
  return source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const record = JSON.parse(line) as ConsoleRecord;
        if (
          record !== null &&
          typeof record === "object" &&
          "healthAllowed" in record &&
          typeof record.healthAllowed !== "boolean"
        ) {
          throw new Error("healthAllowed must be a boolean");
        }
        return record;
      } catch (error) {
        throw new IdiomError(
          `invalid console record in ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function parseAxe(value: unknown, path: string): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray((value as { violations?: unknown }).violations)
  ) {
    throw new IdiomError(
      `invalid axe results in ${path}: violations must be an array`,
    );
  }
  for (const [index, violation] of (
    value as { violations: unknown[] }
  ).violations.entries()) {
    if (
      violation === null ||
      typeof violation !== "object" ||
      typeof (violation as { id?: unknown }).id !== "string" ||
      !Array.isArray((violation as { nodes?: unknown }).nodes)
    ) {
      throw new IdiomError(
        `invalid axe results in ${path}: violations[${index}] must have an id and nodes array`,
      );
    }
  }
  return value;
}

function parseTimelines(value: unknown, path: string) {
  const parsed = actionTimelineArtifactSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new IdiomError(
      `invalid action timelines in ${path}: ${issues}; recapture the flow`,
    );
  }
  return parsed.data;
}

function parseObservations(value: unknown, path: string) {
  const parsed = observationArtifactSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new IdiomError(
      `invalid observations in ${path}: ${issues}; recapture the flow`,
    );
  }
  return parsed.data;
}

export function resolveStoredRun(
  projectDirectory: string,
  runId: string,
): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
    runId === "." ||
    runId === ".."
  ) {
    throw new IdiomError(
      "--from must be a simple run ID beneath .idiom/reports",
    );
  }
  const reports = resolve(projectDirectory, ".idiom", "reports");
  const run = resolve(reports, runId);
  if (
    relative(reports, run).startsWith("..") ||
    isAbsolute(relative(reports, run))
  ) {
    throw new IdiomError("--from must remain beneath .idiom/reports");
  }
  return run;
}

/**
 * The newest stored capture of `flow` taken at `commit` (and, when
 * `requireClean`, from a clean tree) whose tuples all passed. This is what
 * `review --latest` and `check --latest` resolve, so scripts never have to
 * thread a printed run id between commands.
 */
export async function findLatestCapture(options: {
  projectDirectory: string;
  flow: string;
  commit: string;
  production?: boolean | undefined;
}): Promise<string> {
  const reports = resolve(options.projectDirectory, ".idiom", "reports");
  const runs = await storedRunsNewestFirst(reports);
  for (const run of runs) {
    let baseline: string;
    try {
      baseline = await readFile(join(reports, run, "baseline.md"), "utf8");
    } catch {
      continue;
    }
    const summary = baseline.match(
      /Flow `([^`]+)`: (\d+) passed, (\d+) failed/,
    );
    if (summary === null || summary[1] !== options.flow || summary[3] !== "0")
      continue;
    const record = await loadRunRecord(join(reports, run));
    if (record && record.selected.length !== record.declared.length) continue;
    const metadata = await findFirstMetadata(join(reports, run));
    if (metadata === undefined) continue;
    if (options.production === true && !metadata.production) continue;
    if (metadata.commit === options.commit && !metadata.dirty) return run;
  }
  throw new IdiomError(
    `no fully passing capture of ${JSON.stringify(options.flow)} at ${options.commit.slice(0, 12)} with a clean tree; run \`idiom capture ${options.flow}\` first`,
  );
}

/** Stored capture run names under `reports`, newest first. */
async function storedRunsNewestFirst(reports: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(reports, { withFileTypes: true });
  } catch {
    entries = [];
  }
  return entries
    .filter(
      (entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/**
 * The newest stored capture of `flow`, passing or not, from any commit. State
 * coverage describes what the latest capture saw, so nothing is filtered out.
 */
export async function findNewestCapture(options: {
  projectDirectory: string;
  flow: string;
}): Promise<string | undefined> {
  const reports = resolve(options.projectDirectory, ".idiom", "reports");
  for (const run of await storedRunsNewestFirst(reports)) {
    const directory = join(reports, run);
    let recorded: unknown;
    try {
      recorded = JSON.parse(
        await readFile(join(directory, "run.json"), "utf8"),
      );
    } catch {
      recorded = undefined;
    }
    if (
      typeof recorded === "object" &&
      recorded !== null &&
      "flow" in recorded
    ) {
      if (recorded.flow === options.flow) return directory;
      continue;
    }
    let baseline: string;
    try {
      baseline = await readFile(join(directory, "baseline.md"), "utf8");
    } catch {
      continue;
    }
    if (baseline.match(/Flow `([^`]+)`/)?.[1] === options.flow)
      return directory;
  }
  return undefined;
}

async function findFirstMetadata(
  directory: string,
  depth = 0,
): Promise<
  { commit: string; dirty: boolean; production: boolean } | undefined
> {
  if (depth > 4) return undefined;
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const file = entries.find(
    (entry) => entry.isFile() && entry.name === "metadata.json",
  );
  if (file !== undefined) {
    try {
      const parsed = JSON.parse(
        await readFile(join(directory, file.name), "utf8"),
      ) as {
        source?: { commit?: unknown; dirty?: unknown };
        build?: unknown;
      };
      if (typeof parsed.source?.commit === "string")
        return {
          commit: parsed.source.commit,
          dirty: parsed.source.dirty === true,
          production: validBuild(parsed.build),
        };
    } catch {
      return undefined;
    }
  }
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const found = await findFirstMetadata(
      join(directory, entry.name),
      depth + 1,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

export async function loadCaptureRun(options: {
  runDirectory: string;
  expectedFlow: string;
  expectedStatusByState?: ReadonlyMap<string, number> | undefined;
  stateOrder?: string[] | undefined;
  viewportOrder?: string[] | undefined;
  colorSchemeOrder?: ColorScheme[] | undefined;
  legacyColorScheme?: ColorScheme | undefined;
}): Promise<{
  tuples: CheckTuple[];
  commit: string;
  runId: string;
  collapsedTupleKeys: string[];
  collapsedCount: number;
  build?: ProductionBuild;
  record?: import("../capture/run-record.js").RunRecord | undefined;
}> {
  const runDirectory = resolve(options.runDirectory);
  let stateEntries: Dirent[];
  try {
    stateEntries = await readdir(runDirectory, { withFileTypes: true });
  } catch (error) {
    throw new IdiomError(
      `cannot read capture run ${runDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const runRecord = await loadRunRecord(runDirectory);
  if (runRecord && runRecord.flow !== options.expectedFlow)
    throw new IdiomError("run.json flow disagrees with requested flow");
  const combinationsPath = join(runDirectory, "combinations.json");
  let collapsedTupleKeys: string[] = [];
  let combinations: z.infer<typeof combinationsReportSchema> | undefined;
  if (await exists(combinationsPath)) {
    const parsed = combinationsReportSchema.safeParse(
      await parseJson(combinationsPath),
    );
    if (!parsed.success)
      throw new IdiomError(
        `invalid combinations report in ${combinationsPath}: ${parsed.error.message}`,
      );
    combinations = parsed.data;
    collapsedTupleKeys = combinations.collapsed.map(captureTupleKey);
    if (new Set(collapsedTupleKeys).size !== collapsedTupleKeys.length)
      throw new IdiomError(`duplicate collapsed tuples in ${combinationsPath}`);
  }
  const buildPath = join(runDirectory, "build.json");
  let runBuild: ProductionBuild | undefined;
  if (await exists(buildPath)) {
    const value = await parseJson(buildPath);
    if (!validBuild(value))
      throw new IdiomError(`invalid production build in ${buildPath}`);
    runBuild = value;
  }
  const tupleDirectories: string[] = [];
  for (const state of stateEntries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const stateDirectory = join(runDirectory, state.name);
    for (const viewport of (
      await readdir(stateDirectory, { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = join(stateDirectory, viewport.name);
      if (await exists(join(directory, "metadata.json"))) {
        tupleDirectories.push(directory);
        continue;
      }
      for (const scheme of (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const schemeDirectory = join(directory, scheme.name);
        if (await exists(join(schemeDirectory, "metadata.json")))
          tupleDirectories.push(schemeDirectory);
      }
    }
  }
  if (tupleDirectories.length === 0) {
    if (!(await exists(join(runDirectory, "baseline.md")))) {
      throw new IdiomError(
        `capture run has no tuple metadata: ${runDirectory}`,
      );
    }
    if (collapsedTupleKeys.length > 0)
      throw new IdiomError(
        `collapsed tuples have no captured representative in ${combinationsPath}`,
      );
    return {
      collapsedTupleKeys,
      collapsedCount: 0,
      tuples: [],
      commit: "unavailable (capture contains no tuples)",
      ...(runBuild === undefined ? {} : { build: runBuild }),
      runId: runDirectory.split(sep).at(-1) ?? "run",
    };
  }
  const tuples: CheckTuple[] = [];
  let storedCommit: string | undefined;
  let build: ProductionBuild | undefined = runBuild;
  let first = runBuild === undefined;
  const records = await Promise.all(
    tupleDirectories.map(async (directory) => {
      const metadataPath = join(directory, "metadata.json");
      return {
        directory,
        metadataPath,
        record: metadata(await parseJson(metadataPath), metadataPath),
      };
    }),
  );
  const recordKey = (record: StoredMetadata, state = record.state.id) =>
    captureTupleKey({
      state,
      viewport: record.viewport.name,
      colorScheme: record.colorScheme ?? options.legacyColorScheme ?? "light",
    });
  const recordsByKey = new Map(
    records.map((entry) => [recordKey(entry.record), entry]),
  );
  for (const { directory, metadataPath, record } of records) {
    if (runRecord) {
      const viewport = runRecord.viewports.find(
        (v) => v.name === record.viewport.name,
      );
      if (
        record.source.commit !== runRecord.source.commit ||
        record.source.dirty !== runRecord.source.dirty ||
        !runRecord.selected.some(
          (tuple) => captureTupleKey(tuple) === recordKey(record),
        ) ||
        viewport?.width !== record.viewport.width ||
        viewport.height !== record.viewport.height
      )
        throw new IdiomError(
          `run.json disagrees with capture metadata in ${metadataPath}`,
        );
    }
    if (record.flow.id !== options.expectedFlow) {
      throw new IdiomError(
        `stored capture flow ${JSON.stringify(record.flow.id)} does not match requested flow ${JSON.stringify(options.expectedFlow)}`,
      );
    }
    if (storedCommit !== undefined && storedCommit !== record.source.commit) {
      throw new IdiomError("stored capture tuples disagree on source commit");
    }
    if (
      !first &&
      (build?.kind !== record.build?.kind || build?.id !== record.build?.id)
    )
      throw new IdiomError(
        "stored capture tuples disagree on production build",
      );
    first = false;
    build = record.build;
    storedCommit = record.source.commit;
    const artifactNames = [
      "metadata.json",
      "screenshot.png",
      "dom.html",
      "console.jsonl",
      "axe.json",
      "observations.json",
    ];
    const present: Record<string, string> = {};
    for (const name of artifactNames) {
      const path = join(directory, name);
      if (await exists(path)) present[name] = path;
    }
    if (record.layoutRepresentative !== undefined) {
      const entry = combinations?.collapsed.find(
        (entry) => captureTupleKey(entry) === recordKey(record),
      );
      const representative = recordsByKey.get(
        recordKey(record, record.layoutRepresentative),
      );
      if (
        combinations?.evidence !== "per-combination" ||
        entry?.sameAs.state !== record.layoutRepresentative ||
        representative === undefined ||
        representative.record.layoutRepresentative !== undefined
      )
        throw new IdiomError(
          `invalid layout representative in ${metadataPath}`,
        );
      const screenshot = join(representative.directory, "screenshot.png");
      if (await exists(screenshot)) present["screenshot.png"] = screenshot;
    }
    if (record.failure === null) {
      const missing = artifactNames.filter(
        (name) => present[name] === undefined,
      );
      if (missing.length > 0) {
        const coordinate = `${record.state.id}/${record.viewport.name}${record.colorSchemeAxis ? `/${record.colorScheme}` : ""}`;
        throw new IdiomError(
          `successful capture tuple ${coordinate} is stale or corrupt; missing ${missing.join(", ")}; recapture the flow`,
        );
      }
    }
    // Optional: runs captured before action timelines load unchanged.
    const timelinesCandidate = join(directory, "timelines.json");
    if (await exists(timelinesCandidate))
      present["timelines.json"] = timelinesCandidate;
    const filmstripPath = join(directory, "filmstrips.json");
    let filmstrips:
      | import("../checks/filmstrip-schema.js").FilmstripManifest
      | undefined;
    if (await exists(filmstripPath)) {
      const parsed = filmstripManifestSchema.safeParse(
        await parseJson(filmstripPath),
      );
      if (!parsed.success)
        throw new IdiomError(
          `invalid filmstrips in ${filmstripPath}: ${parsed.error.message}; recapture the flow`,
        );
      filmstrips = parsed.data;
      present["filmstrips.json"] = filmstripPath;
      for (const action of filmstrips.actions)
        for (const frame of action.frames)
          if (frame.path) {
            const path = join(directory, frame.path);
            // resolve + realpath confinement is checked again before reading image bytes.
            if (!(await exists(path)))
              throw new IdiomError(
                `missing filmstrip frame ${path}; recapture the flow`,
              );
            await assertEvidencePaths(runDirectory, [
              reportPath(runDirectory, path),
            ]);
            present[frame.path] = path;
          }
    }
    const consolePath = present["console.jsonl"];
    const axePath = present["axe.json"];
    const observationsPath = present["observations.json"];
    const timelinesPath = present["timelines.json"];
    const expectedStatus = options.expectedStatusByState?.get(record.state.id);
    const url = documentUrl(record.url);
    tuples.push({
      ...(runRecord?.captureSettingsIdentity
        ? { captureSettingsIdentity: runRecord.captureSettingsIdentity }
        : {}),
      ...(record.layoutRepresentative === undefined
        ? {}
        : { layoutRepresentative: record.layoutRepresentative }),
      ...(record.combination === undefined
        ? {}
        : { combination: record.combination.label }),
      flow: record.flow.id,
      state: record.state.id,
      ...(record.state.siblingGroup !== undefined
        ? { siblings: `sibling:${record.state.siblingGroup}` }
        : record.state.group !== undefined
          ? { siblings: `group:${record.flow.id}:${record.state.group}` }
          : {}),
      viewport: record.viewport.name,
      colorScheme: record.colorScheme ?? options.legacyColorScheme ?? "light",
      colorSchemeAxis: record.colorSchemeAxis ?? false,
      width: record.viewport.width,
      height: record.viewport.height,
      metadataPath: reportPath(runDirectory, metadataPath),
      ...(present["screenshot.png"] === undefined
        ? {}
        : {
            screenshotPath: reportPath(runDirectory, present["screenshot.png"]),
          }),
      artifactPaths: Object.values(present)
        .map((path) => reportPath(runDirectory, path))
        .sort(),
      filmstrips,
      commit: record.source.commit,
      createdAt: record.timestamps.startedAt,
      ...(observationsPath === undefined
        ? {}
        : {
            observations: parseObservations(
              await parseJson(observationsPath),
              observationsPath,
            ),
          }),
      ...(timelinesPath === undefined
        ? {}
        : {
            timelines: parseTimelines(
              await parseJson(timelinesPath),
              timelinesPath,
            ),
          }),
      ...(axePath === undefined
        ? {}
        : { axe: parseAxe(await parseJson(axePath), axePath) }),
      console:
        consolePath === undefined
          ? []
          : parseConsole(await readFile(consolePath, "utf8"), consolePath),
      consoleAvailable: consolePath !== undefined,
      ...(typeof record.status === "number" &&
      expectedStatus !== undefined &&
      url !== undefined
        ? {
            documentResponse: {
              url,
              actualStatus: record.status,
              expectedStatus,
            },
          }
        : {}),
      mismatches: record.expectations.mismatches,
      ...(record.failure === null ? {} : { failure: record.failure }),
      ...(record.platform === undefined || record.browserVersion === undefined
        ? {}
        : {
            platform: {
              ...record.platform,
              browserVersion: record.browserVersion,
            },
          }),
    });
    const tuple = tuples.at(-1);
    if (tuple && Array.isArray(record.designs) && record.designs.length) {
      tuple.designs = [];
      for (const raw of record.designs)
        tuple.designs.push(await loadDesignArtifacts(runDirectory, raw, tuple));
      tuple.design = tuple.designs[0];
    } else if (record.design !== undefined && tuple)
      tuple.design = await loadDesignArtifacts(
        runDirectory,
        record.design,
        tuple,
      );
    if (tuple && typeof record.designNotApplicable === "string")
      tuple.designNotApplicable = record.designNotApplicable;
  }
  const capturedKeys = new Set(
    tuples.map((tuple) =>
      captureTupleKey({
        state: tuple.state,
        viewport: tuple.viewport,
        colorScheme: tuple.colorScheme ?? options.legacyColorScheme ?? "light",
      }),
    ),
  );
  for (const entry of combinations?.collapsed ?? []) {
    const representative = tuples.find(
      (tuple) =>
        tuple.state === entry.sameAs.state &&
        tuple.viewport === entry.viewport &&
        tuple.colorScheme === entry.colorScheme,
    );
    if (
      (combinations?.evidence === "per-combination"
        ? recordsByKey.get(captureTupleKey(entry))?.record
            .layoutRepresentative !== entry.sameAs.state
        : capturedKeys.has(captureTupleKey(entry))) ||
      representative?.combination !== entry.sameAs.combination
    )
      throw new IdiomError(
        `invalid collapsed tuple representative in ${combinationsPath}`,
      );
  }
  const collapsedCount = combinations?.collapsed.length ?? 0;
  // Legacy runs omitted all collapsed evidence. New runs retain every check tuple
  // and therefore must participate in the complete expected grid.
  if (combinations?.evidence === "per-combination") collapsedTupleKeys = [];
  const stateOrder = new Map(
    (options.stateOrder ?? []).map((state, index) => [state, index]),
  );
  const viewportOrder = new Map(
    (options.viewportOrder ?? []).map((viewport, index) => [viewport, index]),
  );
  const colorSchemeOrder = new Map(
    (options.colorSchemeOrder ?? []).map((scheme, index) => [scheme, index]),
  );
  tuples.sort(
    (left, right) =>
      (stateOrder.get(left.state) ?? Number.MAX_SAFE_INTEGER) -
        (stateOrder.get(right.state) ?? Number.MAX_SAFE_INTEGER) ||
      left.state.localeCompare(right.state) ||
      (viewportOrder.get(left.viewport) ?? Number.MAX_SAFE_INTEGER) -
        (viewportOrder.get(right.viewport) ?? Number.MAX_SAFE_INTEGER) ||
      left.viewport.localeCompare(right.viewport) ||
      (colorSchemeOrder.get(left.colorScheme ?? "light") ??
        Number.MAX_SAFE_INTEGER) -
        (colorSchemeOrder.get(right.colorScheme ?? "light") ??
          Number.MAX_SAFE_INTEGER) ||
      (left.colorScheme ?? "light").localeCompare(right.colorScheme ?? "light"),
  );
  return {
    tuples,
    collapsedTupleKeys,
    collapsedCount,
    commit: storedCommit ?? runRecord?.source.commit ?? "",
    record: runRecord,
    ...(build === undefined ? {} : { build }),
    runId: runDirectory.split(sep).at(-1) ?? "run",
  };
}

export async function assertEvidencePaths(
  runDirectory: string,
  paths: string[],
): Promise<void> {
  const base = resolve(runDirectory);
  for (const item of paths) {
    const path = resolve(base, item);
    const escaped = relative(base, path);
    if (
      escaped.startsWith("..") ||
      isAbsolute(escaped) ||
      !(await exists(path))
    ) {
      throw new IdiomError(
        `finding evidence does not resolve to a capture artifact: ${item}`,
      );
    }
  }
}

/** The same loaded evidence and authoritative expected grid used by review. */
type PixelMeasurement = NonNullable<
  NonNullable<CheckTuple["published"]>["pixel"]
>;

async function measurePixels(
  baseline: string,
  screenshotPath: string | undefined,
): Promise<PixelMeasurement> {
  let before: Buffer;
  try {
    before = await readFile(baseline);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "no-baseline" };
    return { status: "unavailable", reason: errorText(error) };
  }
  if (screenshotPath === undefined)
    return { status: "unavailable", reason: "the tuple has no screenshot" };
  try {
    const diff = diffImages(before, await readFile(screenshotPath));
    const totalPixels = diff.padded.width * diff.padded.height;
    return {
      status: "measured",
      ratio: totalPixels === 0 ? 0 : diff.differentPixels / totalPixels,
      differentPixels: diff.differentPixels,
      totalPixels,
      baseline,
    };
  } catch (error) {
    return { status: "unavailable", reason: errorText(error) };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Gives a published flow's tuples their budget and pixel measurement. */
async function attachPublished(
  validated: ValidationResult,
  flow: WebFlow,
  runDirectory: string,
  tuples: CheckTuple[],
): Promise<void> {
  const maxDiffRatio = flow.budget?.maxDiffRatio;
  const directory = baselineDirectory(
    validated.projectDirectory,
    validated.project,
  );
  for (const tuple of tuples) {
    tuple.published =
      maxDiffRatio === undefined
        ? {}
        : {
            maxDiffRatio,
            pixel: await measurePixels(
              pixelBaselinePath(directory, flow.id, tupleCoordinate(tuple)),
              tuple.screenshotPath === undefined
                ? undefined
                : join(runDirectory, tuple.screenshotPath),
            ),
          };
  }
}

export async function loadRunTuples(
  validated: ValidationResult,
  flow: Flow,
  runDirectory: string,
) {
  const loaded = await loadCaptureRun({
    runDirectory,
    expectedFlow: flow.id,
    expectedStatusByState: expectedStatusByState(flow),
    stateOrder: flow.states.map((state) => state.id),
    viewportOrder:
      flow.viewports ??
      validated.project.viewports.map((viewport) => viewport.name),
    colorSchemeOrder: selectColorSchemes(validated.project, flow),
    legacyColorScheme: validated.project.capture.colorScheme,
  });
  const record = loaded.record;
  annotateDeclaredExpectations(loaded.tuples, flow);
  if (isPublishedFlow(flow))
    await attachPublished(validated, flow, runDirectory, loaded.tuples);
  return {
    ...loaded,
    record,
    expectedTupleKeys: record
      ? record.selected
          .map(captureTupleKey)
          .filter((key) => !loaded.collapsedTupleKeys.includes(key))
      : expectedCaptureTupleKeys({
          project: validated.project,
          flow,
          collapsed: loaded.collapsedTupleKeys,
        }),
  };
}
