import type { HumanFoundSummary } from "./misses-summary.js";

export {
  type HumanFoundSummary,
  humanFoundLine,
  relativeAge,
} from "./misses-summary.js";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDigestRecord } from "../digest/record.js";
import { IdiomError } from "../errors.js";
import { noteUnknownRecord } from "../records/unknown.js";
import { storedRunsNewestFirst } from "../review/artifacts.js";
import {
  type LearnedEntry,
  learnedEntrySchema,
  learnedKinds,
} from "../schemas/learned.js";
import { compileLaw } from "./law.js";

/**
 * The kind a newer Idiom wrote, when this version doesn't know it and the
 * entry still carries its identity (version 1, a learned-N id).
 */
export function unknownLearnedKind(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !/^learned-[1-9]\d*$/.test(record.id) ||
    typeof record.kind !== "string" ||
    (learnedKinds as readonly string[]).includes(record.kind)
  )
    return undefined;
  return record.kind;
}

export async function readLearnedLog(
  projectDirectory: string,
  options: { strict?: boolean | undefined } = {},
): Promise<LearnedEntry[]> {
  const path = join(projectDirectory, ".idiom", "learned.jsonl");
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content.split("\n").flatMap((line, index) => {
    if (line.trim() === "") return [];
    try {
      const value: unknown = JSON.parse(line);
      const kind = unknownLearnedKind(value);
      if (kind !== undefined) {
        noteUnknownRecord({
          family: "learned",
          path,
          line: index + 1,
          type: kind,
        });
        return [];
      }
      return [learnedEntrySchema.parse(value)];
    } catch {
      if (options.strict)
        throw new IdiomError(`invalid .idiom/learned.jsonl line ${index + 1}`);
      return [];
    }
  });
}

type LearnedRule = { check: string; matches: (rule: string) => boolean };
export const LEARNED_RULES = {
  component: {
    check: "component-size",
    matches: (rule: string) => rule === "idiom:component-size-mismatch",
  },
  invariant: {
    check: "layout-invariants",
    matches: (rule: string) => rule.startsWith("idiom:layout-invariants:"),
  },
  glossary: {
    check: "copy-lint",
    matches: (rule: string) => rule === "idiom:glossary-term",
  },
  mirrored: {
    check: "mirrored-control",
    matches: (rule: string) => rule === "idiom:mirrored-asymmetry",
  },
} satisfies Record<
  Exclude<LearnedEntry["kind"], "ruling" | "observation" | "law">,
  LearnedRule
>;

function lawCheck(observation: string): string | undefined {
  const compiled = compileLaw(observation);
  return compiled !== undefined && "law" in compiled
    ? compiled.law.check
    : undefined;
}

/** The rules each check a learned law can configure reports. */
const LAW_RULES: Record<string, LearnedRule> = {
  "control-gap": {
    check: "control-gap",
    matches: (rule: string) => rule === "idiom:control-gap",
  },
  "negative-spacing": {
    check: "negative-spacing",
    matches: (rule: string) => rule === "idiom:negative-spacing",
  },
  "text-centering": {
    check: "text-centering",
    matches: (rule: string) => rule === "idiom:label-off-centre",
  },
  "layout-invariants": LEARNED_RULES.invariant,
};

/**
 * The check that covers an entry. An `observation` (recorded before its state
 * existed) is covered by the check its candidate rule would become.
 */
export function learnedRule(entry: LearnedEntry): LearnedRule | undefined {
  const kind =
    entry.kind === "observation" ? entry.candidate?.kind : entry.kind;
  if (kind === undefined || kind === "ruling") return undefined;
  if (kind === "law") {
    const check =
      entry.target.check ??
      (entry.kind === "observation" ? lawCheck(entry.observation) : undefined);
    return check === undefined ? undefined : LAW_RULES[check];
  }
  return LEARNED_RULES[kind];
}

export type MissEvidence = {
  flow: string;
  state: string;
  /** The finding's rule; blank when it carries only a category. */
  rule: string;
  /** The check that produced the finding (its category), when known. */
  category?: string | undefined;
  at: string;
  runId: string;
};
/** Current findings participate before their run's digest is written. */
export function findingsMissEvidence(
  findings: ReadonlyArray<{
    flow: string;
    state: string;
    rule?: string | undefined;
    category?: string | undefined;
    createdAt: string;
  }>,
  runId: string,
): MissEvidence[] {
  return findings.flatMap((finding) =>
    finding.rule === undefined && finding.category === undefined
      ? []
      : [
          {
            flow: finding.flow,
            state: finding.state,
            rule: finding.rule ?? "",
            ...(finding.category === undefined
              ? {}
              : { category: finding.category }),
            at: finding.createdAt,
            runId,
          },
        ],
  );
}

/**
 * Whether one piece of evidence catches an entry: a rule its learned kind
 * matches, or a finding category among the checks its imported row names.
 */
export function evidenceCatches(
  entry: LearnedEntry,
  item: Pick<MissEvidence, "rule" | "category">,
): string | undefined {
  const rule = learnedRule(entry);
  if (item.rule !== "" && rule?.matches(item.rule)) return rule.check;
  if (
    item.category !== undefined &&
    entry.import?.checks.includes(item.category)
  )
    return item.category;
  return undefined;
}

/** Whether an entry can be covered by run evidence at all. */
const runCoverable = (entry: LearnedEntry) =>
  learnedRule(entry) !== undefined || (entry.import?.checks.length ?? 0) > 0;

/** What covers a miss: nothing yet, a rule, or a regression fixture. */
export type MissCoverage = "open" | "rule" | "fixture";
/** Whether the miss's flow state is declared, or only proposed. */
export type MissState = "matched" | "proposed";

export type MissStatus = { coverage: MissCoverage; state: MissState } & (
  | { entry: LearnedEntry; status: "open" }
  | {
      entry: LearnedEntry;
      status: "covered";
      via: "mark";
      by: string;
      at: string;
    }
  | {
      entry: LearnedEntry;
      status: "covered";
      via: "run";
      rule: string;
      runId: string;
      at: string;
    }
);

/**
 * A `--covered` mark names a fixture when it reads as a path (a slash, or a
 * file extension) or is the word "fixture"; anything else names a rule.
 */
export function markCoverage(by: string): "rule" | "fixture" {
  const value = by.trim();
  return /[/\\]/.test(value) ||
    /\.[A-Za-z0-9]{1,8}$/.test(value) ||
    /^fixtures?$/i.test(value)
    ? "fixture"
    : "rule";
}

/**
 * The flow state a miss names is `proposed` while its draft state is not yet
 * declared, and `matched` otherwise (records from before placement included).
 */
function missState(
  entry: LearnedEntry,
  declared: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): MissState {
  if (entry.placement?.via !== "proposed") return "matched";
  return declared?.get(entry.flow)?.has(entry.state) === true
    ? "matched"
    : "proposed";
}

export function missStatuses(
  entries: LearnedEntry[],
  evidence: MissEvidence[],
  declared?: ReadonlyMap<string, ReadonlySet<string>>,
): MissStatus[] {
  return entries.map((entry) => {
    const state = missState(entry, declared);
    if (entry.covered)
      return {
        entry,
        status: "covered",
        via: "mark",
        ...entry.covered,
        coverage: markCoverage(entry.covered.by),
        state,
      };
    const match = evidence
      .filter(
        (item) =>
          item.flow === entry.flow &&
          item.state === entry.state &&
          evidenceCatches(entry, item) !== undefined &&
          Date.parse(item.at) > Date.parse(entry.recordedAt),
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    return match === undefined
      ? { entry, status: "open", coverage: "open", state }
      : {
          entry,
          status: "covered",
          via: "run",
          rule: evidenceCatches(entry, match) ?? match.rule,
          runId: match.runId,
          at: match.at,
          coverage: "rule",
          state,
        };
  });
}

/**
 * The evidence one stored run carries: its `findings.json` items and its
 * digest occurrences, each with its rule and category.
 */
export async function runEvidence(
  runDirectory: string,
  runId: string,
): Promise<MissEvidence[]> {
  const evidence: MissEvidence[] = [];
  try {
    const items: unknown = JSON.parse(
      await readFile(join(runDirectory, "findings.json"), "utf8"),
    );
    if (Array.isArray(items))
      for (const item of items) {
        const rule = typeof item?.rule === "string" ? item.rule : undefined;
        const category =
          typeof item?.category === "string" ? item.category : undefined;
        if (
          item &&
          typeof item.flow === "string" &&
          typeof item.state === "string" &&
          (rule !== undefined || category !== undefined) &&
          typeof item.createdAt === "string" &&
          Number.isFinite(Date.parse(item.createdAt))
        )
          evidence.push({
            flow: item.flow,
            state: item.state,
            rule: rule ?? "",
            ...(category === undefined ? {} : { category }),
            at: item.createdAt,
            runId,
          });
      }
  } catch {
    /* Unreadable historical findings never break a current check. */
  }
  const record = await readDigestRecord(runDirectory);
  if (record)
    for (const item of record.occurrences) {
      if (item.rule || item.category)
        evidence.push({
          flow: record.flow,
          state: item.state,
          rule: item.rule ?? "",
          ...(item.category ? { category: item.category } : {}),
          at: record.completedAt,
          runId,
        });
    }
  return evidence;
}

export async function collectMissEvidence(
  projectDirectory: string,
  entries: LearnedEntry[],
  extra: MissEvidence[] = [],
): Promise<MissEvidence[]> {
  const evidence = [...extra];
  if (!entries.some((entry) => !entry.covered && runCoverable(entry)))
    return evidence;
  const reports = join(projectDirectory, ".idiom", "reports");
  // Inspect all runs to retain the earliest matching evidence, even though
  // capture directory names need not agree with finding timestamps.
  for (const runId of await storedRunsNewestFirst(reports))
    evidence.push(...(await runEvidence(join(reports, runId), runId)));
  return evidence;
}

export function summarizeStatuses(
  statuses: MissStatus[],
): HumanFoundSummary | undefined {
  if (statuses.length === 0) return undefined;
  const open = statuses.filter((status) => status.status === "open");
  return {
    logged: statuses.length,
    covered: statuses.length - open.length,
    coveredByRun: statuses.filter(
      (status) => status.status === "covered" && status.via === "run",
    ).length,
    coveredByMark: statuses.filter(
      (status) => status.status === "covered" && status.via === "mark",
    ).length,
    open: open.length,
    latest: statuses
      .map(({ entry }) => entry.recordedAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] as string,
    openEntries: open.map(({ entry }) => ({
      id: entry.id,
      flow: entry.flow,
      state: entry.state,
      kind: entry.kind,
      observation: entry.observation,
      recordedAt: entry.recordedAt,
      ...(entry.target.selector === undefined
        ? {}
        : { selector: entry.target.selector }),
    })),
  };
}

export async function summarizeMisses(options: {
  projectDirectory: string;
  extra?: MissEvidence[] | undefined;
  strict?: boolean | undefined;
}): Promise<HumanFoundSummary | undefined> {
  const entries = await readLearnedLog(options.projectDirectory, {
    strict: options.strict,
  });
  return summarizeStatuses(
    missStatuses(
      entries,
      await collectMissEvidence(
        options.projectDirectory,
        entries,
        options.extra,
      ),
    ),
  );
}
