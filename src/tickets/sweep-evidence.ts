import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { IdiomError } from "../errors.js";
import { renderInstruction } from "../instructions/render.js";
import { assertEvidencePaths } from "../review/artifacts.js";
import type { CatalogFinding } from "../review/catalog.js";
import type { FindingCluster } from "./cluster.js";
import { physicalPath } from "./target.js";

export const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const link = (from: string, to: string) =>
  relative(from, to).split(sep).map(encodeURIComponent).join("/");

/** Publish immutable tuple partitions before the visible ticket can reference them. */
export async function sweepTicketEvidence(options: {
  cluster: FindingCluster;
  id: string;
  directory: string;
  projectDirectory: string;
  occurrences: CatalogFinding[];
}): Promise<string> {
  const { cluster, directory, id } = options;
  const ids = new Set(cluster.members.map((m) => m.id));
  const occurrences = options.occurrences.filter((r) => ids.has(r.finding.id));
  const partitions = new Map<string, CatalogFinding[]>();
  for (const record of occurrences) {
    const f = record.finding;
    const key = JSON.stringify([
      f.flow,
      f.state,
      f.viewport,
      f.colorScheme,
      f.combination,
    ]);
    const partition = partitions.get(key) ?? [];
    if (!partition.some((r) => r.finding.id === f.id)) partition.push(record);
    partitions.set(key, partition);
  }
  const sideDirectory = join(directory, ".idiom", id);
  if ((await physicalPath(sideDirectory)) !== resolve(sideDirectory))
    throw new IdiomError(
      `verification sidecar directory must not be a symlink: ${sideDirectory}`,
    );
  await mkdir(sideDirectory, { recursive: true });
  const lines = ["", "## Exact source occurrences", ""];
  for (const record of occurrences) {
    const f = record.finding;
    lines.push(
      `- Coordinate: ${JSON.stringify({ flow: f.flow, state: f.state, viewport: f.viewport, colorScheme: f.colorScheme, combination: f.combination })}; selector/measurements: ${JSON.stringify(f.verification)}.`,
      `  ${f.explanation}`,
    );
    const evidence = [
      ...f.evidence.screenshots,
      ...(f.evidence.filmstrip?.sheet ? [f.evidence.filmstrip.sheet] : []),
      ...(f.evidence.artifacts ?? []),
    ];
    for (const path of evidence) {
      await assertEvidencePaths(record.runDirectory, [path]);
      lines.push(
        `  - [${path.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${link(directory, resolve(record.runDirectory, path))})`,
      );
    }
    // Every tuple's artifacts list its timelines.json; only an explicit
    // action reference means this finding was measured from a timeline.
    const timeline = f.evidence.timeline;
    if (timeline !== undefined) {
      await assertEvidencePaths(record.runDirectory, [timeline.artifact]);
      lines.push(
        `  - Action timeline \`${timeline.id}\`: [${timeline.artifact.replaceAll("[", "\\[").replaceAll("]", "\\]")}](${link(directory, resolve(record.runDirectory, timeline.artifact))})`,
      );
    }
    if (!f.evidence.filmstrip?.sheet)
      lines.push(
        "  - Temporal filmstrip unavailable; see check/probe coverage in the source report.",
      );
  }
  lines.push(
    "",
    "## Verify",
    "",
    "Run every partition below. Model findings retain manual/unverifiable limitations.",
    "",
  );
  for (const [key, records] of [...partitions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    // Stable names do not depend on which other partitions happen to be present.
    const path = join(
      sideDirectory,
      `${createHash("sha256").update(key).digest("hex")}.md`,
    );
    const first = records[0];
    if (first === undefined) continue;
    if ((await physicalPath(path)) !== resolve(path))
      throw new IdiomError(
        `verification sidecar must not be a symlink: ${path}`,
      );
    const content = records
      .map((r) => {
        const serialized = JSON.stringify(r.finding, null, 2);
        const fence = "`".repeat(
          Math.max(
            3,
            ...[...serialized.matchAll(/`+/g)].map((m) => m[0].length + 1),
          ),
        );
        return `${fence}idiom:finding\n${serialized}\n${fence}\n`;
      })
      .join("\n");
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await readFile(path, "utf8")) !== content)
        throw new IdiomError(
          `incompatible verification sidecar; preserving existing bytes: ${path}`,
        );
    }
    lines.push(
      `- Spec: [${first.finding.flow}](${link(directory, path)})`,
      "```sh",
      `idiom verify ${shellQuote(first.finding.flow)} --spec ${shellQuote(path)} --project ${shellQuote(options.projectDirectory)}`,
      "```",
      "",
    );
  }
  lines.push(
    "## Paste-ready repair instruction",
    "",
    cluster.cause?.fix ?? `Fix only component ${cluster.component}.`,
    "Apply the member instructions to the union of source coordinates above. Adjacent findings and ticket promotion are out of scope.",
    "",
  );
  for (const member of cluster.members)
    lines.push(renderInstruction({ target: member.record, siblings: [] }));
  return `${lines.join("\n")}\n`;
}
