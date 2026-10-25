import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readDecisionLog } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
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

function mergeRegistries(
  registries: Array<{ path: string; registry: FindingNameRegistry }>,
): FindingNameRegistry {
  const output: FindingNameEntry[] = [];
  for (const { path, registry } of registries) {
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
      if (matches.length > 1)
        throw new IdiomError(
          `conflicting finding-name registry ${path}: entry ${entry.name} joins unrelated existing entries`,
        );
      const match = matches[0];
      if (match === undefined) {
        output.push({ ...entry });
        continue;
      }
      if (match.name === entry.name && !identityOverlaps(match))
        throw new IdiomError(
          `conflicting finding-name registry ${path}: ${entry.name} is allocated to unrelated identities`,
        );
      if (match.name !== entry.name)
        throw new IdiomError(
          `conflicting finding-name registry ${path}: identity is named both ${match.name} and ${entry.name}`,
        );
      match.fingerprints = unique([
        ...match.fingerprints,
        ...entry.fingerprints,
      ]);
      match.legacyIds = unique([...match.legacyIds, ...entry.legacyIds]);
    }
  }
  return normalizedRegistry({
    version: 1,
    next: Math.max(1, ...registries.map(({ registry }) => registry.next)),
    entries: output,
  });
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

async function ticketObservations(root: string): Promise<Observation[]> {
  const observations: Observation[] = [];
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
      let findings: Finding[];
      try {
        findings = parseFindingBlocks(await readFile(path, "utf8"));
      } catch (error) {
        throw new IdiomError(
          `cannot parse tracker ticket ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
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
  return observations;
}

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

export async function loadFindingNames(options: {
  projectDirectory: string;
  additionalReportRoots?: readonly string[] | undefined;
  additionalTrackerRoots?: readonly string[] | undefined;
  gitTopology?: GitTopology | undefined;
}): Promise<FindingNamesState> {
  const projectDirectory = resolve(options.projectDirectory);
  const path = join(projectDirectory, ".idiom", "finding-names.json");
  const primary = await primaryFor(projectDirectory, options.gitTopology);
  const registryPaths = unique([
    path,
    ...(primary === undefined
      ? []
      : [join(primary, ".idiom", "finding-names.json")]),
  ]);
  const present: Array<{ path: string; registry: FindingNameRegistry }> = [];
  for (const candidate of registryPaths) {
    const registry = await readRegistry(candidate);
    if (registry !== undefined) present.push({ path: candidate, registry });
  }
  const merged = mergeRegistries(present);
  const lineages: BootstrapLineage[] = merged.entries.map((entry) => ({
    name: entry.name,
    fingerprints: [...entry.fingerprints],
    legacyIds: [...entry.legacyIds],
    sources: ["finding-name registry"],
  }));

  const roots = [projectDirectory, ...(primary === undefined ? [] : [primary])];
  for (const root of roots) {
    for (const [index, decision] of (await readDecisionLog(root)).entries()) {
      observe(lineages, {
        id: decision.findingId,
        aliases: [],
        fingerprint: decision.fingerprint,
        source: `${join(root, ".idiom", "decisions.jsonl")}:${index + 1}`,
      });
    }
  }
  const reportRoots = unique([
    ...roots.map((root) => join(root, ".idiom", "reports")),
    ...(options.additionalReportRoots ?? []).map((root) => resolve(root)),
  ]);
  for (const root of reportRoots)
    for (const observation of await reportObservations(root))
      observe(lineages, observation);
  const trackerRoots = unique([
    ...roots.map((root) => join(root, ".autobuild", "tickets")),
    ...(options.additionalTrackerRoots ?? []).map((root) => resolve(root)),
  ]);
  for (const root of trackerRoots)
    for (const observation of await ticketObservations(root))
      observe(lineages, observation);

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
  for (const lineage of lineages) {
    if (lineage.name !== undefined) continue;
    while (claimed.has(`finding-${next}`)) next += 1;
    lineage.name = `finding-${next}`;
    claimed.add(lineage.name);
    next += 1;
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
  return {
    projectDirectory,
    path,
    registry,
    changed:
      local === undefined || registryText(local) !== registryText(registry),
  };
}

export async function persistFindingNames(
  state: FindingNamesState,
): Promise<string> {
  if (!state.changed) return state.path;
  const registry = normalizedRegistry(state.registry);
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
  state.registry = registry;
  state.changed = false;
  return state.path;
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
