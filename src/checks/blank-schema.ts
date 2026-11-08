import { z } from "zod";

const rect = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();
const status = z.enum(["ran", "partial", "skipped", "unavailable"]);
export const visualBlankRecordSchema = z
  .object({
    selector: z.string().min(1),
    kind: z.enum([
      "img",
      "picture",
      "video",
      "canvas",
      "iframe",
      "background",
      "placeholder",
    ]),
    rect,
    interior: rect,
    visible: rect,
    scroll: z.object({ x: z.number(), y: z.number() }).strict(),
    exempt: z.string().optional(),
    masked: z.boolean(),
    opacity: z.number().min(0).max(1),
    overlay: z
      .object({
        alpha: z.number().min(0).max(1),
        coverage: z.number().min(0).max(1),
        selector: z.string().optional(),
        uncertainty: z.string().optional(),
      })
      .strict(),
    video: z
      .object({ poster: z.boolean(), frame: z.boolean() })
      .strict()
      .optional(),
    pixels: z
      .object({
        dominantShare: z.number().min(0).max(1),
        distinct: z.number().int().nonnegative(),
        count: z.number().int().positive(),
        crop: rect,
      })
      .strict()
      .optional(),
    unavailable: z.string().optional(),
  })
  .strict();
export const visualBlankSchema = z
  .object({
    status,
    reason: z.string().optional(),
    algorithm: z.literal("rgb16-v1"),
    dominantThreshold: z.literal(0.995),
    opacityThreshold: z.literal(0.01),
    overlayAlphaThreshold: z.literal(0.98),
    bucketSize: z.literal(16),
    edgeInset: z.literal(2),
    swatchSelectors: z.array(z.string()),
    records: z.array(visualBlankRecordSchema),
  })
  .strict();
export const loadingStuckSchema = z
  .object({
    status,
    reason: z.string().optional(),
    windowMs: z.number().int().positive(),
    observedMs: z.number().nonnegative(),
    intentional: z.boolean(),
    records: z.array(
      z
        .object({
          selector: z.string().min(1),
          identity: z.number().int().nonnegative(),
          kind: z.enum(["busy", "progress", "spinner", "skeleton"]),
          ageMs: z.number().nonnegative(),
          active: z.boolean(),
          endedMs: z.number().nonnegative().optional(),
          masked: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type VisualBlankEvidence = z.infer<typeof visualBlankSchema>;
export type VisualBlankRecord = z.infer<typeof visualBlankRecordSchema>;
export type LoadingStuckEvidence = z.infer<typeof loadingStuckSchema>;
