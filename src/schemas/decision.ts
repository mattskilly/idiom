import { z } from "zod";

export const decisionSchema = z
  .object({
    at: z.iso.datetime(),
    commit: z.string(),
    findingId: z.string(),
    fingerprint: z.string(),
    decision: z.enum(["accept", "reject"]),
    scope: z.enum(["instance", "rule"]).default("instance"),
    reason: z.string().optional(),
    actor: z.string().default("human"),
    /** `decide --choose`: the reference a person chose where several disagreed. */
    designChoice: z
      .object({
        flow: z.string().min(1),
        state: z.string().min(1),
        colorScheme: z.enum(["light", "dark"]).optional(),
        decisionKey: z.string().min(1),
        reference: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Decision = z.infer<typeof decisionSchema>;
