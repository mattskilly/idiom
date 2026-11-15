import type { z } from "zod";
import { baselineFileSchema } from "../baseline/schema.js";
import { ledgerSchema } from "../nightly/ledger.js";
import { findingNameRegistrySchema } from "../review/names.js";
import { rulingNameRegistrySchema } from "../rulings/names.js";
import { storedBriefSchema, storedTriageSchema } from "../schemas/brief.js";
import { harvestStateSchema, learnedEntrySchema } from "../schemas/learned.js";
import { projectSchema } from "../schemas/project.js";
import { referenceMetadataSchema } from "../schemas/reference.js";
import { rulesSchema } from "../schemas/rules.js";

/** A JSON object as a migration step sees it. */
export type FormatDocument = Record<string, unknown>;

/**
 * One versioned file family under `.idiom/`. `document` files hold one JSON
 * object with a top-level integer `version`; `log` files are JSONL with a
 * per-record `version` and are never rewritten.
 */
export type ProjectFileFormat = {
  id: string;
  /**
   * Paths relative to `.idiom/`. `*` matches exactly one path segment and
   * never a dotfile; nothing recurses.
   */
  locations: string[];
  kind: "document" | "log";
  /** The format version the installed release writes. */
  current: number;
  /** One step per older version: `migrations[n]` turns format n into n + 1. */
  migrations: Record<number, (value: FormatDocument) => FormatDocument>;
  /** The reader's own schema: a migrated document must pass it. */
  validate: (value: unknown) => boolean;
  /** A log whose reader keeps accepting records at every older version. */
  readsOlder?: true;
  /** What the file is, for the docs. */
  summary: string;
};

const accepts =
  (schema: z.ZodType) =>
  (value: unknown): boolean =>
    schema.safeParse(value).success;

/**
 * Every versioned project file Idiom reads from `.idiom/`. All are at format
 * version 1 today, so no migrations exist yet; a reader that moves to a new
 * version adds its step here (the registry test catches a mismatch).
 */
export const projectFileFormats: ProjectFileFormat[] = [
  {
    id: "project",
    locations: ["project.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(projectSchema),
    summary: "project configuration",
  },
  {
    id: "rules",
    locations: ["rules.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(rulesSchema),
    summary: "rule overrides",
  },
  {
    id: "finding-names",
    locations: ["finding-names.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(findingNameRegistrySchema),
    summary: "the finding-name registry",
  },
  {
    id: "ruling-names",
    locations: ["ruling-names.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(rulingNameRegistrySchema),
    summary: "the ruling-name registry",
  },
  {
    id: "baseline",
    locations: ["baselines/*.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(baselineFileSchema),
    summary: "flow baselines",
  },
  {
    id: "filed-tickets",
    locations: ["filed-tickets.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(ledgerSchema),
    summary: "the filed-tickets ledger",
  },
  {
    id: "brief",
    locations: ["briefs/*.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(storedBriefSchema),
    summary: "decision briefs",
  },
  {
    id: "brief-triage",
    locations: ["briefs/triage/*.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(storedTriageSchema),
    summary: "brief triages",
  },
  {
    id: "reference",
    locations: [
      "references/*/reference.json",
      "anti-references/*/reference.json",
    ],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(referenceMetadataSchema),
    summary: "reference and anti-reference metadata",
  },
  {
    id: "learned",
    locations: ["learned.jsonl"],
    kind: "log",
    current: 1,
    migrations: {},
    validate: accepts(learnedEntrySchema),
    summary: "learned misses (one record per line)",
  },
  {
    id: "harvest",
    locations: ["harvest.json"],
    kind: "document",
    current: 1,
    migrations: {},
    validate: accepts(harvestStateSchema),
    summary: "learn --harvest cursor",
  },
];

/** Files under `.idiom/` that carry no format version and are never touched. */
export const unversionedProjectFiles: { location: string; reason: string }[] = [
  {
    location: "decisions.jsonl",
    reason:
      "append-only log with no format version; new record types are additive",
  },
  { location: "flows/*.json", reason: "no format version" },
  { location: "glossary.json", reason: "no format version" },
  {
    location: "proposals/states/*.json",
    reason: "draft flow states from idiom learn, adopted by hand",
  },
  {
    location: "reports/, cache/, agent-hooks/, designs/, learned/*.png",
    reason: "run outputs and caches, regenerable",
  },
  { location: "backups/", reason: "originals kept by idiom upgrade" },
];
