import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { structuralMask } from "../autobuild/wiring.js";
import { markedBlock, markers, newlineOf, sectionSpan } from "./sections.js";
import type { Writer } from "./types.js";

export const LANDING_REASON =
  "Tickets labelled design-review wait for a person before merging.";
export function landingWriter(source: string): Writer {
  const original = parse(source);
  const owned = sectionSpan(source, markers("autobuild-landing"));
  const clean = owned
    ? source.slice(0, owned.start) +
      source.slice(owned.end).replace(/^\r?\n/, "")
    : source;
  const document = parse(clean);
  const rules = document.landing;
  if (rules !== undefined && !Array.isArray(rules))
    throw new Error(
      "Unsupported landing syntax; add a [[landing]] design-review consent rule manually before other rules",
    );
  const mask = structuralMask(clean);
  const headers = [...mask.matchAll(/^[\t ]*\[\[landing\]\][\t ]*\r?$/gm)];
  if ((Array.isArray(rules) ? rules.length : 0) !== headers.length)
    throw new Error(
      "Inline/quoted landing arrays require a manual [[landing]] addition before other rules",
    );
  // An unowned equivalent is effective only before any rule that could match its label.
  for (const value of Array.isArray(rules) ? rules : []) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      value instanceof Date
    )
      break;
    const rule = value as Record<string, unknown>;
    if (
      rule.label === "design-review" &&
      rule.mode === "consent" &&
      rule.from === undefined &&
      rule.into === undefined
    )
      return {
        candidate: owned ? clean : source,
        reason: `${LANDING_REASON} Existing effective rule retained without adopting it.`,
      };
    if (rule.label === undefined || rule.label === "design-review") break;
  }
  const newline = newlineOf(source);
  const position = headers[0]?.index ?? clean.length;
  const prefix = clean.slice(0, position);
  const block = markedBlock(
    "autobuild-landing",
    '[[landing]]\nlabel = "design-review"\nmode = "consent"',
    newline,
  );
  const candidate =
    prefix +
    (prefix.length && !prefix.endsWith("\n") ? newline : "") +
    block +
    newline +
    clean.slice(position);
  const result = parse(candidate);
  const { landing: _old, ...other } = document;
  const { landing: resultRules, ...resultOther } = result;
  if (
    !isDeepStrictEqual(other, resultOther) ||
    !isDeepStrictEqual((resultRules as unknown[]).slice(1), rules ?? [])
  )
    throw new Error(
      "Landing edit would change unrelated configuration; add the rule manually",
    );
  if (owned && isDeepStrictEqual(original, result) && source === candidate)
    return { candidate: source, reason: LANDING_REASON };
  return { candidate, reason: LANDING_REASON };
}
