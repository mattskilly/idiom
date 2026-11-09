// Informational observations stay in raw records/reports, outside digest alerts.
import { rangeText } from "../attribution/render.js";
import { IdiomError } from "../errors.js";
import {
  type HumanFoundSummary,
  humanFoundLine,
} from "../learn/misses-summary.js";
import { comparePriority } from "../review/ranking.js";
import type { DigestCounts, DigestFlow, DigestItem } from "./build.js";
import type { DigestCoverageProblem } from "./record.js";

/** The text digest never exceeds this many lines for up to 8 flows. */
export const DIGEST_LINE_BUDGET = 25;
const COVERAGE_LINES = 5;
const FIXED_RESERVE = 3;

function statesText(states: readonly string[]): string {
  const shown = states.slice(0, 2).join(", ");
  return states.length > 2 ? `${shown} +${states.length - 2}` : shown;
}

function coverageLine(prefix: string, problem: DigestCoverageProblem): string {
  if (problem.kind === "busy-host")
    return `! busy host${prefix === "" ? "" : ` (${prefix.slice(0, -1)})`}: ${problem.detail} — re-run on an idle host`;
  const where = `${prefix}${problem.where ?? "run"}`;
  return problem.kind === "interrupted"
    ? `! interrupted ${where} — not captured`
    : `! failed ${where} — ${problem.detail}`;
}

function itemLine(
  sign: "+" | "-",
  prefix: string,
  item: DigestItem,
  tail: string,
): string {
  return `${sign} ${prefix}${item.id} [${item.severity}] ${item.rule ?? item.category} — ${statesText(item.states)} — ${tail}`;
}

/** ` · appeared between … , likely <sha7> (<tickets>)`; subjects stay out. */
function introducedText(item: DigestItem): string {
  const introduced = item.introduced;
  if (introduced === undefined) return "";
  const likely = introduced.likely;
  return ` · ${rangeText(introduced)}${
    likely === undefined
      ? ""
      : `, likely ${likely.commit.slice(0, 7)}${likely.tickets.length === 0 ? "" : ` (${likely.tickets.join(", ")})`}`
  }`;
}

function countsLine(counts: DigestCounts): string {
  const terms = [
    [counts.newMinor, "new minor"],
    [counts.unchanged, "open unchanged"],
    [counts.notCompared, "not compared"],
    [counts.acknowledged, "acknowledged"],
    [counts.rejected, "rejected"],
  ]
    .filter(([count]) => count !== 0)
    .map(([count, label]) => `${count} ${label}`);
  return terms.length === 0
    ? "Also: nothing else open."
    : `Also: ${terms.join(", ")}.`;
}

/** At most `take` lines; a truncated section ends with an overflow line. */
function section(
  lines: readonly string[],
  take: number,
  overflow: (more: number) => string,
): string[] {
  if (lines.length <= take) return [...lines];
  if (take === 0) return [];
  return [...lines.slice(0, take - 1), overflow(lines.length - (take - 1))];
}

/**
 * Verdicts, coverage problems, new findings at major or above, fixed
 * findings, the remaining counts and the report path, within
 * DIGEST_LINE_BUDGET lines. JSON carries the complete lists.
 */
export function renderDigest(
  flows: readonly DigestFlow[],
  options: {
    humanFound?: HumanFoundSummary | undefined;
    now?: Date | undefined;
  } = {},
): string[] {
  const several = flows.length > 1;
  const prefix = (flow: DigestFlow) => (several ? `${flow.flow}/` : "");
  const verdicts = flows.map((flow) =>
    several ? `${flow.flow}: ${flow.text}` : flow.text,
  );
  const coverage = flows.flatMap((flow) =>
    flow.coverage.map((problem) => coverageLine(prefix(flow), problem)),
  );
  const ranked = (pick: (flow: DigestFlow) => DigestItem[]) =>
    flows
      .flatMap((flow) => pick(flow).map((item) => ({ flow, item })))
      .sort(
        (left, right) =>
          comparePriority(left.item, right.item) ||
          left.flow.flow.localeCompare(right.flow.flow) ||
          left.item.id.localeCompare(right.item.id),
      );
  const added = ranked((flow) => flow.newFindings).map(({ flow, item }) =>
    itemLine("+", prefix(flow), item, `${item.problem}${introducedText(item)}`),
  );
  const fixed = ranked((flow) => flow.fixed).map(({ flow, item }) =>
    itemLine("-", prefix(flow), item, "fixed"),
  );
  const total: DigestCounts = {
    newMinor: 0,
    unchanged: 0,
    notCompared: 0,
    acknowledged: 0,
    rejected: 0,
  };
  for (const flow of flows)
    for (const key of Object.keys(total) as Array<keyof DigestCounts>)
      total[key] += flow.counts[key];
  const reports = flows.map((flow) =>
    several
      ? `Report (${flow.flow}): ${flow.run.reportPath}`
      : `Report: ${flow.run.reportPath}`,
  );
  const humanFound = options.humanFound
    ? [humanFoundLine(options.humanFound, options.now ?? new Date())]
    : [];
  const decisionLines = flows.map((flow) => {
    const counts = flow.decisions;
    if (!counts?.available)
      return `${prefix(flow)}Decisions: attribution unavailable (legacy snapshot).`;
    const show = (actor: "human" | "agent" | "unattributed") => {
      const row = counts[actor];
      return `${actor} ${row.accept} accept / ${row.reject} reject / ${row.acknowledge} acknowledge`;
    };
    return `${prefix(flow)}Decisions: ${show("human")}; ${show("agent")}${Object.values(counts.unattributed).some(Boolean) ? `; ${show("unattributed")}` : ""}.`;
  });
  const occurrenceCounts = [countsLine(total)];
  // Eight flows fill the budget with mandatory metadata. Keep the independent
  // learned-miss line by carrying the occurrence totals on the last verdict.
  if (
    verdicts.length +
      reports.length +
      humanFound.length +
      decisionLines.length +
      1 >
    DIGEST_LINE_BUDGET
  ) {
    const last = verdicts.length - 1;
    verdicts[last] = `${verdicts[last]} ${occurrenceCounts.pop()}`;
  }
  const mandatory =
    verdicts.length +
    occurrenceCounts.length +
    reports.length +
    humanFound.length +
    decisionLines.length;
  let remaining = Math.max(0, DIGEST_LINE_BUDGET - mandatory);
  const coverageTake = Math.min(coverage.length, COVERAGE_LINES, remaining);
  remaining -= coverageTake;
  const reserve = Math.min(fixed.length, FIXED_RESERVE, remaining);
  const newTake = Math.min(added.length, remaining - reserve);
  const fixedTake = Math.min(fixed.length, remaining - newTake);
  const only = flows.length === 1 ? flows[0] : undefined;
  const lines = [
    ...verdicts,
    ...section(
      coverage,
      coverageTake,
      (more) => `…and ${more} more coverage problems`,
    ),
    ...section(
      added,
      newTake,
      (more) =>
        `…and ${more} more new findings at major or above — ${
          only === undefined
            ? "see the reports below"
            : `idiom check ${only.flow} or ${only.run.reportPath}`
        }`,
    ),
    ...section(fixed, fixedTake, (more) => `…and ${more} more fixed`),
    ...occurrenceCounts,
    ...decisionLines,
    ...humanFound,
    ...reports,
  ];
  if (flows.length <= 8 && lines.length > DIGEST_LINE_BUDGET)
    throw new IdiomError(
      `internal: digest rendered ${lines.length} lines, over its ${DIGEST_LINE_BUDGET}-line budget`,
    );
  return lines;
}
