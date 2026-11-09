import { join, resolve } from "node:path";
import {
  type AttributionRecord,
  introductionKey,
  introductionsByKey,
  type RecordedIntroduction,
  readAttributionRecord,
} from "../attribution/record.js";
import type { IdentifiedDecision } from "../decisions/attribution.js";
import { readIdentifiedDecisions } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { storedRunsNewestFirst } from "../review/artifacts.js";
import { mergeImpactReasons } from "../review/issues.js";
import { comparePriority, type ImpactReason } from "../review/ranking.js";
import { severityRank as sharedSeverityRank } from "../schemas/severity.js";
import { validateProjectConfiguration } from "../validation.js";
import { countAppliedDecisions, type DecisionCounts } from "./decisions.js";
import {
  coordinateCovers,
  type DigestCoverageProblem,
  type DigestOccurrence,
  type DigestRecord,
  readDigestRecord,
} from "./record.js";

export type DigestItem = {
  id: string;
  ids: string[];
  severity: DigestOccurrence["severity"];
  category: string;
  rule?: string | undefined;
  states: string[];
  viewports: string[];
  where: string[];
  problem: string;
  score: number;
  impact: 0 | 1;
  impactReasons: ImpactReason[];
  /** New items only: the first-seen range check recorded for it, when present. */
  introduced?: RecordedIntroduction | undefined;
};

export type DigestCounts = {
  newMinor: number;
  unchanged: number;
  notCompared: number;
  acknowledged: number;
  rejected: number;
};

export type DigestFlow = {
  flow: string;
  run: {
    id: string;
    completedAt: string;
    commit: string;
    reportPath: string;
  };
  since: { id: string; completedAt: string } | null;
  verdict: "nothing-new" | "changes" | "no-comparison";
  /** The verdict line. */
  text: string;
  configChanged: boolean;
  coverage: DigestCoverageProblem[];
  /** New items at major or above, ranked. Complete; only text truncates. */
  newFindings: DigestItem[];
  fixed: DigestItem[];
  counts: DigestCounts;
  decisions: DecisionCounts;
  /** The commits the latest run's attribution compared; null when it has none. */
  attribution: { previousCommit: string | null; commit: string } | null;
};

/** Every readable digest record under the reports root, newest first, by flow. */
export async function loadFlowRecords(
  reports: string,
): Promise<Map<string, DigestRecord[]>> {
  const byFlow = new Map<string, DigestRecord[]>();
  for (const run of await storedRunsNewestFirst(reports)) {
    const record = await readDigestRecord(join(reports, run));
    if (record === undefined) continue;
    const list = byFlow.get(record.flow) ?? [];
    list.push(record);
    byFlow.set(record.flow, list);
  }
  return byFlow;
}

/** No failed, interrupted or busy-host tuples. */
export function isComplete(record: DigestRecord): boolean {
  return record.coverage.problems.length === 0;
}

/** `YYYY-MM-DD HH:MM UTC`. */
export function formatTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The latest full-scope run, complete or not, and the run it is compared
 * with: by default the newest complete full-scope run older than it.
 */
export function selectRuns(
  flow: string,
  records: readonly DigestRecord[],
  since?: string,
): { latest: DigestRecord; since: DigestRecord | null } {
  const full = records.filter((record) => record.scope === "full");
  const latest = full[0];
  if (latest === undefined)
    throw new IdiomError(
      `no checked run of ${flow} yet; run idiom check ${flow}`,
    );
  const older = full.slice(1);
  if (since === undefined)
    return { latest, since: older.find(isComplete) ?? null };
  const named = records.find((record) => record.runId === since);
  if (named !== undefined) {
    if (named.scope !== "full")
      throw new IdiomError(
        `--since ${since}: that run of ${flow} checked only part of the flow; pick a full run`,
      );
    if (!older.includes(named))
      throw new IdiomError(
        `--since ${since}: that is the latest run of ${flow}; pick an earlier run`,
      );
    return { latest, since: named };
  }
  const oldest = older.filter(isComplete).at(-1);
  const available =
    oldest === undefined
      ? `${flow} has no earlier complete run`
      : `the oldest complete run of ${flow} is ${oldest.runId} (${formatTime(oldest.completedAt)})`;
  let cutoff: (completedAt: number) => boolean;
  if (datePattern.test(since)) {
    const midnight = Date.parse(`${since}T00:00:00Z`);
    if (Number.isNaN(midnight))
      throw new IdiomError(`--since ${since}: not a valid date`);
    cutoff = (completedAt) => completedAt < midnight;
  } else if (since.includes("T") && !Number.isNaN(Date.parse(since))) {
    const instant = Date.parse(since);
    cutoff = (completedAt) => completedAt <= instant;
  } else if (runIdPattern.test(since))
    throw new IdiomError(
      `--since ${since}: no digest record for that run of ${flow}; ${available}`,
    );
  else
    throw new IdiomError(
      `--since ${since}: expected a run id, a YYYY-MM-DD date or an ISO datetime`,
    );
  const match = older.find(
    (record) => isComplete(record) && cutoff(Date.parse(record.completedAt)),
  );
  if (match === undefined)
    throw new IdiomError(
      `--since ${since}: no complete run of ${flow} before then; ${available}`,
    );
  return { latest, since: match };
}

/** The text up to the first `. `, `; ` or ` — `, at most 100 characters. */
export function oneClause(text: string): string {
  const line = text.split("\n")[0] ?? "";
  const ends = [". ", "; ", " — "]
    .map((separator) => line.indexOf(separator))
    .filter((index) => index >= 0);
  const clause = (
    ends.length === 0 ? line : line.slice(0, Math.min(...ends))
  ).trim();
  return clause.length > 100 ? `${clause.slice(0, 99).trimEnd()}…` : clause;
}

const identity = (occurrence: DigestOccurrence) =>
  `${occurrence.where}\0${occurrence.fingerprint}`;
const severityOrder = sharedSeverityRank;

/** Same element and rule across states and schemes form one item. */
export function groupItems(
  occurrences: readonly DigestOccurrence[],
): DigestItem[] {
  return groupedItems(occurrences).map(({ item }) => item);
}

/** groupItems, keeping each item's occurrences in display order. */
function groupedItems(
  occurrences: readonly DigestOccurrence[],
): Array<{ item: DigestItem; occurrences: DigestOccurrence[] }> {
  const groups = new Map<string, DigestOccurrence[]>();
  for (const occurrence of occurrences) {
    const key = occurrence.groupKey ?? identity(occurrence);
    const group = groups.get(key) ?? [];
    group.push(occurrence);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const ordered = [...group].sort(
        (left, right) =>
          left.where.localeCompare(right.where) ||
          left.id.localeCompare(right.id),
      );
      const first = ordered[0] as DigestOccurrence;
      const states = [...new Set(ordered.map((o) => o.state))].sort();
      const viewports = [...new Set(ordered.map((o) => o.viewport))].sort();
      const reasons = mergeImpactReasons([
        ...ordered.map((o) => o.impactReasons),
        states.length >= 2 ? ["states"] : [],
        viewports.length >= 2 ? ["viewports"] : [],
      ]);
      const item: DigestItem = {
        id: first.id,
        ids: [...new Set(ordered.map((o) => o.id))],
        severity: ordered.reduce(
          (worst, o) =>
            severityOrder[o.severity] < severityOrder[worst]
              ? o.severity
              : worst,
          first.severity,
        ),
        category: first.category,
        ...(first.rule === undefined ? {} : { rule: first.rule }),
        states,
        viewports,
        where: [...new Set(ordered.map((o) => o.where))],
        problem: oneClause(first.problem),
        score: Math.max(...ordered.map((o) => o.score)),
        impact: reasons.length > 0 ? 1 : 0,
        impactReasons: reasons,
      };
      return { item, occurrences: ordered };
    })
    .sort(
      (left, right) =>
        comparePriority(left.item, right.item) ||
        left.item.id.localeCompare(right.item.id),
    );
}

const designOccurrences = (record: DigestRecord) =>
  record.occurrences.filter(
    (o) => o.coverageOnly !== true && o.severity !== "info",
  );

/**
 * Occurrence identity at coordinates both records captured: which open
 * occurrences of `latest` are new, which were already open in `since`, which
 * of `since`'s open occurrences are gone, and which sit at coordinates the
 * two cannot be compared at. Ungrouped; the digest groups them.
 */
export function classifyOccurrences(
  latest: DigestRecord,
  since: DigestRecord,
): {
  added: DigestOccurrence[];
  unchanged: DigestOccurrence[];
  fixed: DigestOccurrence[];
  notCompared: DigestOccurrence[];
} {
  const current = designOccurrences(latest);
  const open = current.filter((o) => o.disposition === "open");
  const previous = designOccurrences(since);
  const problemCoordinates = [latest, since].flatMap((record) =>
    record.coverage.problems.flatMap((problem) => [
      ...(problem.where === undefined ? [] : [problem.where]),
      ...(problem.tuples ?? []),
    ]),
  );
  const capturedLatest = new Set(latest.coverage.captured);
  const capturedSince = new Set(since.coverage.captured);
  const comparable = (where: string) =>
    capturedLatest.has(where) &&
    capturedSince.has(where) &&
    !problemCoordinates.some((problem) => coordinateCovers(problem, where));
  const latestIds = new Set(current.map(identity));
  const previousIds = new Set(previous.map(identity));
  return {
    added: open.filter(
      (o) => comparable(o.where) && !previousIds.has(identity(o)),
    ),
    unchanged: open.filter(
      (o) => comparable(o.where) && previousIds.has(identity(o)),
    ),
    fixed: previous.filter(
      (o) =>
        o.disposition === "open" &&
        comparable(o.where) &&
        !latestIds.has(identity(o)),
    ),
    notCompared: open.filter((o) => !comparable(o.where)),
  };
}

/**
 * The newest complete full-scope run older than `currentRunId` in a
 * newest-first list, or the newest one when the current run has no record
 * yet. A run is never its own previous run.
 */
export function previousCompleteRecord(
  records: readonly DigestRecord[],
  currentRunId: string,
): DigestRecord | null {
  const index = records.findIndex((record) => record.runId === currentRunId);
  return (
    records
      .slice(index + 1)
      .find((record) => record.scope === "full" && isComplete(record)) ?? null
  );
}

/** Compare two records by occurrence identity at coordinates both captured. */
export function diffRecords(
  latest: DigestRecord,
  since: DigestRecord | null,
): DigestDiff {
  return diffWithItems(latest, since).diff;
}

type DigestDiff = Omit<
  DigestFlow,
  "flow" | "run" | "since" | "verdict" | "text" | "attribution" | "decisions"
>;

function diffWithItems(
  latest: DigestRecord,
  since: DigestRecord | null,
): {
  diff: DigestDiff;
  newGroups: Array<{ item: DigestItem; occurrences: DigestOccurrence[] }>;
} {
  const current = designOccurrences(latest);
  const open = current.filter((o) => o.disposition === "open");
  const counted = {
    acknowledged: groupItems(
      current.filter((o) => o.disposition === "acknowledged"),
    ).length,
    rejected: groupItems(current.filter((o) => o.disposition === "rejected"))
      .length,
  };
  if (since === null)
    return {
      diff: {
        configChanged: false,
        coverage: latest.coverage.problems,
        newFindings: [],
        fixed: [],
        counts: {
          newMinor: 0,
          unchanged: 0,
          notCompared: groupItems(open).length,
          ...counted,
        },
      },
      newGroups: [],
    };
  const { added, unchanged, fixed, notCompared } = classifyOccurrences(
    latest,
    since,
  );
  const newGroups = groupedItems(added);
  const newItems = newGroups.map(({ item }) => item);
  return {
    diff: {
      configChanged: since.configHash !== latest.configHash,
      coverage: latest.coverage.problems,
      newFindings: newItems.filter(
        (item) => item.severity === "blocker" || item.severity === "major",
      ),
      fixed: groupItems(fixed),
      counts: {
        newMinor: newItems.filter((item) => item.severity === "minor").length,
        unchanged: groupItems(unchanged).length,
        notCompared: groupItems(notCompared).length,
        ...counted,
      },
    },
    newGroups,
  };
}

export function digestFlow(
  flow: string,
  records: readonly DigestRecord[],
  since?: string,
  attribution?: AttributionRecord | undefined,
  effectiveDecisions?: IdentifiedDecision[] | undefined,
): DigestFlow {
  const selected = selectRuns(flow, records, since);
  const { latest } = selected;
  const { diff, newGroups } = diffWithItems(latest, selected.since);
  const recorded =
    attribution?.runId === latest.runId ? attribution : undefined;
  if (recorded !== undefined) {
    const introductions = introductionsByKey(recorded);
    for (const { item, occurrences } of newGroups) {
      const introduced = occurrences
        .map((o) => introductions.get(introductionKey(o.where, o.fingerprint)))
        .find((introduction) => introduction !== undefined);
      if (introduced !== undefined) item.introduced = introduced;
    }
  }
  const newCount = diff.newFindings.length + diff.counts.newMinor;
  const verdict: DigestFlow["verdict"] =
    selected.since === null
      ? "no-comparison"
      : newCount === 0 && diff.fixed.length === 0 && diff.coverage.length === 0
        ? "nothing-new"
        : "changes";
  const text =
    selected.since === null
      ? `No earlier complete run of ${flow} to compare with (latest ${latest.runId}, ${formatTime(latest.completedAt)}).`
      : `${
          verdict === "nothing-new"
            ? `Nothing new since ${selected.since.runId}, ${formatTime(selected.since.completedAt)}.`
            : `${newCount} new, ${diff.fixed.length} fixed since ${selected.since.runId}.`
        }${diff.configChanged ? " Checks configuration changed since then." : ""}`;
  return {
    flow,
    run: {
      id: latest.runId,
      completedAt: latest.completedAt,
      commit: latest.commit,
      reportPath: latest.reportPath,
    },
    since:
      selected.since === null
        ? null
        : {
            id: selected.since.runId,
            completedAt: selected.since.completedAt,
          },
    verdict,
    text,
    ...diff,
    decisions: countAppliedDecisions(
      latest.appliedDecisions,
      effectiveDecisions,
    ),
    attribution:
      recorded === undefined
        ? null
        : {
            previousCommit: recorded.previous?.commit ?? null,
            commit: recorded.commit,
          },
  };
}

/**
 * `idiom digest`: reads stored digest records only. It never captures, runs
 * a check or starts a server.
 */
export async function digestFlows(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  since?: string | undefined;
}): Promise<DigestFlow[]> {
  const { projectDirectory } = await validateProjectConfiguration(options);
  const effectiveDecisions = await readIdentifiedDecisions(projectDirectory);
  const records = await loadFlowRecords(
    resolve(projectDirectory, ".idiom", "reports"),
  );
  // A run id names its own flow when no flow is given.
  const flow =
    options.flow ??
    (options.since === undefined
      ? undefined
      : [...records.values()]
          .flat()
          .find((record) => record.runId === options.since)?.flow);
  const reports = resolve(projectDirectory, ".idiom", "reports");
  const latestAttribution = async (list: readonly DigestRecord[]) => {
    const latest = list.find((record) => record.scope === "full");
    return latest === undefined
      ? undefined
      : readAttributionRecord(join(reports, latest.runId));
  };
  if (flow !== undefined) {
    const list = records.get(flow) ?? [];
    return [
      digestFlow(
        flow,
        list,
        options.since,
        await latestAttribution(list),
        effectiveDecisions,
      ),
    ];
  }
  const flows = [...records.entries()]
    .filter(([, list]) => list.some((record) => record.scope === "full"))
    .map(([id]) => id)
    .sort();
  if (flows.length === 0)
    throw new IdiomError(
      "no checked run of any flow yet; run idiom check <flow>",
    );
  return Promise.all(
    flows.map(async (id) => {
      const list = records.get(id) ?? [];
      return digestFlow(
        id,
        list,
        options.since,
        await latestAttribution(list),
        effectiveDecisions,
      );
    }),
  );
}
