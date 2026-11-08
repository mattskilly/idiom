import { join, resolve } from "node:path";
import type { RunRecord } from "../capture/run-record.js";
import { loadFlowRecords, previousCompleteRecord } from "../digest/build.js";
import { buildDigestRecord, digestInputs } from "../digest/record.js";
import type { ReportCoverage } from "../report/coverage.js";
import type { IssueRankingContext } from "../review/ranking.js";
import type { Finding } from "../schemas/finding.js";
import type { ValidationResult } from "../validation.js";
import { attributeIntroductions } from "./attribute.js";
import {
  introductionsByKey,
  type RecordedIntroduction,
  writeAttributionRecord,
} from "./record.js";
import { DEFAULT_TICKET_PATTERN } from "./tickets.js";

/**
 * `check` only, before the report renders: the provisional digest record of
 * this run (the same inputs `recordDigest` uses) compared with the previous
 * complete run of the flow, written to attribution.json. Records and git are
 * read from the invoking checkout, also under `--ref`. A failure warns and
 * never fails the check.
 */
export async function recordRunAttribution(options: {
  validated: ValidationResult;
  flow: string;
  runDirectory: string;
  occurrences: readonly Finding[];
  coverage: ReportCoverage | undefined;
  scope: RunRecord | undefined;
  rankingContext: IssueRankingContext | undefined;
  now: Date;
  git?: Parameters<typeof attributeIntroductions>[0]["git"];
}): Promise<{
  introductions: ReadonlyMap<string, RecordedIntroduction>;
  warning?: string | undefined;
}> {
  try {
    const { validated } = options;
    const state = validated.stateProjectDirectory ?? validated.projectDirectory;
    const current = buildDigestRecord({
      flow: options.flow,
      runDirectory: options.runDirectory,
      projectDirectory: validated.projectDirectory,
      reportPath: join(options.runDirectory, "report.md"),
      occurrences: options.occurrences,
      coverage: options.coverage,
      scope: options.scope,
      captured: [...(options.rankingContext?.keys() ?? [])],
      ...digestInputs({
        scope: options.scope,
        coverage: options.coverage,
        checks: validated.project.checks,
      }),
      rankingContext: options.rankingContext,
      now: options.now,
    });
    const records = await loadFlowRecords(resolve(state, ".idiom", "reports"));
    const record = await attributeIntroductions({
      projectDirectory: state,
      flows: validated.flows.map(({ flow }) => flow),
      current,
      previous: previousCompleteRecord(
        records.get(options.flow) ?? [],
        current.runId,
      ),
      ticketPattern:
        validated.project.attribution?.ticketPattern ?? DEFAULT_TICKET_PATTERN,
      git: options.git,
    });
    await writeAttributionRecord(options.runDirectory, record);
    return { introductions: introductionsByKey(record) };
  } catch (error) {
    return {
      introductions: new Map(),
      warning: `attribution not recorded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
