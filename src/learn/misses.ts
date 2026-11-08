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
} satisfies Record<Exclude<LearnedEntry["kind"], "ruling">, LearnedRule>;

export function learnedRule(entry: LearnedEntry): LearnedRule | undefined {
  return entry.kind === "ruling" ? undefined : LEARNED_RULES[entry.kind];
}

export type MissEvidence = {
  flow: string;
  state: string;
  rule: string;
  at: string;
  runId: string;
};
/** Current findings participate before their run's digest is written. */
export function findingsMissEvidence(
  findings: ReadonlyArray<{
    flow: string;
    state: string;
    rule?: string | undefined;
    createdAt: string;
  }>,
  runId: string,
): MissEvidence[] {
  return findings.flatMap((finding) =>
    finding.rule === undefined
      ? []
      : [
          {
            flow: finding.flow,
            state: finding.state,
            rule: finding.rule,
            at: finding.createdAt,
            runId,
          },
        ],
  );
}

export type MissStatus =
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
    };

export function missStatuses(
  entries: LearnedEntry[],
  evidence: MissEvidence[],
): MissStatus[] {
  return entries.map((entry) => {
    if (entry.covered)
      return { entry, status: "covered", via: "mark", ...entry.covered };
    const rule = learnedRule(entry);
    const match = evidence
      .filter(
        (item) =>
          item.flow === entry.flow &&
          item.state === entry.state &&
          rule?.matches(item.rule) &&
          Date.parse(item.at) > Date.parse(entry.recordedAt),
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
    return match === undefined
      ? { entry, status: "open" }
      : {
          entry,
          status: "covered",
          via: "run",
          rule: rule?.check ?? match.rule,
          runId: match.runId,
          at: match.at,
        };
  });
}

export async function collectMissEvidence(
  projectDirectory: string,
  entries: LearnedEntry[],
  extra: MissEvidence[] = [],
): Promise<MissEvidence[]> {
  const evidence = [...extra];
  if (!entries.some((entry) => !entry.covered && learnedRule(entry)))
    return evidence;
  const reports = join(projectDirectory, ".idiom", "reports");
  // Inspect all runs to retain the earliest matching evidence, even though
  // capture directory names need not agree with finding timestamps.
  for (const runId of await storedRunsNewestFirst(reports)) {
    const directory = join(reports, runId);
    try {
      const items: unknown = JSON.parse(
        await readFile(join(directory, "findings.json"), "utf8"),
      );
      if (Array.isArray(items))
        for (const item of items) {
          if (
            item &&
            typeof item.flow === "string" &&
            typeof item.state === "string" &&
            typeof item.rule === "string" &&
            typeof item.createdAt === "string" &&
            Number.isFinite(Date.parse(item.createdAt))
          )
            evidence.push({
              flow: item.flow,
              state: item.state,
              rule: item.rule,
              at: item.createdAt,
              runId,
            });
        }
    } catch {
      /* Unreadable historical findings never break a current check. */
    }
    const record = await readDigestRecord(directory);
    if (record)
      for (const item of record.occurrences) {
        if (item.rule)
          evidence.push({
            flow: record.flow,
            state: item.state,
            rule: item.rule,
            at: record.completedAt,
            runId,
          });
      }
  }
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
