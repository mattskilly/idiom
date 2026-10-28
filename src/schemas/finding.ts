import { z } from "zod";
import { acceptanceSchema, basisDetailsSchema } from "./acceptance.js";

export const artifactPathSchema = z
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

const regionRectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
const cropLabel = /^(?:Design(?:: [^()]+)?|App capture)(?: \(absent\))?$/;

/** Several references disagree on one matched element; a person chooses. */
export const designDecisionEvidenceSchema = z
  .object({
    version: z.literal(1),
    decisionKey: z.string().min(1),
    property: z.string().min(1),
    appSelector: z.string().min(1),
    appValue: z.union([z.string(), z.number(), z.null()]),
    references: z
      .array(
        z
          .object({
            name: z.string().min(1),
            source: z.string().min(1),
            value: z.union([z.string(), z.number(), z.null()]),
            allowance: z.number().finite().nonnegative().optional(),
            matchesBuild: z.boolean(),
            layerPath: z.string().min(1).optional(),
            link: z.string().min(1).optional(),
            pairId: z.string().min(1),
            designSelector: z.string().min(1),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();
export type DesignDecisionEvidence = z.infer<
  typeof designDecisionEvidenceSchema
>;

export const designDriftEvidenceSchema = z
  .object({
    version: z.literal(1),
    pairId: z.string().min(1),
    method: z.enum([
      "root",
      "data-node-id",
      "data-idiom-name",
      "role-name",
      "text",
      "descendants",
      "parent-position",
      "unmatched",
      "region",
    ]),
    property: z.string().min(1),
    designValue: z.union([z.string(), z.number(), z.null()]),
    appValue: z.union([z.string(), z.number(), z.null()]),
    designNormalized: z.union([z.string(), z.number(), z.null()]).optional(),
    appNormalized: z.union([z.string(), z.number(), z.null()]).optional(),
    allowance: z.number().finite().nonnegative().optional(),
    designSelector: z.string().nullable(),
    appSelector: z.string().nullable(),
    designContext: z.string().optional(),
    appContext: z.string().optional(),
    region: z
      .object({
        id: z.string().min(1),
        rect: regionRectSchema,
        designRect: regionRectSchema,
        offset: z.number().int(),
        owner: z.string().nullable(),
        elements: z.array(z.string()),
        /** Share of the region's cells that changed, 0–1. */
        changedArea: z.number().min(0).max(1),
      })
      .strict()
      .optional(),
    neighbour: z
      .object({
        pairId: z.string(),
        designSelector: z.string(),
        appSelector: z.string(),
      })
      .strict()
      .optional(),
    /** Figma provenance: layer names from the frame down, node link, bound variable. */
    designLayerPath: z.string().min(1).optional(),
    designLink: z.string().min(1).optional(),
    designVariable: z.string().min(1).optional(),
    /** Other design references that agree with this one on the property. */
    alsoReferences: z.array(z.string().min(1)).optional(),
    /** The design reference this finding is against, when not the first. */
    reference: z.string().min(1).optional(),
    /** The reference a person chose where references disagreed. */
    chosenReference: z.string().min(1).optional(),
    /** Set when several design references disagree on this property. */
    designDecision: designDecisionEvidenceSchema.optional(),
    crops: z
      .array(
        z
          .object({
            label: z.string().regex(cropLabel),
            path: artifactPathSchema,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type DesignDriftEvidence = z.infer<typeof designDriftEvidenceSchema>;

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
  "font-loading",
  "broken-link",
  "focus-visible",
  "line-length",
  "orphan-word",
  "image-distortion",
  "broken-image",
  "layout-shift",
  "interaction-shift",
  "design-drift",
  "loading-state-missing",
  "double-submit",
  "error-state-missing",
  "retry-blocked",
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
    basis: z.enum(["measured", "observed", "judged"]).optional(),
    basisDetails: basisDetailsSchema.optional(),
    category: z.enum(findingCategories),
    severity: z.enum(["blocker", "major", "minor"]),
    confidence: z.number().min(0).max(1),
    rule: z.string().optional(),
    evidence: z
      .object({
        screenshots: z.array(z.string()),
        designDrift: designDriftEvidenceSchema.optional(),
        references: z.array(z.string().trim().min(1)).optional(),
        artifacts: z.array(artifactPathSchema).optional(),
        /** The action timeline this finding was measured from. */
        timeline: z
          .object({ artifact: artifactPathSchema, id: z.string().min(1) })
          .strict()
          .optional(),
        filmstrip: z
          .object({
            sheet: artifactPathSchema.optional(),
            manifest: artifactPathSchema,
            action: z.string().min(1),
            status: z.enum(["complete", "partial", "unavailable"]),
            reason: z.string().optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            bytes: z.number().int().positive().optional(),
            generationMs: z.number().finite().nonnegative().optional(),
            limits: z
              .object({
                width: z.number().int().positive(),
                height: z.number().int().positive(),
                bytes: z.number().int().positive(),
              })
              .strict(),
          })
          .strict()
          .optional(),
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
    acceptance: z.union([acceptanceSchema, z.array(z.string())]),
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
    const basis =
      finding.basis ?? (finding.layer === "model" ? "judged" : "measured");
    if ((finding.layer === "model") !== (basis === "judged"))
      context.addIssue({
        code: "custom",
        path: ["basis"],
        message: "basis is inconsistent with layer",
      });
    if (finding.basisDetails && finding.basisDetails.kind !== basis)
      context.addIssue({
        code: "custom",
        path: ["basisDetails"],
        message: "details must match basis",
      });
    if (
      !Array.isArray(finding.acceptance) &&
      finding.acceptance.kind !== "legacy"
    ) {
      if (!finding.basis || !finding.basisDetails)
        context.addIssue({
          code: "custom",
          path: ["basis"],
          message: "new contracts require explicit basis and details",
        });
      if ((finding.acceptance.kind === "manual") !== (basis === "judged"))
        context.addIssue({
          code: "custom",
          path: ["acceptance"],
          message: "contract kind is inconsistent with basis",
        });
    }
    if (
      !Array.isArray(finding.acceptance) &&
      finding.acceptance.kind === "rule"
    ) {
      const contract = finding.acceptance;
      const original = contract.coordinate;
      const key = (c: typeof original) =>
        JSON.stringify([
          c.flow,
          c.state,
          c.viewport,
          c.colorScheme ?? "light",
          c.combination,
        ]);
      if (!contract.requiredCoordinates.some((c) => key(c) === key(original)))
        context.addIssue({
          code: "custom",
          path: ["acceptance", "requiredCoordinates"],
          message: "must include the original coordinate",
        });
      if (
        key(original) !==
          key({
            ...finding,
            colorScheme: finding.colorScheme ?? original.colorScheme,
          }) ||
        contract.rule !== finding.rule ||
        contract.check !== finding.verification.check
      )
        context.addIssue({
          code: "custom",
          path: ["acceptance"],
          message: "rule, evaluator and coordinate must match the finding",
        });
    }
    if (basis === "observed" && !finding.basisDetails)
      context.addIssue({
        code: "custom",
        path: ["basisDetails"],
        message: "observed basis requires action and timing details",
      });
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
  })
  .transform((finding) => {
    const basis =
      finding.basis ?? (finding.layer === "model" ? "judged" : "measured");
    const basisDetails =
      finding.basisDetails ??
      (basis === "judged"
        ? {
            kind: "judged" as const,
            summary: "Model critique",
            confidence: finding.confidence,
          }
        : {
            kind: "measured" as const,
            rule: finding.rule ?? finding.category,
            summary:
              "Measurement details were not recorded in this historical finding.",
          });
    return {
      ...finding,
      basis,
      basisDetails,
      acceptance: Array.isArray(finding.acceptance)
        ? {
            version: 1 as const,
            kind: "legacy" as const,
            doneWhen: finding.acceptance,
          }
        : finding.acceptance,
    };
  });

export type FindingInput = z.input<typeof findingSchema>;
export type Finding = z.infer<typeof findingSchema>;
