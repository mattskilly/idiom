import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SummaryFinding } from "../../baseline/summary.js";
import { readGit } from "../../changed/git.js";
import type { CheckSummary } from "../../commands/check.js";
import { acceptanceText } from "../../findings/presentation.js";
import { blockingFindings, type FailOn } from "./blocking.js";
import { measuredValue, suggestedFix } from "./fix.js";
import { keptRound, roundOutcome, roundProgress } from "./progress.js";
import { rankFindingIds } from "./rank.js";
import {
  renderHandoffMarkdown,
  renderSummary,
  renderTranscript,
} from "./render.js";
import { findingSelector } from "./selector.js";
import {
  type HandoffFinding,
  type HandoffNext,
  type HandoffOutcome,
  type HandoffRound,
  MAX_REPAIR_ROUNDS,
  TARGETS_PER_ROUND,
} from "./types.js";
import {
  type DirectorSources,
  directorWords,
  loadDirectorSources,
} from "./words.js";

const severityOrder: Record<string, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/** The `handoff` field `check --gate --json` adds when `--handoff` is given. */
export type HandoffJson = {
  dir: string;
  round: number;
  next: HandoffNext;
  targets: number;
  /** Re-verify rounds: keep (commit) or revert the edits this round judged. */
  outcome?: HandoffOutcome;
  /** The round whose handoff the next repair works from. */
  repairFrom?: number;
  summaryPath: string;
};

async function readRounds(dir: string): Promise<HandoffRound[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const numbers = names
    .flatMap((name) => /^round-(\d+)$/.exec(name)?.[1] ?? [])
    .map(Number)
    .sort((a, b) => a - b);
  const rounds: HandoffRound[] = [];
  for (const number of numbers) {
    try {
      rounds.push(
        JSON.parse(
          await readFile(join(dir, `round-${number}`, "handoff.json"), "utf8"),
        ) as HandoffRound,
      );
    } catch {
      /* A round directory without a readable handoff is not a round. */
    }
  }
  return rounds;
}

async function readEdits(
  dir: string,
  rounds: HandoffRound[],
): Promise<Map<number, string>> {
  const edits = new Map<number, string>();
  for (const round of rounds) {
    try {
      edits.set(
        round.round,
        await readFile(join(dir, `round-${round.round}`, "edits.md"), "utf8"),
      );
    } catch {
      /* No edits recorded for this round. */
    }
  }
  return edits;
}

function parseWhere(where: string) {
  const [state = "", viewport = "", colorScheme] =
    where.split("#")[0]?.split("/") ?? [];
  return { state, viewport, colorScheme };
}

function handoffFinding(options: {
  flow: string;
  finding: SummaryFinding;
  summary: CheckSummary;
  sources: DirectorSources;
}): Omit<HandoffFinding, "rank" | "crops"> & { crop?: string | undefined } {
  const { finding, flow } = options;
  const { state, viewport, colorScheme } = parseWhere(finding.where);
  const selector = findingSelector(finding);
  const measuredSummary =
    finding.basisDetails?.summary ?? finding.problem ?? "";
  const rule = finding.rule ?? "";
  const rootCause = options.summary.issues?.find((issue) =>
    issue.rootCause?.symptoms.some((symptom) =>
      symptom.findings.some((item) => item.id === finding.id),
    ),
  )?.rootCause;
  const doneWhen = finding.fix.length
    ? finding.fix
    : finding.acceptance === undefined
      ? []
      : acceptanceText({ acceptance: finding.acceptance });
  return {
    id: finding.id,
    ...(finding.fingerprint === undefined
      ? {}
      : { fingerprint: finding.fingerprint }),
    key: finding.where,
    flow,
    state,
    viewport,
    ...(colorScheme === undefined ? {} : { colorScheme }),
    severity: finding.severity,
    rule,
    category: finding.category,
    selector,
    measured: {
      summary: measuredSummary,
      ...(() => {
        const value = measuredValue(finding.basisDetails, measuredSummary);
        return value === undefined ? {} : { value };
      })(),
    },
    words: directorWords(
      {
        id: finding.id,
        flow,
        state,
        rule,
        category: finding.category,
        fingerprint: finding.fingerprint,
        explanation: `${finding.problem} ${measuredSummary}`,
      },
      options.sources,
    ),
    suggestedFix: suggestedFix({
      category: finding.category,
      selector,
      basisDetails: finding.basisDetails,
      summary: measuredSummary,
      doneWhen,
      rootCauseFix: rootCause?.fix,
    }),
    doneWhen,
    crop: finding.screenshot,
  };
}

export type WriteHandoffOptions = {
  dir: string;
  cwd: string;
  projectDirectory: string;
  designFile?: string | undefined;
  base: string;
  head?: string | undefined;
  failOn: FailOn;
  failOnJudged?: boolean | undefined;
  decisionIds?: ReadonlySet<string> | undefined;
  /** Each checked flow's summary, in flow order; absent when the gate skipped. */
  checked?: ReadonlyArray<{ flow: string; summary: CheckSummary }> | undefined;
  skipLine?: string | undefined;
  totalMs: number;
};

/**
 * Write one round of the fix step's handoff under `dir`, then rewrite the
 * summary and transcript from every round. Never writes outside `dir`.
 */
export async function writeHandoffRound(
  options: WriteHandoffOptions,
): Promise<{ round: HandoffRound; json: HandoffJson }> {
  const dir = resolve(options.cwd, options.dir);
  const previous = await readRounds(dir);
  const number =
    options.checked === undefined
      ? 0
      : previous.length === 0
        ? 0
        : Math.max(...previous.map((round) => round.round)) + 1;
  const head =
    options.head ??
    (await readGit(options.cwd, ["rev-parse", "HEAD"])
      .then((value) => value.trim())
      .catch(() => "HEAD"));
  const roundDir = join(dir, `round-${number}`);
  await mkdir(roundDir, { recursive: true });
  let round: HandoffRound;
  if (options.checked === undefined) {
    round = {
      version: 1,
      round: number,
      base: options.base,
      head,
      next: "skip",
      targets: [],
      remaining: [],
      ...(options.skipLine === undefined ? {} : { line: options.skipLine }),
      timing: { totalMs: Math.round(options.totalMs) },
    };
  } else {
    const sources = await loadDirectorSources(
      options.projectDirectory,
      options.designFile,
    );
    const blocking = blockingFindings(options.checked, options);
    const flowOrder = options.checked.map((entry) => entry.flow);
    const ranked: Array<{ flow: string; finding: SummaryFinding }> = [];
    for (const entry of options.checked) {
      const ids = blocking
        .filter((item) => item.flow === entry.flow)
        .map((item) => item.finding.id);
      for (const id of rankFindingIds(entry.summary, ids, TARGETS_PER_ROUND)) {
        const found = blocking.find(
          (item) => item.flow === entry.flow && item.finding.id === id,
        );
        if (found) ranked.push(found);
      }
    }
    const bySeverity = (
      left: { flow: string; finding: SummaryFinding },
      right: { flow: string; finding: SummaryFinding },
    ) =>
      (severityOrder[left.finding.severity] ?? 9) -
        (severityOrder[right.finding.severity] ?? 9) ||
      flowOrder.indexOf(left.flow) - flowOrder.indexOf(right.flow);
    const merged = ranked
      .map((item, index) => ({ item, index }))
      .sort((a, b) => bySeverity(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
    const targets = merged.slice(0, TARGETS_PER_ROUND);
    const rest = blocking
      .filter((item) => !targets.includes(item))
      .map((item, index) => ({ item, index }))
      .sort((a, b) => bySeverity(a.item, b.item) || a.index - b.index)
      .map(({ item }) => item);
    const summaryOf = (flow: string) =>
      options.checked?.find((entry) => entry.flow === flow)
        ?.summary as CheckSummary;
    await mkdir(join(roundDir, "crops"), { recursive: true });
    const build = async (
      items: Array<{ flow: string; finding: SummaryFinding }>,
      offset: number,
      copyCrops: boolean,
    ) => {
      const out: HandoffFinding[] = [];
      for (const [index, item] of items.entries()) {
        const { crop, ...finding } = handoffFinding({
          ...item,
          summary: summaryOf(item.flow),
          sources,
        });
        const crops: string[] = [];
        if (copyCrops && crop !== undefined) {
          const name = `${finding.id}-${basename(crop)}`;
          try {
            await copyFile(
              resolve(options.cwd, crop),
              join(roundDir, "crops", name),
            );
            crops.push(`round-${number}/crops/${name}`);
          } catch {
            /* A missing crop leaves the finding without an image. */
          }
        }
        out.push({ rank: offset + index + 1, ...finding, crops });
      }
      return out;
    };
    const targetFindings = await build(targets, 0, true);
    const remaining = await build(rest, targets.length, false);
    const next: HandoffNext =
      blocking.length === 0
        ? "pass"
        : number < MAX_REPAIR_ROUNDS
          ? "repair"
          : "stop";
    // Compare with the last round that still describes HEAD: a reverted
    // round's edits are gone, so its findings are not the baseline.
    const last = previous.filter(keptRound).at(-1);
    const progress =
      last === undefined
        ? undefined
        : roundProgress(
            {
              targets: last.targets,
              blocking: [...last.targets, ...last.remaining],
            },
            [...targetFindings, ...remaining],
          );
    const outcome =
      progress === undefined
        ? undefined
        : roundOutcome(progress, blocking.length);
    round = {
      version: 1,
      round: number,
      base: options.base,
      head,
      next,
      targets: targetFindings,
      remaining,
      ...(progress === undefined ? {} : { progress }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(last === undefined
        ? {}
        : {
            repairFrom: outcome === "revert" ? last.round : number,
          }),
      timing: { totalMs: Math.round(options.totalMs) },
    };
  }
  await writeFile(
    join(roundDir, "handoff.json"),
    `${JSON.stringify(round, null, 2)}\n`,
  );
  await writeFile(join(roundDir, "handoff.md"), renderHandoffMarkdown(round));
  const rounds = [
    ...previous.filter((item) => item.round !== round.round),
    round,
  ].sort((a, b) => a.round - b.round);
  const summaryPath = join(dir, "summary.md");
  await writeFile(summaryPath, renderSummary(rounds));
  await writeFile(
    join(dir, "transcript.md"),
    renderTranscript(rounds, await readEdits(dir, rounds)),
  );
  return {
    round,
    json: {
      dir: options.dir,
      round: round.round,
      next: round.next,
      targets: round.targets.length,
      ...(round.outcome === undefined ? {} : { outcome: round.outcome }),
      ...(round.repairFrom === undefined
        ? {}
        : { repairFrom: round.repairFrom }),
      summaryPath: join(options.dir, "summary.md"),
    },
  };
}
