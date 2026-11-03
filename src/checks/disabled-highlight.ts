import { colorDelta, ran, unavailable, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  MenuRowSample,
} from "./types.js";

const RULE = "idiom:disabled-row-highlight";
const PROPERTIES = ["backgroundColor", "color"] as const;

/** The properties a disabled row highlights exactly as the enabled row does. */
function sharedHighlight(
  row: MenuRowSample,
  reference: MenuRowSample,
): Array<(typeof PROPERTIES)[number]> {
  return PROPERTIES.filter(
    (property) =>
      colorDelta(row.rest[property], row.hovered[property]) > 0 &&
      colorDelta(reference.rest[property], reference.hovered[property]) > 0 &&
      colorDelta(row.hovered[property], reference.hovered[property]) < 1,
  );
}

/**
 * A disabled menu or list row that lights up under the pointer exactly like
 * an enabled row, so it reads as available. Measured by the probe, which
 * hovers up to three disabled rows and the first enabled row of each menu
 * it opens.
 */
export const disabledHighlightCheck: DeterministicCheck = {
  id: "disabled-highlight",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.probe === undefined)
      return unavailable(
        this.id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      );
    const candidates: FindingCandidate[] = [];
    for (const result of observation.probe.results) {
      const menu = result.menu;
      if (
        menu?.hover === undefined ||
        result.reusedFrom !== undefined ||
        result.skipped !== undefined
      )
        continue;
      const reference = menu.hover.find((sample) => !sample.disabled);
      if (reference === undefined) continue;
      const flagged = menu.hover.flatMap((sample) => {
        if (!sample.disabled) return [];
        const properties = sharedHighlight(sample, reference);
        return properties.length === 0 ? [] : [{ sample, properties }];
      });
      const first = flagged[0];
      if (first === undefined) continue;
      const nameOf = (selector: string) =>
        menu.items.find((item) => item.selector === selector)?.name ?? "";
      const rows = flagged
        .map(({ sample }) => {
          const name = nameOf(sample.selector);
          return name === ""
            ? sample.selector
            : `"${name}" (${sample.selector})`;
        })
        .join(", ");
      const highlight = first.properties
        .map(
          (property) =>
            `${property === "color" ? "text" : "background"} ${first.sample.hovered[property]}`,
        )
        .join(" and ");
      const selectors = flagged.map(({ sample }) => sample.selector);
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: first.sample.selector,
        fingerprintHint: `${RULE}|${menu.root}|${selectors.join(",")}`,
        explanation: `In the menu "${result.name || result.selector}" opens (${menu.root}), the disabled ${flagged.length === 1 ? "row" : "rows"} ${rows} ${flagged.length === 1 ? "takes" : "take"} the same hover highlight as the enabled "${nameOf(reference.selector) || reference.selector}" row (${highlight}), so ${flagged.length === 1 ? "it reads" : "they read"} as available.`,
        acceptance: [
          `Under the pointer, ${selectors.join(", ")} keep their resting background and text colour, or show a highlight distinct from enabled rows.`,
        ],
        verification: verify(this.id, {
          root: menu.root,
          trigger: result.selector,
          rows: flagged.map(({ sample, properties }) => ({
            selector: sample.selector,
            properties,
            rest: sample.rest,
            hovered: sample.hovered,
          })),
          reference: reference.hovered,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
