import { access } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import { TRACKER_STATES } from "../review/lifecycle.js";
import type { Acknowledgement } from "../schemas/decision.js";
import type { Finding } from "../schemas/finding.js";
import { severityRank as sharedSeverityRank } from "../schemas/severity.js";

export type TrackerState = (typeof TRACKER_STATES)[number];

export type AcknowledgementLapse = {
  findingId: string;
  reference: string;
  reason: "unacknowledged" | "ticket-done" | "expired" | "evidence-changed";
  message: string;
  ticketState?: TrackerState | undefined;
  detail?: string | undefined;
};

export type AcknowledgementState =
  | { kind: "active"; record: Acknowledgement }
  | { kind: "lapsed"; record: Acknowledgement; lapse: AcknowledgementLapse };

/** The identities a finding answers to: a catalog lineage, or the finding alone. */
export type AcknowledgementTarget = {
  id: string;
  ids: readonly string[];
  fingerprints: readonly string[];
};

/** Looks up a tracker ticket's state; cached per run by the caller. */
export type TicketStateLookup = (
  reference: string,
) => Promise<TrackerState | undefined>;

const severityRank = sharedSeverityRank;
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The latest acknowledge or unacknowledge entry for this finding, if any. */
export function latestAcknowledgement(
  target: Pick<AcknowledgementTarget, "ids" | "fingerprints">,
  entries: readonly Acknowledgement[],
): Acknowledgement | undefined {
  return entries
    .filter(
      (entry) =>
        target.ids.includes(entry.findingId) ||
        target.fingerprints.includes(entry.fingerprint),
    )
    .at(-1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The reference's state in the local ticket tracker, earliest state first,
 * as lifecycle reads it. Only a plain ticket id is probed, so free text can
 * never name a path outside a tracker root.
 */
export async function trackerTicketState(
  roots: readonly string[],
  reference: string,
): Promise<TrackerState | undefined> {
  if (!TICKET_ID.test(reference) || reference.includes("..")) return undefined;
  for (const state of TRACKER_STATES)
    for (const root of roots)
      if (await exists(join(root, state, `${reference}.md`))) return state;
  return undefined;
}

/** A cached lookup: each distinct reference is probed once. */
export function ticketStateLookup(roots: readonly string[]): TicketStateLookup {
  const cache = new Map<string, Promise<TrackerState | undefined>>();
  return (reference) => {
    let state = cache.get(reference);
    if (state === undefined) {
      state = trackerTicketState(roots, reference);
      cache.set(reference, state);
    }
    return state;
  };
}

/**
 * Whether the observed occurrence is materially different from what was
 * acknowledged: more severe, or a different rule. Measured values wobble from
 * run to run and are deliberately not compared.
 */
export function materialEvidenceChange(
  record: Acknowledgement,
  finding: Pick<Finding, "severity" | "rule" | "category">,
): string | undefined {
  const evidence = record.evidence;
  if (evidence === undefined) return undefined;
  if (severityRank[finding.severity] < severityRank[evidence.severity])
    return `severity ${evidence.severity} → ${finding.severity}`;
  const was = evidence.rule ?? evidence.category;
  const now = finding.rule ?? finding.category;
  if (was !== now) return `rule ${was} → ${now}`;
  return undefined;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `until` is inclusive: it lapses at 00:00 UTC on the following day. */
export function untilPassed(until: string, now: Date): boolean {
  return utcDay(now) > until;
}

/**
 * The state of this finding's acknowledgement, or undefined when it has
 * none. The first lapse rule that applies wins: unacknowledged, ticket done,
 * expired, evidence changed.
 */
export async function resolveAcknowledgement(options: {
  target: AcknowledgementTarget;
  finding: Pick<Finding, "severity" | "rule" | "category">;
  entries: readonly Acknowledgement[];
  ticketState: TicketStateLookup;
  now: Date;
}): Promise<AcknowledgementState | undefined> {
  const record = latestAcknowledgement(options.target, options.entries);
  if (record === undefined) return undefined;
  const id = options.target.id;
  const lapsed = (
    lapse: Omit<AcknowledgementLapse, "findingId" | "reference">,
  ): AcknowledgementState => ({
    kind: "lapsed",
    record,
    lapse: { findingId: id, reference: record.reference, ...lapse },
  });
  if (record.decision === "unacknowledge")
    return lapsed({
      reason: "unacknowledged",
      message: `${id} was acknowledged for ${record.reference} and unacknowledged on ${record.at.slice(0, 10)}; it counts again.`,
    });
  const ticketState = await options.ticketState(record.reference);
  if (ticketState === "done")
    return lapsed({
      reason: "ticket-done",
      ticketState,
      message: `${id} was acknowledged for ${record.reference}, which is now done; it counts again.`,
    });
  if (record.until !== undefined && untilPassed(record.until, options.now))
    return lapsed({
      reason: "expired",
      message: `${id} was acknowledged for ${record.reference} until ${record.until}, which has passed; it counts again.`,
    });
  const change = materialEvidenceChange(record, options.finding);
  if (change !== undefined)
    return lapsed({
      reason: "evidence-changed",
      detail: change,
      message: `${id} was acknowledged for ${record.reference}, but its evidence changed (${change}); it counts again.`,
    });
  return { kind: "active", record };
}

/** The `--until` validator: a real YYYY-MM-DD date, today (UTC) or later. */
export function parseUntil(value: string, now: Date): string {
  const trimmed = value.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
    Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`)) ||
    !new Date(`${trimmed}T00:00:00Z`).toISOString().startsWith(trimmed)
  )
    throw new IdiomError(
      `--until expects a date as YYYY-MM-DD (got ${JSON.stringify(value)})`,
    );
  if (trimmed < utcDay(now))
    throw new IdiomError(`--until must be today or later (got ${trimmed})`);
  return trimmed;
}

export function acknowledgementStamp(
  record: Acknowledgement,
): NonNullable<Finding["acknowledgement"]> {
  return {
    reference: record.reference,
    at: record.at,
    ...(record.until === undefined ? {} : { until: record.until }),
    ...(record.note === undefined ? {} : { note: record.note }),
  };
}

/**
 * Stamps every finding whose acknowledgement is in force and returns the
 * lapses, one per finding id. The stamp is the only thing the gates read.
 */
export async function stampAcknowledgements(
  findings: readonly Finding[],
  options: {
    targetFor: (finding: Finding) => AcknowledgementTarget;
    entries: readonly Acknowledgement[];
    ticketState: TicketStateLookup;
    now: Date;
  },
): Promise<{ findings: Finding[]; lapses: AcknowledgementLapse[] }> {
  const lapses = new Map<string, AcknowledgementLapse>();
  const stamped: Finding[] = [];
  for (const finding of findings) {
    const { acknowledgement: _prior, ...bare } = finding;
    if (options.entries.length === 0) {
      stamped.push(bare);
      continue;
    }
    const target = options.targetFor(finding);
    const state = await resolveAcknowledgement({
      target,
      finding,
      entries: options.entries,
      ticketState: options.ticketState,
      now: options.now,
    });
    if (state?.kind === "active")
      stamped.push({
        ...bare,
        acknowledgement: acknowledgementStamp(state.record),
      });
    else {
      if (state?.kind === "lapsed" && !lapses.has(state.lapse.findingId))
        lapses.set(state.lapse.findingId, state.lapse);
      stamped.push(bare);
    }
  }
  return { findings: stamped, lapses: [...lapses.values()] };
}
