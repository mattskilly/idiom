import { z } from "zod";
import { isFigmaHost, parseFigmaUrl } from "../design/figma/url.js";

const figmaHost = (source: string) => {
  try {
    return isFigmaHost(new URL(source).hostname);
  } catch {
    return false;
  }
};

/** Syntax only; entry points and response media types are checked at capture. */
export const designSourceSchema = z
  .string()
  .trim()
  .min(1)
  .refine((source) => {
    if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[A-Za-z]:[\\/]/.test(source)) {
      try {
        const url = new URL(source);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !/\.(?:png|jpe?g|gif|webp|svg|pdf|zip|css|js|mjs|json|txt|xml|woff2?|ttf|otf|mp4|webm)(?:$|\/)/i.test(
            url.pathname,
          )
        );
      } catch {
        return false;
      }
    }
    // A directory can have any suffix (e.g. export.v2). Filesystem resolution
    // distinguishes it from a non-HTML file; this schema checks path syntax.
    return !source.startsWith("//") && !source.includes("\0");
  }, "design must be a local HTML file/directory, a local PNG/JPEG/WebP image, an HTTP(S) HTML URL without credentials, or a Figma frame URL (for a remote image, download the image and reference the file)")
  .refine(
    (source) => !figmaHost(source) || parseFigmaUrl(source) !== undefined,
    "Figma design URLs must be https://www.figma.com/design/<file>/…?node-id=…",
  )
  .refine(
    (source) => !figmaHost(source) || parseFigmaUrl(source)?.nodeId,
    "Figma design URLs need ?node-id= (right-click the frame → Copy link to selection)",
  );

const credentialFreeHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const designSiteUrlSchema = z
  .string()
  .trim()
  .refine(
    credentialFreeHttpUrl,
    "design.site must be an absolute HTTP(S) URL without credentials",
  );
/** A live page used as the intended design ("make staging match production"). */
export const designSiteSchema = z
  .object({ site: designSiteUrlSchema })
  .strict();
/** Where one reference's intended design comes from: a source or a live site. */
export const designLocationSchema = z.union([
  designSourceSchema,
  designSiteSchema,
]);
export type DesignLocation = z.infer<typeof designLocationSchema>;

const IMAGE_EXTENSION = /\.(png|jpe?g|webp)$/i;
/** The lower-case extension of a local image design path, else undefined. */
export function imageDesignExtension(source: string): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[A-Za-z]:[\\/]/.test(source))
    return undefined;
  return IMAGE_EXTENSION.exec(source.trim())?.[1]?.toLowerCase();
}
export function designSourceLabel(location: DesignLocation): string {
  return typeof location === "string" ? location : location.site;
}

const referenceOptions = {
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "design reference names are lowercase slugs")
    .optional(),
  /** A project viewport name; for Figma, otherwise the nearest frame width. */
  viewport: z.string().trim().min(1).optional(),
  colorScheme: z.enum(["light", "dark"]).optional(),
};
/** One named design reference on a state: a source or a live site. */
export const designReferenceSchema = z.union([
  z.object({ source: designSourceSchema, ...referenceOptions }).strict(),
  z.object({ site: designSiteUrlSchema, ...referenceOptions }).strict(),
]);
export type DesignReference = z.infer<typeof designReferenceSchema>;
const designEntrySchema = z.union([designSourceSchema, designReferenceSchema]);
/** A source, a declaration, or several of either (for example Figma plus a prototype). */
export const designDeclarationSchema = z
  .union([designEntrySchema, z.array(designEntrySchema).min(1)])
  .superRefine((declaration, context) => {
    if (!Array.isArray(declaration)) return;
    const seen = new Set<string>();
    for (const [index, entry] of declaration.entries()) {
      const name = typeof entry === "string" ? undefined : entry.name;
      if (name === undefined) continue;
      if (seen.has(name))
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `duplicate design reference name ${name}`,
        });
      seen.add(name);
    }
  });
export type DesignDeclaration = z.infer<typeof designDeclarationSchema>;

export const componentToleranceDefault = {
  ratio: 0.15,
  px: 1,
  mode: "tighter" as const,
};
const toleranceOverride = z
  .object({
    ratio: z.number().finite().nonnegative().optional(),
    px: z.number().finite().nonnegative().optional(),
    mode: z.enum(["tighter", "looser"]).optional(),
  })
  .strict();
export const designDriftConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    tolerance: toleranceOverride.default(componentToleranceDefault),
    size: toleranceOverride.optional(),
    position: toleranceOverride.optional(),
    gap: toleranceOverride.optional(),
    radius: toleranceOverride.optional(),
    borderWidth: toleranceOverride.optional(),
    fontSize: toleranceOverride.optional(),
    lineHeight: toleranceOverride.optional(),
    fontWeight: z.number().finite().nonnegative().default(0),
    color: z.number().finite().nonnegative().default(0),
  })
  .strict();
export type DesignDriftConfig = z.infer<typeof designDriftConfigSchema>;
