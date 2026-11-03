import { resolve } from "node:path";
import { sourceStatus } from "./capture/resolve.js";
import { IdiomError, RunFailure } from "./errors.js";
import { preflightFindingNameRegistry } from "./review/names.js";
import { isWebFlow } from "./schemas/flow.js";
import { productionConfigExample } from "./schemas/project.js";
import { type ValidationResult, validateProject } from "./validation.js";
import type { GitTopology } from "./verify/baseline.js";

const LISTED_DIRTY_PATHS = 5;

/** Project and flow validation, refused as a preflight failure. */
export async function validateForRun(options: {
  project?: string | undefined;
  flow?: string | undefined;
  cwd?: string | undefined;
}): Promise<ValidationResult> {
  try {
    return await validateProject(options);
  } catch (error) {
    throw invalidConfig(error);
  }
}

/** Any configuration error as the one-line preflight refusal. */
export function invalidConfig(error: unknown): unknown {
  if (!(error instanceof IdiomError) || error instanceof RunFailure)
    return error;
  const [first = "", ...rest] = error.message.split("\n");
  const missing = /no \.idiom\/project\.json found/.test(first);
  return new RunFailure({
    stage: "preflight",
    cause: missing ? "no-project" : "invalid-config",
    headline: `config invalid: ${first}`,
    detail: rest.join("\n") || undefined,
    hint: missing
      ? "run idiom init in the project (idiom_init over MCP), or pass --project <dir>"
      : "run idiom validate <flow> and fix the reported file",
  });
}

/** The dirty-tree refusal, with up to five paths named. */
export function treeDirtyFailure(
  paths: string[],
  allHint: boolean,
): RunFailure {
  const listed = paths.slice(0, LISTED_DIRTY_PATHS).join(", ");
  const more =
    paths.length > LISTED_DIRTY_PATHS
      ? ` (+${paths.length - LISTED_DIRTY_PATHS} more)`
      : "";
  return new RunFailure({
    stage: "preflight",
    cause: "tree-dirty",
    paths,
    headline: `baseline refused: tree dirty: ${listed}${more} (commit or stash${allHint ? ", or pass --all" : ""})`,
    hint: `commit or stash the listed paths${allHint ? ", or pass --all to inspect without recording a baseline" : ""}`,
  });
}

/**
 * Everything a run can check before it starts a server or captures: the
 * finding-name registry, and a clean tree when the run will record a
 * baseline from its own capture. Cheap by design — no capture work here.
 */
export async function preflightRun(options: {
  validated: ValidationResult;
  baseline: "none" | "record-from-fresh-capture";
  /** Whether `--all` is an alternative the caller offers. */
  allHint: boolean;
  /** Set when the run captures fresh; `prod` mirrors `--prod`. */
  capture?: { prod?: boolean | undefined } | undefined;
  gitTopology?: GitTopology | undefined;
  isolatedRegistry?: boolean | undefined;
}): Promise<void> {
  const { projectDirectory, project } = options.validated;
  const flow = options.validated.flows[0]?.flow;
  if (
    options.capture !== undefined &&
    (options.capture.prod === true ||
      (flow !== undefined &&
        isWebFlow(flow) &&
        flow.server === "production")) &&
    project.server.production === undefined
  )
    throw new RunFailure({
      stage: "preflight",
      cause: "invalid-config",
      headline: "config invalid: production capture requires server.production",
      detail: productionConfigExample,
      hint: "add server.production to .idiom/project.json, or capture without --prod",
    });
  await preflightFindingNameRegistry({
    projectDirectory,
    gitTopology: options.gitTopology,
    isolatedRegistry: options.isolatedRegistry,
  });
  if (options.baseline !== "record-from-fresh-capture") return;
  let status: Awaited<ReturnType<typeof sourceStatus>>;
  try {
    status = await sourceStatus(projectDirectory, {
      excludedPaths: [resolve(projectDirectory, ".idiom", "reports")],
    });
  } catch (error) {
    if (!(error instanceof IdiomError)) throw error;
    throw new RunFailure({
      stage: "preflight",
      cause: "not-a-git-worktree",
      headline: `baseline refused: ${error.message.split("\n")[0]}`,
      detail: error.message.split("\n").slice(1).join("\n") || undefined,
      hint: "record baselines from a committed Git worktree",
    });
  }
  if (status.dirty) throw treeDirtyFailure(status.dirtyPaths, options.allHint);
}
