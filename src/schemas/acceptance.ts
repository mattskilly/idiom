import { z } from "zod";

export const coordinateSchema = z
  .object({
    flow: z.string().min(1),
    state: z.string().min(1),
    viewport: z.string().min(1),
    colorScheme: z.enum(["light", "dark"]).optional(),
    combination: z.string().optional(),
  })
  .strict();
export const actionTargetSchema = z
  .object({
    source: z.enum([
      "load",
      "web-step",
      "probe-click",
      "probe-hover",
      "slow-replay",
      "failure-replay",
      "focus-trial",
      "touch-trial",
      "liveness",
      "progress",
      "explanation-trial",
      "collection-probe",
      "load-sample",
    ]),
    kind: z.string().min(1),
    name: z.string(),
    selector: z.string().min(1).optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    heldOf: z.enum(["web-step", "probe-click"]).optional(),
    failureOf: z.enum(["web-step", "probe-click"]).optional(),
  })
  .strict();
export const acceptanceTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("selectors"),
      selectors: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("document"),
      scope: z.string().optional(),
      reference: z.string().optional(),
      region: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("action"),
      action: actionTargetSchema,
      relatedActions: z.array(actionTargetSchema).optional(),
    })
    .strict(),
]);
const text = { version: z.literal(1), doneWhen: z.array(z.string()) };
export const acceptanceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...text,
      kind: z.literal("rule"),
      rule: z.string().min(1),
      check: z.string().min(1),
      coordinate: coordinateSchema,
      requiredCoordinates: z.array(coordinateSchema).min(1),
      target: acceptanceTargetSchema,
      condition: z
        .object({
          kind: z.literal("rule-clear"),
          parameters: z.record(z.string(), z.json()),
          settingsIdentity: z.string().min(1),
          allowRemoval: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.object({ ...text, kind: z.literal("manual") }).strict(),
  z.object({ ...text, kind: z.literal("legacy") }).strict(),
]);
export const basisDetailsSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("measured"),
      rule: z.string(),
      summary: z.string(),
      measurement: z.record(z.string(), z.json()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("observed"),
      summary: z.string(),
      action: actionTargetSchema,
      timing: z
        .object({
          elapsedMs: z.number().finite().nonnegative().optional(),
          windowMs: z.number().finite().nonnegative().optional(),
          reason: z.string().optional(),
        })
        .strict(),
      result: z.record(z.string(), z.json()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("judged"),
      summary: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    })
    .strict(),
]);
export type Acceptance = z.infer<typeof acceptanceSchema>;
export type RuleAcceptance = Extract<Acceptance, { kind: "rule" }>;
export type BasisDetails = z.infer<typeof basisDetailsSchema>;
export type FindingBasis = BasisDetails["kind"];
export type AcceptanceAction = z.infer<typeof actionTargetSchema>;
