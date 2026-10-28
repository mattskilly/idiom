import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { acceptanceText } from "../findings/presentation.js";
import {
  repairScopeBoundary,
  repairSiblingLines,
} from "../repair/presentation.js";
import type { CatalogFinding } from "../review/catalog.js";
import type { FindingCluster } from "./cluster.js";

export function ticketId(fingerprint: string, findingId: string): string {
  return `idiom-${createHash("sha256")
    .update(fingerprint)
    .update("\0")
    .update(findingId)
    .digest("hex")}`;
}

export function ticketIdsForIdentities(
  identities: Array<{ fingerprint: string; findingId: string }>,
): string[] {
  return [
    ...new Set(
      identities.map((identity) =>
        ticketId(identity.fingerprint, identity.findingId),
      ),
    ),
  ];
}

function markdownPath(fromDirectory: string, target: string): string {
  const path = relative(fromDirectory, resolve(target)).split(sep).join("/");
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function jsonFence(value: string): string {
  const longest = Math.max(
    0,
    ...(value.match(/`+/g) ?? []).map((sequence) => sequence.length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

export function renderTicket(options: {
  record: CatalogFinding;
  sourceFindings: CatalogFinding[];
  ticketDirectory: string;
  identity?: { fingerprint: string; findingId: string } | undefined;
  presentation?:
    | { target: CatalogFinding; siblings: CatalogFinding[] }
    | undefined;
}): { id: string; title: string; body: string } {
  const target = options.presentation?.target ?? options.record;
  const finding = findingForTicket(target.finding, options.identity);
  const id = ticketId(finding.fingerprint, finding.id);
  const title = `Resolve ${finding.category} in ${finding.state} at ${finding.viewport}${finding.colorScheme === undefined ? "" : ` (${finding.colorScheme})`}`;
  const siblings =
    options.presentation?.siblings ??
    options.sourceFindings.filter((record) => record.finding.id !== finding.id);
  const serialized = JSON.stringify(finding, null, 2);
  const fence = jsonFence(serialized);
  const screenshotLines = finding.evidence.screenshots.map(
    (screenshot, index) => {
      const absolute = resolve(target.runDirectory, screenshot);
      return `- [Screenshot ${index + 1}](${markdownPath(options.ticketDirectory, absolute)})`;
    },
  );
  const siblingLines = repairSiblingLines(siblings);
  const lines = [
    "+++",
    `id = ${JSON.stringify(id)}`,
    `title = ${JSON.stringify(title)}`,
    'labels = ["design", "idiom"]',
    "+++",
    "",
    "## What and why",
    "",
    finding.explanation,
    "",
    "## Acceptance criteria",
    "",
    ...acceptanceText(finding).map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Out of scope",
    "",
    ...siblingLines,
    repairScopeBoundary(finding),
    "- Verification, ticket promotion, dispatch, and implementation of adjacent findings.",
    "",
    "## Evidence",
    "",
    `Source review: ${target.runId}; captured commit: \`${finding.commit}\`; finding: \`${finding.id}\`.`,
    "",
    ...(screenshotLines.length === 0
      ? ["No screenshot was available for this finding."]
      : screenshotLines),
    "",
    `${fence}idiom:finding`,
    serialized,
    fence,
    "",
  ];
  return { id, title, body: `${lines.join("\n")}\n` };
}

function findingForTicket(
  finding: CatalogFinding["finding"],
  identity: { fingerprint: string; findingId: string } | undefined,
): CatalogFinding["finding"] {
  return {
    ...finding,
    id: identity?.findingId ?? finding.id,
    fingerprint: identity?.fingerprint ?? finding.fingerprint,
    // A ticket embeds the observed source record; lifecycle checkpoints live
    // in the catalog and must not make retries rewrite ticket bytes.
    status: "open",
  };
}

/** Cluster specs retain a separate, independently verifiable source block per member. */
export function renderClusterTicket(options: {
  cluster: FindingCluster;
  id: string;
  ticketDirectory: string;
  availableImages: Map<string, string[]>;
}): { id: string; title: string; body: string } {
  const { cluster, id, ticketDirectory } = options;
  const cause = cluster.cause;
  const causeTitle =
    cause === undefined ? undefined : `Resolve root cause: ${cause.cause}`;
  const title =
    causeTitle === undefined
      ? `Resolve ${cluster.members[0]?.record.finding.category ?? "findings"} in ${cluster.component}`
      : causeTitle.length > 120
        ? `${causeTitle.slice(0, 119)}…`
        : causeTitle;
  const criteria = [
    ...new Set(
      cluster.members.flatMap((member) =>
        acceptanceText(member.record.finding),
      ),
    ),
  ];
  const causeLead =
    cause === undefined
      ? []
      : [
          `${cause.cause}.`,
          "",
          `Confidence: ${cause.confidence} (${cause.kind} ${JSON.stringify(cause.key.replaceAll("\0", " "))}).`,
          ...cause.evidence.map((line) => `- ${line}`),
          ...(cause.fix === undefined
            ? []
            : ["", `Suggested fix: ${cause.fix}.`]),
          "",
          "Every finding below is a symptom of this one cause.",
          "",
        ];
  const lines = [
    "+++",
    `id = ${JSON.stringify(id)}`,
    `title = ${JSON.stringify(title)}`,
    'labels = ["design", "idiom"]',
    "+++",
    "",
    "## What and why",
    "",
    ...(cause === undefined
      ? [
          `Resolve the observed ${cluster.members[0]?.record.finding.category} problems in component ${JSON.stringify(cluster.component)} of flow ${JSON.stringify(cluster.members[0]?.record.finding.flow)}.`,
          "",
        ]
      : causeLead),
    ...[
      ...new Set(
        cluster.members.map((member) => member.record.finding.explanation),
      ),
    ].flatMap((text) => [text, ""]),
    "## Acceptance criteria",
    "",
    ...(cause === undefined
      ? []
      : [
          `- [ ] All ${cluster.members.length} symptoms below clear on recheck (one fix for the shared cause)`,
        ]),
    ...criteria.map((text) => `- [ ] ${text}`),
    "",
    "## Out of scope",
    "",
    cause === undefined
      ? "- Other components and finding categories; ticket promotion, dispatch, and implementation of adjacent work."
      : "- Findings outside this root cause; ticket promotion, dispatch, and implementation of adjacent work.",
    "- Scope is the union of the member coordinates below and any additional coverage explicitly required by their acceptance criteria. Other coordinates remain out of scope.",
    "",
    "## Evidence",
    "",
    cause === undefined
      ? `Component key: ${JSON.stringify(cluster.component)}`
      : `Root cause key: ${JSON.stringify(`${cause.kind}:${cause.key.replaceAll("\0", " ")}`)} (${cause.id})`,
    "",
  ];
  for (const member of cluster.members) {
    const finding = findingForTicket(member.record.finding, undefined);
    const selector =
      finding.verification.params?.selector ??
      finding.verification.locus?.target.selector;
    lines.push(
      `### ${member.id}`,
      "",
      `Source review: ${member.record.runId}; captured commit: ${JSON.stringify(finding.commit)}; finding: ${JSON.stringify(member.id)}.`,
      `Coordinate: ${JSON.stringify({ flow: finding.flow, state: finding.state, viewport: finding.viewport, colorScheme: finding.colorScheme, combination: finding.combination })}`,
      `Selector: ${JSON.stringify(selector ?? "unavailable")}; component: ${JSON.stringify(member.component)}.`,
      "",
      "Acceptance criteria for this member:",
      ...acceptanceText(finding).map((text) => `- ${text}`),
      "",
    );
    const images = options.availableImages.get(member.id) ?? [];
    if (!images.some((path) => path.includes("/crops/")))
      lines.push("Crop unavailable for this finding.");
    if (images.length === 0)
      lines.push("No screenshot was available for this finding.");
    for (const [index, path] of images.entries())
      lines.push(
        `- [${path.includes("/crops/") ? "Crop" : "Screenshot"} ${index + 1}](${markdownPath(ticketDirectory, resolve(member.record.runDirectory, path))})`,
      );
    const serialized = JSON.stringify(finding, null, 2);
    const fence = jsonFence(serialized);
    lines.push("", `${fence}idiom:finding`, serialized, fence, "");
  }
  return { id, title, body: `${lines.join("\n")}\n` };
}
