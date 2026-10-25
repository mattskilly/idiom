import type { CompareFinding, CompareResult } from "./run.js";

type ReportInput = Omit<
  CompareResult,
  "outputDirectory" | "reportPath" | "manifestPath"
>;

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function tupleLabel(tuple: {
  state: string;
  viewport: string;
  colorScheme?: string | undefined;
  combination?: string | undefined;
}): string {
  return (
    [
      tuple.state,
      tuple.viewport,
      ...(tuple.colorScheme === undefined ? [] : [tuple.colorScheme]),
    ].join(" / ") +
    (tuple.combination === undefined ? "" : ` (${tuple.combination})`)
  );
}

function findingsTable(findings: CompareFinding[]): string[] {
  if (findings.length === 0) return ["None."];
  return [
    "| Severity | Category | Rule | Tuple | Selector |",
    "| --- | --- | --- | --- | --- |",
    ...findings.map(
      (finding) =>
        `| ${finding.severity} | ${finding.category} | ${cell(finding.rule)} | ${cell(finding.key)} | \`${cell(finding.selector)}\` |`,
    ),
  ];
}

function tupleList(
  heading: string,
  tuples: Array<Parameters<typeof tupleLabel>[0] & { reason?: string }>,
): string[] {
  if (tuples.length === 0) return [];
  return [
    `## ${heading}`,
    "",
    ...tuples.map(
      (tuple) =>
        `- ${tupleLabel(tuple)}${tuple.reason === undefined ? "" : ` — ${tuple.reason}`}`,
    ),
    "",
  ];
}

/** The `before-after.md` a compare output carries as its report attachment. */
export function renderCompareReport(input: ReportInput): string {
  const lines = [
    `# Comparison: ${input.flow}`,
    "",
    `- Before: \`${input.before.runId}\` at \`${input.before.commit.slice(0, 12)}\``,
    `- After: \`${input.after.runId}\` at \`${input.after.commit.slice(0, 12)}\``,
    "",
    `${input.changed.length} changed, ${input.unchanged.length} unchanged, ${input.notComparable.length} not comparable · ${input.newFindings.length} new, ${input.fixedFindings.length} fixed finding(s).`,
    "",
    "## Changed tuples",
    "",
    ...(input.changed.length === 0
      ? ["None.", ""]
      : [
          "| Kind | State | Viewport | Scheme | Pixels changed | Composite |",
          "| --- | --- | --- | --- | --- | --- |",
          ...input.changed.map(
            (tuple) =>
              `| \`${tuple.kind}\` | ${cell(tuple.state)} | ${cell(tuple.viewport)} | ${tuple.colorScheme ?? "—"} | ${tuple.differentPixels} of ${tuple.totalPixels} (${((tuple.differentPixels / Math.max(1, tuple.totalPixels)) * 100).toFixed(2)}%) | [before / after](${tuple.path}) |`,
          ),
          "",
        ]),
    "## Unchanged tuples",
    "",
    ...(input.unchanged.length === 0
      ? ["None.", ""]
      : [...input.unchanged.map((tuple) => `- ${tupleLabel(tuple)}`), ""]),
    ...tupleList("Only in before", input.onlyBefore),
    ...tupleList("Only in after", input.onlyAfter),
    ...tupleList("Not comparable", input.notComparable),
    "## New findings",
    "",
    ...findingsTable(input.newFindings),
    "",
    "## Fixed findings",
    "",
    ...findingsTable(input.fixedFindings),
    "",
    "Report attachment kind: `idiom-verify-report` (`before-after.md`).",
    "",
  ];
  return lines.join("\n");
}
