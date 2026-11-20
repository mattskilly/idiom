import { copyFile, mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { briefEligibility } from "../brief/assertions.js";
import { readBrief } from "../brief/store.js";
import { IdiomError } from "../errors.js";
import { findStateCapture, type StateCapture } from "../learn/capture.js";
import {
  type DraftInterpretation,
  draftLearning,
  nextLearnedId,
  type PromotedInvariant,
} from "../learn/draft.js";
import { interpretObservation } from "../learn/interpret.js";
import { type Placement, placeObservation } from "../learn/place.js";
import type { BrowserLaunch } from "../learn/target.js";
import { atomicWrite } from "../learn/write.js";
import { persistRulingNames } from "../rulings/names.js";
import type { RulingConfirmation } from "../rulings/record.js";
import { type CompleteStoredBrief, isCompleteBrief } from "../schemas/brief.js";
import type { SizeInvariant } from "../schemas/invariant.js";
import type {
  LearnedEntry,
  LearnedKind,
  LearnedPlacement,
} from "../schemas/learned.js";
import { type FlowRecord, validateProject } from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";
import type { HarvestDependencies } from "./learn-harvest.js";

export type LearnDependencies = {
  confirm?: RulingConfirmation | undefined;
  clock?: (() => Date) | undefined;
  gitTopology?: GitTopology | undefined;
  launch?: BrowserLaunch | undefined;
  /** The `ab` and `gh` readers `learn --harvest` uses. */
  harvest?: HarvestDependencies | undefined;
};

export type LearnResult =
  | { recorded: false }
  | {
      recorded: true;
      kind: LearnedKind;
      id: string;
      paths: string[];
      next: string;
      /** How the flow state was found. */
      placement: LearnedPlacement;
      /** The draft flow state written when no state matched. */
      proposal?: string | undefined;
      /** The line written to `.idiom/learned.jsonl`. */
      entry: LearnedEntry;
    };

export async function defaultConfirmation(): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question("Apply this learning? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

export { atomicWrite };

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
    (invariant): invariant is SizeInvariant =>
      "selector" in invariant && !("share" in invariant),
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
  /**
   * The flow state the miss was seen on. Without it (and without a brief
   * that names one), the state is matched from `screenshot` or the words,
   * else proposed as a draft state.
   */
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
  // No state named: find it from the screenshot or the words, else propose
  // a draft state. Never fails for want of a state.
  let placed: Placement | undefined;
  let learnedId: string | undefined;
  if (stateId === undefined) {
    learnedId = await nextLearnedId(validated.projectDirectory);
    placed = await placeObservation({
      projectDirectory: validated.projectDirectory,
      flows: validated.flows,
      flowId,
      observation,
      screenshot: options.screenshot,
      from: options.from,
      learnedId,
    });
    if (placed.ambiguous !== undefined)
      throw new IdiomError(placed.ambiguous.message);
    options.write?.((placed.matched ?? placed.proposed).message);
  }
  const placement: LearnedPlacement =
    placed?.matched !== undefined
      ? placed.matched.placement
      : placed?.proposed !== undefined
        ? placed.proposed.placement
        : { via: options.state === undefined ? "brief" : "state" };

  // --ruling, then a measurable reading of the words, then the brief's own
  // size criteria, then a ruling that names the brief.
  let interpretation: DraftInterpretation =
    options.ruling === true
      ? ({ kind: "ruling" } as const)
      : interpretObservation(observation);
  const recordedAt = (
    options.dependencies?.clock ?? (() => new Date())
  )().toISOString();

  const proposed = placed?.proposed;
  let draft: Awaited<ReturnType<typeof draftLearning>>;
  let flowLabel: string;
  if (proposed !== undefined) {
    // Config that works project-wide still applies; what needs the state or
    // its DOM waits as an observation against the proposal.
    const given = (options.selectors ?? []).length;
    const projectWide =
      interpretation.kind === "glossary" ||
      interpretation.kind === "ruling" ||
      (interpretation.kind === "component" && given > 0) ||
      (interpretation.kind === "mirrored" && given > 0) ||
      (interpretation.kind === "law" &&
        (interpretation.law.scope?.selector !== undefined ||
          interpretation.law.scope === undefined ||
          given > 0));
    flowLabel = proposed.flowId;
    draft = await draftLearning({
      projectDirectory: validated.projectDirectory,
      project: validated.project,
      flow: proposed.flow,
      flowId: proposed.flowId,
      state: proposed.stateId,
      id: learnedId,
      placement,
      proposal: proposed.proposal,
      asObservation: !projectWide,
      observation,
      interpretation,
      selectors: options.selectors,
      screenshot: options.screenshot,
      wording: options.wording,
      recordedAt,
      launch: options.dependencies?.launch,
      gitTopology: options.dependencies?.gitTopology,
    });
  } else {
    let flow: FlowRecord;
    let state: string;
    if (placed?.matched !== undefined) {
      flow = placed.matched.flow;
      state = placed.matched.state;
    } else {
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
      const only = matching[0];
      if (only === undefined || stateId === undefined)
        throw new IdiomError("unreachable: no flow");
      flow = only;
      state = stateId;
    }
    flowLabel = flow.flow.id;
    if (
      brief !== undefined &&
      options.ruling !== true &&
      interpretation.kind === "ruling"
    ) {
      const invariants = promotedInvariants(brief, flow, state);
      if (invariants.length > 0)
        interpretation = { kind: "brief-invariants", invariants };
    }
    // The capture the screenshot matched, else the newest of the state.
    const capture: StateCapture | undefined =
      placed?.matched?.capture ??
      (await findStateCapture({
        projectDirectory: validated.projectDirectory,
        flow: flow.flow.id,
        state: state,
        viewports: [
          ...(flow.flow.viewports ?? []),
          ...validated.project.viewports.map((viewport) => viewport.name),
        ],
        colorScheme: validated.project.capture.colorScheme,
        from: options.from,
      }));
    if (options.from !== undefined && capture === undefined)
      throw new IdiomError(
        `run ${options.from} has no capture of ${flow.flow.id}/${state}`,
      );
    // A law scoped to a surface outside the vocabulary needs a selector:
    // given, or resolved from the capture. Without either it stays a ruling.
    if (
      interpretation.kind === "law" &&
      interpretation.law.scope !== undefined &&
      interpretation.law.scope.selector === undefined &&
      (options.selectors ?? []).length === 0 &&
      capture === undefined
    )
      interpretation = {
        kind: "ruling",
        notCompiled: `no selector for "${interpretation.law.scope.surface}"; pass --selector to compile it`,
      };
    draft = await draftLearning({
      projectDirectory: validated.projectDirectory,
      project: validated.project,
      flow,
      state: state,
      id: learnedId,
      placement,
      observation,
      interpretation,
      capture,
      selectors: options.selectors,
      screenshot: options.screenshot,
      wording: options.wording,
      brief: brief?.slug,
      recordedAt,
      launch: options.dependencies?.launch,
      gitTopology: options.dependencies?.gitTopology,
    });
  }
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
    placement,
    entry: draft.entry,
    ...(proposed === undefined
      ? {}
      : { proposal: proposed.proposal.displayPath }),
    next:
      proposed !== undefined
        ? proposed.flow === undefined
          ? `Next: add the draft state in ${proposed.proposal.displayPath} to a flow, then idiom capture it.`
          : `Next: add the draft state in ${proposed.proposal.displayPath} to ${relative(validated.projectDirectory, proposed.flow.file)}, then idiom capture ${flowLabel}.`
        : interpretation.kind === "brief-invariants"
          ? `Next: idiom check ${flowLabel} — the brief's size criteria are now flow invariants.`
          : interpretation.kind === "law"
            ? `Next: idiom check ${flowLabel} — ${interpretation.law.check} enforces it from the next capture.`
            : draft.kind === "ruling"
              ? `Next: idiom review ${flowLabel} — the ruling is now design law.`
              : draft.kind === "glossary"
                ? `Next: idiom check ${flowLabel} — the glossary applies to the next check.`
                : `Next: idiom check ${flowLabel} — ${draft.kind} entries are measured at capture time, so runs captured before this change will not show it.`,
  };
}
