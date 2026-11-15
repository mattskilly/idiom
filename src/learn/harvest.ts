import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { IdiomError } from "../errors.js";
import {
  type HarvestState,
  harvestStateSchema,
  type LearnedEntry,
  type LearnedHarvest,
  learnedEntrySchema,
} from "../schemas/learned.js";
import type { FlowRecord } from "../validation.js";
import { candidateFor } from "./candidate.js";
import { observationEntry } from "./draft.js";
import { classifyCorrection } from "./harvest-classify.js";
import type { HarvestItem, SourceResult } from "./harvest-sources.js";
import { type Interpretation, interpretObservation } from "./interpret.js";
import { readLearnedLog } from "./misses.js";
import { placeObservation } from "./place.js";
import { atomicWrite } from "./write.js";

/**
 * The two places a director already writes corrections. Each reader gets
 * the instant to start from and returns what it read, or why it could not.
 */
export type HarvestSources = {
  autobuild: (cursor: { since?: string | undefined }) => Promise<SourceResult>;
  pullRequests: (cursor: {
    since?: string | undefined;
    repo?: string | undefined;
  }) => Promise<SourceResult>;
};

export type SourceSummary =
  | {
      status: "read";
      examined: number;
      recorded: number;
      ignored: number;
      duplicates: number;
      through?: string | undefined;
      repo?: string | undefined;
      skipped?: string[] | undefined;
    }
  | { status: "unavailable"; reason: string };

export type HarvestedRecord = {
  entry: LearnedEntry;
  /** The draft flow state written when no declared state matched. */
  proposal?: string | undefined;
  /** Where the correction was placed and why. */
  placement: string;
};

export type HarvestResult = {
  dryRun: boolean;
  recorded: HarvestedRecord[];
  ignored: number;
  duplicates: number;
  sources: { autobuild: SourceSummary; pullRequests: SourceSummary };
  /** The cursor after this run (written unless a dry run). */
  cursor?: HarvestState | undefined;
  /** The cursor this run started from. */
  previous?: HarvestState | undefined;
};

export const harvestCursorFile = (projectDirectory: string) =>
  join(projectDirectory, ".idiom", "harvest.json");

export async function readHarvestCursor(
  projectDirectory: string,
): Promise<HarvestState | undefined> {
  const path = harvestCursorFile(projectDirectory);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IdiomError(".idiom/harvest.json is not valid JSON");
  }
  const parsed = harvestStateSchema.safeParse(value);
  if (!parsed.success)
    throw new IdiomError(
      `.idiom/harvest.json is not a harvest cursor this Idiom reads: ${parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  return parsed.data;
}

const later = (a: string | undefined, b: string | undefined) =>
  a === undefined
    ? b
    : b === undefined
      ? a
      : Date.parse(b) > Date.parse(a)
        ? b
        : a;

/** The first measurable reading of any sentence, else a ruling. */
function interpretSentences(sentences: string[]): Interpretation {
  for (const sentence of sentences) {
    const interpretation = interpretObservation(sentence);
    if (interpretation.kind !== "ruling") return interpretation;
  }
  return { kind: "ruling" };
}

function attribution(
  item: HarvestItem,
  categories: LearnedHarvest["categories"],
): LearnedHarvest {
  return {
    source: item.source,
    key: item.key,
    at: item.at,
    ...(item.author === undefined ? {} : { author: item.author }),
    ...(item.build === undefined ? {} : { build: item.build }),
    ...(item.escalation === undefined ? {} : { escalation: item.escalation }),
    ...(item.pr === undefined ? {} : { pr: item.pr }),
    ...(item.url === undefined ? {} : { url: item.url }),
    ...(item.path === undefined ? {} : { path: item.path }),
    categories,
  };
}

/**
 * Collect the UI and UX corrections the director already wrote — answers to
 * autobuild escalations and pull request review comments — as open learned
 * records with their words verbatim and a rule candidate. Records misses
 * only: it never writes design law or check configuration, so a candidate
 * becomes a rule only through `learn --confirm`.
 */
export async function harvestCorrections(options: {
  projectDirectory: string;
  flows: FlowRecord[];
  flowId?: string | undefined;
  /** Start here instead of at the cursor (keys still prevent duplicates). */
  since?: string | undefined;
  dryRun?: boolean | undefined;
  sources: HarvestSources;
  clock?: (() => Date) | undefined;
}): Promise<HarvestResult> {
  const { projectDirectory } = options;
  const clock = options.clock ?? (() => new Date());
  const dryRun = options.dryRun === true;
  const previous = await readHarvestCursor(projectDirectory);
  const [autobuild, pullRequests] = await Promise.all([
    options.sources.autobuild({
      since: options.since ?? previous?.autobuild?.through,
    }),
    options.sources.pullRequests(
      options.since !== undefined
        ? { since: options.since }
        : {
            since: previous?.pullRequests?.through,
            repo: previous?.pullRequests?.repo,
          },
    ),
  ]);
  if (
    autobuild.status === "unavailable" &&
    pullRequests.status === "unavailable"
  )
    throw new IdiomError(
      `nothing to harvest: autobuild answers not read (${autobuild.reason}); pull request comments not read (${pullRequests.reason})`,
    );

  const seen = new Set(
    (await readLearnedLog(projectDirectory, { strict: true }))
      .map((entry) => entry.harvest?.key)
      .filter((key): key is string => key !== undefined),
  );
  const tally = {
    autobuild: { recorded: 0, ignored: 0, duplicates: 0 },
    pullRequests: { recorded: 0, ignored: 0, duplicates: 0 },
  };
  const items = [
    ...(autobuild.status === "read"
      ? autobuild.items.map((item) => ({ item, from: "autobuild" as const }))
      : []),
    ...(pullRequests.status === "read"
      ? pullRequests.items.map((item) => ({
          item,
          from: "pullRequests" as const,
        }))
      : []),
  ].sort(
    (a, b) =>
      Date.parse(a.item.at) - Date.parse(b.item.at) ||
      a.item.key.localeCompare(b.item.key),
  );

  const logPath = join(projectDirectory, ".idiom", "learned.jsonl");
  const readLog = async () => {
    try {
      return await readFile(logPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  };
  let nextNumber =
    (await readLog()).split("\n").filter((line) => line.trim() !== "").length +
    1;
  const recorded: HarvestedRecord[] = [];
  for (const { item, from } of items) {
    if (seen.has(item.key)) {
      tally[from].duplicates += 1;
      continue;
    }
    seen.add(item.key);
    const classification = classifyCorrection(item.text);
    const [firstCategory] = classification.categories;
    if (!classification.ui || firstCategory === undefined) {
      tally[from].ignored += 1;
      continue;
    }
    const observation = classification.sentences.join(" ");
    const id = `learned-${nextNumber}`;
    const placed = await placeObservation({
      projectDirectory,
      flows: options.flows,
      flowId: options.flowId,
      observation,
      learnedId: id,
    });
    const interpretation = interpretSentences(classification.sentences);
    const proposed = placed.proposed;
    const matched = placed.matched;
    const entry = learnedEntrySchema.parse({
      version: 1,
      id,
      recordedAt: clock().toISOString(),
      flow: proposed?.flowId ?? matched?.flow.flow.id,
      state: proposed?.stateId ?? matched?.state,
      observation,
      kind: "observation",
      target: {
        file:
          proposed !== undefined
            ? proposed.proposal.displayPath
            : relative(projectDirectory, matched?.flow.file ?? ""),
      },
      entry: observationEntry(interpretation),
      candidate: candidateFor(interpretation, observation),
      placement: (proposed ?? matched)?.placement,
      harvest: attribution(item, classification.categories),
    });
    if (!dryRun) {
      if (proposed !== undefined)
        await atomicWrite(proposed.proposal.path, proposed.proposal.content);
      const before = await readLog();
      await atomicWrite(
        logPath,
        `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${JSON.stringify(entry)}\n`,
      );
    }
    nextNumber += 1;
    tally[from].recorded += 1;
    recorded.push({
      entry,
      ...(proposed === undefined
        ? {}
        : { proposal: proposed.proposal.displayPath }),
      placement: (proposed ?? matched)?.message ?? "",
    });
  }

  const summary = (
    result: SourceResult,
    counts: { recorded: number; ignored: number; duplicates: number },
  ): SourceSummary =>
    result.status === "unavailable"
      ? result
      : {
          status: "read",
          examined: result.items.length,
          ...counts,
          ...(result.through === undefined ? {} : { through: result.through }),
          ...(result.repo === undefined ? {} : { repo: result.repo }),
          ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
        };

  const autobuildThrough =
    autobuild.status === "read"
      ? later(previous?.autobuild?.through, autobuild.through)
      : previous?.autobuild?.through;
  const pullRequestCursor =
    pullRequests.status === "read" &&
    pullRequests.repo !== undefined &&
    pullRequests.through !== undefined
      ? {
          repo: pullRequests.repo,
          through:
            previous?.pullRequests?.repo === pullRequests.repo
              ? (later(previous.pullRequests.through, pullRequests.through) ??
                pullRequests.through)
              : pullRequests.through,
        }
      : previous?.pullRequests;
  const cursor = harvestStateSchema.parse({
    version: 1,
    ...(autobuildThrough === undefined
      ? {}
      : { autobuild: { through: autobuildThrough } }),
    ...(pullRequestCursor === undefined
      ? {}
      : { pullRequests: pullRequestCursor }),
    lastRunAt: clock().toISOString(),
  });
  if (!dryRun)
    await atomicWrite(
      harvestCursorFile(projectDirectory),
      `${JSON.stringify(cursor, null, 2)}\n`,
    );

  return {
    dryRun,
    recorded,
    ignored: tally.autobuild.ignored + tally.pullRequests.ignored,
    duplicates: tally.autobuild.duplicates + tally.pullRequests.duplicates,
    sources: {
      autobuild: summary(autobuild, tally.autobuild),
      pullRequests: summary(pullRequests, tally.pullRequests),
    },
    cursor,
    ...(previous === undefined ? {} : { previous }),
  };
}
