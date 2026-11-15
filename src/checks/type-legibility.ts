import { defaultChecksSettings } from "../schemas/project.js";
import { legibilityLimits } from "./legibility-dom.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  TypeLegibilityObservation,
  TypeLegibilityReason,
} from "./types.js";

const RULE = "idiom:type-legibility";

/** Reasons whose value distinguishes problems (a size, a ratio, a spacing). */
const valued = new Set<TypeLegibilityReason>([
  "small-body",
  "small-ui",
  "tight-leading",
  "letter-spacing",
]);

const places = (count: number) =>
  count === 1 ? "in 1 place" : `in ${count} places`;

function describe(
  reason: TypeLegibilityReason,
  value: number,
  count: number,
): { problem: string; fix: string } {
  const l = legibilityLimits;
  switch (reason) {
    case "small-body":
      return {
        problem: `Body text is set at ${value}px (under ${l.bodyMinSize}px) ${places(count)}`,
        fix: `body text is at least ${l.bodyMinSize}px`,
      };
    case "small-ui":
      return {
        problem: `Interface text is set at ${value}px (under ${l.uiMinSize}px) ${places(count)}`,
        fix: `interface text is at least ${l.uiMinSize}px`,
      };
    case "tight-leading":
      return {
        problem: `Multi-line body text has a line height of ${value} times its size (under ${l.minLeading}) ${places(count)}, so lines crowd each other`,
        fix: `multi-line body text has a line height of at least ${l.minLeading}`,
      };
    case "justified":
      return {
        problem: `Body text is justified ${places(count)}, which opens uneven gaps between words`,
        fix: "body text is not justified",
      };
    case "all-caps":
      return {
        problem: `Text runs in capitals for more than ${l.capsRun} characters ${places(count)}, which is slow to read`,
        fix: `all-caps runs are at most ${l.capsRun} characters`,
      };
    case "letter-spacing":
      return {
        problem: `Body text has letter-spacing of ${value}em (beyond ±${l.maxTracking}em) ${places(count)}`,
        fix: `body text letter-spacing stays within ±${l.maxTracking}em`,
      };
  }
}

/**
 * Text set too small, too tight, justified, in long capital runs or with
 * heavy tracking. One finding per problem and value per state, so a page
 * set at 11px reports once, not once per paragraph.
 */
export const typeLegibilityCheck: DeterministicCheck = {
  id: "type-legibility",
  run({ tuple, config }) {
    const settings =
      config.typeLegibility ?? defaultChecksSettings.typeLegibility;
    if (!settings.enabled) return skipped(this.id, "typeLegibility");
    const scan = v2Observations(tuple)?.typeLegibility;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the type-legibility scan (recapture)",
      );
    const groups = new Map<string, TypeLegibilityObservation[]>();
    for (const record of scan.records) {
      const key = valued.has(record.reason)
        ? `${record.reason}:${record.value}`
        : record.reason;
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const candidates: FindingCandidate[] = [...groups].map(([key, records]) => {
      const first = records[0] as TypeLegibilityObservation;
      const selectors = [...new Set(records.map((record) => record.selector))];
      const examples = selectors.slice(0, 3);
      const { problem, fix } = describe(
        first.reason,
        first.value,
        records.length,
      );
      return {
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: first.selector,
        fingerprintHint: `type-legibility:${key}`,
        explanation: `${problem} at ${tuple.width}px, for example ${examples.join(", ")}.`,
        acceptance: [`At ${tuple.width}px, ${fix}.`],
        verification: verify(this.id, {
          reason: first.reason,
          ...(valued.has(first.reason) ? { value: first.value } : {}),
          viewportWidth: tuple.width,
          count: records.length,
          examples,
        }),
      };
    });
    return scanResult(this.id, candidates, scan);
  },
};
