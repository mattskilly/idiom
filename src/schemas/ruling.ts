import { z } from "zod";
import { colorSchemeSchema } from "./project.js";

export const rulingCoordinateSchema = z
  .object({
    state: z.string().trim().min(1),
    viewport: z.string().trim().min(1),
    colorScheme: colorSchemeSchema.optional(),
    screenshot: z.string().trim().min(1),
  })
  .strict();

export const rulingPrecedentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("law"),
      excerpt: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("governed-surface"),
      screenshot: z.string().trim().min(1),
      state: z.string().trim().min(1),
      viewport: z.string().trim().min(1),
      colorScheme: colorSchemeSchema.optional(),
    })
    .strict(),
]);

export const rulingCandidateSchema = z
  .object({
    wording: z.string().trim().min(1),
    precedent: rulingPrecedentSchema,
  })
  .strict();

export const decisionObservationSchema = z
  .object({
    choiceKey: z.string().trim().min(1),
    question: z.string().trim().min(1),
    state: z.string().trim().min(1),
    viewport: z.string().trim().min(1),
    colorScheme: colorSchemeSchema.optional(),
    screenshot: z.string().trim().min(1),
    nearestLawExcerpt: z.string().trim().min(1),
    candidates: z.array(rulingCandidateSchema),
  })
  .strict();

export const unruledDecisionSchema = z
  .object({
    id: z.string().regex(/^ruling-[1-9]\d*$/),
    fingerprint: z.string().trim().min(1),
    choiceKey: z.string().trim().min(1),
    question: z.string().trim().min(1),
    nearestLawExcerpt: z.string().trim().min(1),
    occurrences: z.array(rulingCoordinateSchema).min(2),
    candidates: z.array(rulingCandidateSchema),
  })
  .strict()
  .superRefine((decision, context) => {
    if (new Set(decision.occurrences.map((item) => item.state)).size < 2)
      context.addIssue({
        code: "custom",
        path: ["occurrences"],
        message: "must recur across at least two distinct states",
      });
    const seen = new Set<string>();
    for (const [index, item] of decision.occurrences.entries()) {
      const key = `${item.state}\0${item.viewport}\0${item.colorScheme ?? ""}\0${item.screenshot}`;
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: ["occurrences", index],
          message: "duplicate occurrence coordinate",
        });
      seen.add(key);
    }
  });

export const rulingResolutionSchema = z
  .object({
    id: z.string().regex(/^ruling-[1-9]\d*$/),
    fingerprint: z.string().trim().min(1),
    choiceKey: z.string().trim().min(1),
    outcome: z.enum(["rule", "no-rule"]),
    wording: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((resolution, context) => {
    if (resolution.outcome === "rule" && resolution.wording === undefined) {
      context.addIssue({
        code: "custom",
        path: ["wording"],
        message: "required for a rule outcome",
      });
    }
    if (resolution.outcome === "no-rule" && resolution.wording !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["wording"],
        message: "must be omitted for a no-rule outcome",
      });
    }
    if (resolution.outcome === "no-rule" && resolution.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "must be omitted for a no-rule outcome",
      });
    }
  });

export type RulingCoordinate = z.infer<typeof rulingCoordinateSchema>;
export type RulingPrecedent = z.infer<typeof rulingPrecedentSchema>;
export type RulingCandidate = z.infer<typeof rulingCandidateSchema>;
export type DecisionObservation = z.infer<typeof decisionObservationSchema>;
export type UnruledDecision = z.infer<typeof unruledDecisionSchema>;
export type RulingResolution = z.infer<typeof rulingResolutionSchema>;
