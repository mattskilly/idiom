import { z } from "zod";
import { parseCssColor } from "../checks/shared.js";
import { designTokensSchema } from "../system/learn/schema.js";

export const colorSchemeSchema = z.enum(["light", "dark"]);

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
      .default({ ratio: 0.15, px: 1, mode: "tighter" }),
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
  })
  .strict()
  .default({
    spacing: [],
    controlHeights: [],
    radius: { control: [], card: [], panel: [], chip: [] },
    border: { divider: [], control: [] },
    roles: { control: [], card: [], panel: [], chip: [], divider: [] },
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
      })
      .strict()
      .default({ maxMs: 150, durations: [], selectors: [] }),
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
    | "sibling-region";
  selector: string;
};

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
        timezoneId: z.string().default("America/New_York"),
        locale: z.string().default("en-US"),
        colorScheme: colorSchemeSchema.default("light"),
        colorSchemeAttribute: htmlAttributeNameSchema.optional(),
        reducedMotion: z.boolean().default(true),
        fullPage: z.boolean().default(true),
        settleMs: z.number().default(250),
        maxMinutes: z.number().finite().positive().default(30),
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
    checks: checksConfigSchema.default(defaultChecksSettings),
    coverage: coverageSchema.optional(),
    model: z
      .object({
        provider: z.enum(["claude-code", "anthropic"]),
        model: z.string(),
        maxFindings: z.number().int().min(1).max(5).default(5),
      })
      .strict(),
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
