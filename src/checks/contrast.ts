import {
  axeSelector,
  axeSeverity,
  axeViolations,
  ran,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck } from "./types.js";

export const contrastCheck: DeterministicCheck = {
  id: "contrast",
  run({ tuple }) {
    if (tuple.axe === undefined) {
      return unavailable(this.id, "axe.json is unavailable");
    }
    const candidates = axeViolations(tuple.axe)
      .filter((violation) => violation.id === "color-contrast")
      .flatMap((violation) =>
        violation.nodes.map((node) => ({
          category: this.id,
          severity: axeSeverity(violation.impact),
          rule: "axe:color-contrast",
          selectorHint: axeSelector(node),
          explanation: `${axeSelector(node)} fails axe's rendered color-contrast rule.`,
          acceptance: [
            `${axeSelector(node)} meets the applicable WCAG text contrast threshold.`,
          ],
          verification: verify(this.id, { selector: axeSelector(node) }),
          axeNodes: [node],
          ...(typeof node.html === "string" ? { domSnippet: node.html } : {}),
        })),
      );
    return ran(this.id, candidates);
  },
};
