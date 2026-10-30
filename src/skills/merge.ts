import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export type Conflict = {
  id: string;
  local: string;
  base: string;
  incoming: string;
};
export type Merge = {
  segments: (string | Conflict)[];
  marked: string;
  conflicts: Conflict[];
};
export type MergeRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;
export const runMerge: MergeRunner = (args) =>
  new Promise((accept, reject) => {
    execFile(
      "git",
      args,
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed))
          reject(error);
        else accept({ code: (error?.code as number) ?? 0, stdout, stderr });
      },
    );
  });
export async function mergeText(
  base: string,
  local: string,
  incoming: string,
  runner: MergeRunner = runMerge,
): Promise<Merge> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-merge-"));
  const label = randomUUID();
  // Git's separator has no label. Choose a marker width absent from every
  // input, so even literal marker examples inside a hunk cannot spoof it.
  let width = 7;
  for (const content of [base, local, incoming]) {
    for (const run of content.matchAll(/^(?:<+|\|+|=+|>+)/gm))
      width = Math.max(width, run[0].length + 1);
  }
  const start = "<".repeat(width);
  const ancestor = "|".repeat(width);
  const separator = "=".repeat(width);
  const closingMarker = ">".repeat(width);
  const labels = [
    `idiom-local-${label}`,
    `idiom-base-${label}`,
    `idiom-incoming-${label}`,
  ];
  try {
    const paths = ["local", "base", "incoming"].map((file) =>
      join(directory, file),
    );
    await Promise.all(
      paths.map((file, index) =>
        writeFile(file, [local, base, incoming][index] as string, "utf8"),
      ),
    );
    const result = await runner([
      "merge-file",
      "-p",
      "--diff3",
      `--marker-size=${width}`,
      "-L",
      labels[0] as string,
      "-L",
      labels[1] as string,
      "-L",
      labels[2] as string,
      ...paths,
    ]);
    if (result.code < 0 || result.code > 127 || result.stderr.trim())
      throw new Error(`Git merge failed: ${result.stderr || result.code}`);
    if (result.code === 0)
      return {
        segments: [result.stdout],
        marked: result.stdout,
        conflicts: [],
      };
    const lines = result.stdout.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const segments: Merge["segments"] = [];
    const conflicts: Conflict[] = [];
    const marker = (line: string | undefined) => line?.replace(/\r?\n$/, "");
    let clean = "";
    for (let i = 0; i < lines.length; ) {
      if (marker(lines[i]) !== `${start} ${labels[0]}`) {
        clean += lines[i++];
        continue;
      }
      segments.push(clean);
      clean = "";
      i++;
      const sides: string[] = [];
      for (const end of [
        `${ancestor} ${labels[1]}`,
        separator,
        `${closingMarker} ${labels[2]}`,
      ]) {
        let side = "";
        while (i < lines.length && marker(lines[i]) !== end) side += lines[i++];
        if (i >= lines.length)
          throw new Error("Git returned malformed conflict structure");
        sides.push(side);
        i++;
      }
      const conflict = {
        id: `hunk-${conflicts.length + 1}`,
        local: sides[0] as string,
        base: sides[1] as string,
        incoming: sides[2] as string,
      };
      segments.push(conflict);
      conflicts.push(conflict);
    }
    segments.push(clean);
    if (!conflicts.length || Math.min(conflicts.length, 127) !== result.code)
      throw new Error("Git returned an invalid conflict result");
    return { segments, marked: result.stdout, conflicts };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const resolutionSchema = z
  .object({
    decision: z.enum(["resolve", "decline"]),
    replacements: z.array(
      z.object({ id: z.string(), text: z.string() }).strict(),
    ),
    reason: z.string(),
  })
  .strict();
export type Resolution = z.infer<typeof resolutionSchema>;
export const resolutionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["resolve", "decline"] },
    replacements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
      },
    },
    reason: { type: "string" },
  },
  required: ["decision", "replacements", "reason"],
};
const markerLines = /^(?:<{7}|\|{7}|={7}|>{7})(?:[^\r\n]*)/gm;
export function skillIdentity(content: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(
    content,
  );
  if (!frontmatter?.[2]?.trim()) return undefined;
  const names = [
    ...(frontmatter[1] ?? "").matchAll(/^\s*name:[ \t]*([^\r\n]*)$/gm),
  ];
  if (names.length !== 1) return undefined;
  const raw = names[0]?.[1]?.trim() ?? "";
  return /^(?:[a-zA-Z0-9_-]+|"[a-zA-Z0-9_-]+"|'[a-zA-Z0-9_-]+')$/.test(raw)
    ? raw.replace(/^['"]|['"]$/g, "")
    : undefined;
}
export function validateFile(
  content: string,
  filename: string,
  identity: string,
): void {
  if (filename === "SKILL.md" && skillIdentity(content) !== identity)
    throw new Error(
      "Resolution must preserve complete skill frontmatter, exactly one expected name, and a nonempty body",
    );
}
export function reconstruct(
  merge: Merge,
  proposal: unknown,
  filename: string,
  identity: string,
): string {
  const resolution = resolutionSchema.parse(proposal);
  if (resolution.decision !== "resolve")
    throw new Error("Resolver declined an ambiguous overlap");
  const replacements = new Map<string, string>();
  for (const replacement of resolution.replacements) {
    if (
      replacements.has(replacement.id) ||
      !merge.conflicts.some((hunk) => hunk.id === replacement.id)
    )
      throw new Error("Unknown or duplicate conflict ID");
    if (replacement.text.match(markerLines) || /^\s*```/.test(replacement.text))
      throw new Error("Resolution introduced conflict markers or a wrapper");
    replacements.set(replacement.id, replacement.text);
  }
  if (replacements.size !== merge.conflicts.length)
    throw new Error("Incomplete conflict resolution");
  let content = "";
  const protectedMarkers = new Set<number>();
  for (const segment of merge.segments) {
    if (typeof segment === "string") {
      for (const match of segment.matchAll(markerLines))
        protectedMarkers.add(content.length + (match.index ?? 0));
      content += segment;
    } else content += replacements.get(segment.id);
  }
  for (const match of content.matchAll(markerLines))
    if (!protectedMarkers.has(match.index ?? 0))
      throw new Error("Resolution introduced a conflict marker");
  validateFile(content, filename, identity);
  return content;
}
