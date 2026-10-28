import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptanceDescription,
  acceptanceText,
  basisDescription,
} from "../findings/presentation.js";
import {
  type ReportCoverage,
  renderCoverageMarkdown,
} from "../report/coverage.js";
import type { AttachmentManifest } from "./attachments.js";
import type { VerificationEvaluation } from "./evaluate.js";

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function reductionText(evaluation: VerificationEvaluation): string[] {
  return evaluation.calibrations.flatMap((calibration) => {
    const reductions = calibration.baselineProfile.reductions;
    const baselineVersion = calibration.negotiated === "v1-compatible" ? 1 : 2;
    const lines = [
      `- \`${calibration.state}/${calibration.viewport}${calibration.colorScheme === undefined ? "" : `/${calibration.colorScheme}`}\`: historical observation v${baselineVersion}; current observations v2/v2; full-v2 A/B equal; negotiated \`${calibration.negotiated}\` A/B equal; deterministic result sets A/B equal.`,
      `  - Signatures: full-v2 current \`${calibration.fullV2Signature}\`; negotiated historical \`${calibration.baselineProfile.signature}\`; negotiated current \`${calibration.currentProfileB.signature}\`.`,
      `  - Historical reduction: ${reductions.excludedNonRendered} non-rendered records excluded; text suppressed for ${reductions.textSuppressedBoundary} 500-character boundaries, ${reductions.textSuppressedTemporal} temporal records, and ${reductions.textSuppressedMask} masked records; ${reductions.geometrySuppressed} geometry records suppressed.`,
    ];
    for (const mask of reductions.maskStatus)
      lines.push(
        `  - Mask \`${mask.selector}\`: A/B membership agreed; ${mask.status}; transferred paths: ${mask.paths.length === 0 ? "none" : mask.paths.map((path) => `\`${path}\``).join(", ")}.`,
      );
    return lines;
  });
}

export function renderVerificationReport(options: {
  flow: string;
  baselineRunId: string;
  currentRunA: string;
  currentRunB: string;
  evaluation?: VerificationEvaluation | undefined;
  manifest: AttachmentManifest;
  noFindings?: boolean | undefined;
  diagnostic?: string | undefined;
  reportCoverage?: ReportCoverage | undefined;
}): string {
  if (options.noFindings === true) {
    return `${[
      `# Verification: ${options.flow}`,
      "",
      "Outcome: **not applicable — no embedded findings**.",
      "",
      ...(options.reportCoverage === undefined
        ? []
        : [renderCoverageMarkdown(options.reportCoverage), ""]),
      "No setup, build, server, browser, provider, or external API was invoked.",
      "",
    ].join("\n")}\n`;
  }
  const evaluation = options.evaluation;
  if (evaluation === undefined) {
    const axisAware = options.manifest.composites.some(
      (item) => item.colorScheme !== undefined,
    );
    return `${[
      `# Verification: ${options.flow}`,
      "",
      "Outcome: **failed — verification was not safely decidable**.",
      "",
      ...(options.reportCoverage === undefined
        ? []
        : [renderCoverageMarkdown(options.reportCoverage), ""]),
      `Historical baseline: \`${options.baselineRunId}\`. Current calibration runs: \`${options.currentRunA}\` and \`${options.currentRunB}\`.`,
      "",
      `Diagnostic: ${options.diagnostic ?? "unknown comparison failure"}`,
      "",
      "No finding was marked fixed. Pixels and raw image dimensions remain evidence only.",
      "",
      "## Evidence attachments",
      "",
      axisAware
        ? "| Kind | State | Viewport | Scheme | Composite |"
        : "| Kind | State | Viewport | Composite |",
      axisAware
        ? "| --- | --- | --- | --- | --- |"
        : "| --- | --- | --- | --- |",
      ...options.manifest.composites.map((item) =>
        axisAware
          ? `| ${item.kind} | ${item.state} | ${item.viewport} | ${item.colorScheme} | [before / after](${item.path}) |`
          : `| ${item.kind} | ${item.state} | ${item.viewport} | [before / after](${item.path}) |`,
      ),
      "",
      ...filmstripMarkdown(options.manifest),
      `Report attachment kind: \`${options.manifest.report.kind}\` (\`${options.manifest.report.path}\`).`,
      "",
    ].join("\n")}\n`;
  }
  const axisAware = options.manifest.composites.some(
    (composite) => composite.colorScheme !== undefined,
  );
  const lines = [
    `# Verification: ${options.flow}`,
    "",
    `Outcome: **${evaluation.passed ? "passed" : "failed"}**.`,
    "",
    ...(options.reportCoverage === undefined
      ? []
      : [renderCoverageMarkdown(options.reportCoverage), ""]),
    `Historical baseline: \`${options.baselineRunId}\`. Current calibration runs: \`${options.currentRunA}\` and \`${options.currentRunB}\`.`,
    "",
    "Pixels and raw image dimensions are inspectable evidence only; they never determine the verdict. Date/time text and its reflow closure are excluded from verdict signatures.",
    "",
    "## Calibration and comparison basis",
    "",
    "`v2-full` includes visible rendered structure, normalized direct text, allow-listed semantic/presentation attributes, expanded computed styles, and stable-island-relative geometry. It excludes serialized HTML, comments, hidden/forbidden elements, URL/data attributes, and raw document dimensions. `v1-compatible` additionally reduces to rendered legacy subtree text below the 500-character boundary, shared legacy styles, and reconstructed ancestor-relative geometry; all v2-only fields are excluded.",
    "",
    ...reductionText(evaluation),
    "",
    "## Finding verdicts",
    "",
    "| Finding | Tuple | Verdict | Finding basis | Evidence | Target | Reason | Acceptance | Acceptance reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...evaluation.findings.map((verdict) =>
      [
        verdict.finding.id,
        `${verdict.finding.state}/${verdict.finding.viewport}${verdict.finding.colorScheme === undefined ? "" : `/${verdict.finding.colorScheme}`}`,
        verdict.status,
        basisDescription(verdict.finding),
        verdict.locus?.source ?? verdict.finding.verification.kind,
        verdict.locus?.target ?? "n/a",
        verdict.reason,
        verdict.acceptance.status,
        verdict.acceptance.reason,
      ]
        .map(cell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
    "",
    ...evaluation.findings.flatMap((verdict) => [
      `### ${cell(verdict.finding.id)} acceptance`,
      "",
      cell(acceptanceDescription(verdict.acceptance.contract)),
      "",
      ...acceptanceText(verdict.finding).map(
        (criterion) => `- Done when: ${cell(criterion)}`,
      ),
      "",
    ]),
    "## New deterministic blockers",
    "",
    ...(evaluation.newBlockers.length === 0
      ? ["None."]
      : evaluation.newBlockers.map((blocker) => `- ${blocker}`)),
    "",
    ...(evaluation.newFindings === undefined
      ? []
      : [
          "## New deterministic findings (all severities)",
          "",
          ...evaluation.newFindings.map(
            (finding) =>
              `- ${finding.severity}: ${finding.category} ${finding.rule ?? ""} at ${finding.key} (${finding.selector ?? "document"})`,
          ),
          ...(evaluation.newFindings.length ? [] : ["None."]),
          "",
        ]),
    "## Evidence attachments",
    "",
    axisAware
      ? "| Kind | State | Viewport | Scheme | Composite |"
      : "| Kind | State | Viewport | Composite |",
    axisAware ? "| --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- |",
    ...options.manifest.composites.map((composite) =>
      axisAware
        ? `| ${composite.kind} | ${composite.state} | ${composite.viewport} | ${composite.colorScheme} | [before / after](${composite.path}) |`
        : `| ${composite.kind} | ${composite.state} | ${composite.viewport} | [before / after](${composite.path}) |`,
    ),
    "",
    ...filmstripMarkdown(options.manifest),
    `Report attachment kind: \`${options.manifest.report.kind}\` (\`${options.manifest.report.path}\`).`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export async function writeVerificationReport(
  outputDirectory: string,
  source: string,
): Promise<string> {
  const path = join(outputDirectory, "before-after.md");
  await writeFile(path, source);
  return path;
}

function filmstripMarkdown(manifest: AttachmentManifest): string[] {
  return (manifest.filmstrips ?? []).flatMap((f) => [
    `### ${f.kind}: ${f.finding}`,
    "",
    f.before
      ? `Before: ![Before filmstrip](${f.before})`
      : `Before unavailable: ${f.beforeUnavailable}`,
    f.after
      ? `After: ![After filmstrip](${f.after})`
      : `After unavailable: ${f.afterUnavailable}`,
    "",
  ]);
}
