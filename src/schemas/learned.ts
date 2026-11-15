import { z } from "zod";

export const learnedKinds = [
  "component",
  "invariant",
  "glossary",
  "mirrored",
  "law",
  "ruling",
  "observation",
] as const;

/** The kinds a candidate rule can take: every kind but `observation`. */
export const candidateKinds = [
  "component",
  "invariant",
  "glossary",
  "mirrored",
  "law",
  "ruling",
] as const;

export const checkables = ["deterministic", "judged", "reference"] as const;
export type Checkable = (typeof checkables)[number];

export const placementVias = [
  "state",
  "brief",
  "screenshot",
  "words",
  "only-state",
  "proposed",
] as const;
export type PlacementVia = (typeof placementVias)[number];

/** The generalised rule an observation suggests, and how it could be checked. */
export const learnedCandidateSchema = z
  .object({
    rule: z.string().trim().min(1),
    kind: z.enum(candidateKinds),
    checkable: z.enum(checkables),
  })
  .strict();
export type LearnedCandidate = z.infer<typeof learnedCandidateSchema>;

/** How learn found the flow state an observation applies to. */
export const learnedPlacementSchema = z
  .object({
    via: z.enum(placementVias),
    similarity: z.number().min(0).max(1).optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
    viewport: z.string().trim().min(1).optional(),
    colorScheme: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    tokens: z.array(z.string().trim().min(1)).optional(),
    proposal: z.string().trim().min(1).optional(),
  })
  .strict();
export type LearnedPlacement = z.infer<typeof learnedPlacementSchema>;

/** Where a harvested correction was written (`learn --harvest`). */
export const harvestSources = [
  "escalation",
  "pr-review-comment",
  "pr-review",
  "pr-comment",
] as const;
export type HarvestSource = (typeof harvestSources)[number];

/** The kinds of UI or UX correction harvest recognises. */
export const uiCategories = [
  "layout",
  "spacing",
  "copy",
  "interaction",
  "visual",
] as const;
export type UiCategory = (typeof uiCategories)[number];

/**
 * The attribution of a harvested correction: the source it came from, a
 * stable key that makes re-harvesting idempotent, and who wrote it when.
 */
export const learnedHarvestSchema = z
  .object({
    source: z.enum(harvestSources),
    key: z.string().trim().min(1),
    at: z.string().datetime({ offset: true }),
    author: z.string().trim().min(1).optional(),
    build: z.string().trim().min(1).optional(),
    escalation: z.string().trim().min(1).optional(),
    pr: z.number().int().positive().optional(),
    url: z.string().trim().min(1).optional(),
    path: z.string().trim().min(1).optional(),
    categories: z.array(z.enum(uiCategories)).min(1),
  })
  .strict();
export type LearnedHarvest = z.infer<typeof learnedHarvestSchema>;

/** `.idiom/harvest.json`: the newest item examined per source. */
export const harvestStateSchema = z
  .object({
    version: z.literal(1),
    autobuild: z
      .object({ through: z.string().datetime({ offset: true }) })
      .strict()
      .optional(),
    pullRequests: z
      .object({
        repo: z.string().trim().min(1),
        through: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
    lastRunAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type HarvestState = z.infer<typeof harvestStateSchema>;

/**
 * Where an imported record came from: the import's name, the source file and
 * the table row id, which is the re-import identity.
 */
export const learnedImportSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    source: z.string().trim().min(1),
    row: z.string().trim().min(1),
    line: z.number().int().positive(),
    category: z.string().trim().min(1).optional(),
    how: z.string().trim().min(1).optional(),
    state: z.string().trim().min(1).optional(),
    rule: z.string().trim().min(1).optional(),
    /** The surface the row names (screen, panel or page), as written. */
    surface: z.string().trim().min(1).optional(),
    /** When the row says the miss was found, as written. */
    date: z.string().trim().min(1).optional(),
    /** Who or what the row says found the miss (`source` is the file). */
    rowSource: z.string().trim().min(1).optional(),
    /** Shipped check ids the row names or its candidate maps to. */
    checks: z.array(z.string().trim().min(1)),
    updatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type LearnedImport = z.infer<typeof learnedImportSchema>;

/**
 * One line of `.idiom/learned.jsonl`: a human-found miss and the rule or
 * configuration it became, with the capture it was observed on so the next
 * review can be checked against it. Optional coverage marks retain the human's
 * rule or fixture reference without adding another log entry.
 */
export const learnedEntrySchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^learned-[1-9]\d*$/),
    recordedAt: z.string().datetime({ offset: true }),
    flow: z.string().trim().min(1),
    state: z.string().trim().min(1),
    observation: z.string().trim().min(1),
    kind: z.enum(learnedKinds),
    target: z
      .object({
        file: z.string().trim().min(1),
        selector: z.string().trim().min(1).optional(),
        /** The deterministic check a learned law configures. */
        check: z.string().trim().min(1).optional(),
        /** The surface selector a learned law is scoped to. */
        scope: z.string().trim().min(1).optional(),
        rulingId: z
          .string()
          .regex(/^ruling-[1-9]\d*$/)
          .optional(),
      })
      .strict(),
    entry: z.unknown(),
    capture: z
      .object({
        runId: z.string().trim().min(1),
        viewport: z.string().trim().min(1),
        screenshot: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    covered: z
      .object({
        by: z.string().trim().min(1),
        at: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
    screenshot: z.string().trim().min(1).optional(),
    /** The decided brief this rejection was about (`learn --from-brief`). */
    brief: z.string().trim().min(1).optional(),
    /** The generalised rule candidate and its checkability. */
    candidate: learnedCandidateSchema.optional(),
    /** How the flow state was found: named, matched, or proposed. */
    placement: learnedPlacementSchema.optional(),
    /** Where a harvested correction came from (`learn --harvest`). */
    harvest: learnedHarvestSchema.optional(),
    /** The catalog row this record was imported from (`learn --import`). */
    import: learnedImportSchema.optional(),
  })
  .strict();

export type LearnedEntry = z.infer<typeof learnedEntrySchema>;
export type LearnedKind = (typeof learnedKinds)[number];
