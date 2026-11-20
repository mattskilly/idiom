import type { IdentifiedDecision } from "../decisions/attribution.js";
import type { DigestOccurrence, DigestRecord } from "../digest/record.js";
import type { LedgerEntry } from "../nightly/ledger.js";
import type { LearnedEntry } from "../schemas/learned.js";
import { type MatchVia, matchEntry, type ProblemOccurrence } from "./match.js";
import { isoWeek, parseRecordDate, type Week, weekOf } from "./weeks.js";

export const UNRECORDED = "unrecorded";

/** One UI problem as Idiom recorded it: a digest occurrence group. */
export type IdiomProblem = {
  key: string;
  flow: string;
  category: string;
  /** Earliest stored run or filed ticket that names it, epoch ms. */
  firstSeen: number;
  /** The run (or `ticket:<id>`) it was first seen in. */
  firstSeenIn: string;
  occurrences: ProblemOccurrence[];
  ids: Set<string>;
  fingerprints: Set<string>;
};

export type Breakdown = { name: string; idiom: number; director: number };

export type FoundCounts = {
  idiom: number;
  director: number;
  total: number;
  /** director / total; null when nothing was found. */
  directorShare: number | null;
  byCategory: Breakdown[];
  bySurface: Breakdown[];
};

export type AcceptanceCounts = {
  accepted: number;
  rejected: number;
  acknowledged: number;
  /** accepted + rejected: the rate's denominator. */
  n: number;
  /** accepted / n; null when n is 0. */
  rate: number | null;
  /** Agent decisions in the period, left out of every count above. */
  agentExcluded: number;
};

type WeekBounds = { week: string; start: string; end: string };
export type ScorecardWeek = WeekBounds & FoundCounts;
export type AcceptanceWeek = WeekBounds & AcceptanceCounts;

export type ScorecardPair = {
  learned: string;
  problem: string;
  flow: string;
  state: string;
  via: MatchVia;
  detail: string;
  foundBy: "idiom" | "director";
  week: string;
};

export type ScorecardSources = {
  runs: number;
  runRoots: string[];
  oldestRun?: string;
  ledgerEntries: number;
  learned: number;
  undated: number;
  decisions: number;
};

export type Scorecard = {
  window: {
    from: string;
    to: string;
    start: string;
    end: string;
    weeks: string[];
  };
  weeks: ScorecardWeek[];
  overall: FoundCounts;
  acceptance: { weeks: AcceptanceWeek[]; overall: AcceptanceCounts };
  pairs?: ScorecardPair[];
  sources: ScorecardSources;
  notes: string[];
};

export type ScorecardInput = {
  runs: readonly DigestRecord[];
  runRoots: readonly string[];
  ledger: readonly LedgerEntry[];
  learned: readonly LearnedEntry[];
  decisions: readonly IdentifiedDecision[];
  flowSurfaces: ReadonlyMap<string, string>;
  window: readonly Week[];
  verbose?: boolean | undefined;
};

/** Coverage problems (failed tuples, unmet expectations) are not UI problems. */
export function isCoverageOccurrence(occurrence: DigestOccurrence): boolean {
  return (
    occurrence.coverageOnly === true ||
    occurrence.rule?.startsWith("idiom:expectation-") === true ||
    occurrence.rule?.startsWith("idiom:tuple-failure:") === true
  );
}

/**
 * Fold stored runs and the filing ledger into Idiom problems: one per flow and
 * occurrence group (`groupKey`, else fingerprint), first seen at the earliest
 * run or filed ticket naming it. A ledger entry naming no stored occurrence is
 * its own problem, so findings whose runs are gone still count.
 */
export function foldIdiomProblems(
  runs: readonly DigestRecord[],
  ledger: readonly LedgerEntry[],
): IdiomProblem[] {
  const problems = new Map<string, IdiomProblem>();
  const seenRuns = new Set<string>();
  for (const run of runs) {
    if (seenRuns.has(run.runId)) continue;
    seenRuns.add(run.runId);
    const completed = Date.parse(run.completedAt);
    if (!Number.isFinite(completed)) continue;
    for (const occurrence of run.occurrences) {
      if (isCoverageOccurrence(occurrence)) continue;
      const key = `${run.flow}\0${occurrence.groupKey ?? occurrence.fingerprint}`;
      let problem = problems.get(key);
      if (problem === undefined) {
        problem = {
          key,
          flow: run.flow,
          category: occurrence.category,
          firstSeen: completed,
          firstSeenIn: run.runId,
          occurrences: [],
          ids: new Set(),
          fingerprints: new Set(),
        };
        problems.set(key, problem);
      } else if (completed < problem.firstSeen) {
        problem.firstSeen = completed;
        problem.firstSeenIn = run.runId;
        problem.category = occurrence.category;
      }
      problem.occurrences.push({
        state: occurrence.state,
        rule: occurrence.rule,
        category: occurrence.category,
        groupKey: occurrence.groupKey,
        problem: occurrence.problem,
      });
      problem.ids.add(occurrence.id);
      problem.fingerprints.add(occurrence.fingerprint);
    }
  }
  const stored = [...problems.values()];
  for (const entry of ledger) {
    const filed = Date.parse(entry.filedAt);
    if (!Number.isFinite(filed)) continue;
    const ids = new Set(entry.findingIds);
    const fingerprints = new Set(entry.fingerprints);
    const named = stored.filter(
      (problem) =>
        [...problem.ids].some((id) => ids.has(id)) ||
        [...problem.fingerprints].some((print) => fingerprints.has(print)),
    );
    for (const problem of named)
      if (filed < problem.firstSeen) {
        problem.firstSeen = filed;
        problem.firstSeenIn = `ticket:${entry.ticket}`;
      }
    if (named.length > 0) continue;
    const key = `ticket\0${entry.sink}:${entry.ticket}`;
    if (problems.has(key)) continue;
    problems.set(key, {
      key,
      flow: entry.flows[0] ?? UNRECORDED,
      category: UNRECORDED,
      firstSeen: filed,
      firstSeenIn: `ticket:${entry.ticket}`,
      occurrences: [],
      ids: ids,
      fingerprints,
    });
  }
  return [...problems.values()];
}

/** When the director found a learned entry, or undefined when undated. */
export function learnedDate(
  entry: LearnedEntry,
): { at: number; dayOnly: boolean } | undefined {
  if (entry.import !== undefined) return parseRecordDate(entry.import.date);
  return (
    parseRecordDate(entry.harvest?.at) ?? parseRecordDate(entry.recordedAt)
  );
}

function learnedCategory(entry: LearnedEntry): string {
  return entry.import?.category ?? entry.harvest?.categories[0] ?? UNRECORDED;
}

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }
  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    let node = index;
    while (this.parent[node] !== root) {
      const next = this.parent[node] as number;
      this.parent[node] = root;
      node = next;
    }
    return root;
  }
  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent[Math.max(a, b)] = Math.min(a, b);
  }
}

type Found = {
  foundBy: "idiom" | "director";
  at: number;
  category: string;
  surface: string;
};

function emptyFound(): FoundCounts {
  return {
    idiom: 0,
    director: 0,
    total: 0,
    directorShare: null,
    byCategory: [],
    bySurface: [],
  };
}

function tally(found: readonly Found[]): FoundCounts {
  if (found.length === 0) return emptyFound();
  const breakdown = (pick: (item: Found) => string): Breakdown[] => {
    const rows = new Map<string, Breakdown>();
    for (const item of found) {
      const name = pick(item);
      const row = rows.get(name) ?? { name, idiom: 0, director: 0 };
      row[item.foundBy] += 1;
      rows.set(name, row);
    }
    return [...rows.values()].sort(
      (left, right) =>
        Number(left.name === UNRECORDED) - Number(right.name === UNRECORDED) ||
        right.idiom + right.director - (left.idiom + left.director) ||
        left.name.localeCompare(right.name),
    );
  };
  const director = found.filter((item) => item.foundBy === "director").length;
  return {
    idiom: found.length - director,
    director,
    total: found.length,
    directorShare: director / found.length,
    byCategory: breakdown((item) => item.category),
    bySurface: breakdown((item) => item.surface),
  };
}

type AcceptanceKind = "accept" | "reject" | "acknowledge";

function acceptance(
  decisions: readonly { finding: string; kind: AcceptanceKind }[],
  agentExcluded: number,
): AcceptanceCounts {
  const last = new Map<string, AcceptanceKind>();
  for (const decision of decisions) last.set(decision.finding, decision.kind);
  const kinds = [...last.values()];
  const accepted = kinds.filter((kind) => kind === "accept").length;
  const rejected = kinds.filter((kind) => kind === "reject").length;
  const n = accepted + rejected;
  return {
    accepted,
    rejected,
    acknowledged: kinds.filter((kind) => kind === "acknowledge").length,
    n,
    rate: n === 0 ? null : accepted / n,
    agentExcluded,
  };
}

const bounds = (week: Week): WeekBounds => ({
  week: week.label,
  start: new Date(week.start).toISOString(),
  end: new Date(week.end).toISOString(),
});

export function buildScorecard(input: ScorecardInput): Scorecard {
  const window = input.window;
  const problems = foldIdiomProblems(input.runs, input.ledger);
  const learned = [...input.learned];
  const surfaceOf = (flow: string) =>
    input.flowSurfaces.get(flow) ?? UNRECORDED;

  // Nodes: problems first, then learned entries.
  const union = new UnionFind(problems.length + learned.length);
  const edges: Array<{
    problem: number;
    entry: number;
    via: MatchVia;
    detail: string;
  }> = [];
  for (const [entryIndex, entry] of learned.entries())
    for (const [problemIndex, problem] of problems.entries()) {
      const match = matchEntry(entry, problem);
      if (match === undefined) continue;
      edges.push({ problem: problemIndex, entry: entryIndex, ...match });
      union.union(problemIndex, problems.length + entryIndex);
    }

  const components = new Map<
    number,
    { problems: number[]; entries: number[] }
  >();
  const component = (node: number) => {
    const root = union.find(node);
    const found = components.get(root) ?? { problems: [], entries: [] };
    components.set(root, found);
    return found;
  };
  for (const index of problems.keys()) component(index).problems.push(index);
  for (const index of learned.keys())
    component(problems.length + index).entries.push(index);

  const dates = learned.map(learnedDate);
  const outcomes = new Map<number, Found>();
  for (const [root, members] of components) {
    const idiom = members.problems
      .map((index) => problems[index] as IdiomProblem)
      .sort((left, right) => left.firstSeen - right.firstSeen)[0];
    const director = members.entries
      .flatMap((index) => {
        const date = dates[index];
        return date === undefined
          ? []
          : [{ entry: learned[index] as LearnedEntry, ...date }];
      })
      .sort((left, right) => left.at - right.at);
    // A day-only date starts at UTC midnight, so "strictly before it" means a
    // strictly earlier day: a same-day tie goes to the director.
    if (
      idiom !== undefined &&
      director.every((date) => idiom.firstSeen < date.at)
    )
      outcomes.set(root, {
        foundBy: "idiom",
        at: idiom.firstSeen,
        category: idiom.category,
        surface: surfaceOf(idiom.flow),
      });
    else if (director[0] !== undefined) {
      const { entry, at } = director[0];
      outcomes.set(root, {
        foundBy: "director",
        at,
        category: learnedCategory(entry),
        surface: entry.import?.surface ?? surfaceOf(entry.flow),
      });
    }
    // Otherwise only undated entries: never placed in a week.
  }

  const inWeek = window.map(() => [] as Found[]);
  for (const outcome of outcomes.values()) {
    const week = weekOf(window, outcome.at);
    if (week !== undefined) inWeek[window.indexOf(week)]?.push(outcome);
  }

  const decided = window.map(
    () => [] as { finding: string; kind: AcceptanceKind }[],
  );
  const agentDecisions = window.map(() => 0);
  for (const { record } of input.decisions) {
    if (
      record.decision !== "accept" &&
      record.decision !== "reject" &&
      record.decision !== "acknowledge"
    )
      continue;
    const week = weekOf(window, Date.parse(record.at));
    if (week === undefined) continue;
    const index = window.indexOf(week);
    if (record.actor === "human")
      decided[index]?.push({
        finding: record.findingId,
        kind: record.decision,
      });
    else agentDecisions[index] = (agentDecisions[index] ?? 0) + 1;
  }
  const acceptanceWeeks = window.map((week, index) => ({
    ...bounds(week),
    ...acceptance(decided[index] ?? [], agentDecisions[index] ?? 0),
  }));
  const sum = (pick: (week: AcceptanceCounts) => number) =>
    acceptanceWeeks.reduce((total, week) => total + pick(week), 0);
  const accepted = sum((week) => week.accepted);
  const rejected = sum((week) => week.rejected);

  const runIds = new Set(input.runs.map((run) => run.runId));
  const oldest = input.runs
    .map((run) => Date.parse(run.completedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const first = window[0] as Week;
  const last = window[window.length - 1] as Week;
  const notes: string[] = [];
  if (oldest === undefined)
    notes.push(
      "no stored Idiom runs; Idiom-first counts only filed tickets and may be undercounted",
    );
  else if (oldest > first.start)
    notes.push(
      `Idiom runs before ${new Date(oldest).toISOString().slice(0, 10)} are not stored; Idiom-first may be undercounted`,
    );

  const outcomeOf = (problemIndex: number) =>
    outcomes.get(union.find(problemIndex));
  return {
    window: {
      from: first.label,
      to: last.label,
      start: new Date(first.start).toISOString(),
      end: new Date(last.end).toISOString(),
      weeks: window.map((week) => week.label),
    },
    weeks: window.map((week, index) => ({
      ...bounds(week),
      ...tally(inWeek[index] ?? []),
    })),
    overall: tally(inWeek.flat()),
    acceptance: {
      weeks: acceptanceWeeks,
      overall: {
        accepted,
        rejected,
        acknowledged: sum((week) => week.acknowledged),
        n: accepted + rejected,
        rate:
          accepted + rejected === 0 ? null : accepted / (accepted + rejected),
        agentExcluded: sum((week) => week.agentExcluded),
      },
    },
    ...(input.verbose
      ? {
          pairs: edges.flatMap((edge): ScorecardPair[] => {
            const outcome = outcomeOf(edge.problem);
            const entry = learned[edge.entry] as LearnedEntry;
            const problem = problems[edge.problem] as IdiomProblem;
            if (outcome === undefined) return [];
            return [
              {
                learned: entry.id,
                problem: problemLabel(problem),
                flow: problem.flow,
                state: entry.state,
                via: edge.via,
                detail: edge.detail,
                foundBy: outcome.foundBy,
                week: isoWeek(outcome.at).label,
              },
            ];
          }),
        }
      : {}),
    sources: {
      runs: runIds.size,
      runRoots: [...input.runRoots],
      ...(oldest === undefined
        ? {}
        : { oldestRun: new Date(oldest).toISOString() }),
      ledgerEntries: input.ledger.length,
      learned: learned.length,
      undated: dates.filter((date) => date === undefined).length,
      decisions: input.decisions.length,
    },
    notes,
  };
}

/** A readable name for a problem: flow, state and category or rule. */
export function problemLabel(problem: IdiomProblem): string {
  const occurrence = problem.occurrences[0];
  if (occurrence === undefined) return `${problem.flow} ${problem.firstSeenIn}`;
  return `${problem.flow}/${occurrence.state} ${occurrence.rule ?? occurrence.category}`;
}
