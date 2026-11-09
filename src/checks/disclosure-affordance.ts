import { menuTriggerPattern } from "./collection-actions.js";
import { ran, unavailable, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  IndicatorSnapshot,
  ProbeResult,
} from "./types.js";

const RULE = "idiom:disclosure-affordance";

const toggled = (before: IndicatorSnapshot, after: IndicatorSnapshot) =>
  (before.expanded === "false" && after.expanded === "true") ||
  (before.expanded === "closed" && after.expanded === "open");

/** Whether anything that could show collapsed or expanded changed. */
export function indicatorChanged(
  before: IndicatorSnapshot,
  after: IndicatorSnapshot,
): boolean {
  if (before.marker || after.marker) return true;
  if (before.text !== after.text) return true;
  if (before.graphics.length !== after.graphics.length) return true;
  return before.graphics.some((graphic, index) => {
    const other = after.graphics[index];
    return (
      other === undefined ||
      other.where !== graphic.where ||
      other.signature !== graphic.signature ||
      other.visible !== graphic.visible
    );
  });
}

/**
 * A menu button whose label says what it opens needs no collapsed/expanded
 * indicator: a text-only trigger that advertises a popup ("Sort", "File")
 * names its menu, and so does a text-only or popup trigger named "More",
 * "Menu" or "Options". In-flow expanders ("Settings") are never exempt.
 */
function exemptMenuButton(
  result: ProbeResult,
  before: IndicatorSnapshot,
  after: IndicatorSnapshot,
): boolean {
  const textOnly =
    before.text !== "" &&
    !before.graphics.some((graphic) => graphic.visible) &&
    !after.graphics.some((graphic) => graphic.visible);
  const popup = result.openedDisclosure?.kind === "popup";
  if (textOnly && popup) return true;
  if (!menuTriggerPattern.test(result.name.trim())) return false;
  return textOnly || popup;
}

/** A help toggletip: its whole visible text is a help glyph, which already says it reveals an explanation. */
const helpGlyph = /^[?？ⓘℹ]\uFE0F?$/u;

/**
 * A disclosure trigger whose open state toggles with nothing on or beside
 * it (an icon, a glyph, a pseudo-element, its own text) looking different
 * collapsed and expanded, so nothing shows there is more below or that it
 * is open. Measured by the probe, which reads the trigger before its click
 * and once the opening is confirmed.
 */
export const disclosureAffordanceCheck: DeterministicCheck = {
  id: "disclosure-affordance",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.probe === undefined)
      return unavailable(
        this.id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      );
    if (observation.probe.indicators === undefined)
      return unavailable(
        this.id,
        "the probe did not record disclosure indicators (recapture, or checks.probe.disclosures is off)",
      );
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    for (const result of observation.probe.results) {
      const indicator = result.indicator;
      if (
        indicator === undefined ||
        result.reusedFrom !== undefined ||
        result.skipped !== undefined
      )
        continue;
      const { before, after } = indicator;
      if (!toggled(before, after)) continue;
      if (exemptMenuButton(result, before, after)) continue;
      if (helpGlyph.test(before.text)) continue;
      if (indicatorChanged(before, after)) continue;
      if (seen.has(result.selector)) continue;
      seen.add(result.selector);
      const name = result.name || result.selector;
      const change =
        before.expanded === "closed"
          ? "opens its details"
          : "opens content (aria-expanded false → true)";
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: result.selector,
        fingerprintHint: `${RULE}|${result.selector}`,
        explanation: `"${name}" ${change} but nothing on or beside it changes between collapsed and expanded, so nothing shows it has more below or that it is open.`,
        acceptance: [
          `${result.selector} shows an indicator inside or beside it (a chevron, caret, plus/minus or similar) that looks different collapsed and expanded.`,
        ],
        verification: verify(this.id, {
          trigger: result.selector,
          before,
          after,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
