import { z } from "zod";

const artifactPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !/^[A-Za-z]:/.test(path) &&
      !path.includes("\\") &&
      !path.split("/").includes(".."),
    "must be a report-relative artifact path",
  );

const locusNodeSchema = z
  .object({ selector: z.string().min(1), signature: z.string().min(1) })
  .strict();

export const verificationLocusSchema = z
  .object({
    version: z.literal(1),
    target: locusNodeSchema,
    region: locusNodeSchema,
    relativePath: z.string().min(1),
  })
  .strict();

export const findingCategories = [
  "overflow-clip",
  "responsive-break",
  "contrast",
  "a11y-label",
  "target-size",
  "heading-structure",
  "token-drift",
  "console-error",
  "missing-state",
  "spacing-rhythm",
  "unexplained-control",
  "text-centering",
  "adjacent-gap",
  "dead-affordance",
  "dead-control",
  "duplicate-entry",
  "component-size",
  "copy-lint",
  "glyph-icon",
  "error-text",
  "native-control",
  "layout-invariants",
  "group-invariants",
  "selected-state",
  "dialog-shell",
  "disguised-control",
  "fresh-state",
  "mirrored-control",
  "motion",
  "element-overlap",
  "clipped-text",
  "field-group",
  "scale-conformance",
  "control-anatomy",
  "luminance-parity",
  "frame",
  "primary-region",
  "alarm-at-rest",
  "cross-surface-naming",
  "published-budget",
  "empty-state",
  "progress-affordance",
  "page-content",
  "band-edges",
  "word-break",
  "shell-visibility",
  "compound-control",
  "sibling-chrome",
  "touch-reachability",
  "liveness",
  "media-fill",
  "collection-actions",
  "hierarchy",
  "density",
  "brand-alignment",
  "generic-pattern",
  "reference-mismatch",
  "spec-mismatch",
  "direction-drift",
  "offer-change",
  "unsupported-claim",
] as const;

/** Critique focus areas a page review can request (`idiom review --page --focus`). */
export const pageFocusAreas = [
  "hierarchy",
  "primary-action",
  "naming",
  "radii-heights",
  "jargon",
] as const;

export type PageFocusArea = (typeof pageFocusAreas)[number];

/** What an advisory design-intent review of a pattern may judge. */
export const advisoryAspects = ["spacing", "hierarchy", "coherence"] as const;

export type AdvisoryAspect = (typeof advisoryAspects)[number];

export const briefCitationSchema = z
  .object({
    source: z.enum(["brief", "direction"]),
    line: z.number().int().min(1),
    excerpt: z.string(),
  })
  .strict();

export const findingSchema = z
  .object({
    id: z.string().min(1),
    idAliases: z.array(z.string().min(1)).optional(),
    fingerprint: z.string(),
    /** Same element and rule across states and schemes (deterministic only). */
    groupKey: z.string().min(1).optional(),
    createdAt: z.iso.datetime(),
    commit: z.string(),
    flow: z.string(),
    state: z.string(),
    viewport: z.string(),
    colorScheme: z.enum(["light", "dark"]).optional(),
    combination: z.string().optional(),
    layer: z.enum(["deterministic", "model"]),
    category: z.enum(findingCategories),
    severity: z.enum(["blocker", "major", "minor"]),
    confidence: z.number().min(0).max(1),
    rule: z.string().optional(),
    evidence: z
      .object({
        screenshots: z.array(z.string()),
        references: z.array(z.string().trim().min(1)).optional(),
        artifacts: z.array(artifactPathSchema).optional(),
        domSnippet: z.string().optional(),
        consoleExcerpt: z.string().optional(),
        axeNodes: z.array(z.unknown()).optional(),
        section: z.string().min(1).optional(),
        citations: z.array(briefCitationSchema).optional(),
      })
      .strict(),
    explanation: z.string(),
    suggestedArea: z.string().optional(),
    fix: z.string().min(1).optional(),
    focus: z.enum(pageFocusAreas).optional(),
    acceptance: z.array(z.string()),
    verification: z
      .object({
        kind: z.enum(["deterministic-check", "recapture-visual", "manual"]),
        check: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        locus: verificationLocusSchema.optional(),
      })
      .strict(),
    status: z.enum([
      "open",
      "approved",
      "rejected",
      "ticketed",
      "verified-fixed",
      "verify-failed",
    ]),
  })
  .strict()
  .superRefine((finding, context) => {
    const aliases = finding.idAliases ?? [];
    const seen = new Set<string>();
    for (const [index, alias] of aliases.entries()) {
      if (alias === finding.id) {
        context.addIssue({
          code: "custom",
          path: ["idAliases", index],
          message: "must differ from id",
        });
      }
      if (seen.has(alias)) {
        context.addIssue({
          code: "custom",
          path: ["idAliases", index],
          message: "must be unique",
        });
      }
      if (/^finding-[1-9]\d*$/.test(alias)) {
        context.addIssue({
          code: "custom",
          path: ["idAliases", index],
          message: "canonical finding names cannot be aliases",
        });
      }
      seen.add(alias);
    }
  });

export type Finding = z.infer<typeof findingSchema>;
