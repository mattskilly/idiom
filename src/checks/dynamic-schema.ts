import { z } from "zod";
import {
  livenessConfigSchema,
  touchReachabilityConfigSchema,
} from "../schemas/project.js";

const identity = z.string().trim().min(1);
const dimension = z.number().finite().nonnegative();
const rect = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: dimension,
    height: dimension,
  })
  .strict();
const diagnosticBase = {
  version: z.literal(1),
  status: z.enum(["ran", "partial", "unavailable"]),
  diagnostics: z.array(identity),
};
const trial = z
  .object({
    status: z.enum(["revealed", "hidden", "unavailable"]),
    reason: identity.optional(),
  })
  .strict();
export const touchReachabilityArtifactSchema = z
  .object({
    ...diagnosticBase,
    declaration: touchReachabilityConfigSchema,
    eligible: z.number().int().nonnegative(),
    restored: z.boolean(),
    entries: z.array(
      z
        .object({
          selector: identity,
          identity: identity,
          name: z.string(),
          rect,
          elapsedMs: dimension.optional(),
          owner: identity,
          baseline: z
            .object({
              visibility: identity,
              opacity: z.number().finite().min(0).max(1),
            })
            .strict(),
          cause: z.enum(["visibility", "opacity", "visibility and opacity"]),
          hover: trial,
          focus: trial.extend({ target: identity.optional() }).strict(),
        })
        .strict(),
    ),
  })
  .strict();
export const livenessArtifactSchema = z
  .object({
    ...diagnosticBase,
    declaration: livenessConfigSchema,
    entries: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            status: z.literal("measured"),
            selector: identity,
            identity: identity,
            source: z.enum(["declared", "automatic"]),
            declaration: identity.optional(),
            before: identity,
            after: identity,
            elapsedMs: dimension,
          })
          .strict(),
        z
          .object({
            status: z.literal("unavailable"),
            selector: identity,
            identity: identity,
            source: z.enum(["declared", "automatic"]),
            declaration: identity.optional(),
            reason: identity,
          })
          .strict(),
      ]),
    ),
  })
  .strict();
export type TouchReachabilityArtifact = z.infer<
  typeof touchReachabilityArtifactSchema
>;
export type LivenessArtifact = z.infer<typeof livenessArtifactSchema>;
