import { z } from "zod";

export const tokenKindSchema = z.enum([
  "color",
  "spacing",
  "radius",
  "control-height",
  "other",
]);
export const designTokenSchema = z
  .object({
    name: z.string().trim().min(1),
    value: z.string().trim().min(1),
    kind: tokenKindSchema,
    source: z
      .object({
        path: z
          .string()
          .min(1)
          .refine(
            (path) =>
              !/^(?:[/\\]|[A-Za-z]:)/.test(path) &&
              !path.split(/[/\\]/).includes(".."),
            "must be project-relative",
          ),
        key: z.string().min(1),
      })
      .strict(),
    theme: z.string().optional(),
  })
  .strict();
export const designTokensSchema = z
  .array(designTokenSchema)
  .superRefine((tokens, ctx) => {
    const seen = new Set<string>();
    for (const [index, token] of tokens.entries()) {
      const id = tokenIdentity(token);
      if (seen.has(id))
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "duplicate source/key/theme identity",
        });
      seen.add(id);
    }
  });
export type DesignToken = z.infer<typeof designTokenSchema>;
export type TokenKind = DesignToken["kind"];
export function tokenIdentity(token: DesignToken): string {
  return JSON.stringify([
    token.source.path,
    token.source.key,
    token.theme ?? null,
  ]);
}
