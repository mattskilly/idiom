import { access } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  type AttributionCache,
  lineageIntroduction,
} from "../attribution/lookup.js";
import type { RecordedIntroduction } from "../attribution/record.js";
import { causeText, rangeText } from "../attribution/render.js";
import {
  resolveAcknowledgement,
  ticketStateLookup,
} from "../decisions/acknowledgements.js";
import type { Acknowledgement, Decision } from "../schemas/decision.js";
import {
  indexTrackerTickets,
  resolveEmbeddedTicket,
  type TrackerIndex,
  type TrackerTicketState,
} from "../tickets/embedded.js";
import { ticketIdsForIdentities } from "../tickets/render.js";
import type {
  CatalogFinding,
  FindingLineage,
  ReviewCatalog,
} from "./catalog.js";

export const TRACKER_STATES = ["triage", "ready", "doing", "done"] as const;

export type FindingLifecycle = {
  id: string;
  fingerprint: string;
  aliases: { ids: string[]; fingerprints: string[] };
  surface: {
    flow: string;
    state: string;
    viewport: string;
    colorScheme?: "light" | "dark" | undefined;
  };
  firstObserved: string;
  latestObserved: string;
  occurrences: number;
  decision?: Decision | undefined;
  ticket?:
    | {
        id?: string | undefined;
        /** `checkpointed`: the catalog records a ticket, but no tracker holds one. */
        state?: (typeof TRACKER_STATES)[number] | "checkpointed" | undefined;
        paths: string[];
        conflict: boolean;
        /** How the ticket was found: by its generated filename, or embedded in a consolidated ticket. */
        source?: "generated" | "consolidated" | undefined;
      }
    | undefined;
  verification?: "verified-fixed" | "verify-failed" | undefined;
  /** The latest acknowledgement, judged against the latest occurrence. */
  acknowledgement?:
    | {
        reference: string;
        until?: string | undefined;
        note?: string | undefined;
        state: "active" | "lapsed";
        lapse?: string | undefined;
      }
    | undefined;
  path: string[];
  /** `decide --list`: the latest first-seen range `check` recorded for it. */
  introduced?: RecordedIntroduction | undefined;
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function lineageDecision(
  lineage: FindingLineage,
  decisions: readonly Decision[],
  occurrence?: CatalogFinding | undefined,
): Decision | undefined {
  return decisions
    .filter((decision) => {
      if (decision.scope === "rule")
        return lineage.fingerprints.includes(decision.fingerprint);
      if (!lineage.ids.includes(decision.findingId)) return false;
      return (
        occurrence === undefined ||
        decision.commit === occurrence.finding.commit
      );
    })
    .at(-1);
}

export function trackerRootsFor(
  projectDirectory: string,
  additionalTrackerRoots: readonly string[] = [],
): string[] {
  const roots = [
    resolve(projectDirectory, ".autobuild", "tickets"),
    ...additionalTrackerRoots.map((root) => resolve(root)),
  ];
  return roots.filter((root, index) => roots.indexOf(root) === index);
}

/**
 * Whether any resolved tracker root is present on disk. A root that exists but
 * holds no matching ticket is a genuine answer, not missing state.
 */
export async function anyTrackerRootExists(
  roots: readonly string[],
): Promise<boolean> {
  for (const root of roots) if (await exists(root)) return true;
  return false;
}

/**
 * The ticket holding this lineage's embedded record, resolved exactly as
 * `idiom tickets` does. Generated filenames take precedence; this is only the
 * fallback. Indexes are in root order, project first.
 */
function consolidatedTicket(
  lineage: FindingLineage,
  indexes: readonly TrackerIndex[],
): FindingLifecycle["ticket"] {
  const located: Array<{ state: TrackerTicketState; path: string }> = [];
  const conflicting: string[] = [];
  const seen = new Set<string>();
  for (const index of indexes) {
    const resolution = resolveEmbeddedTicket(index, lineage);
    if (resolution.kind === "conflict") {
      for (const path of resolution.paths)
        if (!conflicting.includes(path)) conflicting.push(path);
    } else if (resolution.kind === "single") {
      // The same ticket visible from two roots is one ticket, never a conflict.
      const key = `${resolution.ticket.state}/${basename(resolution.ticket.path)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      located.push(resolution.ticket);
    }
  }
  // State outer, root inner, as the generated-filename lookup orders them.
  located.sort(
    (left, right) =>
      TRACKER_STATES.indexOf(left.state) - TRACKER_STATES.indexOf(right.state),
  );
  const first = located[0];
  if (first !== undefined) {
    const paths = [
      ...located.map((ticket) => ticket.path),
      ...conflicting.filter(
        (path) => !located.some((ticket) => ticket.path === path),
      ),
    ];
    return {
      id: basename(first.path, ".md"),
      state: first.state,
      paths,
      conflict: paths.length > 1,
      source: "consolidated",
    };
  }
  if (conflicting.length > 0)
    return { paths: conflicting, conflict: true, source: "consolidated" };
  return undefined;
}

async function lineageTicket(
  lineage: FindingLineage,
  roots: readonly string[],
  indexes: readonly TrackerIndex[],
): Promise<FindingLifecycle["ticket"]> {
  const ticketIds = ticketIdsForIdentities([
    ...lineage.identities,
    {
      fingerprint: lineage.first.finding.fingerprint,
      findingId: lineage.id,
    },
  ]);
  const located: Array<{
    id: string;
    state: (typeof TRACKER_STATES)[number];
    path: string;
  }> = [];
  const seen = new Set<string>();
  // State outer, root inner: the earliest tracker state still wins, and within
  // one state the project's own root wins over an inherited one. The same
  // ticket visible from two roots is one ticket, never a conflict.
  for (const state of TRACKER_STATES) {
    for (const root of roots) {
      for (const id of ticketIds) {
        const path = join(root, state, `${id}.md`);
        if (seen.has(`${state}/${id}`)) continue;
        if (await exists(path)) {
          seen.add(`${state}/${id}`);
          located.push({ id, state, path });
        }
      }
    }
  }
  if (located.length > 0) {
    return {
      id: located[0]?.id,
      state: located[0]?.state,
      paths: located.map((item) => item.path),
      conflict: located.length > 1,
      source: "generated",
    };
  }
  const consolidated = consolidatedTicket(lineage, indexes);
  if (consolidated !== undefined) return consolidated;
  if (
    lineage.occurrences.some((occurrence) =>
      ["ticketed", "verified-fixed", "verify-failed"].includes(
        occurrence.finding.status,
      ),
    )
  ) {
    return { state: "checkpointed", paths: [], conflict: false };
  }
  return undefined;
}

export async function reduceLifecycles(options: {
  catalog: ReviewCatalog;
  decisions: readonly Decision[];
  /**
   * Tracker roots consulted after the project's own. Defaults to none, so every
   * caller other than `idiom context` reads exactly one checkout.
   */
  additionalTrackerRoots?: readonly string[] | undefined;
  /** `decide --list` only: resolved against the project's own tracker. */
  acknowledgements?: readonly Acknowledgement[] | undefined;
  /** `decide --list` only: read each lineage's recorded first-seen range. */
  introductions?: boolean | undefined;
  now?: Date | undefined;
}): Promise<FindingLifecycle[]> {
  const attributionCache: AttributionCache = new Map();
  const roots = trackerRootsFor(
    options.catalog.projectDirectory,
    options.additionalTrackerRoots,
  );
  const ticketState = ticketStateLookup(
    trackerRootsFor(options.catalog.projectDirectory),
  );
  // Indexed once per call: every lineage is resolved against the same reads.
  const indexes = await Promise.all(roots.map(indexTrackerTickets));
  const output: FindingLifecycle[] = [];
  for (const lineage of options.catalog.lineages) {
    // Judge the current occurrence, as ticket eligibility and the decide prompt do.
    const decision = lineageDecision(
      lineage,
      options.decisions,
      lineage.latest,
    );
    const ticket = await lineageTicket(lineage, roots, indexes);
    // Verification describes the current occurrence; a re-observed lineage needs fresh evaluation.
    const latestStatus = lineage.latest.finding.status;
    const verification =
      latestStatus === "verified-fixed" || latestStatus === "verify-failed"
        ? latestStatus
        : undefined;
    const acknowledged =
      options.acknowledgements === undefined
        ? undefined
        : await resolveAcknowledgement({
            target: lineage,
            finding: lineage.latest.finding,
            entries: options.acknowledgements,
            ticketState,
            now: options.now ?? new Date(),
          });
    const introduced =
      options.introductions === true
        ? await lineageIntroduction(lineage, attributionCache)
        : undefined;
    const path = ["open"];
    if (decision !== undefined)
      path.push(decision.decision === "accept" ? "approved" : "rejected");
    if (ticket !== undefined && decision?.decision !== "reject")
      path.push("ticketed");
    if (verification !== undefined) path.push(verification);
    output.push({
      id: lineage.id,
      fingerprint: lineage.latest.finding.fingerprint,
      aliases: {
        ids: lineage.ids.filter((id) => id !== lineage.id),
        fingerprints: lineage.fingerprints.filter(
          (fingerprint) => fingerprint !== lineage.latest.finding.fingerprint,
        ),
      },
      surface: {
        flow: lineage.latest.finding.flow,
        state: lineage.latest.finding.state,
        viewport: lineage.latest.finding.viewport,
        ...(lineage.latest.finding.colorScheme === undefined
          ? {}
          : { colorScheme: lineage.latest.finding.colorScheme }),
      },
      firstObserved: lineage.first.finding.createdAt,
      latestObserved: lineage.latest.finding.createdAt,
      occurrences: lineage.occurrences.length,
      ...(decision === undefined ? {} : { decision }),
      ...(ticket === undefined ? {} : { ticket }),
      ...(verification === undefined ? {} : { verification }),
      ...(acknowledged === undefined
        ? {}
        : {
            acknowledgement: {
              reference: acknowledged.record.reference,
              ...(acknowledged.record.until === undefined
                ? {}
                : { until: acknowledged.record.until }),
              ...(acknowledged.record.note === undefined
                ? {}
                : { note: acknowledged.record.note }),
              state: acknowledged.kind,
              ...(acknowledged.kind === "lapsed"
                ? { lapse: acknowledged.lapse.message }
                : {}),
            },
          }),
      path,
      ...(introduced === undefined ? {} : { introduced }),
    });
  }
  return output;
}

function ticketLabel(ticket: FindingLifecycle["ticket"]): string {
  if (ticket === undefined) return "none";
  if (ticket.state === "checkpointed")
    return "checkpointed — no tracker ticket found";
  return `${ticket.id ?? "unknown ticket"}${ticket.state === undefined ? "" : ` (${ticket.state})`}${ticket.source === "consolidated" ? " — consolidated" : ""}${ticket.conflict ? " — conflict" : ""}`;
}

function acknowledgementLabel(
  acknowledgement: NonNullable<FindingLifecycle["acknowledgement"]>,
): string {
  const note =
    acknowledgement.note === undefined ? "" : ` — ${acknowledgement.note}`;
  if (acknowledgement.state === "lapsed")
    return `${acknowledgement.reference} (lapsed — ${acknowledgement.lapse ?? "no longer in force"})`;
  return `${acknowledgement.reference} (active${acknowledgement.until === undefined ? "" : ` until ${acknowledgement.until}`})${note}`;
}

export function renderLifecycleList(lifecycles: FindingLifecycle[]): string {
  if (lifecycles.length === 0) return "No reviewed findings.\n";
  const lines: string[] = [];
  for (const lifecycle of lifecycles) {
    lines.push(
      `${lifecycle.id} — ${lifecycle.surface.flow}/${lifecycle.surface.state}/${lifecycle.surface.viewport}${lifecycle.surface.colorScheme === undefined ? "" : `/${lifecycle.surface.colorScheme}`}`,
      `  Fingerprint: ${lifecycle.fingerprint}`,
      ...(lifecycle.aliases.fingerprints.length === 0
        ? []
        : [
            `  Fingerprint aliases: ${lifecycle.aliases.fingerprints.join(", ")}`,
          ]),
      ...(lifecycle.aliases.ids.length === 0
        ? []
        : [`  ID aliases: ${lifecycle.aliases.ids.join(", ")}`]),
      `  Observed: ${lifecycle.firstObserved} -> ${lifecycle.latestObserved} (${lifecycle.occurrences} occurrence${lifecycle.occurrences === 1 ? "" : "s"})`,
      ...(lifecycle.introduced === undefined
        ? []
        : [
            `  Appeared: ${rangeText(lifecycle.introduced)}`,
            `  Likely cause: ${causeText(lifecycle.introduced)}`,
          ]),
      `  Decision: ${
        lifecycle.decision === undefined
          ? "none"
          : `${lifecycle.decision.decision} (${lifecycle.decision.scope})${lifecycle.decision.reason === undefined ? "" : ` — ${lifecycle.decision.reason}`}`
      }`,
      ...(lifecycle.acknowledgement === undefined
        ? []
        : [
            `  Acknowledgement: ${acknowledgementLabel(lifecycle.acknowledgement)}`,
          ]),
      `  Ticket: ${ticketLabel(lifecycle.ticket)}`,
      ...(lifecycle.ticket === undefined || lifecycle.ticket.paths.length === 0
        ? []
        : [`  Ticket path: ${lifecycle.ticket.paths.join(", ")}`]),
      `  Verification: ${lifecycle.verification ?? "none"}`,
      `  Lifecycle: ${lifecycle.path.join(" -> ")}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
