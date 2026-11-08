import { z } from "zod";

export const pendingDecisionSchema = z
  .object({
    kind: z.enum(["reference-conflict", "unruled", "scaleCluster"]),
    key: z.string().min(1),
    fingerprint: z.string().min(1),
    id: z.string().min(1),
    /** Every finding occurrence this question stands for (viewports, schemes). */
    findingIds: z.array(z.string()).optional(),
    flow: z.string(),
    runDirectory: z.string(),
    artifact: z.string(),
    question: z.string(),
    coordinates: z.array(
      z.object({
        state: z.string(),
        viewport: z.string(),
        colorScheme: z.enum(["light", "dark"]).optional(),
      }),
    ),
    evidence: z.array(z.string()),
    missingCropEvidence: z.boolean(),
    citations: z.array(z.string()),
    options: z.array(
      z.object({
        label: z.string(),
        args: z.array(z.string()),
        input: z.enum(["wording", "reason"]).optional(),
      }),
    ),
  })
  .strict();
export type PendingDecision = z.infer<typeof pendingDecisionSchema>;
