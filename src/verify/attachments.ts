import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { CaptureTupleSelection } from "../capture/types.js";
import { IdiomError } from "../errors.js";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes("\\") &&
      !path.split("/").includes(".."),
    "must remain beneath the verify output",
  );

export const attachmentManifestSchema = z
  .object({
    version: z.literal(1),
    report: z
      .object({
        kind: z.literal("idiom-verify-report"),
        path: z.literal("before-after.md"),
      })
      .strict(),
    composites: z.array(
      z
        .object({
          ordinal: z.number().int().positive(),
          kind: z.string(),
          state: z.string().min(1),
          viewport: z.string().min(1),
          colorScheme: z.enum(["light", "dark"]).optional(),
          path: relativePath,
        })
        .strict(),
    ),
  })
  .strict();

export type AttachmentManifest = z.infer<typeof attachmentManifestSchema>;

export function canonicalAttachmentKind(ordinal: number): string {
  return `idiom-before-after-${ordinal.toString().padStart(3, "0")}`;
}

export function createAttachmentManifest(
  tuples: CaptureTupleSelection[],
): AttachmentManifest {
  return {
    version: 1,
    report: { kind: "idiom-verify-report", path: "before-after.md" },
    composites: tuples.map((tuple, index) => {
      const ordinal = index + 1;
      return {
        ordinal,
        kind: canonicalAttachmentKind(ordinal),
        state: tuple.state,
        viewport: tuple.viewport,
        ...(tuple.colorScheme === undefined
          ? {}
          : { colorScheme: tuple.colorScheme }),
        path: `before-after-${tuple.state}-${tuple.viewport}${tuple.colorScheme === undefined ? "" : `-${tuple.colorScheme}`}.png`,
      };
    }),
  };
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateAttachmentManifest(options: {
  outputDirectory: string;
  manifest: unknown;
  requireFiles?: boolean | undefined;
}): Promise<AttachmentManifest> {
  const parsed = attachmentManifestSchema.safeParse(options.manifest);
  if (!parsed.success)
    throw new IdiomError(
      `invalid attachments manifest: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  const kinds = new Set<string>();
  const paths = new Set<string>();
  for (const [index, composite] of parsed.data.composites.entries()) {
    const ordinal = index + 1;
    if (composite.ordinal !== ordinal)
      throw new IdiomError(
        "attachment ordinals must be consecutive and one-based",
      );
    if (composite.kind !== canonicalAttachmentKind(ordinal))
      throw new IdiomError(
        `attachment kind ${composite.kind} is not canonical for ordinal ${ordinal}`,
      );
    if (kinds.has(composite.kind) || paths.has(composite.path))
      throw new IdiomError("attachment kinds and paths must be unique");
    kinds.add(composite.kind);
    paths.add(composite.path);
  }
  if (options.requireFiles !== false) {
    for (const path of [
      parsed.data.report.path,
      ...parsed.data.composites.map(({ path }) => path),
    ]) {
      const absolute = resolve(options.outputDirectory, path);
      const escaped = relative(resolve(options.outputDirectory), absolute);
      if (
        escaped.startsWith("..") ||
        isAbsolute(escaped) ||
        !(await present(absolute))
      )
        throw new IdiomError(
          `attachment file is missing or escapes output: ${path}`,
        );
    }
    const report = await readFile(
      join(options.outputDirectory, parsed.data.report.path),
      "utf8",
    );
    for (const composite of parsed.data.composites) {
      if (!report.includes(composite.kind) || !report.includes(composite.path))
        throw new IdiomError(
          `attachment manifest/report drift for ${composite.kind}`,
        );
    }
  }
  return parsed.data;
}

export async function writeAttachmentManifest(
  outputDirectory: string,
  manifest: AttachmentManifest,
): Promise<string> {
  await validateAttachmentManifest({
    outputDirectory,
    manifest,
    requireFiles: false,
  });
  const path = join(outputDirectory, "attachments.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
