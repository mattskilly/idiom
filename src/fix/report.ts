import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VerifyRunResult } from "../verify/run.js";
import type { AgentName, AgentResult } from "./agent.js";
import type { compareOccurrences, Occurrence } from "./compare.js";

export type FixChanges = ReturnType<typeof compareOccurrences>;
export type FixRound = {
  round: number;
  selected: string[];
  beforeRun: string;
  afterRun?: string;
  promptPath: string;
  specPath: string;
  agent?: AgentResult;
  changes?: FixChanges;
  remaining?: number;
  untouched?: Occurrence[];
  verification?: VerifyRunResult;
  verifiedFixed: string[];
  /** Set when the round attempted one root cause whole. */
  cause?: { id: string; cause: string; findings: string[]; verified: boolean };
  errors: string[];
  reason?: string;
};
export type FixSummary = {
  flow: string;
  agent: AgentName;
  passed: boolean;
  reason: string;
  initialRun: string;
  finalRun: string;
  remaining: number;
  rounds: FixRound[];
  changes: FixChanges;
  sessionDirectory?: string;
  summaryPath?: string;
};
export type FixResult =
  | { dryRun: true; prompt: string }
  | { dryRun: false; summary: FixSummary };

export function renderFixSummary(summary: FixSummary): string {
  return [
    `Fix ${summary.flow}: ${summary.reason} (${summary.passed ? "passed" : "failed"})`,
    `Initial-to-final observed: ${summary.changes.fixed.length} fixed, ${summary.changes.stillOpen.length} still open, ${summary.changes.introduced.length} newly introduced; ${summary.remaining} eligible occurrences remaining.`,
    ...summary.rounds.flatMap((round) => [
      `Round ${round.round}: selected ${round.selected.join(", ")}; ${round.reason ?? "in progress"}.`,
      ...(round.changes
        ? [
            `  Observed: ${round.changes.fixed.length} fixed, ${round.changes.stillOpen.length} still open, ${round.changes.introduced.length} new. Proven fixed targets: ${round.verifiedFixed.length}. Untouched remaining: ${round.untouched?.length ?? 0}.`,
          ]
        : []),
      ...(round.verification
        ? [`  Verification: ${round.verification.reportPath}`]
        : []),
      ...(round.cause
        ? [
            `  Root cause ${round.cause.id}: ${round.cause.verified ? "verified" : "partial"} (${round.cause.findings.filter((id) => round.verifiedFixed.includes(id)).length}/${round.cause.findings.length}${round.cause.verified ? " symptoms cleared" : ""})`,
          ]
        : []),
      ...round.errors.map((error) => `  ${error}`),
    ]),
    `Before: ${summary.initialRun}`,
    `After: ${summary.finalRun}`,
    ...(summary.summaryPath ? [`Summary: ${summary.summaryPath}`] : []),
    "Application edits are left in the working tree.",
    "",
  ].join("\n");
}

export async function persistFixSummary(summary: FixSummary): Promise<void> {
  if (!summary.sessionDirectory) return;
  await writeFile(
    join(summary.sessionDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFile(
    join(summary.sessionDirectory, "summary.md"),
    renderFixSummary(summary),
  );
}
