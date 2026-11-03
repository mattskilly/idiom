// A scoring term ("score", "rating", "grade", "rubric total") is not itself
// an evaluation: the reviewed interface may show a star-rating control or a
// score readout, and a finding must be able to name it.
const TERM = String.raw`(?:scores?|ratings?|grades?|rubric\s+totals?)`;

// Nouns that make a directly following term name an interface surface.
const SURFACE =
  "(?:widgets?|controls?|fields?|inputs?|selectors?|pickers?|dropdowns?|sliders?|stars?|badges?|chips?|pills?|labels?|columns?|rows?|cells?|cards?|panels?|sections?|summary|summaries|components?|displays?|readouts?|indicators?|meters?|bars?|scales?|icons?|text|copy|values?|totals?|filters?|sort|tabs?|buttons?|forms?|modules?|blocks?|areas?|breakdowns?|histograms?|counts?)";

const NUMBER = String.raw`\d+(?:\.\d+)?`;
const WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)";
const FRACTION = String.raw`${NUMBER}\s*(?:\/|out\s+of)\s*(?:${NUMBER}|${WORD})|${WORD}\s+out\s+of\s+(?:${NUMBER}|${WORD})`;
const PERCENT = String.raw`${NUMBER}\s*(?:%|percent\b|points?\b|pts\b)`;
const LETTER = "(?<letter>[A-F][+-]?)";

// A term followed by a copula/connector and a value: "Rubric total: 42".
// Display verbs (shows, reads, renders) are deliberately not connectors.
// A bare number must end there: "rating is 14px" or "score is 2x" is a
// measurement of the surface, not a score.
const BARE_END = String.raw`(?![\w.%/])`;
const CONNECTOR = String.raw`(?:\s*[:=\-–—]\s*|\s+(?:of\s+about|of|is|was|would\s+be|comes\s+to|sits\s+at|at|around)\s+)(?:an?\s+)?`;
const TERM_THEN_VALUE = new RegExp(
  String.raw`\b(?<term>${TERM})${CONNECTOR}(?:${FRACTION}|${PERCENT}|${NUMBER}${BARE_END}|${WORD}${BARE_END}|${LETTER}(?![\w+-]))`,
  "gi",
);
// A value followed by a term: "8/10 rating", "a B+ grade". A bare count
// ("12 ratings") describes the interface unless it is called overall/total.
const VALUE_THEN_TERM = new RegExp(
  String.raw`(?:(?:${FRACTION}|${PERCENT})\s*(?:(?:overall|total)\s+)?|\b(?:${NUMBER}|${WORD})\s+(?:overall|total)\s+|\ban?\s+${LETTER}\s*(?=grade))(?<term>${TERM})\b`,
  "gi",
);
// A term qualified as an evaluation of the design or the review itself.
const QUALIFIED_TERM = new RegExp(
  String.raw`\b(?:overall|aggregate|composite|cumulative|final|design|ux|usability|quality|review|critique|our|my)(?:['’]s)?[\s-]+(?<term>${TERM})\b`,
  "gi",
);

// A score-shaped value: a fraction, percentage, letter grade, or a bare
// number only when it ends the clause ("a 6.", "a 6 overall"), so counts
// such as "2 different hover colours" never read as scores.
const TERMINAL = String.raw`(?=\s*(?:$|[,)]|overall\b))`;
const SCORE_VALUE = String.raw`(?:(?:\ban?\s+)?(?:${FRACTION}|${PERCENT}|\b(?:${NUMBER}|${WORD})${TERMINAL})|\ban?\s+${LETTER}(?=\s*(?:$|[,)]|grades?\b|overall\b)))`;
const SCORER =
  /\b(?:I|we)(?:['’]d|\s+would|\s+will)?\s+(?:\w+\s+)?(?:rate|score|grade|give)\b/gi;
const SCORE_IN_REST = new RegExp(SCORE_VALUE, "gi");
const AWARD = new RegExp(
  String.raw`\b(?:rate[sd]?|score[sd]?|grade[sd]?|earns?|gets?|receives?|deserves?)\s+(?:(?:this|the|it)\s+)?(?:(?:design|page|flow|interface|ui|ux|layout|screen|review)\s+)?${SCORE_VALUE}`,
  "gi",
);
const WORK = /\b(?:design|page|flow|interface|ui|ux|layout|screen|review)\b/i;

const ANCHOR = new RegExp(String.raw`^(?:\s+|-)${SURFACE}\b`, "i");

function anchored(sentence: string, match: RegExpExecArray): boolean {
  const term = match.groups?.term;
  if (term === undefined) return false;
  const end = match.index + match[0].lastIndexOf(term) + term.length;
  return ANCHOR.test(sentence.slice(end));
}

/** Match `pattern` in `text`, skipping lowercase "letter grades" and any
 * term that names a surface. */
function evaluative(
  pattern: RegExp,
  text: string,
  surfaceExempt: boolean,
): RegExpExecArray | undefined {
  pattern.lastIndex = 0;
  for (
    let match = pattern.exec(text);
    match !== null;
    match = pattern.exec(text)
  ) {
    const letter = match.groups?.letter;
    const lowercaseLetter =
      letter !== undefined && letter[0] !== letter[0]?.toUpperCase();
    if (!lowercaseLetter && !(surfaceExempt && anchored(text, match)))
      return match;
    pattern.lastIndex = match.index + 1;
  }
  return undefined;
}

function scorerMatch(sentence: string): RegExpExecArray | undefined {
  SCORER.lastIndex = 0;
  for (
    let match = SCORER.exec(sentence);
    match !== null;
    match = SCORER.exec(sentence)
  ) {
    const rest = sentence.slice(match.index + match[0].length);
    if (evaluative(SCORE_IN_REST, rest, false) !== undefined) return match;
  }
  return undefined;
}

function excerpt(sentence: string, index: number): string {
  if (sentence.length <= 80) return sentence;
  const start = Math.max(0, Math.min(index - 20, sentence.length - 80));
  return sentence.slice(start, start + 80).trim();
}

// The model supplies findings, never an evaluation of the review: a numeric
// or aggregate design score, rating, grade, or rubric total is forbidden.
// Naming a rating surface the interface shows is permitted, so a term
// anchored by a surface noun ("rating widget", "score readout") is exempt;
// a term is evaluative only when bound to a value ("score: 7/10"), qualified
// as the design's or review's ("overall design rating"), or awarded by a
// scoring verb ("I'd rate this page a 6"). Returns the offending excerpt.
export function modelEvaluation(prose: string): string | undefined {
  for (const raw of prose.split(/[.!?;](?=\s|$)|\n/)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    const match =
      evaluative(TERM_THEN_VALUE, sentence, true) ??
      evaluative(VALUE_THEN_TERM, sentence, true) ??
      evaluative(QUALIFIED_TERM, sentence, true) ??
      scorerMatch(sentence) ??
      (WORK.test(sentence) ? evaluative(AWARD, sentence, false) : undefined);
    if (match !== undefined) return excerpt(sentence, match.index);
  }
  return undefined;
}
