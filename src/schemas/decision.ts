import { z } from "zod";
import { rulingResolutionSchema } from "./ruling.js";
import { findingSeveritySchema } from "./severity.js";

export const decisionProvenanceSchema = z
  .object({
    build: z.string().trim().min(1),
    escalation: z.string().trim().min(1).optional(),
  })
  .strict();

export const rulingDecisionSchema = z
  .object({
    at: z.iso.datetime(),
    commit: z.string(),
    findingId: z.string(),
    fingerprint: z.string(),
    decision: z.literal("ruling"),
    actor: z.string().default("human"),
    reason: z.string().trim().min(1),
    resolution: rulingResolutionSchema,
    provenance: decisionProvenanceSchema.optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.fingerprint === record.resolution.fingerprint &&
      record.findingId === record.resolution.id,
    "ruling identity must match its resolution",
  );
export type RulingDecision = z.infer<typeof rulingDecisionSchema>;

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
    provenance: decisionProvenanceSchema.optional(),
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

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date")
  .refine(
    (value) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    "expected a real calendar date",
  );

/**
 * `decide --ack`: a real problem tracked elsewhere. Not a judgment, so it
 * never reads as an accept or a reject; it only keeps the finding out of the
 * gate until it lapses.
 */
export const acknowledgementSchema = z
  .object({
    at: z.iso.datetime(),
    commit: z.string(),
    findingId: z.string(),
    fingerprint: z.string(),
    decision: z.enum(["acknowledge", "unacknowledge"]),
    /** A ticket id or URL; `unacknowledge` echoes the one it removed. */
    reference: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => !/[\r\n]/.test(value), "must be a single line"),
    /** Inclusive: the acknowledgement lapses the day after. */
    until: calendarDate.optional(),
    note: z.string().optional(),
    /** What was acknowledged; a later occurrence that differs materially lapses it. */
    evidence: z
      .object({
        severity: findingSeveritySchema,
        rule: z.string().optional(),
        category: z.string(),
      })
      .strict()
      .optional(),
    actor: z.string().default("human"),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.decision === "acknowledge" && record.evidence === undefined)
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "an acknowledgement records the evidence it covers",
      });
  });

export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

/** Every line of .idiom/decisions.jsonl: a judgment or an acknowledgement. */
export const decisionLogEntrySchema = z.union([
  decisionSchema,
  acknowledgementSchema,
  rulingDecisionSchema,
]);

export type DecisionLogEntry = z.infer<typeof decisionLogEntrySchema>;

export function isAcknowledgement(
  entry: DecisionLogEntry,
): entry is Acknowledgement {
  return entry.decision === "acknowledge" || entry.decision === "unacknowledge";
}
