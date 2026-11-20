import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readDecisionLogEntries } from "../../decisions/log.js";
import { evidenceCatches, readLearnedLog } from "../../learn/misses.js";
import { readRules, ruleMatches } from "../../rules/index.js";
import { parseRulingBlocks } from "../../rulings/law.js";
import type { LearnedEntry } from "../../schemas/learned.js";
import type { Rules } from "../../schemas/rules.js";
import type { RulingResolution } from "../../schemas/ruling.js";
import type { WordsSource } from "./types.js";

/** Everything a project records in its director's words. */
export type DirectorSources = {
  learned: LearnedEntry[];
  rules: Rules;
  /** Rulings recorded through decisions (`.idiom/decisions.jsonl`). */
  rulings: RulingResolution[];
  /** Recorded ruling blocks in DESIGN.md. */
  design: RulingResolution[];
};

export type WordsSubject = {
  id: string;
  flow: string;
  state: string;
  rule: string;
  category: string;
  fingerprint?: string | undefined;
  /** The finding's own explanation and measured summary. */
  explanation: string;
};

export type DirectorWords = { text: string; source: WordsSource; ref: string };

/** Read the project's learned log, rules, rulings and DESIGN.md once. */
export async function loadDirectorSources(
  projectDirectory: string,
  designFile = "DESIGN.md",
): Promise<DirectorSources> {
  const learned = await readLearnedLog(projectDirectory).catch(() => []);
  const rules = await readRules(projectDirectory).catch(
    (): Rules => ({ version: 1, overrides: [] }),
  );
  const rulings = await readDecisionLogEntries(projectDirectory)
    .then((entries) =>
      entries.flatMap((entry) =>
        entry.decision === "ruling" ? [entry.resolution] : [],
      ),
    )
    .catch(() => []);
  let design: RulingResolution[] = [];
  try {
    design = parseRulingBlocks(
      await readFile(resolve(projectDirectory, designFile), "utf8"),
    ).resolutions;
  } catch {
    /* No DESIGN.md, or no parseable ruling block: nothing to cite. */
  }
  return { learned, rules, rulings, design };
}

const rulingText = (ruling: RulingResolution) =>
  [ruling.wording ?? "", ruling.reason ? `Reason: ${ruling.reason}` : ""]
    .filter(Boolean)
    .join(" ");

const cites = (text: string, id: string) =>
  new RegExp(`(^|[^\\w-])${id}(?![\\w-])`).test(text);

/**
 * The rule a finding breaks, in the director's words where the project has
 * them: a learned catch, a ruling the finding cites, a rules.json override's
 * reason, a DESIGN.md ruling naming the rule; else the shipped rule reference.
 * The source is always labelled, so shipped text never passes as the director's.
 */
export function directorWords(
  finding: WordsSubject,
  sources: DirectorSources,
): DirectorWords {
  // 1. A learned catch covering this rule: same flow and state first.
  const learned = sources.learned.filter(
    (entry) =>
      evidenceCatches(entry, {
        rule: finding.rule,
        category: finding.category,
      }) !== undefined,
  );
  const entry =
    learned.find(
      (item) => item.flow === finding.flow && item.state === finding.state,
    ) ??
    learned.find((item) => item.flow === finding.flow) ??
    learned[0];
  if (entry !== undefined)
    return { text: entry.observation, source: "learned", ref: entry.id };
  // 2. A ruling the finding cites, or one a learned entry for this check names.
  const linked = new Set(
    sources.learned.flatMap((item) =>
      item.target.rulingId !== undefined &&
      item.target.check === finding.category
        ? [item.target.rulingId]
        : [],
    ),
  );
  const cited = sources.rulings.find(
    (ruling) =>
      ruling.outcome === "rule" &&
      (cites(finding.explanation, ruling.id) || linked.has(ruling.id)),
  );
  if (cited !== undefined)
    return { text: rulingText(cited), source: "ruling", ref: cited.id };
  // 3. A rules.json severity override that matches, by its reason.
  const override = [...sources.rules.overrides].reverse().find(
    (item) =>
      item.action === "severity" &&
      ruleMatches(item, {
        fingerprint: finding.fingerprint ?? "",
        category: finding.category as never,
        flow: finding.flow,
        state: finding.state,
        rule: finding.rule,
      }),
  );
  if (override !== undefined)
    return {
      text: override.reason,
      source: "rules",
      ref: `.idiom/rules.json#${override.id}`,
    };
  // 4. A DESIGN.md recorded ruling that names the rule or its check.
  const named = sources.design.find(
    (ruling) =>
      ruling.outcome === "rule" &&
      (linked.has(ruling.id) ||
        (finding.rule !== "" &&
          (ruling.wording ?? "").includes(finding.rule)) ||
        cites(ruling.wording ?? "", finding.category)),
  );
  if (named !== undefined)
    return {
      text: rulingText(named),
      source: "design",
      ref: `DESIGN.md#${named.id}`,
    };
  // 5. The shipped rule itself.
  return {
    text: `${finding.rule || finding.category}: ${finding.explanation}`,
    source: "rule-reference",
    ref: `https://idiom.build/docs/rules#${finding.category}`,
  };
}
