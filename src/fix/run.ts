import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import { IdiomError } from "../errors.js";
import type { ReviewDependencies } from "../review/run.js";
import { runVerify, type VerifyDependencies } from "../verify/run.js";
import {
  type AgentDependencies,
  type AgentName,
  type AgentRequest,
  type AgentResult,
  runAgent,
  safeDiagnostic,
} from "./agent.js";
import {
  eligibleRecords,
  type FixSnapshot,
  refreshEligibility,
  selectedCause,
  selectTargets,
  takeFixSnapshot,
} from "./check.js";
import { compareOccurrences } from "./compare.js";
import { repairPrompt } from "./prompt.js";
import {
  type FixChanges,
  type FixResult,
  type FixRound,
  type FixSummary,
  persistFixSummary,
} from "./report.js";

const execFileAsync = promisify(execFile);
async function readHead(cwd: string): Promise<string> {
  return (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" })
  ).stdout.trim();
}
export type FixDependencies = {
  check?: typeof takeFixSnapshot;
  review?: ReviewDependencies;
  agent?: (request: AgentRequest) => Promise<AgentResult>;
  agentProcess?: AgentDependencies;
  verify?: typeof runVerify;
  verification?: VerifyDependencies;
  head?: typeof readHead;
  progress?: (message: string) => void;
};
export type FixOptions = {
  flow: string;
  project?: string | undefined;
  cwd?: string | undefined;
  agent?: AgentName | undefined;
  maxRounds?: number | undefined;
  top?: number | undefined;
  dryRun?: boolean | undefined;
  dependencies?: FixDependencies | undefined;
};
function changes(before: FixSnapshot, after: FixSnapshot): FixChanges {
  return {
    ...compareOccurrences(before.eligible, after.eligible),
    introduced: compareOccurrences(before.raw, after.raw).introduced,
  };
}
function targetPresent(
  snapshot: FixSnapshot,
  finding: {
    fingerprint: string;
    state: string;
    viewport: string;
    colorScheme?: "light" | "dark" | undefined;
    combination?: string | undefined;
  },
): boolean {
  return snapshot.raw.some(
    (item) =>
      item.key === tupleCoordinateKey(finding) &&
      [item.fingerprint, ...item.aliases].includes(finding.fingerprint),
  );
}

export async function runFix(options: FixOptions): Promise<FixResult> {
  const agent = options.agent ?? "claude";
  const maxRounds = options.maxRounds ?? 3;
  const top = options.top ?? 5;
  if (!["claude", "codex"].includes(agent))
    throw new IdiomError("fix agent must be claude or codex");
  for (const [name, count] of [
    ["max-rounds", maxRounds],
    ["top", top],
  ] as const)
    if (!Number.isSafeInteger(count) || count < 1)
      throw new IdiomError(`--${name} must be a positive integer`);
  const dependencies = options.dependencies ?? {};
  const snapshot = () =>
    (dependencies.check ?? takeFixSnapshot)({
      flow: options.flow,
      project: options.project,
      cwd: options.cwd,
      dependencies: dependencies.review,
    });
  const initial = await snapshot();
  let current = initial;
  let records = await eligibleRecords(current);
  let selected = selectTargets(current, records, top);
  let prompt = await repairPrompt(current, selected, records);
  if (options.dryRun) return { dryRun: true, prompt };
  const summary: FixSummary = {
    flow: options.flow,
    agent,
    passed: initial.eligible.length === 0,
    reason:
      initial.eligible.length === 0
        ? "clean"
        : "no selectable eligible findings",
    initialRun: initial.runDirectory,
    finalRun: initial.runDirectory,
    remaining: initial.eligible.length,
    rounds: [],
    changes: changes(initial, initial),
  };
  if (summary.passed) return { dryRun: false, summary };
  const reports = join(initial.projectDirectory, ".idiom", "reports");
  await mkdir(reports, { recursive: true });
  summary.sessionDirectory = await mkdtemp(
    join(reports, `fix-${new Date().toISOString().replaceAll(":", "-")}-`),
  );
  summary.summaryPath = join(summary.sessionDirectory, "summary.md");
  await persistFixSummary(summary);
  const head = dependencies.head ?? readHead;
  for (let index = 1; index <= maxRounds; index++) {
    let round: FixRound | undefined;
    try {
      // Decisions may change while a session runs. Re-read immediately before each invocation.
      await refreshEligibility(current);
      records = await eligibleRecords(current);
      selected = selectTargets(current, records, top);
      prompt = await repairPrompt(current, selected, records);
      if (!current.eligible.length) {
        summary.passed = true;
        summary.reason = "clean";
        break;
      }
      if (!selected.length) {
        summary.reason = "no selectable eligible findings";
        break;
      }
      const prefix = join(summary.sessionDirectory, `round-${index}`);
      round = {
        round: index,
        selected: selected.map(({ finding }) => finding.id),
        beforeRun: current.runDirectory,
        promptPath: `${prefix}-prompt.md`,
        specPath: `${prefix}-spec.md`,
        verifiedFixed: [],
        errors: [],
      };
      const cause = selectedCause(current, selected);
      if (cause !== undefined)
        round.cause = {
          id: cause.id,
          cause: cause.cause,
          findings: round.selected,
          verified: false,
        };
      summary.rounds.push(round);
      await writeFile(round.promptPath, prompt);
      await writeFile(
        round.specPath,
        selected
          .map(
            ({ finding }) =>
              `\`\`\`idiom:finding\n${JSON.stringify(finding, null, 2)}\n\`\`\``,
          )
          .join("\n\n"),
      );
      const before = current;
      const beforeHead = await head(initial.projectDirectory);
      dependencies.progress?.(
        `Fix round ${index}/${maxRounds}: ${selected.length} target(s), agent ${agent}`,
      );
      try {
        round.agent = await (
          dependencies.agent ??
          ((request) => runAgent(request, dependencies.agentProcess))
        )({ agent, prompt, cwd: initial.projectDirectory });
      } catch (error) {
        round.agent = { ok: false, diagnostic: safeDiagnostic(error) };
      }
      if (!round.agent.ok)
        round.errors.push(round.agent.diagnostic ?? "agent failed");
      let headChanged = false;
      try {
        headChanged = beforeHead !== (await head(initial.projectDirectory));
        if (headChanged)
          round.errors.push(
            "HEAD changed during agent invocation; edits preserved without undo",
          );
      } catch (error) {
        headChanged = true;
        round.errors.push(`cannot check HEAD: ${safeDiagnostic(error)}`);
      }
      // Even failed agents can leave edits. Always try to diagnose the complete result.
      let after: FixSnapshot | undefined;
      try {
        after = await snapshot();
        current = after;
        round.afterRun = after.runDirectory;
        round.changes = changes(before, after);
        round.remaining = after.eligible.length;
        round.untouched = after.eligible.filter(
          (item) =>
            !selected.some(({ finding }) =>
              [item.fingerprint, ...item.aliases].includes(finding.fingerprint),
            ),
        );
      } catch (error) {
        round.errors.push(`recheck failed: ${safeDiagnostic(error)}`);
      }
      const drift =
        after !== undefined && before.configuration !== after.configuration;
      if (drift)
        round.errors.push(
          "flow/check/design configuration changed during repair",
        );
      const regression = (round.changes?.introduced.length ?? 0) > 0;
      if (round.agent.ok && after && !drift && !headChanged) {
        try {
          round.verification = await (dependencies.verify ?? runVerify)({
            flow: options.flow,
            project: initial.projectDirectory,
            spec: round.specPath,
            against: before.runDirectory,
            out: `${prefix}-verify`,
            dependencies: dependencies.verification,
          });
          const verdicts = round.verification.verdicts;
          if (
            !verdicts ||
            selected.some(
              ({ finding }) =>
                !verdicts.some((verdict) => verdict.finding.id === finding.id),
            ) ||
            verdicts.some((verdict) => verdict.status === "unverifiable")
          ) {
            round.errors.push(
              "verification calibration or target evaluation unavailable/unverifiable",
            );
          }
          round.verifiedFixed = (verdicts ?? [])
            .filter(
              (verdict) =>
                verdict.status === "fixed" &&
                selected.some(
                  ({ finding }) => finding.id === verdict.finding.id,
                ) &&
                !targetPresent(after, verdict.finding),
            )
            .map((verdict) => verdict.finding.id);
          if (round.verification.newBlockers?.length)
            round.errors.push(...round.verification.newBlockers);
          // A failed aggregate with reproduced targets is expected for partial progress.
          if (
            verdicts &&
            !round.verification.passed &&
            verdicts.every((verdict) => verdict.status === "fixed")
          )
            round.errors.push(
              ...round.verification.causes,
              "verification failed despite fixed targets",
            );
        } catch (error) {
          round.errors.push(`verification failed: ${safeDiagnostic(error)}`);
        }
      }
      if (round.cause !== undefined)
        round.cause.verified = round.cause.findings.every((id) =>
          round?.verifiedFixed.includes(id),
        );
      if (regression) summary.reason = "regression: newly introduced findings";
      else if (round.errors.length) summary.reason = "repair attempt failed";
      else if (!round.verifiedFixed.length)
        summary.reason = "no verified progress";
      else if (after?.eligible.length === 0) {
        summary.reason = "clean";
        summary.passed = true;
      } else if (index === maxRounds)
        summary.reason = "max rounds reached with work remaining";
      else summary.reason = "continuing";
      round.reason = summary.reason;
      summary.finalRun = current.runDirectory;
      summary.remaining = current.eligible.length;
      summary.changes = changes(initial, current);
      await persistFixSummary(summary);
      if (summary.reason !== "continuing") break;
    } catch (error) {
      const diagnostic = safeDiagnostic(error);
      if (round) {
        round.errors.push(diagnostic);
        round.reason = "repair attempt failed";
      }
      summary.reason = `repair attempt failed: ${diagnostic}`;
      break;
    }
  }
  summary.finalRun = current.runDirectory;
  summary.remaining = current.eligible.length;
  summary.changes = changes(initial, current);
  await persistFixSummary(summary);
  return { dryRun: false, summary };
}
