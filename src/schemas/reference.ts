import { z } from "zod";

export const referenceNameSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be a lowercase slug containing only letters, numbers, and single hyphens",
  );

export const referenceImageMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const referenceImageMediaTypeSchema = z.enum(referenceImageMediaTypes);

const referenceImagePathSchema = z
  .string()
  .regex(
    /^image\.(?:png|jpe?g|webp|gif)$/i,
    "must be a safe entry-relative supported image path",
  );

const common = {
  version: z.literal(1),
  name: referenceNameSchema,
  note: z.string().trim().min(1, "must not be blank"),
  image: referenceImagePathSchema,
  mediaType: referenceImageMediaTypeSchema,
};

export const referenceMetadataSchema = z.discriminatedUnion("sourceKind", [
  z
    .object({
      ...common,
      sourceKind: z.literal("url"),
      source: z.url(),
      capturedAt: z.iso.datetime(),
      viewport: z
        .object({
          name: z.string().trim().min(1),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      sourceKind: z.literal("file"),
      source: z.string().trim().min(1),
    })
    .strict(),
]);

export type ReferenceMetadata = z.infer<typeof referenceMetadataSchema>;
export type ReferenceImageMediaType = z.infer<
  typeof referenceImageMediaTypeSchema
>;
