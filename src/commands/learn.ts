import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { IdiomError } from "../errors.js";
import { findStateCapture } from "../learn/capture.js";
import { draftLearning } from "../learn/draft.js";
import { interpretObservation } from "../learn/interpret.js";
import type { BrowserLaunch } from "../learn/target.js";
import { persistRulingNames } from "../rulings/names.js";
import type { RulingConfirmation } from "../rulings/record.js";
import type { LearnedKind } from "../schemas/learned.js";
import { validateProject } from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";

export type LearnDependencies = {
  confirm?: RulingConfirmation | undefined;
  clock?: (() => Date) | undefined;
  gitTopology?: GitTopology | undefined;
  launch?: BrowserLaunch | undefined;
};

export type LearnResult =
  | { recorded: false }
  | {
      recorded: true;
      kind: LearnedKind;
      id: string;
      paths: string[];
      next: string;
    };

async function defaultConfirmation(): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question("Apply this learning? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new IdiomError(
      `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Coaching from a miss: turn what a human saw into a check configuration
 * entry or a design-law ruling, plus a provenance line naming the capture it
 * was seen on. Shows the exact diff and writes nothing until confirmed.
 */
export async function learnCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  state: string;
  observation: string;
  screenshot?: string | undefined;
  from?: string | undefined;
  selectors?: string[] | undefined;
  ruling?: boolean | undefined;
  wording?: string | undefined;
  yes?: boolean | undefined;
  dependencies?: LearnDependencies | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<LearnResult> {
  const observation = options.observation.trim();
  if (observation === "")
    throw new IdiomError("describe what is wrong; the observation is blank");
  if (options.wording !== undefined && options.ruling !== true)
    throw new IdiomError("--wording applies only with --ruling");
  const validated = await validateProject({
    project: options.project,
    cwd: options.cwd,
  });
  const matching = validated.flows.filter(
    (record) =>
      (options.flow === undefined || record.flow.id === options.flow) &&
      record.flow.states.some((state) => state.id === options.state),
  );
  if (matching.length === 0)
    throw new IdiomError(
      options.flow === undefined
        ? `no flow declares state ${JSON.stringify(options.state)}`
        : `flow ${JSON.stringify(options.flow)} does not declare state ${JSON.stringify(options.state)}`,
    );
  if (matching.length > 1)
    throw new IdiomError(
      `state ${JSON.stringify(options.state)} is declared by ${matching.map((record) => record.flow.id).join(", ")}; pass --flow`,
    );
  const flow = matching[0];
  if (flow === undefined) throw new IdiomError("unreachable: no flow");

  const interpretation =
    options.ruling === true
      ? ({ kind: "ruling" } as const)
      : interpretObservation(observation);
  const capture = await findStateCapture({
    projectDirectory: validated.projectDirectory,
    flow: flow.flow.id,
    state: options.state,
    viewports: [
      ...(flow.flow.viewports ?? []),
      ...validated.project.viewports.map((viewport) => viewport.name),
    ],
    colorScheme: validated.project.capture.colorScheme,
    from: options.from,
  });
  if (options.from !== undefined && capture === undefined)
    throw new IdiomError(
      `run ${options.from} has no capture of ${flow.flow.id}/${options.state}`,
    );
  const draft = await draftLearning({
    projectDirectory: validated.projectDirectory,
    project: validated.project,
    flow,
    state: options.state,
    observation,
    interpretation,
    capture,
    selectors: options.selectors,
    screenshot: options.screenshot,
    wording: options.wording,
    recordedAt: (
      options.dependencies?.clock ?? (() => new Date())
    )().toISOString(),
    launch: options.dependencies?.launch,
    gitTopology: options.dependencies?.gitTopology,
  });
  options.write?.(draft.diff);
  const confirmed =
    options.yes === true ||
    (await (options.dependencies?.confirm ?? defaultConfirmation)(draft.diff));
  if (!confirmed) return { recorded: false };

  for (const copy of draft.copies) {
    await mkdir(dirname(copy.to), { recursive: true });
    await copyFile(copy.from, copy.to);
  }
  for (const write of draft.writes) await atomicWrite(write.path, write.after);
  if (draft.rulingNames !== undefined)
    await persistRulingNames(draft.rulingNames);
  return {
    recorded: true,
    kind: draft.kind,
    id: draft.id,
    paths: [
      ...draft.writes.map((write) => write.displayPath),
      ...(draft.entry.screenshot === undefined ? [] : [draft.entry.screenshot]),
    ],
    next:
      draft.kind === "ruling"
        ? `Next: idiom review ${flow.flow.id} — the ruling is now design law.`
        : draft.kind === "glossary"
          ? `Next: idiom check ${flow.flow.id} — the glossary applies to the next check.`
          : `Next: idiom check ${flow.flow.id} — ${draft.kind} entries are measured at capture time, so runs captured before this change will not show it.`,
  };
}
