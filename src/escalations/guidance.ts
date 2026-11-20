import type { OpenEscalation } from "./ab.js";
import type { Match } from "./match.js";

/** The first line of every answer Idiom sends; harvest skips text starting with it. */
export const GUIDANCE_MARKER =
  "Idiom precedent answer: this design question is already settled.";

const QUOTE_LIMIT = 600;
const SUMMARY_QUOTE_LIMIT = 160;
const SUMMARY_QUESTION_LIMIT = 300;

/** The text cut to `limit` characters with an ellipsis, only when longer. */
export function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/** One line: runs of whitespace become a space. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The precedent, where it lives, and its words verbatim. */
function precedentSentence(match: Match): string {
  const quote = `"${clip(match.text, QUOTE_LIMIT)}"`;
  switch (match.kind) {
    case "ruling":
      return `Recorded ruling ${match.id} in ${match.file} says: ${quote}`;
    case "decision":
      return `The director ${match.stance ?? "decided"} this before (${match.where}, finding ${match.id}): ${quote}`;
    case "law":
      return `Learned law ${match.id} in ${match.file} says: ${quote}`;
  }
}

/** The guidance sent through `ab answer` for a decisive match. */
export function guidanceText(match: Match): string {
  return [
    GUIDANCE_MARKER,
    precedentSentence(match),
    "Follow it. If it does not apply to this case, escalate again and say why; a person will answer.",
  ].join("\n");
}

/** The first two sentences of a question, cut to the summary limit. */
function questionGist(question: string): string {
  const single = oneLine(question);
  const parts = single.match(/[^.!?]+[.!?]*/g) ?? [single];
  const gist = parts.slice(0, 2).join("").trim();
  const clipped = clip(gist, SUMMARY_QUESTION_LIMIT);
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

/** One paragraph for an escalation left open: the question, the closest precedent, why. */
export function summaryParagraph(options: {
  build: string;
  escalation: OpenEscalation;
  reason: string;
  closest?: Match | undefined;
}): string {
  const { build, escalation, reason, closest } = options;
  const asked = `${build} [${escalation.id}] (${escalation.phase}) asks: ${questionGist(escalation.question)}`;
  const precedent =
    closest === undefined
      ? "No recorded precedent matches."
      : `Closest precedent: ${closest.kind} ${closest.id} in ${closest.where} (score ${closest.score.toFixed(2)}; shares ${closest.sharedTerms.join(", ")}) — "${clip(oneLine(closest.text), SUMMARY_QUOTE_LIMIT)}".`;
  return `${asked} ${precedent} Left open: ${reason}.`;
}
