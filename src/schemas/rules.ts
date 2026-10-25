import { z } from "zod";
import { findingCategories } from "./finding.js";

export const findingSeveritySchema = z.enum(["blocker", "major", "minor"]);

const ruleMatchSchema = z
  .object({
    fingerprint: z.string().trim().min(1).optional(),
    category: z.enum(findingCategories).optional(),
    flow: z.string().trim().min(1).optional(),
    state: z.string().trim().min(1).optional(),
    rule: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((match) => Object.keys(match).length > 0, {
    message: "must contain at least one match field",
  });

export const ruleOverrideSchema = z
  .object({
    id: z.string().trim().min(1),
    match: ruleMatchSchema,
    action: z.enum(["suppress", "severity"]),
    severity: findingSeveritySchema.optional(),
    reason: z.string().trim().min(1),
  })
  .strict()
  .superRefine((override, context) => {
    if (override.action === "severity" && override.severity === undefined) {
      context.addIssue({
        code: "custom",
        path: ["severity"],
        message: "is required when action is severity",
      });
    }
    if (override.action === "suppress" && override.severity !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["severity"],
        message: "is only allowed when action is severity",
      });
    }
  });

export const rulesSchema = z
  .object({
    version: z.literal(1),
    overrides: z.array(ruleOverrideSchema),
  })
  .strict()
  .superRefine((rules, context) => {
    const seen = new Set<string>();
    for (const [index, override] of rules.overrides.entries()) {
      if (seen.has(override.id)) {
        context.addIssue({
          code: "custom",
          path: ["overrides", index, "id"],
          message: `duplicate override id ${JSON.stringify(override.id)}`,
        });
      }
      seen.add(override.id);
    }
  });

export type RuleOverride = z.infer<typeof ruleOverrideSchema>;
export type Rules = z.infer<typeof rulesSchema>;
