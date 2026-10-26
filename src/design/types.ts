import { z } from "zod";
import type { TupleResult } from "../capture/types.js";
import type { ObservationArtifact } from "../checks/types.js";
import { artifactPathSchema } from "../schemas/finding.js";

export const matchMethodSchema = z.enum([
  "root",
  "data-node-id",
  "data-idiom-name",
  "role-name",
  "text",
  "descendants",
  "parent-position",
]);
export type MatchMethod = z.infer<typeof matchMethodSchema>;
export const matchesSchema = z
  .object({
    version: z.literal(1),
    pairs: z.array(
      z
        .object({
          id: z.string().min(1),
          app: z.string().min(1),
          design: z.string().min(1),
          method: matchMethodSchema,
          parent: z.string().nullable(),
        })
        .strict(),
    ),
    unmatchedApp: z.array(z.string()),
    unmatchedDesign: z.array(z.string()),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["id", "app", "design"] as const)
      if (new Set(value.pairs.map((p) => p[key])).size !== value.pairs.length)
        context.addIssue({
          code: "custom",
          message: `duplicate matched ${key}`,
        });
    for (const [side, unmatched] of [
      ["app", value.unmatchedApp],
      ["design", value.unmatchedDesign],
    ] as const) {
      const matched = new Set(value.pairs.map((p) => p[side]));
      if (
        new Set(unmatched).size !== unmatched.length ||
        unmatched.some((selector) => matched.has(selector))
      )
        context.addIssue({
          code: "custom",
          message: `invalid unmatched ${side}`,
        });
    }
    const ids = new Set(value.pairs.map((p) => p.id));
    if (
      value.pairs.some(
        (p) => p.parent !== null && (p.parent === p.id || !ids.has(p.parent)),
      )
    )
      context.addIssue({ code: "custom", message: "unknown matched parent" });
  });
export type DesignMatches = z.infer<typeof matchesSchema>;
export type DesignPair = DesignMatches["pairs"][number];

const rectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
/** Changed areas between an intended design image and the app screenshot. */
export const designRegionsSchema = z
  .object({
    version: z.literal(1),
    /** CSS px; design y = app y + offset. */
    offset: z.number().int(),
    compared: z
      .object({
        top: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
      })
      .strict(),
    uncompared: z.array(
      z
        .object({
          top: z.number().int().nonnegative(),
          height: z.number().int().positive(),
          side: z.enum(["app", "design"]),
        })
        .strict(),
    ),
    regions: z.array(
      z
        .object({
          id: z.string().regex(/^region-\d+$/),
          rect: rectSchema,
          designRect: rectSchema,
          owner: z.string().nullable(),
          elements: z.array(z.string()),
          changedCells: z.number().int().positive(),
          cells: z.number().int().positive(),
          meanDelta: z.number().finite().nonnegative(),
        })
        .strict(),
    ),
    omitted: z.number().int().nonnegative(),
  })
  .strict();
export type DesignRegions = z.infer<typeof designRegionsSchema>;
export type DesignRegion = DesignRegions["regions"][number];

export const designImageMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
export type DesignImageMediaType = z.infer<typeof designImageMediaTypeSchema>;
const elementArtifacts = ["observations", "matches"] as const;
const elementOnlyArtifacts = [
  ...elementArtifacts,
  "dom",
  "axe",
  "figma",
] as const;

export const figmaProvenanceSchema = z
  .object({
    fileKey: z.string().min(1),
    nodeId: z.string().min(1),
    version: z.string().min(1),
    lastModified: z.string().optional(),
    frame: z
      .object({ width: z.number().positive(), height: z.number().positive() })
      .strict(),
    /** "resolved", or "unavailable: <why>" when variable names could not be read. */
    variables: z.string().min(1),
    link: z.string().min(1),
    /** Project-relative cache directory of the pinned version. */
    cache: z.string().min(1),
  })
  .strict();
export type FigmaProvenance = z.infer<typeof figmaProvenanceSchema>;

export const designDescriptorSchema = z
  .object({
    version: z.literal(1),
    source: z.string().min(1),
    /** Reference name; present when a state declares several references. */
    name: z.string().min(1).optional(),
    resolved: z
      .object({
        kind: z.enum(["file", "url", "inline", "site", "image", "figma"]),
        requested: z.string(),
        final: z.string(),
        entry: z.string().optional(),
        mediaType: designImageMediaTypeSchema.optional(),
        sha256: z
          .string()
          .regex(/^[a-f\d]{64}$/)
          .optional(),
      })
      .strict()
      .optional(),
    coordinate: z
      .object({
        state: z.string(),
        viewport: z.string(),
        width: z.number().positive(),
        height: z.number().positive(),
        colorScheme: z.enum(["light", "dark"]),
      })
      .strict(),
    runtimeVersion: z.string(),
    status: z.enum(["captured", "failed"]),
    failure: z.string().optional(),
    figma: figmaProvenanceSchema.optional(),
    artifacts: z
      .object({
        observations: artifactPathSchema.optional(),
        screenshot: artifactPathSchema,
        dom: artifactPathSchema.optional(),
        console: artifactPathSchema.optional(),
        axe: artifactPathSchema.optional(),
        /** The Figma node tree the observations were normalised from. */
        figma: artifactPathSchema.optional(),
        source: artifactPathSchema,
        matches: artifactPathSchema.optional(),
        image: artifactPathSchema.optional(),
        regions: artifactPathSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const image = value.resolved?.kind === "image";
    const required = image ? (["image", "regions"] as const) : elementArtifacts;
    const absent = image
      ? elementOnlyArtifacts
      : (["image", "regions"] as const);
    for (const key of required)
      if (value.artifacts[key] === undefined)
        context.addIssue({
          code: "custom",
          path: ["artifacts", key],
          message: `design artifact ${key} is required`,
        });
    for (const key of absent)
      if (value.artifacts[key] !== undefined)
        context.addIssue({
          code: "custom",
          path: ["artifacts", key],
          message: `design artifact ${key} does not apply to this reference kind`,
        });
    if (
      image &&
      (value.resolved?.mediaType === undefined ||
        value.resolved.sha256 === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: "image design provenance needs mediaType and sha256",
      });
  });
export type DesignDescriptor = z.infer<typeof designDescriptorSchema>;
export type DesignImage = {
  bytes: Buffer;
  mediaType: DesignImageMediaType;
  extension: string;
};
export type CapturedDesign = {
  source: string;
  image?: DesignImage | undefined;
  name?: string | undefined;
  figma?: FigmaProvenance | undefined;
  /** The raw Figma node tree, kept beside the tuple as evidence. */
  figmaDocument?: unknown;
  resolved?: DesignDescriptor["resolved"] | undefined;
  runtimeVersion: string;
  result?: TupleResult | undefined;
  failure?: string | undefined;
};
export type LoadedDesign = {
  descriptor: DesignDescriptor;
  observations?: ObservationArtifact | undefined;
  screenshotPath?: string | undefined;
  matches?: DesignMatches | undefined;
  regions?: DesignRegions | undefined;
  unavailable?: string | undefined;
};
