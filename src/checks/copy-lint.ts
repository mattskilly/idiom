import { copyTermKey, mergeCopyTerms } from "../copy-policy.js";
import {
  codeTags,
  isVisuallyHidden,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const camelAllow = new Set([
  "iPhone",
  "iPad",
  "iPod",
  "iOS",
  "iPadOS",
  "macOS",
  "watchOS",
  "tvOS",
  "visionOS",
  "iCloud",
  "iMessage",
  "eBay",
  "eSIM",
  "eCommerce",
  "xAI",
]);
const camelToken = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
const dottedToken =
  /\b(?:color|colors|colour|space|spacing|type|typography|radius|radii|font|fonts|shadow|shadows|size|sizes|token|tokens|theme|border|z)\.[a-z][\w.-]*\b/gi;
const slashToken = /\b([A-Z][a-z]+)\/([A-Z][a-z]+)\b/g;
const slashAllow = new Set([
  "Yes/No",
  "On/Off",
  "Read/Write",
  "Input/Output",
  "Light/Dark",
  "Show/Hide",
  "Open/Close",
  "Start/End",
  "Before/After",
  "Min/Max",
  "Mac/Windows",
  "Day/Night",
  "Buy/Sell",
  "Pros/Cons",
]);
const xOnX = /\b(\p{L}[\p{L}-]*)\s+on\s+\1\b/iu;
const doubled = /\b(\p{L}{3,})\s+\1\b/iu;

/** en-GB spelling → en-US spelling. Word-boundary matched, case-insensitive. */
const localePairs: Array<[string, string]> = [
  ["colour", "color"],
  ["colours", "colors"],
  ["organise", "organize"],
  ["organised", "organized"],
  ["favourite", "favorite"],
  ["favourites", "favorites"],
  ["behaviour", "behavior"],
  ["centre", "center"],
  ["centred", "centered"],
  ["grey", "gray"],
  ["customise", "customize"],
  ["customised", "customized"],
  ["optimise", "optimize"],
  ["optimised", "optimized"],
  ["recognise", "recognize"],
  ["analyse", "analyze"],
  ["catalogue", "catalog"],
  ["licence", "license"],
  ["cancelled", "canceled"],
  ["modelling", "modeling"],
  ["labelled", "labeled"],
  ["synchronise", "synchronize"],
  ["prioritise", "prioritize"],
  ["summarise", "summarize"],
  ["visualise", "visualize"],
  ["personalise", "personalize"],
];

const canadianBritish = new Set([
  "colour",
  "colours",
  "favourite",
  "favourites",
  "behaviour",
  "centre",
  "centred",
  "grey",
  "catalogue",
  "cancelled",
  "modelling",
  "labelled",
]);

function preferredSpelling(
  locale: string,
  gb: string,
  us: string,
): string | undefined {
  if ((locale === "en-CA" || locale === "en-AU") && gb === "licence")
    return undefined;
  if (locale === "en-CA") return canadianBritish.has(gb) ? gb : us;
  return locale === "en-US" ? us : gb;
}

function matchCase(word: string, replacement: string): string {
  if (word === word.toUpperCase()) return replacement.toUpperCase();
  if (/^[A-Z]/.test(word))
    return replacement[0]?.toUpperCase() + replacement.slice(1);
  return replacement;
}

function escapePattern(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Visible copy that leaks implementation (token names, camelCase keys),
 * stutters ("On primary on primary"), mixes casing among sibling labels, or
 * mixes locales. A configurable glossary bans or prefers specific terms.
 */
export const copyLintCheck: DeterministicCheck = {
  id: "copy-lint",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    const report = (
      rule: string,
      selector: string,
      explanation: string,
      acceptance: string,
      severity: "major" | "minor" = "minor",
      params: Record<string, string> = {},
      fingerprintHint?: string,
    ) => {
      const key = `${rule}\u0000${explanation}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        category: this.id,
        severity,
        rule,
        selectorHint: selector,
        ...(fingerprintHint === undefined ? {} : { fingerprintHint }),
        explanation,
        acceptance: [acceptance],
        verification: verify(this.id, { selector, rule, ...params }),
      });
    };
    const copy = observed.elements.filter(
      (element) =>
        !isVisuallyHidden(element) &&
        !codeTags.has(element.tag) &&
        !/(?:^|\/)(?:pre|code|kbd|samp|textarea)\[/.test(
          element.structuralPath,
        ) &&
        element.directText.trim() !== "" &&
        element.attributes.translate !== "no",
    );
    const retired = mergeCopyTerms(config.copy.retired);
    const retiredKeys = new Set(
      retired.map((entry) => copyTermKey(entry.term)),
    );
    const jargon = mergeCopyTerms(config.copy.jargon).filter(
      (entry) => !retiredKeys.has(copyTermKey(entry.term)),
    );
    const policyKeys = new Set(
      [...retired, ...jargon].map((entry) => copyTermKey(entry.term)),
    );
    const policies = [
      ...retired.map((entry) => ({
        ...entry,
        rule: "idiom:retired-term",
        pattern: new RegExp(escapePattern(entry.term), "iu"),
      })),
      ...jargon.map((entry) => ({
        ...entry,
        rule: "idiom:jargon-in-copy",
        pattern: new RegExp(
          `(?<![\\p{L}\\p{N}])${escapePattern(entry.term)}(?![\\p{L}\\p{N}])`,
          "iu",
        ),
      })),
    ];
    const glossary = config.copy.glossary
      .filter((entry) => !policyKeys.has(copyTermKey(entry.term)))
      .map((entry) => ({
        ...entry,
        pattern: new RegExp(
          `(?<![\\p{L}\\p{N}])${entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
          "iu",
        ),
      }));
    const schemaWords = config.copy.schemaWords.map((word) => ({
      word,
      pattern: new RegExp(
        `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      ),
    }));
    const usage = new Map<string, { gb: string[]; us: string[] }>();
    for (const element of copy) {
      const text = element.directText.replace(/\s+/g, " ").trim();
      // An identifier is a leak when it *is* the label; inside a sentence it
      // is usually deliberate (release notes, changelog mock-ups).
      const labelLike = words(text).length <= 4;
      for (const match of labelLike ? text.matchAll(camelToken) : []) {
        if (camelAllow.has(match[0])) continue;
        report(
          "idiom:engineering-token-in-copy",
          element.selector,
          `"${text}" (${element.selector}) shows the code identifier "${match[0]}" to people.`,
          `${element.selector} uses a human label instead of "${match[0]}".`,
          "major",
        );
      }
      for (const match of text.matchAll(dottedToken))
        report(
          "idiom:engineering-token-in-copy",
          element.selector,
          `"${text}" (${element.selector}) shows the raw token path "${match[0]}".`,
          `${element.selector} names the value in words, not as "${match[0]}".`,
          "major",
        );
      for (const match of labelLike ? text.matchAll(slashToken) : []) {
        if (slashAllow.has(match[0])) continue;
        report(
          "idiom:engineering-token-in-copy",
          element.selector,
          `"${text}" (${element.selector}) shows the token group path "${match[0]}".`,
          `${element.selector} uses a human label instead of "${match[0]}".`,
        );
      }
      const stutter = text.match(xOnX) ?? text.match(doubled);
      if (stutter !== null)
        report(
          "idiom:repeated-words",
          element.selector,
          `"${text}" (${element.selector}) repeats itself ("${stutter[0]}").`,
          `${element.selector} reads naturally without the repeated "${stutter[1]}".`,
          "major",
        );
      for (const entry of policies) {
        if (!entry.pattern.test(text)) continue;
        report(
          entry.rule,
          element.selector,
          `"${text}" (${element.selector}) uses "${entry.term}"; replace it with "${entry.preferred}".`,
          `${element.selector} replaces "${entry.term}" with "${entry.preferred}" within "${text}".`,
          "minor",
          { term: entry.term, preferred: entry.preferred },
          JSON.stringify([
            element.selector,
            entry.rule,
            copyTermKey(entry.term),
          ]),
        );
      }
      for (const entry of glossary)
        if (entry.pattern.test(text))
          report(
            "idiom:glossary-term",
            element.selector,
            `"${text}" (${element.selector}) uses "${entry.term}"${entry.preferred === undefined ? ", which the glossary bans" : `; the glossary prefers "${entry.preferred}"`}.`,
            entry.preferred === undefined
              ? `${element.selector} does not use "${entry.term}".`
              : `${element.selector} says "${entry.preferred}" instead of "${entry.term}".`,
          );
      for (const entry of schemaWords)
        if (entry.pattern.test(text))
          report(
            "idiom:schema-word-in-copy",
            element.selector,
            `"${text}" (${element.selector}) exposes the internal schema word "${entry.word}".`,
            `${element.selector} describes the thing in product language, not as "${entry.word}".`,
          );
      for (const [gb, us] of localePairs) {
        if (config.copy.locale !== undefined) {
          const preferred = preferredSpelling(config.copy.locale, gb, us);
          if (preferred === undefined) continue;
          const incorrect = preferred === gb ? us : gb;
          const match = text.match(new RegExp(`\\b${incorrect}\\b`, "i"));
          if (match) {
            const replacement = matchCase(match[0], preferred);
            report(
              "idiom:mixed-locale-spelling",
              element.selector,
              `"${text}" (${element.selector}) uses "${match[0]}"; ${config.copy.locale} prefers "${replacement}".`,
              `${element.selector} replaces "${match[0]}" with "${replacement}" for ${config.copy.locale}.`,
              "minor",
              {
                term: match[0],
                preferred: replacement,
                locale: config.copy.locale,
              },
            );
          }
          continue;
        }
        const pairKey = us;
        const lower = text.toLowerCase();
        const found = (word: string) => new RegExp(`\\b${word}\\b`).test(lower);
        const record = usage.get(pairKey) ?? { gb: [], us: [] };
        if (found(gb)) record.gb.push(`${element.selector}|${gb}|${text}`);
        if (found(us)) record.us.push(`${element.selector}|${us}|${text}`);
        usage.set(pairKey, record);
      }
    }
    const allGb = [...usage.values()].flatMap((entry) => entry.gb);
    const allUs = [...usage.values()].flatMap((entry) => entry.us);
    const locale =
      config.copy.locale ??
      (allGb.length > 0 && allUs.length > 0
        ? allGb.length > allUs.length
          ? "en-GB"
          : "en-US"
        : undefined);
    const wrong = locale === "en-US" ? allGb : locale === "en-GB" ? allUs : [];
    for (const entry of wrong) {
      const [selector = "document", word = "", text = ""] = entry.split("|");
      report(
        "idiom:mixed-locale-spelling",
        selector,
        `"${text}" (${selector}) spells "${word}" in ${locale === "en-US" ? "British" : "American"} English, while the product is ${locale}${config.copy.locale === undefined ? " (by majority of observed spellings)" : ""}.`,
        `${selector} uses the ${locale} spelling.`,
      );
    }
    // Casing: the same word, in a non-initial position, capitalised in one
    // sibling label and lowercase in another ("Link On Background" beside
    // "Primary on background", "Coding Sessions" beside "Coding sessions").
    // Comparing shared words, not whole-label styles, leaves proper nouns
    // ("Stripe Sigma" among sentence-case links) alone. Declared proper nouns
    // (checks.copy.properNouns, matched case-sensitively) drop out of the
    // comparison, and so does an item marked data-idiom-name in a list or
    // grid collection: a picker of pattern names is a list of names.
    const properNouns = (config.copy.properNouns ?? []).map(
      (noun) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}])${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
          "gu",
        ),
    );
    const comparedWords = (text: string): string[] => {
      const named = properNouns.flatMap((pattern) =>
        [...text.matchAll(pattern)].map(
          (match) => [match.index, match.index + match[0].length] as const,
        ),
      );
      return [...text.matchAll(/\S+/g)]
        .slice(1)
        .filter(
          (match) =>
            !named.some(
              ([start, end]) =>
                match.index < end && match.index + match[0].length > start,
            ),
        )
        .map((match) => match[0]);
    };
    // Every observed element, not just signalled ones, so ancestors resolve.
    const byPath = new Map(
      (tuple.observations?.version === 2
        ? tuple.observations.elements
        : []
      ).map((element) => [element.structuralPath, element]),
    );
    const ancestry = (path: string) => {
      const chain = [];
      for (
        let end = path.length;
        end > 0;
        end = path.lastIndexOf("/", end - 1)
      ) {
        const element = byPath.get(path.slice(0, end));
        if (element !== undefined) chain.push(element);
      }
      return chain;
    };
    const collectionRoles = new Set([
      "list",
      "listitem",
      "grid",
      "gridcell",
      "row",
      "listbox",
      "option",
      "feed",
    ]);
    const namedInCollection = (path: string): boolean => {
      const chain = ancestry(path);
      const carrier = chain.findIndex(
        (element) => element.attributes["data-idiom-name"] !== undefined,
      );
      return (
        carrier !== -1 &&
        chain
          .slice(carrier)
          .some(
            (element) =>
              ["ul", "ol", "li", "table", "tr"].includes(element.tag) ||
              collectionRoles.has(element.attributes.role ?? "") ||
              ["grid", "inline-grid"].includes(element.styles.display),
          )
      );
    };
    const siblings = new Map<
      string,
      Array<{ selector: string; text: string }>
    >();
    for (const element of copy) {
      const text = element.directText.replace(/\s+/g, " ").trim();
      if (words(text).length > 6 || text.length > 60 || /[.!?]$/.test(text))
        continue;
      if (element.styles.textTransform !== "none") continue;
      if (namedInCollection(element.structuralPath)) continue;
      const key = [
        element.stableIslandPath,
        element.tag,
        element.styles.fontSize,
        element.styles.fontWeight,
      ].join("|");
      siblings.set(key, [
        ...(siblings.get(key) ?? []),
        { selector: element.selector, text },
      ]);
    }
    for (const group of siblings.values()) {
      if (group.length < 2) continue;
      const forms = new Map<string, Map<"upper" | "lower", typeof group>>();
      for (const entry of group) {
        for (const word of comparedWords(entry.text)) {
          if (!/^\p{L}[\p{L}'’-]*$/u.test(word) || /^\p{Lu}{2,}/u.test(word))
            continue;
          const form = /^\p{Lu}/u.test(word) ? "upper" : "lower";
          const byForm = forms.get(word.toLowerCase()) ?? new Map();
          byForm.set(form, [...(byForm.get(form) ?? []), entry]);
          forms.set(word.toLowerCase(), byForm);
        }
      }
      for (const [word, byForm] of forms) {
        const upper = byForm.get("upper") ?? [];
        const lower = byForm.get("lower") ?? [];
        if (upper.length === 0 || lower.length === 0) continue;
        const [minority, majority] =
          upper.length <= lower.length ? [upper, lower] : [lower, upper];
        for (const entry of minority)
          report(
            "idiom:mixed-label-casing",
            entry.selector,
            `"${entry.text}" (${entry.selector}) writes "${word}" ${minority === upper ? "capitalised" : "in lowercase"}, while the sibling label "${majority[0]?.text}" writes it ${minority === upper ? "in lowercase" : "capitalised"}.`,
            "Sibling labels share one casing convention.",
          );
      }
    }
    return ran(this.id, candidates);
  },
};
