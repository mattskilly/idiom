import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readDecisionLog } from "../decisions/log.js";
import { IdiomError, RunFailure } from "../errors.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import { mentionsToken } from "../tickets/mentions.js";
import { type GitTopology, primaryCheckout } from "../verify/baseline.js";
import { parseFindingBlocks } from "../verify/spec.js";

export const FINDING_NAME_PATTERN = /^finding-([1-9]\d*)$/;

export const findingNameEntrySchema = z
  .object({
    name: z
      .string()
      .regex(FINDING_NAME_PATTERN)
      .refine((value) => findingNameNumber(value) !== undefined, {
        message: "finding number must be a safe integer",
      }),
    fingerprints: z.array(z.string().trim().min(1)).min(1),
    legacyIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export const findingNameRegistrySchema = z
  .object({
    version: z.literal(1),
    next: z.number().int().positive(),
    entries: z.array(findingNameEntrySchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const names = new Map<string, number>();
    const identities = new Map<string, number>();
    let maximum = 0;
    for (const [entryIndex, entry] of registry.entries.entries()) {
      const sequence = findingNameNumber(entry.name);
      maximum = Math.max(maximum, sequence ?? 0);
      const priorName = names.get(entry.name);
      if (priorName !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryIndex, "name"],
          message: `duplicates entries.${priorName}.name`,
        });
      }
      names.set(entry.name, entryIndex);
      const local = new Set<string>();
      for (const [field, values] of [
        ["fingerprints", entry.fingerprints],
        ["legacyIds", entry.legacyIds],
      ] as const) {
        for (const [valueIndex, value] of values.entries()) {
          if (local.has(value)) {
            context.addIssue({
              code: "custom",
              path: ["entries", entryIndex, field, valueIndex],
              message: "must be unique within the entry",
            });
          }
          local.add(value);
          const prior = identities.get(value);
          if (prior !== undefined && prior !== entryIndex) {
            context.addIssue({
              code: "custom",
              path: ["entries", entryIndex, field, valueIndex],
              message: `is already owned by entries.${prior}`,
            });
          }
          identities.set(value, entryIndex);
          if (field === "legacyIds" && FINDING_NAME_PATTERN.test(value)) {
            context.addIssue({
              code: "custom",
              path: ["entries", entryIndex, field, valueIndex],
              message: "canonical finding names cannot be legacy aliases",
            });
          }
        }
      }
      if (local.has(entry.name)) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryIndex, "name"],
          message: "must not also appear in fingerprints or legacyIds",
        });
      }
      const nameOwner = identities.get(entry.name);
      if (nameOwner !== undefined && nameOwner !== entryIndex) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryIndex, "name"],
          message: `is already an identity owned by entries.${nameOwner}`,
        });
      }
      identities.set(entry.name, entryIndex);
    }
    if (registry.next <= maximum) {
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: `must be greater than every reserved finding number (${maximum})`,
      });
    }
  });

export type FindingNameEntry = z.infer<typeof findingNameEntrySchema>;
export type FindingNameRegistry = z.infer<typeof findingNameRegistrySchema>;

export type FindingNamesState = {
  projectDirectory: string;
  path: string;
  registry: FindingNameRegistry;
  changed: boolean;
  /**
   * Inherited (primary checkout) names skipped because they conflict with
   * this checkout's; `path` is the primary registry, or its `.idiom`
   * directory when only evidence conflicted.
   */
  divergence?: { path: string; skipped: number } | undefined;
  /** This checkout's tracker tickets whose embedded records don't parse. */
  malformedTickets: Array<{ path: string; error: string }>;
  /**
   * Names minted this run for lineages a malformed own ticket mentions; used
   * in memory but never persisted, since the unreadable block may claim a
   * different name.
   */
  provisional?: string[] | undefined;
};

type Observation = {
  id: string;
  aliases: string[];
  fingerprint: string;
  finding?: Finding | undefined;
  source: string;
};

type BootstrapLineage = {
  name?: string | undefined;
  fingerprints: string[];
  legacyIds: string[];
  finding?: Finding | undefined;
  sources: string[];
};

function issues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sorted(values: readonly string[]): string[] {
  return unique(values).sort((left, right) => left.localeCompare(right));
}

export function findingNameNumber(value: string): number | undefined {
  const match = FINDING_NAME_PATTERN.exec(value);
  if (match === null) return undefined;
  const valueNumber = Number(match[1]);
  return Number.isSafeInteger(valueNumber) ? valueNumber : undefined;
}

export function compareFindingNames(left: string, right: string): number {
  const leftNumber = findingNameNumber(left);
  const rightNumber = findingNameNumber(right);
  if (leftNumber !== undefined && rightNumber !== undefined)
    return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

function normalizedRegistry(
  registry: FindingNameRegistry,
): FindingNameRegistry {
  const entries = registry.entries
    .map((entry) => ({
      name: entry.name,
      fingerprints: sorted(entry.fingerprints),
      legacyIds: sorted(entry.legacyIds),
    }))
    .sort((left, right) => compareFindingNames(left.name, right.name));
  const maximum = Math.max(
    0,
    ...entries.map((entry) => findingNameNumber(entry.name) ?? 0),
  );
  return findingNameRegistrySchema.parse({
    version: 1,
    next: Math.max(registry.next, maximum + 1),
    entries,
  });
}

function registryText(registry: FindingNameRegistry): string {
  return `${JSON.stringify(normalizedRegistry(registry), null, 2)}\n`;
}

async function readRegistry(
  path: string,
): Promise<FindingNameRegistry | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdiomError(
      `cannot read finding-name registry ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new IdiomError(
      `invalid finding-name registry ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = findingNameRegistrySchema.safeParse(value);
  if (!parsed.success)
    throw new IdiomError(
      `invalid finding-name registry ${path}: ${issues(parsed.error)}`,
    );
  return normalizedRegistry(parsed.data);
}

function compatible(left: Finding, right: Finding): boolean {
  return (
    left.flow === right.flow &&
    left.state === right.state &&
    left.category === right.category &&
    left.rule === right.rule &&
    (left.colorScheme === undefined ||
      right.colorScheme === undefined ||
      left.colorScheme === right.colorScheme)
  );
}

type RegistryInput = {
  path: string;
  registry: FindingNameRegistry;
  /** Read from the primary checkout: merged only where it fits. */
  inherited: boolean;
};

function mergeRegistries(registries: RegistryInput[]): {
  registry: FindingNameRegistry;
  skipped: FindingNameEntry[];
} {
  const output: FindingNameEntry[] = [];
  const skipped: FindingNameEntry[] = [];
  for (const { path, registry, inherited } of registries) {
    for (const entry of registry.entries) {
      const identityOverlaps = (candidate: FindingNameEntry) =>
        candidate.fingerprints.some((value) =>
          entry.fingerprints.includes(value),
        ) ||
        candidate.legacyIds.some((value) => entry.legacyIds.includes(value));
      const matches = output.filter(
        (candidate) =>
          candidate.name === entry.name || identityOverlaps(candidate),
      );
      const match = matches[0];
      const conflict =
        matches.length > 1
          ? `entry ${entry.name} joins unrelated existing entries`
          : match === undefined
            ? undefined
            : match.name === entry.name && !identityOverlaps(match)
              ? `${entry.name} is allocated to unrelated identities`
              : match.name !== entry.name
                ? `identity is named both ${match.name} and ${entry.name}`
                : undefined;
      if (conflict !== undefined) {
        // The current checkout's names win; the primary's conflicting entry
        // sits this run out.
        if (inherited) {
          skipped.push(entry);
          continue;
        }
        throw new IdiomError(
          `conflicting finding-name registry ${path}: ${conflict}`,
        );
      }
      if (match === undefined) {
        output.push({ ...entry });
        continue;
      }
      match.fingerprints = unique([
        ...match.fingerprints,
        ...entry.fingerprints,
      ]);
      match.legacyIds = unique([...match.legacyIds, ...entry.legacyIds]);
    }
  }
  return {
    // `next` spans both files so a new local name never reuses a number the
    // primary already spent.
    registry: normalizedRegistry({
      version: 1,
      next: Math.max(1, ...registries.map(({ registry }) => registry.next)),
      entries: output,
    }),
    skipped,
  };
}

async function reportObservations(root: string): Promise<Observation[]> {
  let runs: Dirent[];
  try {
    runs = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IdiomError(`cannot enumerate finding-name evidence ${root}`);
  }
  const observations: Observation[] = [];
  for (const run of runs
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, run.name, "findings.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new IdiomError(`cannot read finding-name evidence ${path}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new IdiomError(
        `invalid finding-name evidence ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(value))
      throw new IdiomError(
        `invalid finding-name evidence ${path}: expected an array`,
      );
    for (const [index, item] of value.entries()) {
      const parsed = findingSchema.safeParse(item);
      if (!parsed.success)
        throw new IdiomError(
          `invalid finding-name evidence ${path}[${index}]: ${issues(parsed.error)}`,
        );
      observations.push({
        id: parsed.data.id,
        aliases: parsed.data.idAliases ?? [],
        fingerprint: parsed.data.fingerprint,
        finding: parsed.data,
        source: `${path}[${index}]`,
      });
    }
  }
  return observations;
}

const TICKET_STATES = ["triage", "ready", "doing", "done"] as const;

type MalformedTicketSource = { path: string; error: string; source: string };

/**
 * A ticket whose `idiom:finding` blocks don't parse is reported, not thrown:
 * it contributes no observations so unrelated lineages still resolve. Read
 * and enumeration failures stay fatal.
 */
async function ticketObservations(root: string): Promise<{
  observations: Observation[];
  malformed: MalformedTicketSource[];
}> {
  const observations: Observation[] = [];
  const malformed: MalformedTicketSource[] = [];
  for (const state of TICKET_STATES) {
    const directory = join(root, state);
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new IdiomError(
        `cannot enumerate finding-name evidence ${directory}`,
      );
    }
    for (const entry of entries
      .filter((item) => item.isFile() && item.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch (error) {
        throw new IdiomError(
          `cannot parse tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let findings: Finding[];
      try {
        findings = parseFindingBlocks(source);
      } catch (error) {
        malformed.push({
          path,
          error: `cannot parse tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
          source,
        });
        continue;
      }
      for (const [index, finding] of findings.entries())
        observations.push({
          id: finding.id,
          aliases: finding.idAliases ?? [],
          fingerprint: finding.fingerprint,
          finding,
          source: `${path}#${index + 1}`,
        });
    }
  }
  return { observations, malformed };
}

/**
 * Folds one record into the lineages. Every refusal happens before any
 * mutation, so a caller may catch it and skip the record safely — keep it so.
 */
function observe(lineages: BootstrapLineage[], observation: Observation): void {
  const identifiers = unique([observation.id, ...observation.aliases]);
  const matches = lineages.filter(
    (lineage) =>
      lineage.fingerprints.includes(observation.fingerprint) ||
      identifiers.some(
        (id) => lineage.name === id || lineage.legacyIds.includes(id),
      ),
  );
  if (matches.length > 1)
    throw new IdiomError(
      `conflicting finding identities at ${observation.source}: the record joins unrelated lineages`,
    );
  const canonicalClaims = identifiers.filter((id) =>
    FINDING_NAME_PATTERN.test(id),
  );
  if (canonicalClaims.length > 1)
    throw new IdiomError(
      `conflicting finding names at ${observation.source}: ${canonicalClaims.join(", ")}`,
    );
  const claim = canonicalClaims[0];
  const legacyIds = identifiers.filter((id) => !FINDING_NAME_PATTERN.test(id));
  const match = matches[0];
  if (match === undefined) {
    lineages.push({
      ...(claim === undefined ? {} : { name: claim }),
      fingerprints: [observation.fingerprint],
      legacyIds,
      finding: observation.finding,
      sources: [observation.source],
    });
    return;
  }
  if (claim !== undefined && match.name !== undefined && claim !== match.name)
    throw new IdiomError(
      `conflicting finding names at ${observation.source}: lineage is named both ${match.name} and ${claim}`,
    );
  if (
    match.finding !== undefined &&
    observation.finding !== undefined &&
    !compatible(match.finding, observation.finding)
  )
    throw new IdiomError(
      `incompatible finding identity at ${observation.source}; previously observed at ${match.sources[0]}`,
    );
  match.name ??= claim;
  match.fingerprints = unique([...match.fingerprints, observation.fingerprint]);
  match.legacyIds = unique([...match.legacyIds, ...legacyIds]);
  match.finding ??= observation.finding;
  match.sources.push(observation.source);
}

async function primaryFor(
  projectDirectory: string,
  gitTopology: GitTopology | undefined,
): Promise<string | undefined> {
  try {
    const value = await (gitTopology ?? primaryCheckout)(projectDirectory);
    if (value === undefined || resolve(value) === resolve(projectDirectory))
      return undefined;
    return resolve(value);
  } catch {
    return undefined;
  }
}

/**
 * An explicit override, else `findingNames.isolatedRegistry` from the
 * project config. Read raw so every catalog reader agrees without plumbing;
 * a missing or malformed config means "not isolated" (validation reports it).
 */
async function resolveIsolation(
  projectDirectory: string,
  override: boolean | undefined,
): Promise<boolean> {
  if (override !== undefined) return override;
  try {
    const value: unknown = JSON.parse(
      await readFile(join(projectDirectory, ".idiom", "project.json"), "utf8"),
    );
    const findingNames =
      typeof value === "object" && value !== null
        ? (value as { findingNames?: unknown }).findingNames
        : undefined;
    return (
      typeof findingNames === "object" &&
      findingNames !== null &&
      (findingNames as { isolatedRegistry?: unknown }).isolatedRegistry === true
    );
  } catch {
    return false;
  }
}

async function readRegistries(
  path: string,
  primary: string | undefined,
): Promise<{
  present: RegistryInput[];
  merged: FindingNameRegistry;
  skipped: FindingNameEntry[];
  primaryPath: string | undefined;
}> {
  const primaryPath =
    primary === undefined
      ? undefined
      : join(primary, ".idiom", "finding-names.json");
  const present: RegistryInput[] = [];
  for (const candidate of unique([
    path,
    ...(primaryPath === undefined ? [] : [primaryPath]),
  ])) {
    const registry = await readRegistry(candidate);
    if (registry !== undefined)
      present.push({
        path: candidate,
        registry,
        inherited: candidate !== path,
      });
  }
  const { registry: merged, skipped } = mergeRegistries(present);
  return { present, merged, skipped, primaryPath };
}

/**
 * Resolves finding names without persisting, run before any capture so a
 * corrupt registry or a conflict in this checkout's own evidence refuses the
 * run in seconds, not after it. Divergence from the primary is not a refusal.
 */
export async function preflightFindingNameRegistry(options: {
  projectDirectory: string;
  gitTopology?: GitTopology | undefined;
  isolatedRegistry?: boolean | undefined;
}): Promise<void> {
  const projectDirectory = resolve(options.projectDirectory);
  try {
    await loadFindingNames({
      projectDirectory,
      gitTopology: options.gitTopology,
      isolatedRegistry: options.isolatedRegistry,
    });
  } catch (error) {
    if (!(error instanceof IdiomError) || error instanceof RunFailure)
      throw error;
    const primary = (await resolveIsolation(
      projectDirectory,
      options.isolatedRegistry,
    ))
      ? undefined
      : await primaryFor(projectDirectory, options.gitTopology);
    const inherited =
      primary !== undefined && error.message.includes(join(primary, ".idiom"));
    throw new RunFailure({
      stage: "preflight",
      cause: "finding-name-registry",
      headline: `finding-name registry refused: ${error.message}`,
      hint: inherited
        ? `fix or restore the primary checkout's .idiom/finding-names.json, or pass --isolated-registry`
        : "fix or restore .idiom/finding-names.json (git checkout -- .idiom/finding-names.json) and rerun",
    });
  }
}

/** The one warning line for a divergent primary registry, if any. */
export function findingNameDivergenceWarning(
  state: Pick<FindingNamesState, "divergence">,
): string | undefined {
  const divergence = state.divergence;
  if (divergence === undefined || divergence.skipped === 0) return undefined;
  const entries = divergence.skipped === 1 ? "entry" : "entries";
  return `Warning: finding-name registry diverges from the primary checkout: skipped ${divergence.skipped} conflicting ${entries} from ${divergence.path}; this checkout's names win (pass --isolated-registry to ignore the primary's names)`;
}

function touches(observation: Observation, shadowed: Set<string>): boolean {
  return (
    shadowed.has(observation.fingerprint) ||
    shadowed.has(observation.id) ||
    observation.aliases.some((alias) => shadowed.has(alias))
  );
}

/**
 * Whether an inherited record would extend a named lineage only by claiming
 * its name, with no shared fingerprint or legacy id — a different finding
 * allocated the same number elsewhere.
 */
function claimsByNameOnly(
  lineages: readonly BootstrapLineage[],
  observation: Observation,
): boolean {
  const identifiers = [observation.id, ...observation.aliases];
  return lineages.some(
    (lineage) =>
      lineage.name !== undefined &&
      identifiers.includes(lineage.name) &&
      !lineage.fingerprints.includes(observation.fingerprint) &&
      !identifiers.some((id) => lineage.legacyIds.includes(id)),
  );
}

export async function loadFindingNames(options: {
  projectDirectory: string;
  additionalReportRoots?: readonly string[] | undefined;
  additionalTrackerRoots?: readonly string[] | undefined;
  gitTopology?: GitTopology | undefined;
  /** Ignore the primary checkout's names; defaults to the project config. */
  isolatedRegistry?: boolean | undefined;
}): Promise<FindingNamesState> {
  const projectDirectory = resolve(options.projectDirectory);
  const path = join(projectDirectory, ".idiom", "finding-names.json");
  const primary = (await resolveIsolation(
    projectDirectory,
    options.isolatedRegistry,
  ))
    ? undefined
    : await primaryFor(projectDirectory, options.gitTopology);
  const { present, merged, skipped, primaryPath } = await readRegistries(
    path,
    primary,
  );
  const lineages: BootstrapLineage[] = merged.entries.map((entry) => ({
    name: entry.name,
    fingerprints: [...entry.fingerprints],
    legacyIds: [...entry.legacyIds],
    sources: ["finding-name registry"],
  }));
  const shadowed = new Set(
    skipped.flatMap((entry) => [
      entry.name,
      ...entry.fingerprints,
      ...entry.legacyIds,
    ]),
  );

  const decisionObservations = async (root: string) =>
    (await readDecisionLog(root)).map(
      (decision, index): Observation => ({
        id: decision.findingId,
        aliases: [],
        fingerprint: decision.fingerprint,
        source: `${join(root, ".idiom", "decisions.jsonl")}:${index + 1}`,
      }),
    );
  const ownReports = join(projectDirectory, ".idiom", "reports");
  const ownTickets = join(projectDirectory, ".autobuild", "tickets");

  // This checkout's evidence first, and strictly: a conflict here cannot be
  // resolved. Inherited evidence follows so it never founds a lineage that a
  // local record then collides with.
  const ownTicketEvidence = await ticketObservations(ownTickets);
  for (const observation of [
    ...(await decisionObservations(projectDirectory)),
    ...(await reportObservations(ownReports)),
    ...ownTicketEvidence.observations,
  ])
    observe(lineages, observation);

  const inheritedReports = unique([
    ...(primary === undefined ? [] : [join(primary, ".idiom", "reports")]),
    ...(options.additionalReportRoots ?? []).map((root) => resolve(root)),
  ]).filter((root) => root !== ownReports);
  const inheritedTickets = unique([
    ...(primary === undefined ? [] : [join(primary, ".autobuild", "tickets")]),
    ...(options.additionalTrackerRoots ?? []).map((root) => resolve(root)),
  ]).filter((root) => root !== ownTickets);
  let skippedRecords = 0;
  const inherited: Observation[] = [
    ...(primary === undefined ? [] : await decisionObservations(primary)),
  ];
  for (const root of inheritedReports)
    inherited.push(...(await reportObservations(root)));
  for (const root of inheritedTickets) {
    const evidence = await ticketObservations(root);
    inherited.push(...evidence.observations);
    skippedRecords += evidence.malformed.length;
  }
  for (const observation of inherited) {
    if (
      touches(observation, shadowed) ||
      claimsByNameOnly(lineages, observation)
    ) {
      skippedRecords += 1;
      continue;
    }
    try {
      observe(lineages, observation);
    } catch (error) {
      if (!(error instanceof IdiomError)) throw error;
      skippedRecords += 1;
    }
  }

  const claimed = new Set(
    lineages.flatMap((lineage) =>
      lineage.name === undefined ? [] : [lineage.name],
    ),
  );
  let next = Math.max(
    merged.next,
    1,
    ...[...claimed].map((name) => (findingNameNumber(name) ?? 0) + 1),
  );
  const provisional = new Set<string>();
  for (const lineage of lineages) {
    if (lineage.name !== undefined) continue;
    while (claimed.has(`finding-${next}`)) next += 1;
    lineage.name = `finding-${next}`;
    claimed.add(lineage.name);
    next += 1;
    if (
      ownTicketEvidence.malformed.some((ticket) =>
        [...lineage.fingerprints, ...lineage.legacyIds].some((value) =>
          mentionsToken(ticket.source, value),
        ),
      )
    )
      provisional.add(lineage.name);
  }
  const registry = normalizedRegistry({
    version: 1,
    next,
    entries: lineages.map((lineage) => ({
      name: lineage.name as string,
      fingerprints: lineage.fingerprints,
      legacyIds: lineage.legacyIds,
    })),
  });
  const local = present.find((item) => item.path === path)?.registry;
  const divergent = skipped.length + skippedRecords;
  return {
    projectDirectory,
    path,
    registry,
    changed:
      local === undefined ||
      registryText(local) !==
        registryText(persistableRegistry(registry, provisional)),
    malformedTickets: ownTicketEvidence.malformed.map(({ path, error }) => ({
      path,
      error,
    })),
    ...(provisional.size === 0 ? {} : { provisional: [...provisional] }),
    ...(divergent === 0
      ? {}
      : {
          divergence: {
            path:
              skipped.length > 0 && primaryPath !== undefined
                ? primaryPath
                : primary === undefined
                  ? (inheritedReports[0] ?? inheritedTickets[0] ?? path)
                  : join(primary, ".idiom"),
            skipped: divergent,
          },
        }),
  };
}

export async function persistFindingNames(
  state: FindingNamesState,
): Promise<string> {
  if (!state.changed) return state.path;
  const registry = persistableRegistry(
    state.registry,
    new Set(state.provisional ?? []),
  );
  await mkdir(join(state.path, ".."), { recursive: true });
  const temporary = `${state.path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, registryText(registry), "utf8");
    await rename(temporary, state.path);
  } catch (error) {
    throw new IdiomError(
      `cannot persist finding-name registry ${state.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Provisional names stay in memory so this run's lookups still resolve.
  if (state.provisional === undefined || state.provisional.length === 0)
    state.registry = registry;
  state.changed = false;
  return state.path;
}

/** The registry minus names minted provisionally this run; `next` stays advanced. */
function persistableRegistry(
  registry: FindingNameRegistry,
  provisional: ReadonlySet<string>,
): FindingNameRegistry {
  return normalizedRegistry({
    ...registry,
    entries: registry.entries.filter((entry) => !provisional.has(entry.name)),
  });
}

function entryForIdentity(
  registry: FindingNameRegistry,
  ids: readonly string[],
  fingerprints: readonly string[],
): FindingNameEntry | undefined {
  const matches = registry.entries.filter(
    (entry) =>
      ids.some((id) => entry.name === id || entry.legacyIds.includes(id)) ||
      fingerprints.some((fingerprint) =>
        entry.fingerprints.includes(fingerprint),
      ),
  );
  if (matches.length > 1)
    throw new IdiomError(
      "finding identity resolves to multiple registry entries",
    );
  return matches[0];
}

export class FindingNamingSession {
  readonly state: FindingNamesState;

  constructor(state: FindingNamesState) {
    this.state = state;
  }

  name(
    finding: Finding,
    fingerprintAliases: readonly string[] = [],
    options: { preserveIdAsAlias?: boolean | undefined } = {},
  ): Finding {
    const sourceIds = [finding.id, ...(finding.idAliases ?? [])];
    const legacyIds = sourceIds.filter(
      (id) =>
        !FINDING_NAME_PATTERN.test(id) &&
        !/^draft(?:-|$)/.test(id) &&
        (options.preserveIdAsAlias !== false || id !== finding.id),
    );
    const fingerprints = unique([finding.fingerprint, ...fingerprintAliases]);
    let entry = entryForIdentity(this.state.registry, sourceIds, fingerprints);
    if (entry === undefined) {
      const name = `finding-${this.state.registry.next}`;
      this.state.registry.next += 1;
      entry = { name, fingerprints: [...fingerprints], legacyIds };
      this.state.registry.entries.push(entry);
      this.state.changed = true;
    } else {
      const nextFingerprints = unique([...entry.fingerprints, ...fingerprints]);
      const nextLegacyIds = unique([...entry.legacyIds, ...legacyIds]);
      if (
        nextFingerprints.length !== entry.fingerprints.length ||
        nextLegacyIds.length !== entry.legacyIds.length
      ) {
        entry.fingerprints = nextFingerprints;
        entry.legacyIds = nextLegacyIds;
        this.state.changed = true;
      }
    }
    return findingSchema.parse({
      ...finding,
      id: entry.name,
      ...(entry.legacyIds.length === 0 ? {} : { idAliases: entry.legacyIds }),
    });
  }
}

export function registryEntryForFinding(
  state: FindingNamesState,
  finding: Pick<Finding, "id" | "idAliases" | "fingerprint">,
): FindingNameEntry {
  const entry = entryForIdentity(
    state.registry,
    [finding.id, ...(finding.idAliases ?? [])],
    [finding.fingerprint],
  );
  if (entry === undefined)
    throw new IdiomError(
      `finding ${JSON.stringify(finding.id)} has no naming-registry entry`,
    );
  return entry;
}
