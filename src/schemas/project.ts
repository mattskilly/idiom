import { z } from "zod";
import { validGlob } from "../../plugins/claude/hooks/lib.mjs";
import { filmstripConfigSchema } from "../checks/filmstrip-schema.js";
import { parseCssColor } from "../checks/shared.js";
import { designTokensSchema } from "../system/learn/schema.js";
import {
  componentToleranceDefault,
  designDriftConfigSchema,
} from "./design.js";

export const colorSchemeSchema = z.enum(["light", "dark"]);

export const critiqueProviderSchema = z.enum([
  "claude-code",
  "anthropic",
  "codex",
]);
export type CritiqueProvider = z.infer<typeof critiqueProviderSchema>;

const colorSchemesSchema = z
  .array(colorSchemeSchema)
  .min(1, "must contain at least one color scheme")
  .superRefine((schemes, context) => {
    const seen = new Set<string>();
    for (const [index, scheme] of schemes.entries()) {
      if (seen.has(scheme)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate color scheme ${JSON.stringify(scheme)}`,
        });
      }
      seen.add(scheme);
    }
  });

const htmlAttributeNameSchema = z
  .string()
  .regex(/^[A-Za-z_:][A-Za-z0-9_.:-]*$/, "must be a valid HTML attribute name");

const viewportSchema = z
  .object({
    name: z.string(),
    width: z.number(),
    height: z.number(),
    touch: z.boolean().optional(),
  })
  .strict();

const surfaceSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
  })
  .strict();

const surfacesSchema = z
  .array(surfaceSchema)
  .default([])
  .superRefine((surfaces, context) => {
    const seen = new Map<string, number>();
    for (const [index, surface] of surfaces.entries()) {
      const prior = seen.get(surface.id);
      if (prior !== undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `duplicates surfaces[${prior}].id`,
        });
      }
      seen.set(surface.id, index);
    }
  });

const componentSizeSchema = z
  .object({
    name: z.string().trim().min(1),
    selector: z.string().trim().min(1),
    width: z.number().positive(),
    height: z.number().positive(),
    tolerance: z
      .object({
        ratio: z.number().min(0).default(0.25),
        px: z.number().min(0).default(4),
        mode: z.enum(["tighter", "looser"]).default("looser"),
      })
      .strict()
      .default(componentToleranceDefault),
  })
  .strict();

const isValidRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
};

const regexList = z
  .array(
    z
      .string()
      .min(1)
      .refine(isValidRegex, "must be a valid regular expression"),
  )
  .default([]);

const selectorList = z.array(z.string().trim().min(1)).default([]);

const mirroredPairSchema = z
  .object({
    name: z.string().trim().min(1),
    a: z.string().trim().min(1),
    b: z.string().trim().min(1),
    axis: z.enum(["vertical", "horizontal"]).default("vertical"),
  })
  .strict()
  .refine((pair) => pair.a !== pair.b, {
    message: "a and b must be different selectors",
    path: ["b"],
  });

const radiusList = z
  .array(z.union([z.number().min(0), z.literal("full")]))
  .default([]);

const colorList = z
  .array(
    z
      .string()
      .trim()
      .refine(
        (value) => parseCssColor(value) !== undefined,
        "must be #rgb, #rrggbb, #rrggbbaa, rgb() or rgba()",
      ),
  )
  .default([]);

const scaleRoles = ["control", "card", "panel", "chip", "divider"] as const;

const shareSchema = z.number().gt(0).max(1);

const primaryRegionSchema = z
  .object({
    selector: z.string().trim().min(1),
    minShare: z.union([
      shareSchema,
      z
        .record(z.string().trim().min(1), shareSchema)
        .refine(
          (record) => Object.keys(record).length > 0,
          "must name at least one viewport",
        ),
    ]),
  })
  .strict();

const alarmSchema = z
  .object({ colors: colorList, brand: colorList, ignore: selectorList })
  .strict()
  .default({ colors: [], brand: [], ignore: [] });

const namingSchema = z
  .object({
    surfaces: z
      .record(z.string().trim().min(1), z.string().trim().min(1))
      .default({})
      .refine(
        (surfaces) => Object.keys(surfaces).length !== 1,
        "declare at least two surfaces to compare",
      ),
  })
  .strict()
  .default({ surfaces: {} });

const emptyStateSchema = z
  .object({
    regions: z
      .array(
        z
          .object({
            selector: z.string().trim().min(1),
            items: z.string().trim().min(1),
          })
          .strict(),
      )
      .default([]),
    auto: z.boolean().default(true),
    ignore: selectorList,
  })
  .strict()
  .default({ regions: [], auto: true, ignore: [] });

const pageSchema = z
  .object({
    ctaSelectors: selectorList,
    placeholderPatterns: regexList,
    claimsAllow: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

const scalesSchema = z
  .object({
    spacing: z
      .array(
        z.union([
          z.number().finite().nonnegative(),
          z.object({ multipleOf: z.number().finite().positive() }).strict(),
        ]),
      )
      .default([]),
    controlHeights: z.array(z.number().positive()).default([]),
    radius: z
      .object({
        control: radiusList,
        card: radiusList,
        panel: radiusList,
        chip: radiusList,
      })
      .strict()
      .default({ control: [], card: [], panel: [], chip: [] }),
    border: z
      .object({ divider: colorList, control: colorList })
      .strict()
      .default({ divider: [], control: [] }),
    roles: z
      .object({
        control: selectorList,
        card: selectorList,
        panel: selectorList,
        chip: selectorList,
        divider: selectorList,
      })
      .strict()
      .default({ control: [], card: [], panel: [], chip: [], divider: [] }),
    /** Off-scale repeats in one context that become a design-system question. */
    suggestAfter: z.number().int().min(2).default(5),
  })
  .strict()
  .default({
    spacing: [],
    controlHeights: [],
    radius: { control: [], card: [], panel: [], chip: [] },
    border: { divider: [], control: [] },
    roles: { control: [], card: [], panel: [], chip: [], divider: [] },
    suggestAfter: 5,
  });

const diagnosticSelectors = z
  .array(z.string().trim().min(1))
  .refine(
    (values) => new Set(values).size === values.length,
    "selectors must be unique",
  )
  .default([]);
export const touchReachabilityConfigSchema = z
  .object({ ignore: diagnosticSelectors })
  .strict();
export const livenessConfigSchema = z
  .object({
    selectors: diagnosticSelectors,
    auto: z.boolean().default(true),
    ignore: diagnosticSelectors,
  })
  .strict();

export const mediaFillConfigSchema = z
  .object({
    auto: z.boolean().default(true),
    bandThreshold: z.number().finite().gt(0).lt(1).default(0.2),
    tolerance: z.number().int().min(0).max(64).default(8),
    ignore: selectorList,
  })
  .strict()
  .prefault({});
export const collectionActions = ["open", "rename", "delete"] as const;
export const collectionsConfigSchema = z
  .array(
    z
      .object({
        selector: z.string().trim().min(1),
        name: z.string().trim().min(1).optional(),
        actions: z
          .array(z.enum(collectionActions))
          .min(1)
          .refine(
            (values) => new Set(values).size === values.length,
            "actions must be unique",
          )
          .default([...collectionActions]),
      })
      .strict(),
  )
  .refine(
    (values) =>
      new Set(values.map(({ selector }) => selector)).size === values.length,
    "collection selectors must be unique",
  )
  .default([]);

const copyEntrySchema = z
  .object({
    term: z.string().trim().min(1),
    preferred: z.string().trim().min(1),
  })
  .strict();

const copyPolicyFields = {
  locale: z.enum(["en-US", "en-GB", "en-CA", "en-AU"]),
  glossary: z.array(
    copyEntrySchema.extend({
      preferred: z.string().trim().min(1).optional(),
    }),
  ),
  retired: z.array(copyEntrySchema),
  jargon: z.array(copyEntrySchema),
  schemaWords: z.array(z.string().trim().min(1)),
  properNouns: z.array(z.string().trim().min(1)),
};

/** A file policy has no defaults until it is merged with project settings. */
export const copyPolicySchema = z.object(copyPolicyFields).strict().partial();
export const copyConfigSchema = z
  .object({
    ...copyPolicyFields,
    locale: copyPolicyFields.locale.optional(),
    glossary: copyPolicyFields.glossary.default([]),
    retired: copyPolicyFields.retired.default([]),
    jargon: copyPolicyFields.jargon.default([]),
    schemaWords: copyPolicyFields.schemaWords.default([]),
    properNouns: copyPolicyFields.properNouns.default([]),
  })
  .strict();
export type CopyConfig = z.infer<typeof copyConfigSchema>;
export type CopyPolicy = z.infer<typeof copyPolicySchema>;

export const checksConfigSchema = z
  .object({
    shellVisibility: z
      .object({
        floatingOverlays: z
          .array(z.string().trim().min(1))
          .refine(
            (values) => new Set(values).size === values.length,
            "floatingOverlays must be unique",
          )
          .default([]),
      })
      .strict()
      .optional(),
    compoundControls: z
      .object({
        tokenMax: z.number().int().min(1).max(8).default(4),
        minInset: z.number().finite().min(0).default(2),
      })
      .strict()
      .optional(),
    siblingChrome: z.object({ regions: selectorList }).strict().prefault({}),
    explanation: z.enum(["default", "visible"]).default("default"),
    minGap: z.number().min(0).default(3),
    adjacentGap: z
      .object({
        regions: selectorList,
        indicatorMax: z.number().min(0).default(16),
      })
      .strict()
      .prefault({}),
    centeringTolerance: z.number().positive().default(1.5),
    components: z.array(componentSizeSchema).default([]),
    copy: copyConfigSchema.prefault({}),
    glyphAllow: z.array(z.string().min(1)).default([]),
    errorPatterns: z.array(z.string().min(1)).default([]),
    selectedState: z
      .object({
        minColorDelta: z.number().min(1).max(255).default(24),
      })
      .strict()
      .default({ minColorDelta: 24 }),
    probe: z
      .object({
        enabled: z.boolean().default(true),
        everywhere: z.boolean().default(false),
        respectControlIntent: z.boolean().default(false),
        skip: z.array(z.string().trim().min(1)).default([]),
        maxControls: z.number().int().positive().default(80),
        waitMs: z.number().int().min(0).default(350),
        controlTimeoutMs: z.number().int().positive().default(5000),
        stateTimeoutMs: z.number().int().positive().default(60000),
        /** Run target for the whole probe in ms (resolved default 400000); 0 = no target. No zod default: keeps config hashes stable. */
        flowBudgetMs: z.number().int().min(0).optional(),
        /** Open disclosures and check what they reveal (resolved default true). No zod default. */
        disclosures: z.boolean().optional(),
        /** Revealed-state observations per state (resolved default 12); 0 = none. No zod default. */
        maxRevealed: z.number().int().min(0).optional(),
      })
      .strict()
      .default({
        enabled: true,
        everywhere: false,
        respectControlIntent: false,
        skip: [],
        maxControls: 80,
        waitMs: 350,
        controlTimeoutMs: 5000,
        stateTimeoutMs: 60000,
      }),
    /**
     * `idiom check --gate`: the build gate's wall-clock budget (resolved
     * default 180000) and globs of changed files that never affect the UI.
     * No zod default: keeps config hashes stable.
     */
    gate: z
      .object({
        budgetMs: z.number().int().min(1).optional(),
        nonUi: z
          .array(
            z
              .string()
              .refine(
                validGlob,
                "must be a project-relative glob using *, ? or **; braces, negation and extglobs are unsupported",
              ),
          )
          .optional(),
      })
      .strict()
      .optional(),
    disguisedControl: z
      .object({ placeholderPatterns: regexList, ignore: selectorList })
      .strict()
      .default({ placeholderPatterns: [], ignore: [] }),
    freshState: z
      .object({
        historyNames: regexList,
        historySelectors: selectorList,
        unsavedPatterns: regexList,
        unsavedSelectors: selectorList,
      })
      .strict()
      .default({
        historyNames: [],
        historySelectors: [],
        unsavedPatterns: [],
        unsavedSelectors: [],
      }),
    mirrored: z.array(mirroredPairSchema).default([]),
    motion: z
      .object({
        maxMs: z.number().finite().positive().default(150),
        durations: z
          .array(z.number().finite().positive())
          .refine(
            (values) => new Set(values).size === values.length,
            "durations must be unique",
          )
          .default([]),
        selectors: z.array(z.string().trim().min(1)).default([]),
        /** Smallest visible change (px) a content snap must reach. */
        minExtentPx: z.number().finite().positive().default(24),
      })
      .strict()
      .default({ maxMs: 150, durations: [], selectors: [], minExtentPx: 24 }),
    fieldGroups: z
      .object({
        inner: z.number().min(0).default(4),
        between: z.number().min(0).default(12),
      })
      .strict()
      .refine((value) => value.between >= value.inner, {
        message: "between must be at least inner",
        path: ["between"],
      })
      .default({ inner: 4, between: 12 }),
    scales: scalesSchema,
    designDrift: designDriftConfigSchema.optional(),
    luminanceParity: z
      .object({ primarySelectors: selectorList, ignore: selectorList })
      .strict()
      .prefault({}),
    frame: z
      .object({
        selector: z.string().trim().min(1).optional(),
        minLuminanceDelta: z.number().finite().min(0).max(1).default(0.05),
      })
      .strict()
      .prefault({}),
    targetSize: z
      .object({
        fine: z.number().finite().positive().default(24),
        coarse: z.number().finite().positive().default(44),
        narrowBelow: z.number().finite().positive().default(768),
      })
      .strict()
      .refine((value) => value.coarse >= value.fine, {
        message: "coarse must be at least fine",
        path: ["coarse"],
      })
      .optional(),
    primaryRegion: primaryRegionSchema.optional(),
    alarm: alarmSchema,
    naming: namingSchema,
    progressWithinMs: z.number().int().positive().default(1000),
    /** The probe's held replay: how long the action's responses are held. */
    loading: z
      .object({ delayMs: z.number().int().positive().default(1500) })
      .strict()
      .prefault({}),
    failure: z
      .object({
        mode: z.enum(["status", "network"]).default("status"),
        status: z.number().int().min(400).max(599).default(500),
        feedbackWithinMs: z.number().int().positive().default(2000),
      })
      .strict()
      .prefault({}),
    emptyState: emptyStateSchema,
    page: pageSchema.optional(),
    bandEdges: z
      .object({
        enabled: z.boolean().default(true),
        tolerance: z.number().finite().nonnegative().default(8),
      })
      .strict()
      .optional(),
    wordBreak: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .optional(),
    touchReachability: touchReachabilityConfigSchema.optional(),
    liveness: livenessConfigSchema.optional(),
    mediaFill: mediaFillConfigSchema,
    collections: collectionsConfigSchema,
    fonts: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .prefault({}),
    links: z
      .object({
        enabled: z.boolean().default(true),
        external: z.boolean().default(false),
        timeoutMs: z.number().int().positive().default(5000),
        budgetMs: z.number().int().positive().default(30000),
        concurrency: z.number().int().min(1).max(32).default(4),
        /** Absolute-URL or path prefixes that are never requested. */
        ignore: z.array(z.string().trim().min(1)).default([]),
      })
      .strict()
      .prefault({}),
    focusVisible: z
      .object({ enabled: z.boolean().default(true), ignore: selectorList })
      .strict()
      .prefault({}),
    lineLength: z
      .object({
        enabled: z.boolean().default(true),
        max: z.number().int().min(20).default(90),
      })
      .strict()
      .prefault({}),
    orphanWord: z
      .object({
        enabled: z.boolean().default(true),
        maxChars: z.number().int().min(1).default(7),
      })
      .strict()
      .prefault({}),
    nestedBorder: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .prefault({}),
    images: z
      .object({
        enabled: z.boolean().default(true),
        distortionTolerance: z.number().finite().gt(0).lt(1).default(0.03),
      })
      .strict()
      .prefault({}),
    layoutShift: z
      .object({
        enabled: z.boolean().default(true),
        max: z.number().finite().min(0).default(0.1),
      })
      .strict()
      .prefault({}),
    interactionShift: z
      .object({
        enabled: z.boolean().default(true),
        minDistance: z.number().finite().min(0).default(4),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type ChecksSettings = z.infer<typeof checksConfigSchema>;

export const defaultChecksSettings: ChecksSettings = checksConfigSchema.parse(
  {},
);

export type CheckMark = {
  purpose:
    | "history"
    | "unsaved"
    | "disguised-ignore"
    | "mirrored"
    | "primary-action"
    | "luminance-ignore"
    | "frame"
    | `scale-${(typeof scaleRoles)[number]}`
    | "primary-region"
    | "alarm-ignore"
    | "naming"
    | "cta"
    | "adjacent-region"
    | "sibling-region"
    | "brief";
  selector: string;
};

/** A decided brief's assertion selectors, resolved like configured marks. */
export function briefMarks(selectors: readonly string[] = []): CheckMark[] {
  return selectors.map((selector) => ({ purpose: "brief" as const, selector }));
}

/**
 * Configured selectors the capture resolves into the observation artifact,
 * so review-time checks can honour them without evaluating CSS.
 */
export function checkMarks(checks: ChecksSettings): CheckMark[] {
  return [
    ...checks.luminanceParity.primarySelectors.map((selector) => ({
      purpose: "primary-action" as const,
      selector,
    })),
    ...checks.luminanceParity.ignore.map((selector) => ({
      purpose: "luminance-ignore" as const,
      selector,
    })),
    ...(checks.frame.selector === undefined
      ? []
      : [{ purpose: "frame" as const, selector: checks.frame.selector }]),
    ...checks.freshState.historySelectors.map((selector) => ({
      purpose: "history" as const,
      selector,
    })),
    ...checks.freshState.unsavedSelectors.map((selector) => ({
      purpose: "unsaved" as const,
      selector,
    })),
    ...checks.disguisedControl.ignore.map((selector) => ({
      purpose: "disguised-ignore" as const,
      selector,
    })),
    ...[...new Set(checks.mirrored.flatMap((pair) => [pair.a, pair.b]))].map(
      (selector) => ({ purpose: "mirrored" as const, selector }),
    ),
    ...scaleRoles.flatMap((role) =>
      [...new Set(checks.scales.roles[role])].map((selector) => ({
        purpose: `scale-${role}` as const,
        selector,
      })),
    ),
    ...(checks.primaryRegion === undefined
      ? []
      : [
          {
            purpose: "primary-region" as const,
            selector: checks.primaryRegion.selector,
          },
        ]),
    ...[...new Set(checks.alarm.ignore)].map((selector) => ({
      purpose: "alarm-ignore" as const,
      selector,
    })),
    ...[...new Set(Object.values(checks.naming.surfaces))].map((selector) => ({
      purpose: "naming" as const,
      selector,
    })),
    ...[...new Set(checks.page?.ctaSelectors ?? [])].map((selector) => ({
      purpose: "cta" as const,
      selector,
    })),
    ...[...new Set(checks.adjacentGap.regions)].map((selector) => ({
      purpose: "adjacent-region" as const,
      selector,
    })),
    ...[...new Set(checks.siblingChrome.regions)].map((selector) => ({
      purpose: "sibling-region" as const,
      selector,
    })),
  ];
}

export const productionConfigExample = `add server.production to .idiom/project.json, for example:
{"server":{"production":{"build":"npm run build","start":"npm run start -- --port 3000","distDir":".next","env":{"PORT":"3000","DATA_DIR":"\${dataDir}"}}}}`;

export const productionSchema = z
  .object({
    reuseBuild: z.boolean().default(false),
    build: z.string().trim().min(1),
    start: z.string().trim().min(1),
    distDir: z
      .string()
      .trim()
      .min(1)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          !/^[A-Za-z]:/.test(path) &&
          path
            .split("/")
            .every((part) => part !== ".." && part !== "." && part !== "") &&
          ![".git", ".idiom", ".ab"].includes(path.split("/")[0] ?? ""),
        "must be a contained project-relative output directory (without . or .. segments)",
      )
      .optional(),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();

/** Routes `idiom coverage` leaves out of the uncaptured list. */
const coverageSchema = z
  .object({ exclude: z.array(z.string().trim().min(1)).default([]) })
  .strict();

const briefSectionContents = [
  "decision",
  "options",
  "criteria",
  "outOfScope",
  "evidence",
  "references",
  "text",
] as const;
export type BriefSectionContent = (typeof briefSectionContents)[number];

const briefSectionSchema = z
  .object({
    heading: z.string().trim().min(1).max(80),
    content: z.enum(briefSectionContents),
    /** Fixed Markdown for a `text` section; required there and nowhere else. */
    body: z.string().trim().min(1).optional(),
  })
  .strict();
export type BriefSection = z.infer<typeof briefSectionSchema>;

const briefReferenceSchema = z
  .object({
    name: z.string().trim().min(1),
    /** Documented tiers: bar, always, floor. */
    tier: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]*$/, "must be a lowercase tier such as bar"),
    note: z.string().trim().min(1),
    url: z.string().url().optional(),
  })
  .strict();
export type BriefReference = z.infer<typeof briefReferenceSchema>;

/** Sections the rendered brief must carry exactly once. */
const requiredBriefSections = ["decision", "criteria", "evidence"] as const;

/** `idiom brief`: the bar-setting products and the brief's ticket headings. */
export const briefConfigSchema = z
  .object({
    $comment: z.string().optional(),
    ticketTemplate: z
      .object({ sections: z.array(briefSectionSchema).min(1) })
      .strict()
      .optional(),
    references: z.array(briefReferenceSchema).default([]),
    /** `idiom brief "<request>" --research`: the run's wall-clock budget. */
    researchBudgetMs: z.number().int().min(60_000).max(3_600_000).optional(),
    /** Web searches allowed per research question. */
    researchMaxSearches: z.number().int().min(1).max(20).optional(),
  })
  .strict()
  .superRefine((brief, context) => {
    const sections = brief.ticketTemplate?.sections;
    if (sections === undefined) return;
    const seen = new Map<string, number>();
    for (const [index, section] of sections.entries()) {
      const path = ["ticketTemplate", "sections", index];
      if (section.content === "text" && section.body === undefined)
        context.addIssue({
          code: "custom",
          path: [...path, "body"],
          message: "a text section needs a body",
        });
      if (section.content !== "text" && section.body !== undefined)
        context.addIssue({
          code: "custom",
          path: [...path, "body"],
          message: "only a text section takes a body",
        });
      if (section.content === "text") continue;
      const prior = seen.get(section.content);
      if (prior !== undefined)
        context.addIssue({
          code: "custom",
          path: [...path, "content"],
          message: `${JSON.stringify(section.content)} already appears at sections[${prior}]`,
        });
      else seen.set(section.content, index);
    }
    for (const content of requiredBriefSections)
      if (!seen.has(content))
        context.addIssue({
          code: "custom",
          path: ["ticketTemplate", "sections"],
          message: `must include a ${JSON.stringify(content)} section`,
        });
  });
export type BriefConfig = z.infer<typeof briefConfigSchema>;

/** Autobuild's spec standard. */
export const DEFAULT_BRIEF_TICKET_TEMPLATE: BriefSection[] = [
  { heading: "What and why", content: "decision" },
  { heading: "Acceptance criteria", content: "criteria" },
  { heading: "Out of scope", content: "outOfScope" },
  { heading: "Evidence", content: "evidence" },
];

export const DEFAULT_BRIEF_RESEARCH_BUDGET_MS = 900_000;
export const DEFAULT_BRIEF_RESEARCH_MAX_SEARCHES = 5;

/** `checks.gate.budgetMs` when unset: three minutes. */
export const DEFAULT_GATE_BUDGET_MS = 180_000;

export type GateSettings = { budgetMs: number; nonUi: string[] };

export function resolveGateConfig(project: {
  checks: {
    gate?:
      | { budgetMs?: number | undefined; nonUi?: string[] | undefined }
      | undefined;
  };
}): GateSettings {
  return {
    budgetMs: project.checks.gate?.budgetMs ?? DEFAULT_GATE_BUDGET_MS,
    nonUi: project.checks.gate?.nonUi ?? [],
  };
}

export type BriefSettings = {
  sections: BriefSection[];
  references: BriefReference[];
  researchBudgetMs: number;
  researchMaxSearches: number;
};

export function briefSettings(
  project: { brief?: BriefConfig | undefined } | undefined,
): BriefSettings {
  return {
    sections:
      project?.brief?.ticketTemplate?.sections ?? DEFAULT_BRIEF_TICKET_TEMPLATE,
    references: project?.brief?.references ?? [],
    researchBudgetMs:
      project?.brief?.researchBudgetMs ?? DEFAULT_BRIEF_RESEARCH_BUDGET_MS,
    researchMaxSearches:
      project?.brief?.researchMaxSearches ??
      DEFAULT_BRIEF_RESEARCH_MAX_SEARCHES,
  };
}

const projectInputSchema = z
  .object({
    version: z.literal(1),
    app: z
      .object({
        name: z.string(),
        framework: z.enum(["nextjs", "other"]),
      })
      .strict(),
    server: z
      .object({
        build: z.string(),
        start: z.string(),
        readyUrl: z.string(),
        port: z.number(),
        fixedPort: z.boolean().optional(),
        env: z.record(z.string(), z.string()),
        production: productionSchema.optional(),
        startupTimeoutMs: z.number().default(60_000),
        /** Reuse a server already answering at readyUrl instead of starting one. No default. */
        reuse: z.boolean().optional(),
      })
      .strict(),
    viewports: z.array(viewportSchema).default([
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ]),
    surfaces: surfacesSchema,
    colorSchemes: colorSchemesSchema.optional(),
    capture: z
      .object({
        filmstrips: filmstripConfigSchema.default(() =>
          filmstripConfigSchema.parse({}),
        ),
        timezoneId: z.string().default("America/New_York"),
        locale: z.string().default("en-US"),
        colorScheme: colorSchemeSchema.default("light"),
        colorSchemeAttribute: htmlAttributeNameSchema.optional(),
        reducedMotion: z.boolean().default(true),
        /**
         * Make navigator.webdriver read false, for apps that turn motion off
         * under automation. No default: keeps existing config hashes stable.
         */
        hideWebdriver: z.boolean().optional(),
        fullPage: z.boolean().default(true),
        settleMs: z.number().default(250),
        animationSettleMs: z.number().finite().nonnegative().default(1500),
        maxMinutes: z.number().finite().positive().default(30),
        /**
         * Capture lanes (one per viewport and colour scheme) run at once.
         * Each tuple keeps its own fresh context; only tuples overlap.
         */
        concurrency: z.number().int().min(1).max(8).default(4),
      })
      .strict(),
    design: z
      .object({
        tokensFile: z.string().optional(),
        tokens: designTokensSchema.optional(),
        productFile: z.string().default("PRODUCT.md"),
        designFile: z.string().default("DESIGN.md"),
        /** A written spec `idiom sweep` compares each surface against. */
        specFile: z.string().optional(),
      })
      .strict(),
    baselines: z
      .object({ directory: z.string().min(1) })
      .strict()
      .optional(),
    agent: z
      .object({
        hooks: z.boolean().optional(),
        uiGlobs: z
          .array(
            z
              .string()
              .refine(
                validGlob,
                "must be a project-relative glob using *, ? or **; braces, negation and extglobs are unsupported",
              ),
          )
          .optional(),
      })
      .strict()
      .optional(),
    checks: checksConfigSchema.default(defaultChecksSettings),
    coverage: coverageSchema.optional(),
    brief: briefConfigSchema.optional(),
    findingNames: z
      .object({
        /** Skip the primary checkout's finding-name memory; for throwaway worktrees. */
        isolatedRegistry: z.boolean().optional(),
      })
      .strict()
      .optional(),
    model: z
      .object({
        provider: critiqueProviderSchema,
        model: z.string(),
        maxFindings: z.number().int().min(1).max(5).default(5),
        /** Used, visibly, only when the primary provider fails. */
        fallback: z
          .object({
            provider: critiqueProviderSchema,
            model: z.string().trim().min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((model, context) => {
        if (model.fallback?.provider === model.provider)
          context.addIssue({
            code: "custom",
            path: ["fallback", "provider"],
            message: "must differ from model.provider",
          });
      }),
  })
  .strict();

export const projectSchema = projectInputSchema
  .superRefine((project, context) => {
    if (
      project.colorSchemes !== undefined &&
      !project.colorSchemes.includes(project.capture.colorScheme)
    ) {
      context.addIssue({
        code: "custom",
        path: ["colorSchemes"],
        message: `must include capture.colorScheme ${JSON.stringify(project.capture.colorScheme)}`,
      });
    }
  })
  .transform((project) => ({
    ...project,
    colorSchemes: project.colorSchemes ?? [project.capture.colorScheme],
  }));

export type Project = z.infer<typeof projectSchema>;
export type ColorScheme = z.infer<typeof colorSchemeSchema>;
