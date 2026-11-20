import type { EscalationAnswer } from "../schemas/escalation-answer.js";
import type { Match } from "./match.js";
import type { EscalationItem, EscalationPass } from "./run.js";

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

function matchLine(match: Match): string {
  const stance = match.stance === undefined ? "" : ` ${match.stance}`;
  return `${match.kind}${stance} ${match.id} in ${match.where} (score ${match.score.toFixed(2)}; shares ${match.sharedTerms.join(", ")})`;
}

function itemLines(item: EscalationItem, answering: boolean): string[] {
  const head = `${item.build} [${item.id}] (${item.phase}, ${item.source})`;
  const asked = `  asks: ${firstLine(item.question)}`;
  switch (item.verdict) {
    case "not-design":
      return [`${head}: not a design question; ignored`, asked];
    case "answered-before":
      return [`${head}: already answered by Idiom; see --history`, asked];
    case "decisive": {
      const [top] = item.matches;
      return [
        `${head}: settled by precedent${item.answered ? "; answered" : answering ? "" : "; run with --answer to answer it"}`,
        asked,
        ...(top === undefined ? [] : [`  precedent: ${matchLine(top)}`]),
        ...item.matches.slice(1).map((match) => `  also: ${matchLine(match)}`),
      ];
    }
    case "open":
      return [
        `${head}: left open (${item.reason ?? "needs a person"})`,
        ...item.matches.map((match) => `  match: ${matchLine(match)}`),
        `  ${item.summary ?? asked.trim()}`,
      ];
  }
}

/** The list (and, with --answer, what was answered) as text. */
export function renderEscalationPass(
  pass: EscalationPass,
  options: { answer: boolean },
): string {
  if (pass.items.length === 0)
    return "No open autobuild escalations on blocked or paused builds.";
  const count = (verdict: EscalationItem["verdict"]) =>
    pass.items.filter((item) => item.verdict === verdict).length;
  const builds = new Set(pass.items.map((item) => item.build)).size;
  const settled = count("decisive");
  const lines = [
    `${pass.items.length} open escalation${pass.items.length === 1 ? "" : "s"} on ${builds} build${builds === 1 ? "" : "s"}: ${options.answer ? `${pass.answered.length} answered` : `${settled} settled by precedent`}, ${count("open")} left open, ${count("not-design")} not design${count("answered-before") === 0 ? "" : `, ${count("answered-before")} already answered`}.`,
  ];
  for (const item of pass.items)
    lines.push("", ...itemLines(item, options.answer));
  if (options.answer && pass.answered.length > 0) {
    lines.push("", "Answers sent:");
    for (const record of pass.answered)
      lines.push(
        "",
        `${record.build} [${record.escalation}]:`,
        ...record.guidance.split("\n").map((line) => `  ${line}`),
      );
  }
  return lines.join("\n");
}

/** Every answer Idiom gave, newest first, for the director to audit. */
export function renderEscalationHistory(
  history: readonly EscalationAnswer[],
): string {
  if (history.length === 0)
    return "Idiom has not answered any autobuild escalation.";
  const lines: string[] = [];
  for (const record of newestFirst(history)) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${record.at} ${record.build} [${record.escalation}]`,
      `  precedent: ${record.precedent.kind}${record.precedent.stance === undefined ? "" : ` ${record.precedent.stance}`} ${record.precedent.id} in ${record.precedent.where}`,
      `  asked: ${firstLine(record.question)}`,
      "  overrule: answer the build again or revise the precedent",
    );
  }
  return lines.join("\n");
}

export function newestFirst(
  history: readonly EscalationAnswer[],
): EscalationAnswer[] {
  return [...history]
    .reverse()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
