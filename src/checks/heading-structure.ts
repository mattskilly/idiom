import { classifyDocument } from "../document.js";
import {
  axeSelector,
  axeViolations,
  ran,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const axeHeadingRules = new Set(["heading-order", "page-has-heading-one"]);

export const headingStructureCheck: DeterministicCheck = {
  id: "heading-structure",
  run({ tuple }) {
    if (
      classifyDocument(tuple.observations?.document.contentType) === "non-html"
    )
      return {
        candidates: [],
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "Heading structure is not applicable to a non-HTML document.",
        },
      };
    if (tuple.observations === undefined && tuple.axe === undefined) {
      return unavailable(
        this.id,
        "axe.json and observations.json are unavailable",
      );
    }
    const candidates: FindingCandidate[] = [];
    const axeSelectors = new Set<string>();
    for (const violation of axeViolations(tuple.axe).filter((entry) =>
      axeHeadingRules.has(entry.id),
    )) {
      for (const node of violation.nodes) {
        const selector = axeSelector(node);
        axeSelectors.add(selector);
        candidates.push({
          category: this.id,
          severity: "minor",
          rule: `axe:${violation.id}`,
          selectorHint: selector,
          explanation: `${selector} violates the rendered heading structure (${violation.id}).`,
          acceptance: [
            violation.id === "page-has-heading-one"
              ? "The page has one visible level-one heading."
              : "Visible headings do not skip levels.",
          ],
          verification: verify(this.id, { selector, axeRule: violation.id }),
          axeNodes: [node],
          ...(typeof node.html === "string" ? { domSnippet: node.html } : {}),
        });
      }
    }
    if (tuple.observations === undefined) return ran(this.id, candidates);
    const headings = tuple.observations?.headings ?? [];
    const h1s = headings.filter((heading) => heading.level === 1);
    if (
      h1s.length === 0 &&
      !candidates.some(
        (candidate) => candidate.rule === "axe:page-has-heading-one",
      )
    ) {
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:missing-h1",
        selectorHint: "document",
        explanation: "The page has no visible level-one heading.",
        acceptance: ["The page has one visible level-one heading."],
        verification: verify(this.id),
      });
    }
    if (h1s.length > 1) {
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:multiple-h1",
        selectorHint: h1s
          .map((heading) => heading.selector)
          .sort()
          .join(" | "),
        explanation: `The page has ${h1s.length} visible level-one headings.`,
        acceptance: ["The page has exactly one visible level-one heading."],
        verification: verify(this.id),
      });
    }
    for (let index = 1; index < headings.length; index += 1) {
      const previous = headings[index - 1];
      const heading = headings[index];
      if (
        previous === undefined ||
        heading === undefined ||
        heading.level <= previous.level + 1 ||
        axeSelectors.has(heading.selector) ||
        (heading.axeTargets ?? []).some((target) => axeSelectors.has(target))
      )
        continue;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:heading-level-skip",
        selectorHint: heading.selector,
        explanation: `${heading.selector} skips from h${previous.level} to h${heading.level}.`,
        acceptance: [
          `${heading.selector} follows a heading no more than one level above it.`,
        ],
        verification: verify(this.id, { selector: heading.selector }),
      });
    }
    return ran(this.id, candidates);
  },
};
