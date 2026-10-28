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

export const scaleClusterPropertySchema = z.enum([
  "spacing:padding",
  "spacing:margin",
  "spacing:gap",
  "height",
  "radius",
  "border",
]);

export const scaleClusterContextSchema = z
  .object({
    landmark: z.string().trim().min(1),
    component: z.string().trim().min(1),
    viewport: z.string().trim().min(1),
  })
  .strict();

/** A suggested token name: what `idiom ruling --add-step --token` accepts. */
export const scaleTokenSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "must start with a letter or digit and use only letters, digits, '.', '_' or '-' (at most 64 characters)",
  );

/** A repeated off-scale value asked as one design-system question. */
export const scaleClusterSchema = z
  .object({
    property: scaleClusterPropertySchema,
    value: z.string().trim().min(1),
    count: z.number().int().positive(),
    distinctStates: z.number().int().positive(),
    distinctElements: z.number().int().positive(),
    context: scaleClusterContextSchema,
    componentLabel: z.string().trim().min(1),
    nearestSteps: z
      .object({
        below: z.string().trim().min(1).optional(),
        above: z.string().trim().min(1).optional(),
        steps: z.array(z.string().trim().min(1)),
      })
      .strict(),
    suggestedToken: scaleTokenSchema,
    examples: z
      .array(
        z
          .object({
            state: z.string().trim().min(1),
            viewport: z.string().trim().min(1),
            colorScheme: colorSchemeSchema.optional(),
            screenshot: z.string().trim().min(1),
            selector: z.string().trim().min(1),
            crop: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();

export const unruledDecisionSchema = z
  .object({
    id: z.string().regex(/^ruling-[1-9]\d*$/),
    fingerprint: z.string().trim().min(1),
    choiceKey: z.string().trim().min(1),
    question: z.string().trim().min(1),
    nearestLawExcerpt: z.string().trim().min(1),
    occurrences: z.array(rulingCoordinateSchema).min(1),
    candidates: z.array(rulingCandidateSchema),
    /** Present on a design-system question raised by scale-conformance. */
    scaleCluster: scaleClusterSchema.optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    // Model decisions recur across states; a scale question may sit in one
    // state when it spans three distinct elements.
    if (decision.scaleCluster === undefined && decision.occurrences.length < 2)
      context.addIssue({
        code: "custom",
        path: ["occurrences"],
        message: "must contain at least 2 occurrences",
      });
    else if (
      decision.scaleCluster === undefined &&
      new Set(decision.occurrences.map((item) => item.state)).size < 2
    )
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
    /** The answer to a design-system question. */
    scale: z
      .object({
        answer: z.enum(["add-step", "drift"]),
        property: scaleClusterPropertySchema,
        value: z.string().trim().min(1),
        context: scaleClusterContextSchema,
        token: scaleTokenSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((resolution, context) => {
    const scale = resolution.scale;
    if (scale?.answer === "add-step") {
      if (resolution.outcome !== "rule")
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "an add-step answer records a rule",
        });
      if (scale.token === undefined)
        context.addIssue({
          code: "custom",
          path: ["scale", "token"],
          message: "required for an add-step answer",
        });
    }
    if (scale?.answer === "drift") {
      if (resolution.outcome !== "no-rule")
        context.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "a drift answer records no rule",
        });
      if (scale.token !== undefined)
        context.addIssue({
          code: "custom",
          path: ["scale", "token"],
          message: "must be omitted for a drift answer",
        });
    }
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
    if (
      resolution.outcome === "no-rule" &&
      resolution.reason !== undefined &&
      scale === undefined
    ) {
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
export type ScaleClusterDecision = z.infer<typeof scaleClusterSchema>;
