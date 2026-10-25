import { z } from "zod";

export const learnedKinds = [
  "component",
  "invariant",
  "glossary",
  "mirrored",
  "ruling",
] as const;

/**
 * One line of `.idiom/learned.jsonl`: a human-found miss and the rule or
 * configuration it became, with the capture it was observed on so the next
 * review can be checked against it.
 */
export const learnedEntrySchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^learned-[1-9]\d*$/),
    recordedAt: z.string().datetime({ offset: true }),
    flow: z.string().trim().min(1),
    state: z.string().trim().min(1),
    observation: z.string().trim().min(1),
    kind: z.enum(learnedKinds),
    target: z
      .object({
        file: z.string().trim().min(1),
        selector: z.string().trim().min(1).optional(),
        rulingId: z
          .string()
          .regex(/^ruling-[1-9]\d*$/)
          .optional(),
      })
      .strict(),
    entry: z.unknown(),
    capture: z
      .object({
        runId: z.string().trim().min(1),
        viewport: z.string().trim().min(1),
        screenshot: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    screenshot: z.string().trim().min(1).optional(),
  })
  .strict();

export type LearnedEntry = z.infer<typeof learnedEntrySchema>;
export type LearnedKind = (typeof learnedKinds)[number];
