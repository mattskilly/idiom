import { z } from "zod";
import { findingCategories } from "../schemas/finding.js";

const fingerprint = z.string().regex(/^[0-9a-f]+$/);
export const baselineFindingSchema = z
  .object({
    fingerprint,
    aliases: z.array(fingerprint),
    category: z.enum(findingCategories),
    rule: z.string(),
    severity: z.enum(["blocker", "major", "minor"]),
    selector: z.string(),
  })
  .strict();
export const baselineTupleSchema = z
  .object({
    state: z.string().min(1),
    viewport: z.string().min(1),
    colorScheme: z.enum(["light", "dark"]).optional(),
    combination: z.string().min(1).optional(),
    findings: z.array(baselineFindingSchema),
  })
  .strict();
export const baselineRecordSchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    recordedAt: z.iso.datetime(),
    idiomVersion: z.string().min(1),
    configHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    tuples: z.array(baselineTupleSchema),
  })
  .strict();
export const baselineFileSchema = z
  .object({
    version: z.literal(1),
    flow: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    records: z.array(baselineRecordSchema),
  })
  .strict();
export type BaselineFinding = z.infer<typeof baselineFindingSchema>;
export type BaselineTuple = z.infer<typeof baselineTupleSchema>;
export type BaselineRecord = z.infer<typeof baselineRecordSchema>;
export type BaselineFile = z.infer<typeof baselineFileSchema>;
