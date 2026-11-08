import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { IdiomError } from "../errors.js";
import {
  briefAssertionSchema,
  briefCriterionKinds,
  briefSlugSchema,
  formatBriefIssues,
} from "../schemas/brief.js";
import { colorSchemeSchema } from "../schemas/project.js";
import type { BriefCheck } from "./assertions.js";

export const DESIGN_ASSET_FORMAT = "idiom-design-asset";

const nonEmpty = z.string().trim().min(1);

/**
 * `criteria.json` in an exported design asset: exactly what a `BriefCheck`
 * needs, versioned on its own so the asset never tracks the stored brief schema.
 */
export const designAssetSchema = z
  .object({
    format: z.literal(DESIGN_ASSET_FORMAT),
    version: z.literal(1),
    brief: z
      .object({
        slug: briefSlugSchema,
        title: nonEmpty,
        decision: nonEmpty,
        chosenOption: briefSlugSchema,
        chosenTitle: nonEmpty,
        decidedBy: nonEmpty,
      })
      .strict(),
    criteria: z.array(
      z
        .object({
          index: z.number().int().min(0),
          kind: z.enum(briefCriterionKinds),
          statement: nonEmpty,
          assertions: z.array(briefAssertionSchema),
          rules: z.array(nonEmpty),
        })
        .strict(),
    ),
    screenshots: z.array(
      z
        .object({
          flow: nonEmpty,
          state: nonEmpty,
          viewport: nonEmpty,
          colorScheme: colorSchemeSchema,
          path: z
            .string()
            .regex(
              /^screenshots\/[A-Za-z0-9._+-]+\.png$/,
              "must be screenshots/<name>.png",
            ),
        })
        .strict(),
    ),
    capture: z
      .object({ runId: nonEmpty, commit: nonEmpty.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type DesignAsset = z.infer<typeof designAssetSchema>;

export type DesignAssetBrief = BriefCheck & {
  source: { kind: "design-asset"; name: string };
};

/** Where autobuild pins a build's design assets, relative to the worktree. */
export const DESIGN_ASSETS_PATH = join(".ab", "assets", "design");

async function present(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The `.ab/assets/design` directory for this project's build, if any. */
async function designAssetsDirectory(
  projectDirectory: string,
): Promise<string | undefined> {
  let directory = resolve(projectDirectory);
  while (true) {
    const candidate = join(directory, DESIGN_ASSETS_PATH);
    if (await present(candidate)) return candidate;
    // `.git` is a file in a worktree; either kind ends the walk.
    if (
      (await present(join(directory, ".ab"))) ||
      (await present(join(directory, ".git")))
    )
      return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function designAssetBrief(
  asset: DesignAsset,
  name: string,
): DesignAssetBrief {
  return {
    slug: asset.brief.slug,
    title: asset.brief.title,
    decision: asset.brief.chosenTitle,
    // Export refuses ineligible briefs, so a pinned asset is always judged.
    eligible: true,
    criteria: asset.criteria.map((criterion) => ({
      index: criterion.index,
      statement: criterion.statement,
      assertions: criterion.assertions,
    })),
    source: { kind: "design-asset", name },
  };
}

/**
 * The Idiom exports pinned to the build this project sits in, sorted by
 * slug. Someone else's design asset is ignored; a broken Idiom export throws,
 * because it is the contract the ticket was claimed with.
 */
export async function readDesignAssets(
  projectDirectory: string,
): Promise<DesignAssetBrief[]> {
  const directory = await designAssetsDirectory(projectDirectory);
  if (directory === undefined) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const briefs: DesignAssetBrief[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    let text: string;
    try {
      text = await readFile(
        join(directory, entry.name, "criteria.json"),
        "utf8",
      );
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (
      typeof json !== "object" ||
      json === null ||
      (json as { format?: unknown }).format !== DESIGN_ASSET_FORMAT
    )
      continue;
    const parsed = designAssetSchema.safeParse(json);
    if (!parsed.success)
      throw new IdiomError(
        `design asset ${entry.name} is not a valid Idiom export: ${formatBriefIssues(parsed.error).join("; ")}`,
      );
    if (briefs.some((brief) => brief.slug === parsed.data.brief.slug)) continue;
    briefs.push(designAssetBrief(parsed.data, entry.name));
  }
  return briefs.sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Each asserted `(flow, state)` once, in brief and criterion order. */
export function assertedStates(
  briefs: readonly BriefCheck[],
): Array<{ flow: string; state: string; brief: BriefCheck }> {
  const seen = new Set<string>();
  const states: Array<{ flow: string; state: string; brief: BriefCheck }> = [];
  for (const brief of briefs)
    for (const criterion of brief.criteria)
      for (const assertion of criterion.assertions) {
        const key = `${assertion.flow}\0${assertion.state}`;
        if (seen.has(key)) continue;
        seen.add(key);
        states.push({ flow: assertion.flow, state: assertion.state, brief });
      }
  return states;
}
