import { defaultChecksSettings } from "../schemas/project.js";
import { ran, skipped, unavailable, v2Observations, verify } from "./shared.js";
import type {
  CheckResult,
  DeterministicCheck,
  FindingCandidate,
  TokenObservation,
} from "./types.js";

type V2Observations = NonNullable<ReturnType<typeof v2Observations>>;

const RULE = "idiom:browser-default-style";

const linkTokenName = /(?:^|[-_])(link|accent)(?:[-_]|$)/i;

/** Link or accent colour tokens a tokens file declares (not inline tokens). */
export function linkColorTokens(tokens: TokenObservation): string[] {
  if (tokens.status !== "configured" || tokens.source === "design.tokens")
    return [];
  return Object.keys(tokens.declarations)
    .filter((name) => linkTokenName.test(name))
    .sort();
}

/** The link half: judged only when the tokens file defines a link or accent colour. */
function linkHalf(
  check: "browser-default-style",
  observation: V2Observations,
): CheckResult {
  const tokens = observation.tokens;
  if (tokens.status !== "configured" || tokens.source === "design.tokens")
    return {
      coverage: {
        check,
        status: "skipped",
        reason: "design.tokensFile is not configured",
      },
      candidates: [],
    };
  const names = linkColorTokens(tokens);
  if (names.length === 0)
    return {
      coverage: {
        check,
        status: "skipped",
        reason: "the design tokens define no link or accent colour",
      },
      candidates: [],
    };
  const links = observation.browserDefaultLinks;
  if (links === undefined)
    return unavailable(
      check,
      "observations predate the default-link scan (recapture)",
    );
  const first = links.records[0];
  if (links.count === 0 || first === undefined) return ran(check, []);
  const examples = links.records.slice(0, 3).map((link) => link.selector);
  const more = links.count > examples.length ? ", …" : "";
  const tokenList = names.map((name) => `\`${name}\``).join(", ");
  return ran(check, [
    {
      category: check,
      severity: "minor",
      rule: RULE,
      selectorHint: first.selector,
      fingerprintHint: "browser-default-style:link",
      explanation: `${links.count} link${links.count === 1 ? " uses" : "s use"} the browser's default link colour (${examples.join(", ")}${more}), though the design tokens define ${tokenList}.`,
      acceptance: [
        `Links in this state use the project's link or accent colour (${tokenList}), not the browser default.`,
      ],
      verification: verify(check, {
        count: links.count,
        selectors: links.records.map((link) => link.selector),
        colors: [...new Set(links.records.map((link) => link.color))],
        tokens: names,
      }),
    },
  ]);
}

/**
 * Fieldset legends notched into their fieldset's border (the browser's
 * default fieldset look), judged whatever the tokens; and links left in the
 * browser's default blue (or visited purple) in a project whose design
 * tokens define a link or accent colour.
 */
export const browserDefaultStyleCheck: DeterministicCheck = {
  id: "browser-default-style",
  run({ tuple, config }) {
    const settings =
      config.browserDefaultStyle ?? defaultChecksSettings.browserDefaultStyle;
    if (!settings.enabled) return skipped(this.id, "browserDefaultStyle");
    const observation = v2Observations(tuple);
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    const legendCandidates: FindingCandidate[] = [];
    const legends = observation.browserDefaultLegends;
    const firstLegend = legends?.records[0];
    if (legends !== undefined && legends.count > 0 && firstLegend) {
      const examples = legends.records
        .slice(0, 3)
        .map((legend) => legend.selector);
      const more = legends.count > examples.length ? ", …" : "";
      legendCandidates.push({
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: firstLegend.selector,
        fingerprintHint: "browser-default-style:legend",
        explanation: `${legends.count} fieldset legend${legends.count === 1 ? " sits" : "s sit"} notched into ${legends.count === 1 ? "its fieldset's" : "their fieldsets'"} border, the browser's default fieldset look (${examples.join(", ")}${more}), instead of a styled section heading.`,
        acceptance: [
          "Section headings in this state are styled headings, not legends notched into a fieldset border.",
        ],
        verification: verify(this.id, {
          count: legends.count,
          selectors: legends.records.map((legend) => legend.selector),
          fieldsets: legends.records.map((legend) => legend.fieldset),
        }),
      });
    }
    const links = linkHalf("browser-default-style", observation);
    if (legends === undefined) return links;
    if (links.coverage.status === "ran")
      return ran(this.id, [...legendCandidates, ...links.candidates]);
    return {
      coverage: {
        check: this.id,
        status: "ran",
        reason: `links not judged: ${links.coverage.reason ?? links.coverage.status}`,
      },
      candidates: legendCandidates,
    };
  },
};
