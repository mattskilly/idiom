import {
  isVisuallyHidden,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

const signatures: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\b(?:renderer|render|rendering) failed\b/i,
    label: "a render failure",
  },
  {
    pattern: /\bfailed to (?:load|render|fetch|compile|parse)\b/i,
    label: "a load failure",
  },
  {
    pattern:
      /\b(?:something went wrong|unexpected error|internal server error|application error)\b/i,
    label: "a generic error",
  },
  {
    pattern:
      /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Unhandled(?: Runtime)? Error)\b/,
    label: "a JavaScript exception",
  },
  {
    pattern:
      /\b(?:cannot read propert(?:y|ies) of|is not a function|is not defined|undefined is not)\b/i,
    label: "a JavaScript exception",
  },
  {
    pattern: /\b(?:ECONNREFUSED|EPIPE|ENOENT|ETIMEDOUT|EACCES)\b/,
    label: "a system error code",
  },
  {
    pattern: /\bat [\w.<>$]+ \((?:[\w/.:-]+):\d+:\d+\)/,
    label: "a stack trace",
  },
  { pattern: /\[object Object\]/, label: "an unrendered object" },
  { pattern: /^\s*(?:undefined|null|NaN)\s*$/, label: "an unrendered value" },
  { pattern: /^\s*[{[]\s*"[\w-]+"\s*:/, label: "raw JSON" },
];

/**
 * Error text that reached the screen: "Renderer failed" thumbnails, raw
 * exceptions, stack traces, JSON blobs and [object Object]. A flow's own
 * error states are expected to show messages; only engineering-shaped
 * failures are reported.
 */
export const errorTextCheck: DeterministicCheck = {
  id: "error-text",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const custom = config.errorPatterns.map((pattern) => ({
      pattern: new RegExp(pattern, "i"),
      label: "a configured error signature",
    }));
    const groups = new Map<
      string,
      { selectors: string[]; text: string; label: string }
    >();
    for (const element of observed.elements) {
      if (
        isVisuallyHidden(element) ||
        ["script", "style", "noscript", "template"].includes(element.tag)
      )
        continue;
      const text = element.directText.replace(/\s+/g, " ").trim();
      if (text === "") continue;
      const match = [...signatures, ...custom].find((entry) =>
        entry.pattern.test(text),
      );
      if (match === undefined) continue;
      const key = `${match.label}\u0000${text.slice(0, 120)}`;
      const group = groups.get(key);
      if (group === undefined)
        groups.set(key, {
          selectors: [element.selector],
          text,
          label: match.label,
        });
      else group.selectors.push(element.selector);
    }
    const candidates: FindingCandidate[] = [];
    for (const group of groups.values()) {
      const first = group.selectors[0];
      if (first === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:visible-error-text",
        selectorHint: first,
        explanation: `${group.label[0]?.toUpperCase()}${group.label.slice(1)} is visible to people: "${group.text.slice(0, 160)}"${group.selectors.length > 1 ? ` in ${group.selectors.length} places (${group.selectors.slice(0, 3).join(", ")}${group.selectors.length > 3 ? ", …" : ""})` : ` (${first})`}.`,
        acceptance: [
          "No engineering error text is visible; failures render a designed fallback with a recovery action.",
        ],
        verification: verify(this.id, { selector: first }),
      });
    }
    return ran(this.id, candidates);
  },
};
