import { harvestEnvironment } from "../learn/harvest-sources.js";
import {
  type AutobuildTracker,
  autobuildTracker,
  type TrackerTicket,
} from "../nightly/autobuild.js";
import { findAutobuildRoot } from "../tickets/target.js";
import type { GitTopology } from "../verify/baseline.js";
import { executableOnPath } from "../wiring/detect.js";
import {
  type ClearedScope,
  type Condition,
  conditionLine,
  conditionTitle,
  mergeAppStart,
  type UnattendedMode,
} from "./condition.js";
import {
  type ConditionEntry,
  conditionStorePath,
  recordConditions,
  recordTickets,
} from "./store.js";

export const UNATTENDED_DEFAULT_LABELS = ["idiom", "idiom-condition"] as const;

export type UnattendedTrackerSetting = "auto" | "autobuild" | "off";

export type UnattendedConfig = {
  tracker?: UnattendedTrackerSetting | undefined;
  labels?: string[] | undefined;
};

export type ConditionOutcome = {
  key: string;
  ticket?: string | undefined;
  kind: "created" | "updated" | "unchanged" | "cleared" | "skipped" | "error";
  message?: string | undefined;
};

export type ConditionReport = {
  conditions: Array<{ key: string; cause: string; line: string }>;
  outcomes: ConditionOutcome[];
  /** stderr notes: store or filing problems; never change the exit. */
  messages: string[];
  storePath: string;
};

export function conditionMarker(key: string): string {
  return `<!-- idiom-condition: ${key} -->`;
}

function renderBody(condition: Condition, entry: ConditionEntry): string {
  return [
    conditionLine(condition),
    "",
    `- Cause: ${condition.cause} (${condition.subcause})`,
    `- Fix: ${condition.fix}`,
    `- Flows: ${condition.flows.join(", ")}`,
    ...(condition.state === undefined ? [] : [`- State: ${condition.state}`]),
    `- First seen: ${entry.firstSeen}`,
    `- Last seen: ${entry.lastSeen} by idiom ${entry.mode}`,
    `- Runs: ${entry.runs}`,
    ...(condition.detail === undefined || condition.detail.length === 0
      ? []
      : ["", "```", ...condition.detail, "```"]),
    "",
    "Filed by an unattended Idiom run. It stays open until a run that covers it passes; nothing is moved out of triage automatically.",
    "",
    conditionMarker(condition.key),
    "",
  ].join("\n");
}

type ResolvedTracker =
  | { kind: "none"; note?: string | undefined }
  | { kind: "autobuild"; tracker: AutobuildTracker };

async function resolveTracker(options: {
  setting: UnattendedTrackerSetting;
  projectDirectory: string;
  environment: NodeJS.ProcessEnv;
}): Promise<ResolvedTracker> {
  if (options.setting === "off") return { kind: "none" };
  const root = await findAutobuildRoot(options.projectDirectory);
  const ab =
    root !== undefined &&
    (await executableOnPath("ab", { environment: options.environment }));
  if (root === undefined || !ab) {
    if (options.setting === "auto") return { kind: "none" };
    return {
      kind: "none",
      note:
        root === undefined
          ? `unattended.tracker is autobuild but no autobuild.toml is above ${options.projectDirectory}; filed nothing`
          : "unattended.tracker is autobuild but the autobuild CLI (ab) is not on PATH; filed nothing",
    };
  }
  return {
    kind: "autobuild",
    // Sessionless ticket verbs must not inherit a running build's identity.
    tracker: autobuildTracker({
      root,
      environment: harvestEnvironment(options.environment),
    }),
  };
}

function trackerSetting(
  environment: NodeJS.ProcessEnv,
  config: UnattendedConfig | undefined,
): UnattendedTrackerSetting {
  const override =
    environment.IDIOM_UNATTENDED_TRACKER ??
    process.env.IDIOM_UNATTENDED_TRACKER;
  if (override === "off" || override === "autobuild" || override === "auto")
    return override;
  return config?.tracker ?? "auto";
}

async function findTicket(
  tracker: AutobuildTracker,
  key: string,
  stored: string | undefined,
  label: string,
  listed: { tickets?: TrackerTicket[] },
): Promise<TrackerTicket | undefined> {
  if (stored !== undefined) {
    const ticket = await tracker.show(stored);
    if (ticket !== undefined && !ticket.resolved) return ticket;
  }
  listed.tickets ??= await tracker.listLabelled(label);
  const marker = conditionMarker(key);
  return listed.tickets.find(
    (ticket) => !ticket.resolved && ticket.body.includes(marker),
  );
}

/**
 * The one entry point every unattended mode calls with its run outcome:
 * record the conditions for `idiom doctor`, file or update one triage ticket
 * per distinct cause, and note a `Cleared:` line on tickets this run cleared.
 * It never throws for store or tracker trouble: the caller's exit 2 and the
 * one-line report never depend on filing.
 */
export async function reportConditions(options: {
  mode: UnattendedMode;
  projectDirectory: string;
  config?: UnattendedConfig | undefined;
  observed: readonly Condition[];
  /** The scopes this run fully exercised (see recordConditions). */
  cleared: readonly ClearedScope[];
  environment?: NodeJS.ProcessEnv | undefined;
  now?: Date | undefined;
  /** Test seam and nightly's own sink: file through this tracker. */
  tracker?: AutobuildTracker | undefined;
  /** Set false to record without filing (nightly's directory sink). */
  file?: boolean | undefined;
  gitTopology?: GitTopology | undefined;
}): Promise<ConditionReport> {
  const environment = options.environment ?? process.env;
  const now = options.now ?? new Date();
  const observed = mergeAppStart(options.observed);
  const messages: string[] = [];
  const outcomes: ConditionOutcome[] = [];
  const storePath = await conditionStorePath({
    projectDirectory: options.projectDirectory,
    gitTopology: options.gitTopology,
  });
  const recorded = await recordConditions({
    path: storePath,
    mode: options.mode,
    observed,
    cleared: options.cleared,
    now,
  });
  if (recorded.warning !== undefined)
    messages.push(`idiom ${options.mode}: ${recorded.warning}`);
  const conditions = observed.map((condition) => ({
    key: condition.key,
    cause: condition.cause,
    line: conditionLine(condition),
  }));
  const withTicket = recorded.resolved.filter(
    (entry) => entry.ticket !== undefined,
  );
  if (observed.length === 0 && withTicket.length === 0)
    return { conditions, outcomes, messages, storePath };

  let tracker: AutobuildTracker | undefined = options.tracker;
  if (tracker === undefined && options.file !== false) {
    const setting = trackerSetting(environment, options.config);
    try {
      const resolved = await resolveTracker({
        setting,
        projectDirectory: options.projectDirectory,
        environment,
      });
      if (resolved.kind === "autobuild") tracker = resolved.tracker;
      else if (resolved.note !== undefined)
        messages.push(`idiom ${options.mode}: ${resolved.note}`);
    } catch (error) {
      messages.push(
        `idiom ${options.mode}: could not reach the tracker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (tracker === undefined || options.file === false) {
    for (const condition of observed)
      outcomes.push({ key: condition.key, kind: "skipped" });
    return { conditions, outcomes, messages, storePath };
  }
  const labels = [
    ...new Set(
      options.config?.labels !== undefined && options.config.labels.length > 0
        ? options.config.labels
        : UNATTENDED_DEFAULT_LABELS,
    ),
  ];
  const label = labels[0] as string;
  let triageState: string | undefined;
  try {
    triageState = (await tracker.triageStates())[0];
  } catch (error) {
    messages.push(
      `idiom ${options.mode}: could not read ticket states: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tickets = new Map<string, string>();
  const listed: { tickets?: TrackerTicket[] } = {};
  for (const condition of observed) {
    const entry = recorded.observed.find((item) => item.key === condition.key);
    if (entry === undefined) continue;
    try {
      const body = renderBody(condition, entry);
      const existing = await findTicket(
        tracker,
        condition.key,
        entry.ticket,
        label,
        listed,
      );
      if (existing !== undefined) {
        tickets.set(condition.key, existing.ref.id);
        if (existing.body === body) {
          outcomes.push({
            key: condition.key,
            ticket: existing.ref.id,
            kind: "unchanged",
          });
          continue;
        }
        await tracker.update({
          id: existing.ref.id,
          body,
          labels: [...new Set([...existing.labels, ...labels])],
        });
        outcomes.push({
          key: condition.key,
          ticket: existing.ref.id,
          kind: "updated",
        });
        continue;
      }
      if (triageState === undefined) {
        outcomes.push({
          key: condition.key,
          kind: "skipped",
          message: "no ticket state has the triage role",
        });
        messages.push(
          `idiom ${options.mode}: could not file ${condition.key}: no autobuild ticket state has the triage role`,
        );
        continue;
      }
      const created = await tracker.create({
        title: conditionTitle(condition),
        body,
        state: triageState,
        labels,
      });
      tickets.set(condition.key, created.ref.id);
      outcomes.push({
        key: condition.key,
        ticket: created.ref.id,
        kind: "created",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ key: condition.key, kind: "error", message });
      messages.push(
        `idiom ${options.mode}: could not file ${condition.key}: ${message}`,
      );
    }
  }
  for (const entry of withTicket) {
    try {
      const ticket = await tracker.show(entry.ticket as string);
      if (ticket === undefined || ticket.resolved) continue;
      const line = `Cleared: ${entry.resolvedAt?.slice(0, 10)} by idiom ${entry.resolvedBy ?? options.mode}`;
      if (ticket.body.includes("Cleared: ")) continue;
      await tracker.update({
        id: ticket.ref.id,
        body: `${ticket.body.trimEnd()}\n\n${line}\n`,
        labels: ticket.labels,
      });
      outcomes.push({ key: entry.key, ticket: ticket.ref.id, kind: "cleared" });
    } catch (error) {
      messages.push(
        `idiom ${options.mode}: could not note ${entry.key} cleared: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    await recordTickets(storePath, tickets);
  } catch (error) {
    messages.push(
      `idiom ${options.mode}: could not remember tickets in ${storePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { conditions, outcomes, messages, storePath };
}
