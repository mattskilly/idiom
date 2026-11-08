import { z } from "zod";

export const targetToleranceSchema = z
  .object({
    ratio: z.number().finite().nonnegative().optional(),
    px: z.number().finite().nonnegative().optional(),
    mode: z.enum(["tighter", "looser"]).optional(),
  })
  .strict();

/** Resolve single-unit allowances without introducing a second default unit. */
export function normalizeTargetTolerance(
  target: number,
  tolerance: z.infer<typeof targetToleranceSchema> = {},
) {
  const { ratio, px, mode } = tolerance;
  if (ratio !== undefined && px !== undefined)
    return { ratio, px, mode: mode ?? ("looser" as const) };
  return {
    ratio: 0,
    px: px ?? (ratio === undefined ? 1 : Math.abs(target) * ratio),
    mode: "looser" as const,
  };
}

const selector = z.string().trim().min(1);
export const spacingTargetSchema = z
  .union([
    z
      .object({ between: z.tuple([selector, selector]), ...spacingFields() })
      .strict(),
    z.object({ within: selector, ...spacingFields() }).strict(),
  ])
  .refine(
    (target) =>
      !("between" in target) || target.between[0] !== target.between[1],
    "between selectors must differ",
  )
  .transform((target) => ({
    ...target,
    tolerance: normalizeTargetTolerance(target.gap, target.tolerance),
  }));

function spacingFields() {
  return {
    gap: z.number().finite().nonnegative(),
    axis: z.enum(["vertical", "horizontal"]).default("vertical"),
    tolerance: targetToleranceSchema.optional(),
  };
}
export type SpacingTarget = z.infer<typeof spacingTargetSchema>;
