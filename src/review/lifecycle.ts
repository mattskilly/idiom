import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Decision } from "../schemas/decision.js";
import { ticketIdsForIdentities } from "../tickets/render.js";
import type {
  CatalogFinding,
  FindingLineage,
  ReviewCatalog,
} from "./catalog.js";

const TRACKER_STATES = ["triage", "ready", "doing", "done"] as const;

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
        state?: (typeof TRACKER_STATES)[number] | "custom" | undefined;
        paths: string[];
        conflict: boolean;
      }
    | undefined;
  verification?: "verified-fixed" | "verify-failed" | undefined;
  path: string[];
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

async function lineageTicket(
  lineage: FindingLineage,
  roots: readonly string[],
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
    };
  }
  if (
    lineage.occurrences.some((occurrence) =>
      ["ticketed", "verified-fixed", "verify-failed"].includes(
        occurrence.finding.status,
      ),
    )
  ) {
    return { state: "custom", paths: [], conflict: false };
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
}): Promise<FindingLifecycle[]> {
  const roots = trackerRootsFor(
    options.catalog.projectDirectory,
    options.additionalTrackerRoots,
  );
  const output: FindingLifecycle[] = [];
  for (const lineage of options.catalog.lineages) {
    const decision = lineageDecision(lineage, options.decisions);
    const ticket = await lineageTicket(lineage, roots);
    const verification = [...lineage.occurrences]
      .reverse()
      .map((occurrence) => occurrence.finding.status)
      .find(
        (status): status is "verified-fixed" | "verify-failed" =>
          status === "verified-fixed" || status === "verify-failed",
      );
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
      path,
    });
  }
  return output;
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
      `  Decision: ${
        lifecycle.decision === undefined
          ? "none"
          : `${lifecycle.decision.decision} (${lifecycle.decision.scope})${lifecycle.decision.reason === undefined ? "" : ` — ${lifecycle.decision.reason}`}`
      }`,
      `  Ticket: ${
        lifecycle.ticket === undefined
          ? "none"
          : `${lifecycle.ticket.id ?? "custom checkpoint"}${lifecycle.ticket.state === undefined ? "" : ` (${lifecycle.ticket.state})`}${lifecycle.ticket.conflict ? " — conflict" : ""}`
      }`,
      `  Verification: ${lifecycle.verification ?? "none"}`,
      `  Lifecycle: ${lifecycle.path.join(" -> ")}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
