import {
  interactiveAncestry,
  isVisuallyHidden,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** Arrows, geometric shapes, bullets, box drawing and the multiplication sign. */
const glyph = /[←-⇿─-╿■-◿☀-⛿✀-➿•·×⋮⋯…‹›«»☰-☷✕-✗➕-➗⬀-⯿]/u;
const onlyGlyphs = new RegExp(`^(?:${glyph.source}|\\s)+$`, "u");
const leadingGlyph = new RegExp(`^(${glyph.source})\\s+\\S`, "u");

/**
 * Unicode symbols standing in for icons inside interactive chrome (▾ ▸ ◆ ◉
 * ▣ ↗ ×). They render with whatever font is at hand, misalign with the icon
 * set, and read as unfinished. Allow-list deliberate ones with
 * checks.glyphAllow.
 */
export const glyphIconCheck: DeterministicCheck = {
  id: "glyph-icon",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const inside = interactiveAncestry(observed.elements);
    const bySelector = new Map(
      observed.elements.map((element) => [element.selector, element]),
    );
    const arrow = /^[\u2190-\u21FF]$/u;
    const allowed = new Set(config.glyphAllow);
    const groups = new Map<string, string[]>();
    for (const element of observed.elements) {
      if (isVisuallyHidden(element) || !inside(element)) continue;
      if (element.attributes["aria-hidden"] === "true" && element.tag === "svg")
        continue;
      const text = element.directText.trim();
      if (text === "") continue;
      const symbols = onlyGlyphs.test(text)
        ? [...text.replace(/\s+/g, "")]
        : (() => {
            const match = text.match(leadingGlyph);
            return match?.[1] === undefined ? [] : [match[1]];
          })();
      // A trailing arrow beside a real label ("Learn more →") is a common
      // adornment, not a substitute icon; the arrow alone, or leading a
      // tab label ("↗ Export"), is.
      const control = element.interactive
        ? element
        : element.ancestorSelectors
            .map((selector) => bySelector.get(selector))
            .find((ancestor) => ancestor?.interactive);
      const adornment =
        !element.interactive &&
        control !== undefined &&
        /\p{L}{2}/u.test(control.text) &&
        !control.text.trim().startsWith(text);
      for (const symbol of symbols) {
        if (allowed.has(symbol)) continue;
        if (adornment && arrow.test(symbol)) continue;
        groups.set(symbol, [...(groups.get(symbol) ?? []), element.selector]);
      }
    }
    const candidates: FindingCandidate[] = [];
    for (const [symbol, selectors] of groups) {
      const first = selectors[0];
      if (first === undefined) continue;
      const code = `U+${(symbol.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:unicode-glyph-icon",
        selectorHint: first,
        explanation: `The text glyph "${symbol}" (${code}) is used as an icon in ${selectors.length} control${selectors.length === 1 ? "" : "s"} (${selectors.slice(0, 4).join(", ")}${selectors.length > 4 ? ", …" : ""}) instead of the product's icon set.`,
        acceptance: [
          `Controls use an icon from the product's icon set instead of "${symbol}", or the glyph is allow-listed in checks.glyphAllow.`,
        ],
        verification: verify(this.id, { glyph: symbol }),
      });
    }
    return ran(this.id, candidates);
  },
};
