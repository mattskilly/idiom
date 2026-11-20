import { join } from "node:path";
import { fetchTarget } from "../baseline/advance.js";
import { type LockOptions, withFileLock } from "../baseline/lock.js";
import { defaultBranch, type GitRead, readGit } from "../changed/git.js";
import { type NightlyTracker, resolveFiling } from "../commands/nightly.js";
import { IdiomError } from "../errors.js";
import { type EscalationPass, runEscalationPass } from "../escalations/run.js";
import type { NightlySeverity } from "../nightly/file.js";
import type { ReviewDependencies } from "../review/run.js";
import { validateProject } from "../validation.js";
import {
  defaultWatchSteps,
  processMerge,
  type WatchContext,
  type WatchSteps,
} from "./merge.js";
import { isRemoteTarget, pendingMerges, resolveTip, short } from "./merges.js";
import {
  readWatchState,
  repositoryProjectPath,
  type WatchOutcome,
  type WatchState,
  watchDirectory,
  watchStatePath,
  writeWatchState,
} from "./state.js";

export const WATCH_DEFAULT_POLL_MS = 60_000;
export const WATCH_MIN_POLL_MS = 5_000;
/** A failed merge is tried this many times before the cursor moves past it. */
export const WATCH_MAX_ATTEMPTS = 2;

export type WatchEvent =
  | { event: "start"; at: string; target: string; cursor: string }
  | { event: "resume"; at: string; target: string; commit: string }
  | { event: "since-ignored"; at: string; cursor: string }
  | { event: "rewritten"; at: string; from: string; to: string }
  | { event: "fetch-failed"; at: string; reason: string }
  | {
      event: "retry";
      at: string;
      commit: string;
      attempt: number;
      error: string;
    }
  | ({ event: "merge" } & WatchOutcome)
  | {
      event: "escalations";
      at: string;
      /** The escalations answered from precedent this pass. */
      answered: Array<{ build: string; escalation: string }>;
      /** Design escalations left for a person. */
      open: number;
      /** Escalations that are not design questions. */
      ignored: number;
      /** Why the pass failed or was unavailable, or what went wrong answering. */
      reason?: string | undefined;
    }
  | { event: "stop"; at: string; inFlight?: string | undefined };

export type WatchOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
  target?: string | undefined;
  /** First start only: process every merge after this ref. */
  since?: string | undefined;
  pollMs?: number | undefined;
  /** Process what is pending, then return. */
  once?: boolean | undefined;
  signal?: AbortSignal | undefined;
  severity?: NightlySeverity | undefined;
  labels?: string[] | undefined;
  tracker?: NightlyTracker | undefined;
  out?: string | undefined;
  log: (event: WatchEvent) => void;
  dependencies?:
    | {
        steps?: Partial<WatchSteps> | undefined;
        git?: GitRead | undefined;
        now?: (() => Date) | undefined;
        sleep?:
          | ((ms: number, signal: AbortSignal) => Promise<void>)
          | undefined;
        environment?: NodeJS.ProcessEnv | undefined;
        lock?: Partial<LockOptions> | undefined;
        review?: ReviewDependencies | undefined;
        /** The escalation answer pass run each loop when `escalations.watch` is on. */
        escalations?:
          | ((input: EscalationPassInput) => Promise<EscalationPass>)
          | undefined;
      }
    | undefined;
};

export type EscalationPassInput = {
  projectDirectory: string;
  stateProjectDirectory: string;
  designFile: string;
  environment: NodeJS.ProcessEnv;
};

export type WatchRunResult = {
  target: string;
  cursor: string;
  processed: WatchOutcome[];
  stopped: boolean;
};

/** Resolves after `ms`, or as soon as the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * `idiom watch`: process each new first-parent commit on the target, oldest
 * first and one at a time. A merge's cursor is written only after its steps
 * finish, so a restart redoes at most the merge that was in flight, and the
 * filing ledger and baseline advance make that redo idempotent.
 */
export async function runWatch(options: WatchOptions): Promise<WatchRunResult> {
  const dependencies = options.dependencies ?? {};
  const git = dependencies.git ?? readGit;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? abortableSleep;
  const environment = dependencies.environment ?? process.env;
  const signal = options.signal ?? new AbortController().signal;
  const steps: WatchSteps = { ...defaultWatchSteps, ...dependencies.steps };
  const pollMs = options.pollMs ?? WATCH_DEFAULT_POLL_MS;
  const at = () => now().toISOString();

  const validated = await validateProject({
    project: options.project,
    cwd: options.cwd,
  });
  const { projectDirectory } = validated;
  const stateProject = validated.stateProjectDirectory ?? projectDirectory;
  // Every refusal happens before the lock.
  const filing = await resolveFiling({
    validated,
    options: {
      severity: options.severity,
      labels: options.labels,
      tracker: options.tracker,
      out: options.out,
      cwd: options.cwd,
    },
    environment,
  });
  const { repository, projectRelative } = await repositoryProjectPath(
    projectDirectory,
    git,
  );
  const target = options.target ?? (await defaultBranch(repository, git));
  if (target === undefined)
    throw new IdiomError(
      "idiom watch found no base branch to watch (no remote HEAD, main or master); pass --target <ref>",
    );
  const since =
    options.since === undefined
      ? undefined
      : await resolveTip(repository, options.since, git).catch(() => {
          throw new IdiomError(
            `cannot resolve --since ${JSON.stringify(options.since)} to a local commit`,
          );
        });
  const watchDir = await watchDirectory(stateProject, git);
  const statePath = watchStatePath(watchDir);
  const context: WatchContext = {
    repository,
    primaryProject: projectDirectory,
    projectRelative,
    watchDir,
    filing,
    signal,
    environment,
    review: dependencies.review,
  };

  return withFileLock(
    join(watchDir, "watch.lock"),
    {
      waitMs: 0,
      staleMs: Number.MAX_SAFE_INTEGER,
      holderLabel: "another idiom watch",
      describe: `watching ${target}`,
      ...dependencies.lock,
    },
    async () => {
      const remote = await isRemoteTarget(repository, target, git);
      let fetchFailing = false;
      const refresh = async () => {
        if (!remote) return;
        try {
          await fetchTarget(repository, target, git);
          fetchFailing = false;
        } catch (error) {
          if (!fetchFailing)
            options.log({
              event: "fetch-failed",
              at: at(),
              reason: error instanceof Error ? error.message : String(error),
            });
          fetchFailing = true;
        }
      };

      let state: WatchState | undefined = await readWatchState(statePath);
      if (state !== undefined && state.target !== target)
        throw new IdiomError(
          `${statePath} watches ${state.target}, not ${target}; delete it to start watching ${target} from its tip`,
        );
      if (state === undefined) {
        await refresh();
        const cursor = since ?? (await resolveTip(repository, target, git));
        state = {
          version: 1,
          target,
          cursor,
          startedAt: at(),
          recent: [],
        };
        await writeWatchState(statePath, state);
        options.log({ event: "start", at: at(), target, cursor });
      } else {
        if (since !== undefined)
          options.log({
            event: "since-ignored",
            at: at(),
            cursor: state.cursor,
          });
        if (state.inFlight !== undefined)
          options.log({
            event: "resume",
            at: at(),
            target,
            commit: state.inFlight.commit,
          });
      }

      // Answering settled autobuild escalations rides along each pass when
      // the project turns it on. It never stops the watch: a failure is
      // logged once per streak, like a failing fetch.
      const escalationPass =
        dependencies.escalations ??
        ((input: EscalationPassInput) =>
          runEscalationPass({ ...input, answer: true }));
      let escalationsFailing = false;
      const answerEscalations = async () => {
        if (validated.project.escalations?.watch !== true) return;
        const failed = (reason: string) => {
          if (!escalationsFailing)
            options.log({
              event: "escalations",
              at: at(),
              answered: [],
              open: 0,
              ignored: 0,
              reason,
            });
          escalationsFailing = true;
        };
        let pass: EscalationPass;
        try {
          pass = await escalationPass({
            projectDirectory,
            stateProjectDirectory: stateProject,
            designFile: validated.project.design.designFile,
            environment,
          });
        } catch (error) {
          if (signal.aborted) return;
          failed(error instanceof Error ? error.message : String(error));
          return;
        }
        if (pass.status === "unavailable") {
          failed(pass.reason);
          return;
        }
        escalationsFailing = false;
        if (pass.answered.length === 0 && pass.warnings.length === 0) return;
        options.log({
          event: "escalations",
          at: at(),
          answered: pass.answered.map((record) => ({
            build: record.build,
            escalation: record.escalation,
          })),
          open: pass.items.filter((item) => item.verdict === "open").length,
          ignored: pass.items.filter((item) => item.verdict === "not-design")
            .length,
          ...(pass.warnings.length === 0
            ? {}
            : { reason: pass.warnings.join("; ") }),
        });
      };

      const processed: WatchOutcome[] = [];
      let current: WatchState = state;
      const save = async (next: WatchState) => {
        current = next;
        await writeWatchState(statePath, next);
      };
      const stop = (): WatchRunResult => {
        options.log({
          event: "stop",
          at: at(),
          ...(current.inFlight === undefined
            ? {}
            : { inFlight: current.inFlight.commit }),
        });
        return { target, cursor: current.cursor, processed, stopped: true };
      };

      while (!signal.aborted) {
        await refresh();
        if (signal.aborted) break;
        const tip = await resolveTip(repository, target, git);
        const pending = await pendingMerges(
          repository,
          current.cursor,
          tip,
          git,
        );
        if (!Array.isArray(pending)) {
          options.log({
            event: "rewritten",
            at: at(),
            from: current.cursor,
            to: tip,
          });
          const { inFlight: _dropped, ...rest } = current;
          await save({ ...rest, cursor: tip });
          continue;
        }
        let retrying = false;
        for (const merge of pending) {
          if (signal.aborted) break;
          const previous =
            current.inFlight?.commit === merge.commit
              ? current.inFlight
              : undefined;
          const attempt = (previous?.attempts ?? 0) + 1;
          await save({
            ...current,
            inFlight: {
              commit: merge.commit,
              attempts: attempt,
              startedAt: at(),
            },
          });
          let outcome: WatchOutcome;
          try {
            outcome = await processMerge(merge, context, steps, now);
          } catch (error) {
            if (signal.aborted) return stop();
            throw error;
          }
          if (signal.aborted) return stop();
          if (outcome.error !== undefined && attempt < WATCH_MAX_ATTEMPTS) {
            options.log({
              event: "retry",
              at: at(),
              commit: merge.commit,
              attempt,
              error: outcome.error,
            });
            retrying = true;
            break;
          }
          const { inFlight: _done, ...rest } = current;
          await save({
            ...rest,
            cursor: merge.commit,
            recent: [...current.recent, outcome],
          });
          processed.push(outcome);
          options.log({ event: "merge", ...outcome });
        }
        if (signal.aborted) break;
        if (retrying) {
          if (!options.once) await sleep(pollMs, signal);
          continue;
        }
        if (pending.length > 0) continue;
        await answerEscalations();
        if (signal.aborted) break;
        if (options.once)
          return { target, cursor: current.cursor, processed, stopped: false };
        await sleep(pollMs, signal);
      }
      return stop();
    },
  );
}

const statusText: Record<WatchOutcome["baseline"]["status"], string> = {
  advanced: "advanced",
  current: "current",
  superseded: "superseded",
  "not-advanced": "not advanced",
  failed: "failed",
  absent: "no flows on target",
};

/** One line per finished merge. */
export function renderWatchLine(outcome: WatchOutcome): string {
  const gate =
    outcome.gate.status === "clean"
      ? "clean"
      : outcome.gate.status === "findings"
        ? `${outcome.gate.newFindings} new (${outcome.gate.eligible} at threshold)${outcome.gate.reason === undefined ? "" : ` (${outcome.gate.reason})`}`
        : `${outcome.gate.status}${outcome.gate.reason === undefined ? "" : ` (${outcome.gate.reason})`}`;
  const tickets =
    outcome.tickets.length === 0
      ? "none"
      : outcome.tickets
          .map((ticket) =>
            ticket.ticket === undefined
              ? ticket.kind
              : `${ticket.ticket} ${ticket.kind}`,
          )
          .join(", ");
  const baseline = `${statusText[outcome.baseline.status]}${outcome.baseline.reason === undefined || outcome.baseline.status === "current" ? "" : ` (${outcome.baseline.reason})`}`;
  const harvest =
    outcome.harvest.status === "recorded"
      ? `${outcome.harvest.recorded ?? 0} recorded`
      : `${outcome.harvest.status}${outcome.harvest.reason === undefined ? "" : ` (${outcome.harvest.reason})`}`;
  return [
    `${outcome.finishedAt} ${short(outcome.commit)} ${JSON.stringify(outcome.subject)}`,
    `gate: ${gate};`,
    `tickets: ${tickets};`,
    `baseline: ${baseline};`,
    `harvest: ${harvest};`,
    ...(outcome.error === undefined ? [] : [`error: ${outcome.error};`]),
    `${(outcome.ms / 1000).toFixed(1)}s`,
  ].join(" ");
}

/** Text or a JSON line for any watch event. */
export function renderWatchEvent(event: WatchEvent, json = false): string {
  if (json) return JSON.stringify(event);
  switch (event.event) {
    case "merge": {
      const { event: _event, ...outcome } = event;
      return renderWatchLine(outcome);
    }
    case "start":
      return `${event.at} watching ${event.target} from ${short(event.cursor)}`;
    case "resume":
      return `${event.at} resuming ${short(event.commit)} (interrupted)`;
    case "since-ignored":
      return `${event.at} --since ignored: already watching from ${short(event.cursor)} (delete the watch state to restart)`;
    case "rewritten":
      return `${event.at} history rewritten: ${short(event.from)} is not on the branch; continuing from ${short(event.to)}`;
    case "fetch-failed":
      return `${event.at} fetch failed; watching the local ref until it recovers: ${event.reason}`;
    case "retry":
      return `${event.at} ${short(event.commit)} attempt ${event.attempt} failed (${event.error}); retrying`;
    case "escalations": {
      if (event.answered.length === 0)
        return `${event.at} escalations not answered: ${event.reason ?? "nothing settled"}`;
      const answered = event.answered
        .map((item) => `${item.build} ${item.escalation}`)
        .join(", ");
      return `${event.at} escalations: answered ${event.answered.length} (${answered}); ${event.open} left open${event.reason === undefined ? "" : ` (${event.reason})`}`;
    }
    case "stop":
      return `${event.at} stopped${event.inFlight === undefined ? "" : `; ${short(event.inFlight)} will be redone`}`;
  }
}
