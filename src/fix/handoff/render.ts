import { keptRound } from "./progress.js";
import {
  type HandoffFinding,
  type HandoffRound,
  MAX_REPAIR_ROUNDS,
} from "./types.js";

const coordinate = (finding: HandoffFinding) =>
  [finding.state, finding.viewport, finding.colorScheme]
    .filter(Boolean)
    .join(", ");

const sourceLabel: Record<HandoffFinding["words"]["source"], string> = {
  learned: "learned catch",
  ruling: "recorded ruling",
  rules: "project rule",
  design: "DESIGN.md ruling",
  "rule-reference": "Idiom rule reference, not the director's words",
};

/** The scope a repair may touch, in the repair prompt's own words. */
function boundary(finding: HandoffFinding): string {
  return finding.colorScheme === undefined
    ? `The default scope is flow ${finding.flow}, state ${finding.state}, and viewport ${finding.viewport}. An acceptance criterion that explicitly requires additional coverage extends the corresponding flow, state, or viewport scope; every flow, state, and viewport not required by that default tuple or an acceptance criterion remains out of scope.`
    : `The default scope is flow ${finding.flow}, state ${finding.state}, viewport ${finding.viewport}, and color scheme ${finding.colorScheme}. An acceptance criterion that explicitly requires additional coverage extends the corresponding flow, state, viewport, or color-scheme scope; every coordinate not required by that default tuple or an acceptance criterion remains out of scope.`;
}

function findingSection(finding: HandoffFinding): string[] {
  return [
    `## ${finding.rank}. ${finding.id} — ${finding.rule || finding.category} (${finding.severity})`,
    "",
    `- Where: flow ${finding.flow}, ${coordinate(finding)}`,
    `- Selector: \`${finding.selector}\``,
    `- Measured: ${finding.measured.value === undefined ? "" : `${finding.measured.value} — `}${finding.measured.summary}`,
    `- Rule broken (${sourceLabel[finding.words.source]}, ${finding.words.ref}): "${finding.words.text}"`,
    `- Suggested fix: ${finding.suggestedFix}`,
    ...(finding.suggestedArea === undefined
      ? []
      : [`- Suggested area: ${finding.suggestedArea}`]),
    "- Done when:",
    ...finding.doneWhen.map((line) => `  - ${line}`),
    ...(finding.crops.length === 0
      ? []
      : ["- Crops:", ...finding.crops.map((path) => `  - ${path}`)]),
    `- ${boundary(finding)}`,
    "",
  ];
}

/** The agent-facing file for one round: every structured field per target. */
export function renderHandoffMarkdown(round: HandoffRound): string {
  const header = [
    `# Idiom fix — round ${round.round}`,
    "",
    `Base ${round.base}, head ${round.head}. Next: ${round.next}.`,
    "",
  ];
  if (round.next === "skip")
    return [...header, round.line ?? "No UI changes; skipped.", ""].join("\n");
  if (round.targets.length === 0)
    return [...header, "No new blocking findings remain.", ""].join("\n");
  const reverted =
    round.outcome === "revert"
      ? [
          `Outcome: revert. The edits this round judged ${round.progress?.introduced.length ? `introduced ${round.progress.introduced.join(", ")}` : "fixed no target"}, so they are reverted and these findings no longer describe HEAD. ${round.next === "repair" ? `The next repair works from round-${round.repairFrom}/handoff.md; the findings below are what that attempt caused, kept for context.` : "No repair rounds remain."}`,
          "",
        ]
      : [];
  return [
    ...header,
    ...reverted,
    "Repair these findings in the application source only. Never change `.idiom/**`, DESIGN.md, PRODUCT.md, rules, decisions, baselines, flows, test expectations or suppressions to make a finding go away. Never stash, reset or clean.",
    "",
    ...(round.progress === undefined
      ? []
      : [
          `Since the last round: fixed ${round.progress.fixed.join(", ") || "none"}; persisting ${round.progress.persisting.join(", ") || "none"}; introduced ${round.progress.introduced.join(", ") || "none"}.`,
          "",
        ]),
    ...round.targets.flatMap(findingSection),
    round.remaining.length === 0
      ? "Other blocking findings: none."
      : `Other blocking findings, separate work for a later round: ${round.remaining.map((finding) => `${finding.id} (${finding.rule || finding.category} at ${coordinate(finding)})`).join("; ")}.`,
    "",
  ].join("\n");
}

const unresolvedLine = (finding: HandoffFinding, tried: number) =>
  `- ${finding.id} ${finding.rule || finding.category} at \`${finding.selector}\` (${coordinate(finding)}): measured ${finding.measured.value ?? "see report"}; "${finding.words.text}" (${finding.words.ref}); suggested: ${finding.suggestedFix} Rounds tried: ${tried}.`;

/**
 * The short escalation text: fixed X of Y in N rounds, one line per
 * unresolved finding, what was committed, and where the full report is.
 * At most 15 lines, whatever the number of findings.
 */
export function renderSummary(rounds: HandoffRound[]): string {
  const latest = rounds.at(-1);
  if (latest === undefined) return "Idiom fix: no gate round ran.\n";
  if (latest.next === "skip")
    return `Idiom fix: ${latest.line ?? "no UI changes; skipped"}\n`;
  // Only kept rounds describe HEAD: a reverted round's findings (and what it
  // seemed to fix) vanished with its edits.
  const kept = rounds.filter(keptRound);
  const last = kept.at(-1) ?? latest;
  const seen = new Map<string, HandoffFinding>();
  for (const round of kept)
    for (const finding of [...round.targets, ...round.remaining])
      if (!seen.has(finding.id)) seen.set(finding.id, finding);
  const open = [...last.targets, ...last.remaining];
  const openIds = new Set(open.map((finding) => finding.id));
  const fixed = [...seen.keys()].filter((id) => !openIds.has(id));
  const repairRounds = Math.max(0, rounds.length - 1);
  // A repair attempt n works from the last kept round before it.
  const tried = (id: string) =>
    rounds.slice(1).filter((attempt) => {
      const source = rounds
        .filter((round) => round.round < attempt.round && keptRound(round))
        .at(-1);
      return source?.targets.some((finding) => finding.id === id) ?? false;
    }).length;
  const reverted = rounds.filter((round) => round.outcome === "revert").length;
  const lines = [
    `Idiom fix: fixed ${fixed.length} of ${seen.size} new blocking finding(s) in ${repairRounds} round(s)${reverted ? ` (${reverted} reverted)` : ""}${last.next === "pass" ? "; re-verify passed" : ""}.`,
  ];
  const shown = open.slice(0, 10);
  for (const finding of shown)
    lines.push(unresolvedLine(finding, tried(finding.id)));
  if (open.length > shown.length)
    lines.push(`- … and ${open.length - shown.length} more in the report.`);
  lines.push(`Fixed and committed: ${fixed.join(", ") || "none"}.`);
  lines.push(
    "Full transcript: the idiom-fix-report artifact (.ab/idiom-fix/transcript.md).",
  );
  return `${lines.join("\n")}\n`;
}

/** The full per-round transcript: finding, edits, re-verify, result. */
export function renderTranscript(
  rounds: HandoffRound[],
  edits: Map<number, string> = new Map(),
): string {
  const lines = ["# Idiom fix transcript", ""];
  for (const round of rounds) {
    lines.push(
      round.round === 0
        ? "## Round 0 — initial gate"
        : `## Round ${round.round} — re-verify after repair round ${round.round}`,
      "",
      `Head ${round.head} against base ${round.base}; ${round.timing.totalMs} ms.`,
    );
    // round-N/edits.md: the edits this re-verify judged, written by the step.
    const edit = edits.get(round.round);
    if (edit !== undefined)
      lines.push("", "Edits this round re-verified:", "", edit.trim());
    if (round.progress !== undefined)
      lines.push(
        `Re-verify: fixed ${round.progress.fixed.join(", ") || "none"}; persisting ${round.progress.persisting.join(", ") || "none"}; introduced ${round.progress.introduced.join(", ") || "none"}.`,
      );
    if (round.outcome !== undefined)
      lines.push(
        round.outcome === "commit"
          ? "Outcome: edits kept (committed)."
          : `Outcome: edits reverted; the next repair works from round ${round.repairFrom}.`,
      );
    lines.push("");
    if (round.next === "skip") lines.push(round.line ?? "Skipped.", "");
    else if (round.targets.length === 0)
      lines.push("Result: no new blocking findings. Pass.", "");
    else {
      lines.push("Findings:", "");
      for (const finding of round.targets)
        lines.push(...findingSection(finding));
      if (round.remaining.length)
        lines.push(
          `Beyond the top three: ${round.remaining.map((finding) => finding.id).join(", ")}.`,
          "",
        );
      lines.push(
        round.next === "stop"
          ? `Result: stopped after ${MAX_REPAIR_ROUNDS} repair rounds with blocking findings.`
          : "Result: repair.",
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
