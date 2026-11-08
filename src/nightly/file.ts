import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  type AttributionCache,
  lineageIntroduction,
} from "../attribution/lookup.js";
import type { RecordedIntroduction } from "../attribution/record.js";
import { causeText, rangeText } from "../attribution/render.js";
import type { ClusterInputs } from "../commands/check.js";
import { readDecisionLog } from "../decisions/log.js";
import { severityGateEligible } from "../findings/gate.js";
import { acceptanceText } from "../findings/presentation.js";
import {
  type FindingLineage,
  findCatalogLineage,
  loadReviewCatalog,
  type ReviewCatalog,
} from "../review/catalog.js";
import { lineageDecision } from "../review/lifecycle.js";
import {
  type ClusterMember,
  clusterTicketId,
  type FindingCluster,
  groupFindings,
  observationLoader,
} from "../tickets/cluster.js";
import { buildClusterMember } from "../tickets/emit.js";
import { indexTickets } from "../tickets/index.js";
import { rankClusters } from "../tickets/ranking.js";
import { renderClusterTicket } from "../tickets/render.js";
import { physicalPath } from "../tickets/target.js";
import { parseFindingBlocks } from "../verify/spec.js";
import type { AutobuildTracker } from "./autobuild.js";
import {
  type FindingIdentities,
  type Ledger,
  type LedgerEntry,
  matchEntries,
  readLedger,
  writeLedger,
} from "./ledger.js";

export type NightlySeverity = "blocker" | "major" | "minor";

/** Where filed clusters go: the autobuild tracker's triage, or a directory. */
export type NightlySink =
  | {
      kind: "autobuild";
      tracker: AutobuildTracker;
      /** The state new tickets are created in: the first triage-role state. */
      triageState: string;
      /** Every triage-role state; a ticket in one of them may be updated. */
      triageStates: readonly string[];
    }
  | { kind: "directory"; out: string };

export type NightlyOutcomeKind =
  | "created"
  | "updated"
  | "unchanged"
  | "in-progress"
  | "reopened-as-new"
  | "refiled-missing"
  | "conflict"
  | "skipped"
  | "error";

export type NightlyOutcome = {
  kind: NightlyOutcomeKind;
  findingIds: string[];
  clusterId?: string | undefined;
  /** The tracker ticket id or proposal path filed, updated or left alone. */
  ticket?: string | undefined;
  /** conflict: every ticket the cluster matched. */
  tickets?: string[] | undefined;
  /** The ticket this one was filed in place of (resolved or missing). */
  replaced?: string | undefined;
  title?: string | undefined;
  labels?: string[] | undefined;
  /** created, reopened-as-new and refiled-missing: the state filed in. */
  state?: string | undefined;
  /** in-progress: the state the ticket is in. */
  ticketState?: string | undefined;
  /** skipped: why. */
  reason?: "rejected" | "acknowledged" | undefined;
  /** error: what failed. */
  message?: string | undefined;
};

export type NightlyFilingResult = {
  ledgerPath: string;
  dryRun: boolean;
  /** New findings below the severity threshold; never filed. */
  belowSeverity: number;
  outcomes: NightlyOutcome[];
};

export type FileNightlyOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
  isolatedRegistry?: boolean | undefined;
  /** Where the ledger lives: `.idiom/filed-tickets.json` here. */
  ledgerPath: string;
  inputs: readonly ClusterInputs[];
  severity: NightlySeverity;
  /** Configured labels; the first is the one tracker recovery lists by. */
  labels: readonly string[];
  sink: NightlySink;
  dryRun?: boolean | undefined;
  now?: (() => Date) | undefined;
};

/** One cluster ready to file: its rendering inputs and identities. */
type Prepared = {
  cluster: FindingCluster;
  id: string;
  findingIds: string[];
  identities: FindingIdentities;
  flows: string[];
  labels: string[];
  images: Map<string, string[]>;
  memberNotes: Map<string, string[]>;
  introduced: string;
  doneWhen: string;
};

type Recovered = Pick<LedgerEntry, "ticket" | "findingIds" | "fingerprints">;

const unique = (values: Iterable<string>) => [...new Set(values)];
const sameSet = (left: readonly string[], right: readonly string[]) =>
  unique(left).sort().join("\0") === unique(right).sort().join("\0");
const code = (value: string) => `\`${value}\``;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * File each new cluster at or above the severity as a triage ticket, or
 * update the one already filed. Never moves a ticket and never checkpoints
 * a finding's catalog status: humans promote, and the gate still counts it.
 */
export async function fileNightly(
  options: FileNightlyOptions,
): Promise<NightlyFilingResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? (() => new Date());
  const catalog = await loadReviewCatalog(options);
  const decisions = await readDecisionLog(catalog.projectDirectory);
  const result: NightlyFilingResult = {
    ledgerPath: options.ledgerPath,
    dryRun,
    belowSeverity: 0,
    outcomes: [],
  };
  const loadObservations = observationLoader();
  const members = new Map<string, ClusterMember>();
  const images = new Map<string, string[]>();
  const scores = new Map<string, number>();
  for (const input of options.inputs)
    for (const record of input.records) {
      if (!severityGateEligible(record.finding, options.severity, false)) {
        result.belowSeverity += 1;
        continue;
      }
      const lineage = findCatalogLineage(catalog, record.finding.id);
      if (members.has(lineage.id)) continue;
      const reason =
        lineageDecision(lineage, decisions)?.decision === "reject"
          ? "rejected"
          : record.finding.acknowledgement !== undefined
            ? "acknowledged"
            : undefined;
      if (reason !== undefined) {
        result.outcomes.push({
          kind: "skipped",
          findingIds: [lineage.id],
          reason,
        });
        continue;
      }
      const built = await buildClusterMember(catalog, record, {
        id: lineage.id,
        cause: input.rootCauses.get(record.finding.id),
        loadObservations,
      });
      members.set(lineage.id, built.member);
      images.set(lineage.id, built.images);
      const score = input.issueScores.get(record.finding.id);
      if (score !== undefined)
        scores.set(
          lineage.id,
          Math.max(scores.get(lineage.id) ?? score, score),
        );
    }
  if (members.size === 0) return result;
  const attribution: AttributionCache = new Map();
  const clusters = rankClusters(groupFindings([...members.values()]), scores);
  const prepared: Prepared[] = [];
  for (const cluster of clusters)
    prepared.push(
      await prepare(catalog, cluster, images, options.labels, attribution),
    );

  const ledger = await readLedger(options.ledgerPath);
  const sink = options.sink;
  let recovered: Recovered[] | undefined;
  const recover = async () => {
    recovered ??=
      sink.kind === "autobuild"
        ? await recoverFromTracker(sink.tracker, options.labels[0] ?? "idiom")
        : await recoverFromDirectory(catalog.projectDirectory, sink.out);
    return recovered;
  };
  const persist = async () => {
    if (!dryRun) await writeLedger(options.ledgerPath, ledger);
  };
  const claimed = new Set<string>();
  for (const item of prepared) {
    const base = {
      clusterId: item.id,
      findingIds: item.findingIds,
    };
    try {
      let entries = matchEntries(
        ledger.entries.filter((entry) => entry.sink === sink.kind),
        item.identities,
      );
      if (entries.length === 0) {
        const found = matchEntries(await recover(), item.identities);
        if (found.length > 1) {
          result.outcomes.push({
            ...base,
            kind: "conflict",
            tickets: found.map((entry) => entry.ticket),
          });
          continue;
        }
        const adopted = found[0];
        if (adopted !== undefined) {
          // A fresh checkout (CI) recovers what an earlier run filed.
          const at = now().toISOString();
          const entry: LedgerEntry = {
            sink: sink.kind,
            ticket: adopted.ticket,
            findingIds: adopted.findingIds,
            fingerprints: adopted.fingerprints,
            flows: item.flows,
            labels: item.labels,
            bodyDigest: "",
            filedAt: at,
            updatedAt: at,
          };
          ledger.entries.push(entry);
          entries = [entry];
        }
      }
      if (entries.length > 1) {
        result.outcomes.push({
          ...base,
          kind: "conflict",
          tickets: entries.map((entry) => entry.ticket),
        });
        continue;
      }
      const entry = entries[0];
      if (entry !== undefined && claimed.has(entry.ticket)) {
        // Two clusters this run map to one ticket; updating it twice would lose one.
        result.outcomes.push({
          ...base,
          kind: "conflict",
          tickets: [entry.ticket],
        });
        continue;
      }
      if (entry !== undefined) claimed.add(entry.ticket);
      const outcome =
        sink.kind === "autobuild"
          ? await fileToTracker({
              item,
              entry,
              sink,
              ledger,
              dryRun,
              now,
              projectDirectory: catalog.projectDirectory,
            })
          : await fileToDirectory({
              item,
              entry,
              out: sink.out,
              ledger,
              dryRun,
              now,
              projectDirectory: catalog.projectDirectory,
            });
      result.outcomes.push({ ...base, ...outcome });
      await persist();
    } catch (error) {
      result.outcomes.push({
        ...base,
        kind: "error",
        message: errorText(error),
      });
    }
  }
  return result;
}

async function prepare(
  catalog: ReviewCatalog,
  cluster: FindingCluster,
  allImages: ReadonlyMap<string, string[]>,
  configured: readonly string[],
  attribution: AttributionCache,
): Promise<Prepared> {
  const lineages: FindingLineage[] = cluster.members.map((member) =>
    findCatalogLineage(catalog, member.id),
  );
  const findingIds = cluster.members.map((member) => member.id);
  const flows = unique(
    cluster.members.map((member) => member.record.finding.flow),
  ).sort();
  const memberNotes = new Map<string, string[]>();
  const ranges = new Map<string, string[]>();
  const unavailable: string[] = [];
  for (const [index, member] of cluster.members.entries()) {
    const lineage = lineages[index] as FindingLineage;
    const introduction: RecordedIntroduction | undefined =
      await lineageIntroduction(lineage, attribution);
    if (introduction === undefined) {
      unavailable.push(member.id);
      memberNotes.set(member.id, [
        "Introduced: commit range unavailable: no earlier complete run.",
      ]);
      continue;
    }
    const range = rangeText(introduction);
    ranges.set(range, [...(ranges.get(range) ?? []), member.id]);
    memberNotes.set(member.id, [
      `Introduced: ${range}; ${causeText(introduction)}.`,
    ]);
  }
  const introduced = [
    ...[...ranges].map(
      ([range, ids]) => `${range} (${ids.map(code).join(", ")})`,
    ),
    ...(unavailable.length === 0
      ? []
      : [
          `commit range unavailable: no earlier complete run (${unavailable.map(code).join(", ")})`,
        ]),
  ].join("; ");
  const checks = flows
    .map((flow) => code(`idiom check ${flow} --since-baseline`))
    .join(" and ");
  const verifies = flows
    .map((flow) => code(`idiom verify ${flow} --spec <this ticket>`))
    .join(" and ");
  return {
    cluster,
    id: clusterTicketId(cluster),
    findingIds,
    identities: {
      ids: unique(lineages.flatMap((lineage) => [lineage.id, ...lineage.ids])),
      fingerprints: unique([
        ...cluster.members.map((member) => member.record.finding.fingerprint),
        ...lineages.flatMap((lineage) => lineage.fingerprints),
      ]),
    },
    flows,
    labels: unique([
      ...configured,
      ...cluster.members.map((member) => member.record.finding.category),
    ]),
    images: new Map(
      findingIds.map((id) => [id, allImages.get(id) ?? []] as const),
    ),
    memberNotes,
    introduced: `Introduced: ${introduced}.`,
    doneWhen: `Done when ${checks} no longer ${flows.length === 1 ? "reports" : "report"} ${findingIds.map(code).join(", ")}, and ${verifies} passes for every embedded finding.`,
  };
}

function render(
  item: Prepared,
  options: {
    id: string;
    ticketDirectory: string;
    frontMatter: boolean;
    evidenceRoot?: string | undefined;
    reappearedAfter?: string | undefined;
  },
): { title: string; body: string; digest: string } {
  const leadNotes = [
    ...(options.reappearedAfter === undefined
      ? []
      : [
          `Reappeared after ${code(options.reappearedAfter)} was resolved: the same findings are new again, so this is a regression, not a duplicate.`,
        ]),
    item.introduced,
  ];
  const rendered = renderClusterTicket({
    cluster: item.cluster,
    id: options.id,
    ticketDirectory: options.ticketDirectory,
    availableImages: item.images,
    frontMatter: options.frontMatter,
    labels: item.labels,
    extraCriteria: [item.doneWhen],
    memberNotes: item.memberNotes,
    leadNotes,
    evidenceRoot: options.evidenceRoot,
  });
  return {
    title: rendered.title,
    body: rendered.body,
    digest: filingDigest(item, rendered.title, leadNotes),
  };
}

/**
 * What a filed ticket says, without the run-specific parts (run ids and
 * evidence paths change every night): an unchanged digest means the ticket
 * needs no update.
 */
function filingDigest(
  item: Prepared,
  title: string,
  leadNotes: readonly string[],
): string {
  const members = item.cluster.members.map((member) => {
    const finding = member.record.finding;
    return [
      member.id,
      finding.fingerprint,
      finding.severity,
      finding.category,
      finding.flow,
      finding.state,
      finding.viewport,
      finding.colorScheme ?? "",
      finding.combination ?? "",
      finding.explanation,
      acceptanceText(finding),
      member.component,
      item.memberNotes.get(member.id) ?? [],
    ];
  });
  return createHash("sha256")
    .update(
      JSON.stringify([
        title,
        item.labels,
        leadNotes,
        item.doneWhen,
        item.cluster.cause?.id ?? null,
        members,
      ]),
    )
    .digest("hex");
}

function merged(
  entry: LedgerEntry,
  item: Prepared,
  changes: Partial<LedgerEntry>,
): LedgerEntry {
  return {
    ...entry,
    findingIds: unique([...entry.findingIds, ...item.identities.ids]),
    fingerprints: unique([
      ...entry.fingerprints,
      ...item.identities.fingerprints,
    ]),
    flows: unique([...entry.flows, ...item.flows]),
    labels: unique([...entry.labels, ...item.labels]),
    ...changes,
  };
}

/** A new filing, keeping every identity the entry it replaces covered. */
function repointed(
  entry: LedgerEntry | undefined,
  item: Prepared,
  next: LedgerEntry,
): LedgerEntry {
  if (entry === undefined) return next;
  const { findingIds: _ids, fingerprints: _prints, ...filing } = next;
  return merged(entry, item, filing);
}

function replaceEntry(
  ledger: Ledger,
  previous: LedgerEntry | undefined,
  next: LedgerEntry,
) {
  const index = previous === undefined ? -1 : ledger.entries.indexOf(previous);
  if (index === -1) ledger.entries.push(next);
  else ledger.entries[index] = next;
}

function fresh(
  item: Prepared,
  sink: LedgerEntry["sink"],
  ticket: string,
  digest: string,
  at: string,
  replaced?: string | undefined,
): LedgerEntry {
  return {
    sink,
    ticket,
    findingIds: item.identities.ids,
    fingerprints: item.identities.fingerprints,
    flows: item.flows,
    labels: item.labels,
    bodyDigest: digest,
    filedAt: at,
    updatedAt: at,
    ...(replaced === undefined ? {} : { replaced }),
  };
}

type FileOptions = {
  item: Prepared;
  entry: LedgerEntry | undefined;
  ledger: Ledger;
  dryRun: boolean;
  now: () => Date;
  projectDirectory: string;
};
type FiledOutcome = Omit<NightlyOutcome, "clusterId" | "findingIds">;

async function fileToTracker(
  options: FileOptions & {
    sink: Extract<NightlySink, { kind: "autobuild" }>;
  },
): Promise<FiledOutcome> {
  const { item, entry, ledger, dryRun, sink } = options;
  const at = options.now().toISOString();
  const shape = (reappearedAfter?: string) =>
    render(item, {
      id: item.id,
      ticketDirectory: options.projectDirectory,
      frontMatter: false,
      evidenceRoot: options.projectDirectory,
      reappearedAfter,
    });
  const create = async (
    kind: "created" | "reopened-as-new" | "refiled-missing",
    replaced?: string,
  ): Promise<FiledOutcome> => {
    const rendered = shape(kind === "reopened-as-new" ? replaced : undefined);
    const filed = {
      kind,
      title: rendered.title,
      labels: item.labels,
      state: sink.triageState,
      ...(replaced === undefined ? {} : { replaced }),
    };
    if (dryRun) return filed;
    const ticket = await sink.tracker.create({
      title: rendered.title,
      body: rendered.body,
      state: sink.triageState,
      labels: item.labels,
    });
    const next = fresh(
      item,
      "autobuild",
      ticket.ref.id,
      rendered.digest,
      at,
      replaced,
    );
    replaceEntry(ledger, entry, repointed(entry, item, next));
    return { ...filed, ticket: ticket.ref.id };
  };
  if (entry === undefined) return create("created");
  const ticket = await sink.tracker.show(entry.ticket);
  if (ticket === undefined) return create("refiled-missing", entry.ticket);
  if (ticket.resolved) return create("reopened-as-new", entry.ticket);
  if (ticket.state === undefined || !sink.triageStates.includes(ticket.state)) {
    // Work someone is building is never touched.
    replaceEntry(ledger, entry, merged(entry, item, {}));
    return {
      kind: "in-progress",
      ticket: entry.ticket,
      ...(ticket.state === undefined ? {} : { ticketState: ticket.state }),
    };
  }
  const rendered = shape();
  const labels = unique([...ticket.labels, ...item.labels]);
  const changed =
    rendered.digest !== entry.bodyDigest || !sameSet(labels, ticket.labels);
  const outcome: FiledOutcome = {
    kind: changed ? "updated" : "unchanged",
    ticket: entry.ticket,
    title: rendered.title,
    labels,
  };
  if (dryRun) return outcome;
  if (changed)
    await sink.tracker.update({
      id: entry.ticket,
      body: rendered.body,
      labels,
    });
  replaceEntry(
    ledger,
    entry,
    merged(entry, item, {
      bodyDigest: rendered.digest,
      ...(changed ? { updatedAt: at } : {}),
    }),
  );
  return outcome;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const projectRelative = (projectDirectory: string, path: string) =>
  relative(projectDirectory, path).split(sep).join("/");

async function fileToDirectory(
  options: FileOptions & { out: string },
): Promise<FiledOutcome> {
  const { item, entry, ledger, dryRun, out, projectDirectory } = options;
  const at = options.now().toISOString();
  const write = async (path: string, body: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  };
  if (entry === undefined) {
    const path = join(out, `${item.id}.md`);
    const rendered = render(item, {
      id: item.id,
      ticketDirectory: out,
      frontMatter: true,
    });
    const ticket = projectRelative(projectDirectory, path);
    const outcome: FiledOutcome = {
      kind: "created",
      ticket,
      title: rendered.title,
      labels: item.labels,
    };
    if (dryRun) return outcome;
    await write(path, rendered.body);
    const next = fresh(item, "directory", ticket, rendered.digest, at);
    replaceEntry(ledger, entry, next);
    return outcome;
  }
  const existing = resolve(projectDirectory, entry.ticket);
  const rendered = render(item, {
    // The file keeps its name; its front matter id stays the filename's.
    id: basename(existing, ".md"),
    ticketDirectory: dirname(existing),
    frontMatter: true,
  });
  const changed = rendered.digest !== entry.bodyDigest;
  const outcome: FiledOutcome = {
    kind: changed ? "updated" : "unchanged",
    ticket: entry.ticket,
    title: rendered.title,
    labels: item.labels,
  };
  if (dryRun) return outcome;
  // CI may restore only the ledger. Recover the proposal at its recorded path
  // without treating a missing report as a new filing or resetting its history.
  if (changed || !(await exists(existing)))
    await write(existing, rendered.body);
  replaceEntry(
    ledger,
    entry,
    merged(entry, item, {
      bodyDigest: rendered.digest,
      ...(changed ? { updatedAt: at } : {}),
    }),
  );
  return outcome;
}

function identitiesFrom(source: string): FindingIdentities | undefined {
  try {
    const findings = parseFindingBlocks(source);
    if (findings.length === 0) return undefined;
    return {
      ids: unique(
        findings.flatMap((finding) => [
          finding.id,
          ...(finding.idAliases ?? []),
        ]),
      ),
      fingerprints: unique(findings.map((finding) => finding.fingerprint)),
    };
  } catch {
    // A ticket whose embedded records don't parse owns nothing provably.
    return undefined;
  }
}

async function recoverFromTracker(
  tracker: AutobuildTracker,
  label: string,
): Promise<Recovered[]> {
  return (await tracker.listLabelled(label)).flatMap((ticket) => {
    const identities = identitiesFrom(ticket.body);
    return identities === undefined
      ? []
      : [
          {
            ticket: ticket.ref.id,
            findingIds: identities.ids,
            fingerprints: identities.fingerprints,
          },
        ];
  });
}

async function recoverFromDirectory(
  projectDirectory: string,
  out: string,
): Promise<Recovered[]> {
  // The index reports physical paths; the ledger names them from the project.
  const root = await physicalPath(projectDirectory);
  return (await indexTickets([out])).flatMap((ticket) => {
    const identities =
      ticket.error === undefined ? identitiesFrom(ticket.source) : undefined;
    return identities === undefined
      ? []
      : [
          {
            ticket: projectRelative(root, ticket.path),
            findingIds: identities.ids,
            fingerprints: identities.fingerprints,
          },
        ];
  });
}
