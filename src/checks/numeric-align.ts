import { defaultChecksSettings } from "../schemas/project.js";
import {
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const RULE = "idiom:numeric-align";

/** A mostly numeric column set left-aligned or with proportional figures. */
export const numericAlignCheck: DeterministicCheck = {
  id: "numeric-align",
  run({ tuple, config }) {
    const settings = config.numericAlign ?? defaultChecksSettings.numericAlign;
    if (!settings.enabled) return skipped(this.id, "numericAlign");
    const scan = v2Observations(tuple)?.numericColumns;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the numeric-align scan (recapture)",
      );
    const candidates: FindingCandidate[] = scan.records.map((record) => {
      const name =
        record.header === ""
          ? `column ${record.column + 1}`
          : `the "${record.header}" column`;
      const problems = record.problems.map((problem) =>
        problem === "left-aligned"
          ? "left-aligned, so digits of different lengths do not line up"
          : "set in proportional figures (no tabular-nums), so digits differ in width",
      );
      const fixes = record.problems.map((problem) =>
        problem === "left-aligned"
          ? "right-aligned (or aligned on the decimal point)"
          : "set with font-variant-numeric: tabular-nums",
      );
      return {
        category: this.id,
        severity: "minor",
        rule: RULE,
        selectorHint: record.container,
        fingerprintHint: `numeric-align:${record.container}:${record.column}`,
        explanation: `In ${record.container}, ${name} holds numbers in ${record.numeric} of ${record.cells} cells (such as ${record.example}) and is ${problems.join(", and ")} at ${tuple.width}px.`,
        acceptance: [
          `At ${tuple.width}px, the numbers in ${name} of ${record.container} are ${fixes.join(" and ")}.`,
        ],
        verification: verify(this.id, {
          selector: record.container,
          kind: record.kind,
          column: record.column,
          viewportWidth: tuple.width,
          problems: record.problems,
        }),
      };
    });
    return scanResult(this.id, candidates, scan);
  },
};
