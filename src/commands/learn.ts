import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { briefEligibility } from "../brief/assertions.js";
import { readBrief } from "../brief/store.js";
import { IdiomError } from "../errors.js";
import { findStateCapture } from "../learn/capture.js";
import {
  type DraftInterpretation,
  draftLearning,
  type PromotedInvariant,
} from "../learn/draft.js";
import { interpretObservation } from "../learn/interpret.js";
import type { BrowserLaunch } from "../learn/target.js";
import { persistRulingNames } from "../rulings/names.js";
import type { RulingConfirmation } from "../rulings/record.js";
import { type CompleteStoredBrief, isCompleteBrief } from "../schemas/brief.js";
import type { Invariant } from "../schemas/invariant.js";
import type { LearnedKind } from "../schemas/learned.js";
import { type FlowRecord, validateProject } from "../validation.js";
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

export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
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

/** The one flow/state pair a brief's assertions name, for `--from-brief` without `--state`. */
function briefState(
  brief: CompleteStoredBrief,
  flow: string | undefined,
): { flow: string; state: string } {
  const pairs = [
    ...new Map(
      brief.acceptanceCriteria
        .flatMap((criterion) => criterion.assertions ?? [])
        .filter((assertion) => flow === undefined || assertion.flow === flow)
        .map((assertion) => [
          `${assertion.flow}/${assertion.state}`,
          { flow: assertion.flow, state: assertion.state },
        ]),
    ).entries(),
  ];
  const only = pairs[0];
  if (pairs.length === 1 && only !== undefined) return only[1];
  throw new IdiomError(
    pairs.length === 0
      ? `brief ${brief.slug} has no assertions naming a flow state; pass --state`
      : `brief ${brief.slug} names several flow states (${pairs.map(([key]) => key).join(", ")}); pass --state`,
  );
}

/**
 * The brief's absolute size assertions on this flow state, as state
 * invariants, less those the state already declares.
 */
function promotedInvariants(
  brief: CompleteStoredBrief,
  flow: FlowRecord,
  state: string,
): PromotedInvariant[] {
  if (briefEligibility(brief) !== true) return [];
  const declared = (
    flow.flow.states.find((candidate) => candidate.id === state)?.invariants ??
    []
  ).filter(
    (invariant): invariant is Extract<Invariant, { selector: string }> =>
      "selector" in invariant,
  );
  const same = (left: unknown, right: unknown) =>
    JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  return brief.acceptanceCriteria.flatMap((criterion) =>
    (criterion.assertions ?? []).flatMap((assertion) => {
      if (assertion.flow !== flow.flow.id || assertion.state !== state)
        return [];
      if (!("width" in assertion || "height" in assertion)) return [];
      if (
        declared.some(
          (invariant) =>
            invariant.selector === assertion.selector &&
            same(invariant.width, assertion.width) &&
            same(invariant.height, assertion.height) &&
            invariant.tolerance === assertion.tolerance,
        )
      )
        return [];
      const statement = criterion.statement.replace(/\s+/g, " ").trim();
      return [
        {
          name: `${brief.slug}: ${statement.length > 80 ? `${statement.slice(0, 79)}…` : statement}`,
          selector: assertion.selector,
          ...(assertion.width === undefined ? {} : { width: assertion.width }),
          ...(assertion.height === undefined
            ? {}
            : { height: assertion.height }),
          tolerance: assertion.tolerance,
        },
      ];
    }),
  );
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
  /** Required unless `fromBrief` names exactly one flow state. */
  state?: string | undefined;
  /** A decided brief the rejection is about. */
  fromBrief?: string | undefined;
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
  let brief: CompleteStoredBrief | undefined;
  let flowId = options.flow;
  let stateId = options.state;
  if (options.fromBrief !== undefined) {
    const stored = (
      await readBrief(validated.projectDirectory, options.fromBrief)
    ).brief;
    if (stored.status !== "decided" || !isCompleteBrief(stored))
      throw new IdiomError(
        `brief ${stored.slug} is ${stored.status}; learn from a decided brief`,
      );
    brief = stored;
    if (stateId === undefined) {
      const pair = briefState(brief, flowId);
      flowId = pair.flow;
      stateId = pair.state;
    }
  }
  if (stateId === undefined)
    throw new IdiomError(
      "pass --state, or --from-brief with a brief that names one",
    );
  const matching = validated.flows.filter(
    (record) =>
      (flowId === undefined || record.flow.id === flowId) &&
      record.flow.states.some((state) => state.id === stateId),
  );
  if (matching.length === 0)
    throw new IdiomError(
      flowId === undefined
        ? `no flow declares state ${JSON.stringify(stateId)}`
        : `flow ${JSON.stringify(flowId)} does not declare state ${JSON.stringify(stateId)}`,
    );
  if (matching.length > 1)
    throw new IdiomError(
      `state ${JSON.stringify(stateId)} is declared by ${matching.map((record) => record.flow.id).join(", ")}; pass --flow`,
    );
  const flow = matching[0];
  if (flow === undefined) throw new IdiomError("unreachable: no flow");
  const state = stateId;

  // --ruling, then a measurable reading of the words, then the brief's own
  // size criteria, then a ruling that names the brief.
  let interpretation: DraftInterpretation =
    options.ruling === true
      ? ({ kind: "ruling" } as const)
      : interpretObservation(observation);
  if (
    brief !== undefined &&
    options.ruling !== true &&
    interpretation.kind === "ruling"
  ) {
    const invariants = promotedInvariants(brief, flow, state);
    if (invariants.length > 0)
      interpretation = { kind: "brief-invariants", invariants };
  }
  const capture = await findStateCapture({
    projectDirectory: validated.projectDirectory,
    flow: flow.flow.id,
    state: state,
    viewports: [
      ...(flow.flow.viewports ?? []),
      ...validated.project.viewports.map((viewport) => viewport.name),
    ],
    colorScheme: validated.project.capture.colorScheme,
    from: options.from,
  });
  if (options.from !== undefined && capture === undefined)
    throw new IdiomError(
      `run ${options.from} has no capture of ${flow.flow.id}/${state}`,
    );
  const draft = await draftLearning({
    projectDirectory: validated.projectDirectory,
    project: validated.project,
    flow,
    state: state,
    observation,
    interpretation,
    capture,
    selectors: options.selectors,
    screenshot: options.screenshot,
    wording: options.wording,
    brief: brief?.slug,
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
      interpretation.kind === "brief-invariants"
        ? `Next: idiom check ${flow.flow.id} — the brief's size criteria are now flow invariants.`
        : draft.kind === "ruling"
          ? `Next: idiom review ${flow.flow.id} — the ruling is now design law.`
          : draft.kind === "glossary"
            ? `Next: idiom check ${flow.flow.id} — the glossary applies to the next check.`
            : `Next: idiom check ${flow.flow.id} — ${draft.kind} entries are measured at capture time, so runs captured before this change will not show it.`,
  };
}
