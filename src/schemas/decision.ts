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
  })
  .strict();

export type Decision = z.infer<typeof decisionSchema>;
