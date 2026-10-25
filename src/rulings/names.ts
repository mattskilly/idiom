import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { IdiomError } from "../errors.js";
import type { UnruledDecision } from "../schemas/ruling.js";
import { type GitTopology, primaryCheckout } from "../verify/baseline.js";

export const rulingNameEntrySchema = z
  .object({
    name: z.string().regex(/^ruling-[1-9]\d*$/),
    fingerprint: z.string().trim().min(1),
  })
  .strict();

export const rulingNameRegistrySchema = z
  .object({
    version: z.literal(1),
    next: z.number().int().positive(),
    entries: z.array(rulingNameEntrySchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const names = new Map<string, number>();
    const fingerprints = new Map<string, number>();
    let maximum = 0;
    for (const [index, entry] of registry.entries.entries()) {
      const sequence = Number(entry.name.slice("ruling-".length));
      maximum = Math.max(maximum, sequence);
      for (const [field, value, owners] of [
        ["name", entry.name, names],
        ["fingerprint", entry.fingerprint, fingerprints],
      ] as const) {
        const prior = owners.get(value);
        if (prior !== undefined)
          context.addIssue({
            code: "custom",
            path: ["entries", index, field],
            message: `duplicates entries.${prior}.${field}`,
          });
        owners.set(value, index);
      }
    }
    if (registry.next <= maximum)
      context.addIssue({
        code: "custom",
        path: ["next"],
        message: `must be greater than every reserved ruling number (${maximum})`,
      });
  });

export type RulingNameRegistry = z.infer<typeof rulingNameRegistrySchema>;
export type RulingNameEntry = z.infer<typeof rulingNameEntrySchema>;
export type RulingNamesState = {
  path: string;
  registry: RulingNameRegistry;
  changed: boolean;
};

async function readRegistry(
  path: string,
): Promise<RulingNameRegistry | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdiomError(`cannot read ruling-name registry ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new IdiomError(
      `invalid ruling-name registry ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = rulingNameRegistrySchema.safeParse(value);
  if (!parsed.success)
    throw new IdiomError(
      `invalid ruling-name registry ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  return parsed.data;
}

function registryText(registry: RulingNameRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function merge(
  local: RulingNameRegistry | undefined,
  primary: RulingNameRegistry | undefined,
  primaryPath: string | undefined,
): RulingNameRegistry {
  const entries = [...(local?.entries ?? [])].map((entry) => ({ ...entry }));
  for (const entry of primary?.entries ?? []) {
    const byName = entries.find((candidate) => candidate.name === entry.name);
    const byFingerprint = entries.find(
      (candidate) => candidate.fingerprint === entry.fingerprint,
    );
    if (byName !== undefined && byName.fingerprint !== entry.fingerprint)
      throw new IdiomError(
        `conflicting ruling-name registry ${primaryPath}: ${entry.name} is allocated to unrelated fingerprints`,
      );
    if (byFingerprint !== undefined && byFingerprint.name !== entry.name)
      throw new IdiomError(
        `conflicting ruling-name registry ${primaryPath}: fingerprint is named both ${byFingerprint.name} and ${entry.name}`,
      );
    if (byName === undefined && byFingerprint === undefined)
      entries.push({ ...entry });
  }
  entries.sort(
    (left, right) => Number(left.name.slice(7)) - Number(right.name.slice(7)),
  );
  return rulingNameRegistrySchema.parse({
    version: 1,
    next: Math.max(local?.next ?? 1, primary?.next ?? 1),
    entries,
  });
}

export async function loadRulingNames(options: {
  projectDirectory: string;
  gitTopology?: GitTopology | undefined;
}): Promise<RulingNamesState> {
  const projectDirectory = resolve(options.projectDirectory);
  const path = join(projectDirectory, ".idiom", "ruling-names.json");
  let primaryDirectory: string | undefined;
  try {
    const candidate = await (options.gitTopology ?? primaryCheckout)(
      projectDirectory,
    );
    if (candidate !== undefined && resolve(candidate) !== projectDirectory)
      primaryDirectory = resolve(candidate);
  } catch {
    primaryDirectory = undefined;
  }
  const local = await readRegistry(path);
  const primaryPath =
    primaryDirectory === undefined
      ? undefined
      : join(primaryDirectory, ".idiom", "ruling-names.json");
  const registry = merge(
    local,
    primaryPath === undefined ? undefined : await readRegistry(primaryPath),
    primaryPath,
  );
  return {
    path,
    registry,
    changed:
      local === undefined || registryText(local) !== registryText(registry),
  };
}

export function nameUnruledDecisions(
  state: RulingNamesState,
  decisions: Array<Omit<UnruledDecision, "id">>,
): UnruledDecision[] {
  return decisions.map((decision) => {
    let entry = state.registry.entries.find(
      (candidate) => candidate.fingerprint === decision.fingerprint,
    );
    if (entry === undefined) {
      entry = {
        name: `ruling-${state.registry.next}`,
        fingerprint: decision.fingerprint,
      };
      state.registry.next += 1;
      state.registry.entries.push(entry);
      state.changed = true;
    }
    return { id: entry.name, ...decision };
  });
}

export function reserveRulingFingerprint(
  state: RulingNamesState,
  fingerprint: string,
): string {
  const normalized = fingerprint.trim();
  if (normalized === "")
    throw new IdiomError("ruling fingerprint must not be blank");
  let entry = state.registry.entries.find(
    (candidate) => candidate.fingerprint === normalized,
  );
  if (entry === undefined) {
    entry = { name: `ruling-${state.registry.next}`, fingerprint: normalized };
    state.registry.next += 1;
    state.registry.entries.push(entry);
    state.changed = true;
  }
  return entry.name;
}

export async function persistRulingNames(
  state: RulingNamesState,
): Promise<string> {
  if (!state.changed) return state.path;
  const registry = rulingNameRegistrySchema.parse(state.registry);
  await mkdir(join(state.path, ".."), { recursive: true });
  const temporary = `${state.path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, registryText(registry), "utf8");
  await rename(temporary, state.path);
  state.changed = false;
  return state.path;
}
