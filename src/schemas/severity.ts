import { z } from "zod";

export const findingSeveritySchema = z.enum([
  "blocker",
  "major",
  "minor",
  "info",
]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;
export const severityRank: Record<FindingSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};
