import { z } from "zod";
import { artifactPathSchema } from "../schemas/finding.js";

export const FILMSTRIP_LIMITS = {
  width: 4096,
  height: 1536,
  bytes: 4 * 1024 * 1024,
  actionBytes: 16 * 1024 * 1024,
  laneBytes: 64 * 1024 * 1024,
  decodedPixels: 16 * 1024 * 1024,
  toleranceMs: 35,
} as const;
export const filmstripOffsetsSchema = z
  .array(z.number().int().min(0).max(5000))
  .min(1)
  .max(16)
  .refine(
    (values) =>
      values[0] === 0 &&
      values.every((v, i) => i === 0 || v > (values[i - 1] ?? v)),
    "offsets must begin at zero and strictly increase",
  );
export const filmstripConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    offsetsMs: filmstripOffsetsSchema.default([0, 50, 100, 200, 400, 800]),
    actions: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
const rect = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
export const filmstripIdentitySchema = z
  .object({
    source: z.enum([
      "load",
      "web-step",
      "probe-click",
      "probe-hover",
      "slow-replay",
      "failure-replay",
    ]),
    kind: z.string().min(1),
    selector: z.string().min(1).optional(),
    name: z.string(),
    stepIndex: z.number().int().positive().optional(),
    failureOf: z.enum(["web-step", "probe-click"]).optional(),
    heldOf: z.enum(["web-step", "probe-click"]).optional(),
  })
  .strict();
export const filmstripFrameSchema = z
  .object({
    slot: z.union([z.number().int().nonnegative(), z.literal("settle")]),
    requestedMs: z.number().finite().nonnegative(),
    actualMs: z.number().finite().optional(),
    timestamp: z.number().finite().optional(),
    path: artifactPathSchema.optional(),
    reason: z.string().min(1).optional(),
    geometry: z
      .object({
        width: z.number().positive(),
        height: z.number().positive(),
        scrollX: z.number().finite(),
        scrollY: z.number().finite(),
        scale: z.number().positive(),
        pageScale: z.number().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (f) =>
      f.path !== undefined
        ? f.actualMs !== undefined &&
          f.timestamp !== undefined &&
          f.geometry !== undefined
        : !!f.reason,
    "frame requires sampled pixels and timing, or an unavailable reason",
  );
export const filmstripManifestSchema = z
  .object({
    version: z.literal(1),
    offsetsMs: filmstripOffsetsSchema,
    limits: z
      .object(
        Object.fromEntries(
          Object.entries(FILMSTRIP_LIMITS).map(([k]) => [
            k,
            z.number().positive(),
          ]),
        ) as Record<keyof typeof FILMSTRIP_LIMITS, z.ZodNumber>,
      )
      .strict(),
    actions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            identity: filmstripIdentitySchema,
            status: z.enum(["complete", "partial", "unavailable"]),
            reason: z.string().optional(),
            anchor: z.number().finite().optional(),
            timelineOrigin: z.number().finite(),
            settleMs: z.number().finite().nonnegative(),
            settled: z.boolean(),
            visualFrames: z
              .array(
                z
                  .object({
                    time: z.number().finite(),
                    elements: z
                      .array(z.object({ selector: z.string(), rect }).strict())
                      .max(250),
                  })
                  .strict(),
              )
              .max(120)
              .optional(),
            region: rect.refine(
              (r) => r.width > 0 && r.height > 0,
              "filmstrip region must have positive area",
            ),
            regionReason: z.string().optional(),
            frames: z.array(filmstripFrameSchema).max(17),
          })
          .strict(),
      )
      .max(240),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, action] of manifest.actions.entries()) {
      if (ids.has(action.id))
        context.addIssue({
          code: "custom",
          path: ["actions", index, "id"],
          message: "duplicate action identity",
        });
      ids.add(action.id);
      const expected = [...manifest.offsetsMs, "settle"];
      if (
        action.frames.length !== expected.length ||
        action.frames.some((frame, i) => frame.slot !== expected[i])
      )
        context.addIssue({
          code: "custom",
          path: ["actions", index, "frames"],
          message:
            "frames must contain each configured offset in order and an independent settle slot",
        });
      if (action.status !== "complete" && !action.reason)
        context.addIssue({
          code: "custom",
          path: ["actions", index, "reason"],
          message: "incomplete filmstrip requires a reason",
        });
      if (action.status === "complete" && action.frames.some((f) => !f.path))
        context.addIssue({
          code: "custom",
          path: ["actions", index, "status"],
          message: "complete filmstrip requires every sampled slot",
        });
    }
  });
export type FilmstripConfig = z.infer<typeof filmstripConfigSchema>;
export type FilmstripIdentity = z.infer<typeof filmstripIdentitySchema>;
export type FilmstripManifest = z.infer<typeof filmstripManifestSchema>;
export type FilmstripAction = FilmstripManifest["actions"][number];
export type FilmstripFrame = z.infer<typeof filmstripFrameSchema>;
