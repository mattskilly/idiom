import {
  access,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { IdiomError } from "../errors.js";
import {
  type ExplorationRun,
  type ExplorationRunResolution,
  explorationRunSchema,
  type PersistedExplorationCandidate,
} from "../schemas/exploration.js";

function runPath(projectDirectory: string, runId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
    runId === "." ||
    runId === ".."
  )
    throw new IdiomError(
      "exploration run must be a simple run ID beneath .idiom/reports",
    );
  const reports = resolve(projectDirectory, ".idiom", "reports");
  const directory = resolve(reports, runId);
  const escaped = relative(reports, directory);
  if (escaped.startsWith("..") || isAbsolute(escaped))
    throw new IdiomError("exploration run must remain beneath .idiom/reports");
  return directory;
}

function contained(directory: string, item: string): string {
  const path = resolve(directory, item);
  const escaped = relative(directory, path);
  if (escaped.startsWith("..") || isAbsolute(escaped))
    throw new IdiomError(
      `exploration candidate capture escapes its run: ${item}`,
    );
  return path;
}

async function parse(
  path: string,
  unknownRun: boolean,
): Promise<ExplorationRun> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (unknownRun && (error as NodeJS.ErrnoException).code === "ENOENT")
      throw new IdiomError(
        `unknown exploration run ${JSON.stringify(path.split("/").at(-2))}`,
      );
    throw new IdiomError(
      `cannot read exploration artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = explorationRunSchema.safeParse(value);
  if (!parsed.success)
    throw new IdiomError(
      `invalid exploration artifact ${path}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

export type LoadedExplorationRun = {
  runId: string;
  runDirectory: string;
  manifestPath: string;
  markdownPath: string;
  reportPath: string;
  manifest: ExplorationRun;
  candidates: PersistedExplorationCandidate[];
  capturePath(candidate: PersistedExplorationCandidate): string;
};

export async function loadExplorationRun(options: {
  projectDirectory: string;
  runId: string;
  allowResolved?: boolean;
}): Promise<LoadedExplorationRun> {
  const lexicalRun = runPath(options.projectDirectory, options.runId);
  const reportsDirectory = resolve(
    options.projectDirectory,
    ".idiom",
    "reports",
  );
  let runDirectory: string;
  try {
    const [canonicalReports, canonicalRun] = await Promise.all([
      realpath(reportsDirectory),
      realpath(lexicalRun),
    ]);
    const escaped = relative(canonicalReports, canonicalRun);
    if (escaped.startsWith("..") || isAbsolute(escaped))
      throw new IdiomError(
        `exploration run ${options.runId} escapes .idiom/reports`,
      );
    runDirectory = canonicalRun;
  } catch (error) {
    if (error instanceof IdiomError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new IdiomError(
        `unknown exploration run ${JSON.stringify(options.runId)}`,
      );
    throw new IdiomError(
      `cannot access exploration run ${JSON.stringify(options.runId)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifestPath = join(runDirectory, "exploration.json");
  const manifest = await parse(manifestPath, true);
  if (manifest.resolution !== undefined && options.allowResolved !== true)
    throw new IdiomError(
      `exploration run ${options.runId} is already resolved`,
    );
  const markdownPath = join(runDirectory, "exploration.md");
  const reportPath = join(runDirectory, "report.html");
  for (const path of [markdownPath, reportPath])
    try {
      await access(path);
    } catch {
      throw new IdiomError(
        `exploration run ${options.runId} is incomplete: missing ${path.split("/").at(-1)}`,
      );
    }
  const capturePaths = new Map<PersistedExplorationCandidate, string>();
  for (const candidate of manifest.candidates)
    try {
      const lexicalCapture = contained(runDirectory, candidate.capture);
      const capture = await realpath(lexicalCapture);
      const escaped = relative(runDirectory, capture);
      if (escaped.startsWith("..") || isAbsolute(escaped))
        throw new IdiomError(
          `exploration candidate capture escapes its run: ${candidate.capture}`,
        );
      capturePaths.set(candidate, capture);
    } catch (error) {
      if (error instanceof IdiomError) throw error;
      throw new IdiomError(
        `exploration run ${options.runId} is incomplete: missing candidate capture ${candidate.capture}`,
      );
    }
  const base = manifest.candidates.filter((candidate) => !candidate.refined);
  const refined = manifest.candidates.find((candidate) => candidate.refined);
  const candidates = base.map((candidate) =>
    refined?.label === candidate.label ? refined : candidate,
  );
  return {
    runId: options.runId,
    runDirectory,
    manifestPath,
    markdownPath,
    reportPath,
    manifest,
    candidates,
    capturePath: (candidate) =>
      capturePaths.get(candidate) ?? contained(runDirectory, candidate.capture),
  };
}

export async function recordExplorationResolution(
  manifestPath: string,
  resolution: ExplorationRunResolution,
): Promise<void> {
  const current = await parse(manifestPath, false);
  if (current.resolution !== undefined)
    throw new IdiomError("exploration run is already resolved");
  const completed = explorationRunSchema.parse({ ...current, resolution });
  const temporary = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(completed, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, manifestPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new IdiomError(
      `cannot record exploration resolution in ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
