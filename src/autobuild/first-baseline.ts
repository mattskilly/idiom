import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { baselineDirectory, baselinePath } from "../baseline/store.js";
import { sourceStatus } from "../capture/resolve.js";
import { baselineRecordCommand } from "../commands/baseline.js";
import { validateProject } from "../validation.js";

const execFileAsync = promisify(execFile);

/**
 * The gate's first-run step: a new project has no baseline until one is
 * recorded on a clean main and committed. When noninteractive wiring installs
 * the gate (`idiom upgrade --yes`, `idiom init --wire --yes`), it records the
 * missing ones at clean HEAD, before its own writes dirty the tree, or names
 * the exact command when it cannot.
 */
export type FirstBaselineOutcome =
  /** Every gated flow already has a baseline committed at HEAD. */
  | { kind: "present" }
  | {
      kind: "recorded";
      /** Project-relative baseline files written; the user commits them. */
      paths: string[];
      directory: string;
      /** Flows recorded before one failed, when only some were. */
      failed?: { flow: string; reason: string; command: string }[];
    }
  | {
      kind: "next-step";
      reason: string;
      /** One `idiom baseline record <flow>` per flow with no baseline. */
      commands: string[];
      directory: string;
    };

export type FirstBaselineDependencies = {
  /** Records one flow's baseline; the default is `idiom baseline record`. */
  record?: (options: {
    flow: string;
    cwd: string;
  }) => Promise<{ path: string }>;
};

export const firstBaselineCommand = (flow: string) =>
  `idiom baseline record ${flow}`;

async function committedAtHead(
  projectDirectory: string,
  path: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["cat-file", "-e", `HEAD:./${relative(projectDirectory, path)}`],
      { cwd: projectDirectory },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a baseline for every flow with none committed at HEAD, when the tree
 * is clean. Never throws: anything that stops it becomes a next step naming
 * the command. Undefined when there is no Idiom project to record for.
 */
export async function recordFirstBaselines(
  projectDirectory: string,
  dependencies: FirstBaselineDependencies = {},
): Promise<FirstBaselineOutcome | undefined> {
  if (!existsSync(join(projectDirectory, ".idiom", "project.json")))
    return undefined;
  let validated: Awaited<ReturnType<typeof validateProject>>;
  try {
    validated = await validateProject({ project: projectDirectory });
  } catch {
    // An invalid project is reported by every other command; nothing to name.
    return undefined;
  }
  const root = validated.stateProjectDirectory ?? validated.projectDirectory;
  const directory = relative(
    root,
    baselineDirectory(root, validated.project),
  ).replaceAll("\\", "/");
  const missing: string[] = [];
  for (const { flow } of validated.flows)
    if (
      !(await committedAtHead(
        root,
        baselinePath(baselineDirectory(root, validated.project), flow.id),
      ))
    )
      missing.push(flow.id);
  if (missing.length === 0) return { kind: "present" };
  const nextStep = (reason: string, flows = missing): FirstBaselineOutcome => ({
    kind: "next-step",
    reason,
    commands: flows.map(firstBaselineCommand),
    directory,
  });
  try {
    const status = await sourceStatus(validated.projectDirectory, {
      ignoreDirty: validated.project.baselines?.ignoreDirty,
      excludedPaths: [join(validated.projectDirectory, ".idiom", "reports")],
    });
    if (status.dirty)
      return nextStep(
        `HEAD is not clean (${status.dirtyPaths.slice(0, 3).join(", ")}${status.dirtyPaths.length > 3 ? ", …" : ""}); on a clean main`,
      );
  } catch {
    return nextStep("not a committed Git tree; on a clean main");
  }
  const record =
    dependencies.record ??
    (async ({ flow, cwd }: { flow: string; cwd: string }) =>
      baselineRecordCommand({ flow, cwd }));
  const paths: string[] = [];
  const failed: { flow: string; reason: string; command: string }[] = [];
  for (const flow of missing) {
    try {
      const result = await record({ flow, cwd: validated.projectDirectory });
      paths.push(relative(root, result.path).replaceAll("\\", "/"));
    } catch (error) {
      failed.push({
        flow,
        reason: (error as Error).message.split("\n")[0] ?? "capture failed",
        command: firstBaselineCommand(flow),
      });
    }
  }
  if (paths.length === 0)
    return nextStep(
      `recording failed (${failed.map((entry) => `${entry.flow}: ${entry.reason}`).join("; ")}); fix that, then on a clean main`,
    );
  return {
    kind: "recorded",
    paths,
    directory,
    ...(failed.length === 0 ? {} : { failed }),
  };
}

/** Human lines for the outcome: what was recorded and what to commit, or the command. */
export function firstBaselineLines(
  outcome: FirstBaselineOutcome | undefined,
): string[] {
  if (outcome === undefined || outcome.kind === "present") return [];
  if (outcome.kind === "recorded")
    return [
      `Recorded the gate's first baseline at clean HEAD: ${outcome.paths.join(", ")}. Commit ${outcome.directory} so builds compare against it.`,
      ...(outcome.failed ?? []).map(
        (entry) =>
          `Next: ${entry.command} (${entry.reason}), then commit ${outcome.directory}.`,
      ),
    ];
  return [
    `The gate has no committed baseline yet: ${outcome.reason}, run`,
    ...outcome.commands.map((command) => `  ${command}`),
    `then commit ${outcome.directory}.`,
  ];
}
