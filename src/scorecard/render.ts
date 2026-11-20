import type {
  AcceptanceCounts,
  Breakdown,
  FoundCounts,
  Scorecard,
} from "./build.js";

const percent = (value: number) => `${Math.round(value * 100)}%`;
const LABEL_WIDTH = 9;
const pad = (label: string) => label.padEnd(LABEL_WIDTH);

function foundLine(label: string, found: FoundCounts): string {
  if (found.total === 0 || found.directorShare === null)
    return `  ${pad(label)} no UI problems recorded`;
  return `  ${pad(label)} Idiom ${found.idiom}  director ${found.director}  director share ${percent(found.directorShare)} (n=${found.total})`;
}

function breakdownLine(title: string, rows: readonly Breakdown[]): string {
  return `  ${title} ${rows.map((row) => `${row.name} ${row.idiom}/${row.director}`).join(", ")} (Idiom/director)`;
}

function acceptanceLine(label: string, counts: AcceptanceCounts): string {
  const excluded =
    counts.agentExcluded === 0
      ? ""
      : `; ${counts.agentExcluded} agent decision${counts.agentExcluded === 1 ? "" : "s"} excluded`;
  if (counts.n === 0 || counts.rate === null)
    return `  ${pad(label)} no director accept/reject decisions${counts.acknowledged === 0 ? "" : ` (${counts.acknowledged} acknowledged)`}${excluded}`;
  return `  ${pad(label)} ${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.acknowledged} acknowledged — ${percent(counts.rate)} accepted (n=${counts.n})${excluded}`;
}

export function renderScorecard(card: Scorecard): string[] {
  const { window, sources } = card;
  const lines = [
    `Scorecard ${window.from === window.to ? window.from : `${window.from} to ${window.to}`} (ISO weeks, UTC)`,
    "Found first (UI problems first found by Idiom vs by the director)",
    ...card.weeks.map((week) => foundLine(week.week, week)),
    foundLine("Window", card.overall),
  ];
  if (card.overall.total > 0)
    lines.push(
      breakdownLine("By category:", card.overall.byCategory),
      breakdownLine("By surface: ", card.overall.bySurface),
    );
  lines.push(
    "Acceptance (director decisions on findings)",
    ...card.acceptance.weeks.map((week) => acceptanceLine(week.week, week)),
    acceptanceLine("Window", card.acceptance.overall),
  );
  const watchRoots = sources.runRoots.length - 1;
  const runDetail = [
    ...(sources.oldestRun === undefined
      ? []
      : [`oldest ${sources.oldestRun.slice(0, 10)}`]),
    ...(watchRoots > 0
      ? [`${watchRoots} watch root${watchRoots === 1 ? "" : "s"}`]
      : []),
  ];
  lines.push(
    `Sources: ${sources.runs} run${sources.runs === 1 ? "" : "s"}${runDetail.length === 0 ? "" : ` (${runDetail.join("; ")})`}, ${sources.ledgerEntries} filed ticket${sources.ledgerEntries === 1 ? "" : "s"}, ${sources.learned} learned${sources.undated === 0 ? "" : ` (${sources.undated} undated, not placed)`}, ${sources.decisions} decision${sources.decisions === 1 ? "" : "s"}`,
    ...card.notes.map((note) => `note: ${note}`),
  );
  if (card.pairs !== undefined) {
    lines.push("Matches:");
    if (card.pairs.length === 0) lines.push("  none");
    for (const pair of card.pairs)
      lines.push(
        `  ${pair.learned} ↔ ${pair.problem} (${pair.via}: ${pair.detail}) — ${pair.foundBy === "idiom" ? "Idiom" : "director"} first, ${pair.week}`,
      );
  }
  return lines;
}
