import {
  axeSelector,
  axeSeverity,
  axeViolations,
  ran,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck } from "./types.js";

const labelRules = new Set([
  "aria-command-name",
  "aria-input-field-name",
  "aria-meter-name",
  "aria-progressbar-name",
  "aria-toggle-field-name",
  "aria-tooltip-name",
  "button-name",
  "input-button-name",
  "label",
  "link-name",
  "select-name",
]);

export const a11yLabelCheck: DeterministicCheck = {
  id: "a11y-label",
  run({ tuple }) {
    if (tuple.axe === undefined) {
      return unavailable(this.id, "axe.json is unavailable");
    }
    return ran(
      this.id,
      axeViolations(tuple.axe)
        .filter((violation) => labelRules.has(violation.id))
        .flatMap((violation) =>
          violation.nodes.map((node) => ({
            category: this.id,
            severity: axeSeverity(violation.impact),
            rule: `axe:${violation.id}`,
            selectorHint: axeSelector(node),
            explanation: `${axeSelector(node)} has no accessible label according to axe rule ${violation.id}.`,
            acceptance: [
              `${axeSelector(node)} exposes a nonempty accessible name.`,
            ],
            verification: verify(this.id, {
              selector: axeSelector(node),
              axeRule: violation.id,
            }),
            axeNodes: [node],
            ...(typeof node.html === "string" ? { domSnippet: node.html } : {}),
          })),
        ),
    );
  },
};
