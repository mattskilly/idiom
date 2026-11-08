import type { Finding } from "../schemas/finding.js";
import { severityRank as sharedSeverityRank } from "../schemas/severity.js";

/**
 * Most deterministic findings listed in one model prompt. Every batch or
 * session repeats this section, and the list grows with axe violation node
 * counts, so an unbounded list would crowd out evidence and multiply toward
 * the provider request limit.
 */
export const DETERMINISTIC_FINDINGS_LIMIT = 50;

/**
 * Character budget for the listed entries (each measured as compact JSON),
 * so a few very long explanations cannot outgrow the section either. The
 * bound only decides how many whole entries go in; no entry is cut.
 */
export const DETERMINISTIC_FINDINGS_CHAR_LIMIT = 20_000;

/** Most category/severity groups named in the omission summary line. */
export const DETERMINISTIC_SUMMARY_GROUP_LIMIT = 30;

export type DeterministicContextLimit = {
  state?: string | undefined;
  totalFindings: number;
  includedFindings: number;
};

export type DeterministicPromptEntry = {
  category: Finding["category"];
  severity: Finding["severity"];
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark";
  rule?: string | undefined;
  explanation: string;
};

export type DeterministicOmission = {
  category: string;
  severity: Finding["severity"];
  count: number;
};

export type BoundedDeterministicFindings = {
  entries: DeterministicPromptEntry[];
  totalFindings: number;
  includedFindings: number;
  omitted: DeterministicOmission[];
};

const severityOrder = sharedSeverityRank;

export function deterministicPromptEntry(
  finding: Finding,
): DeterministicPromptEntry {
  return {
    category: finding.category,
    severity: finding.severity,
    state: finding.state,
    viewport: finding.viewport,
    ...(finding.colorScheme === undefined
      ? {}
      : { colorScheme: finding.colorScheme }),
    rule: finding.rule,
    explanation: finding.explanation,
  };
}

/**
 * Keeps the longest input-order prefix within both limits. Callers pass
 * finalized findings (sorted severity first), so the prefix is the most
 * severe; this does not re-sort, which would change small-set output.
 */
export function boundDeterministicFindings(
  findings: Finding[],
): BoundedDeterministicFindings {
  const entries: DeterministicPromptEntry[] = [];
  let chars = 0;
  for (const finding of findings) {
    if (entries.length >= DETERMINISTIC_FINDINGS_LIMIT) break;
    const entry = deterministicPromptEntry(finding);
    const size = JSON.stringify(entry).length;
    if (chars + size > DETERMINISTIC_FINDINGS_CHAR_LIMIT) break;
    entries.push(entry);
    chars += size;
  }
  const groups = new Map<string, DeterministicOmission>();
  for (const finding of findings.slice(entries.length)) {
    const key = `${finding.category}\u0000${finding.severity}`;
    const group = groups.get(key);
    if (group === undefined)
      groups.set(key, {
        category: finding.category,
        severity: finding.severity,
        count: 1,
      });
    else group.count += 1;
  }
  return {
    entries,
    totalFindings: findings.length,
    includedFindings: entries.length,
    omitted: [...groups.values()].sort(
      (left, right) =>
        right.count - left.count ||
        left.category.localeCompare(right.category) ||
        severityOrder[left.severity] - severityOrder[right.severity],
    ),
  };
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function deterministicOmissionMarker(
  bounded: BoundedDeterministicFindings,
): string {
  const named = bounded.omitted.slice(0, DETERMINISTIC_SUMMARY_GROUP_LIMIT);
  const rest = bounded.omitted
    .slice(DETERMINISTIC_SUMMARY_GROUP_LIMIT)
    .reduce((sum, group) => sum + group.count, 0);
  const omittedCount = bounded.totalFindings - bounded.includedFindings;
  return `[deterministic findings bounded: first ${count(bounded.includedFindings)} of ${count(bounded.totalFindings)} listed; the other ${count(omittedCount)}, by category and severity: ${named
    .map(
      (group) => `${group.category} (${group.severity}) ×${count(group.count)}`,
    )
    .join(
      ", ",
    )}${rest === 0 ? "" : `, and ${count(rest)} more in other categories`}]`;
}

export function deterministicContextLimit(
  findings: Finding[],
  state?: string,
): DeterministicContextLimit | undefined {
  const bounded = boundDeterministicFindings(findings);
  if (bounded.omitted.length === 0) return undefined;
  return {
    ...(state === undefined ? {} : { state }),
    totalFindings: bounded.totalFindings,
    includedFindings: bounded.includedFindings,
  };
}

export function deterministicContextSentence(
  items: DeterministicContextLimit[],
): string {
  return `Deterministic findings context for the model was bounded (limit ${count(DETERMINISTIC_FINDINGS_LIMIT)} findings or ${count(DETERMINISTIC_FINDINGS_CHAR_LIMIT)} characters per prompt): ${items
    .map(
      (item) =>
        `${item.state === undefined ? "" : `${item.state} `}${count(item.includedFindings)} of ${count(item.totalFindings)} listed`,
    )
    .join(
      ", ",
    )}${items.length === 1 ? "," : ";"} the rest summarized by category and severity.`;
}
