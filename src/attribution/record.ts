import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Which commits a check's new findings appeared between, and the commits in
 * that range that touched their states. Written by `check` beside
 * digest.json, so an older reader of digest.json is never affected; the
 * report, `digest` and `decide --list` only read it.
 */
export const ATTRIBUTION_RECORD_FILE = "attribution.json";

const causeSchema = z
  .object({
    commit: z.string(),
    subject: z.string(),
    tickets: z.array(z.string()),
  })
  .strict();
export const introductionSchema = z
  .object({
    id: z.string(),
    fingerprint: z.string(),
    /** Coordinate key: state/viewport[/scheme][#combination]. */
    where: z.string(),
    state: z.string(),
    range: z
      .object({
        /** The previous complete run's commit: last seen without the finding. */
        from: z.string(),
        /** This run's commit. */
        to: z.string(),
        /** First-parent commits in from..to; null when the range is not linear. */
        commits: z.number().int().min(0).nullable(),
        /** `from` is `to` or an ancestor of it. */
        linear: z.boolean(),
        fromDirty: z.boolean(),
        toDirty: z.boolean(),
      })
      .strict(),
    /** Commits in the range that touched the state's files, oldest first. */
    candidates: z.array(causeSchema).optional(),
    /** Why candidates were not computed. */
    candidatesOmitted: z.string().optional(),
    /** The only candidate, when there is exactly one. */
    likely: causeSchema.optional(),
  })
  .strict();
export const attributionRecordSchema = z
  .object({
    version: z.literal(1),
    flow: z.string(),
    runId: z.string(),
    commit: z.string(),
    dirty: z.boolean(),
    /** The run compared with; null when there was no earlier complete run. */
    previous: z
      .object({
        runId: z.string(),
        commit: z.string(),
        dirty: z.boolean(),
        completedAt: z.string(),
      })
      .strict()
      .nullable(),
    configChanged: z.boolean(),
    introductions: z.array(introductionSchema),
  })
  .strict();
export type AttributionRecord = z.infer<typeof attributionRecordSchema>;
export type Introduction = z.infer<typeof introductionSchema>;
export type IntroductionCause = z.infer<typeof causeSchema>;
/** An introduction with the record-level facts its text needs. */
export type RecordedIntroduction = Introduction & {
  configChanged: boolean;
  runId: string;
};

/** The lookup key of an occurrence: coordinate plus fingerprint. */
export const introductionKey = (where: string, fingerprint: string) =>
  `${where}\0${fingerprint}`;

export async function writeAttributionRecord(
  runDirectory: string,
  record: AttributionRecord,
): Promise<string> {
  const path = join(runDirectory, ATTRIBUTION_RECORD_FILE);
  const temporary = `${path}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(attributionRecordSchema.parse(record), null, 2)}\n`,
  );
  await rename(temporary, path);
  return path;
}

/** Missing or unreadable records are absent. */
export async function readAttributionRecord(
  runDirectory: string,
): Promise<AttributionRecord | undefined> {
  try {
    const parsed = attributionRecordSchema.safeParse(
      JSON.parse(
        await readFile(join(runDirectory, ATTRIBUTION_RECORD_FILE), "utf8"),
      ),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Every introduction in a record, keyed by introductionKey. */
export function introductionsByKey(
  record: AttributionRecord,
): Map<string, RecordedIntroduction> {
  return new Map(
    record.introductions.map((introduction) => [
      introductionKey(introduction.where, introduction.fingerprint),
      {
        ...introduction,
        configChanged: record.configChanged,
        runId: record.runId,
      },
    ]),
  );
}
