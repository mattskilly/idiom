import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type GitRead, readGit } from "../changed/git.js";
import type { IdentifiedDecision } from "../decisions/attribution.js";
import { readIdentifiedDecisions } from "../decisions/log.js";
import { type DigestRecord, readDigestRecord } from "../digest/record.js";
import { readLearnedLog } from "../learn/misses.js";
import { type LedgerEntry, ledgerPath, readLedger } from "../nightly/ledger.js";
import { storedRunsNewestFirst } from "../review/artifacts.js";
import type { LearnedEntry } from "../schemas/learned.js";
import { loadDeclaredSurfaceFlows, loadProjectContext } from "../validation.js";
import {
  repositoryProjectPath,
  watchDirectory,
  watchTreeReports,
} from "../watch/state.js";

export type ScorecardInputs = {
  runs: DigestRecord[];
  /** Every report root read, the project's own first. */
  runRoots: string[];
  ledger: LedgerEntry[];
  learned: LearnedEntry[];
  decisions: IdentifiedDecision[];
  flowSurfaces: Map<string, string>;
  warnings: string[];
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The watch tree's report root, when this project is a git checkout with one. */
async function watchReportRoot(
  projectDirectory: string,
  git: GitRead,
): Promise<string | undefined> {
  try {
    const { projectRelative } = await repositoryProjectPath(
      projectDirectory,
      git,
    );
    const root = watchTreeReports(
      await watchDirectory(projectDirectory, git),
      projectRelative,
    );
    return (await exists(root)) ? root : undefined;
  } catch {
    // Not a git repository (or git is unavailable): no watch root.
    return undefined;
  }
}

/** Every readable digest record under a report root, newest first. */
async function readRoot(root: string): Promise<DigestRecord[]> {
  const records: DigestRecord[] = [];
  for (const runId of await storedRunsNewestFirst(root).catch(
    () => [] as string[],
  )) {
    const record = await readDigestRecord(join(root, runId));
    if (record !== undefined) records.push(record);
  }
  return records;
}

async function flowSurfaces(
  projectDirectory: string,
): Promise<Map<string, string>> {
  try {
    // Flow surfaces exist only when the project declares surfaces.
    const flows = await loadDeclaredSurfaceFlows(
      await loadProjectContext({ project: projectDirectory }),
    );
    return new Map(
      flows.flatMap(({ flow }) =>
        flow.surface === undefined ? [] : [[flow.id, flow.surface] as const],
      ),
    );
  } catch {
    // An invalid project still has a scorecard; surfaces read as unrecorded.
    return new Map();
  }
}

/**
 * What the scorecard reads, all of it already on disk: stored digest records
 * (the project's and the watch tree's), the filing ledger, the learned log and
 * the decision log. Reads only; never writes.
 */
export async function loadScorecardInputs(options: {
  projectDirectory: string;
  git?: GitRead | undefined;
}): Promise<ScorecardInputs> {
  const { projectDirectory } = options;
  const git = options.git ?? readGit;
  const warnings: string[] = [];
  const runRoots = [resolve(projectDirectory, ".idiom", "reports")];
  const watchRoot = await watchReportRoot(projectDirectory, git);
  if (watchRoot !== undefined) runRoots.push(watchRoot);
  const runs: DigestRecord[] = [];
  const seen = new Set<string>();
  for (const root of runRoots)
    for (const record of await readRoot(root)) {
      if (seen.has(record.runId)) continue;
      seen.add(record.runId);
      runs.push(record);
    }
  let ledger: LedgerEntry[] = [];
  try {
    ledger = (await readLedger(ledgerPath(projectDirectory))).entries;
  } catch (error) {
    warnings.push(
      `filed tickets not read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    runs,
    runRoots,
    ledger,
    learned: await readLearnedLog(projectDirectory),
    decisions: await readIdentifiedDecisions(projectDirectory),
    flowSurfaces: await flowSurfaces(projectDirectory),
    warnings,
  };
}
