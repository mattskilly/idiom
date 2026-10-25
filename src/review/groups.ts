import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type TupleCoordinate,
  tupleCoordinateKey,
} from "../baseline/coordinate.js";
import { IdiomError } from "../errors.js";
import type { Finding } from "../schemas/finding.js";
import type { FindingDraft } from "./findings.js";

/**
 * Repeated findings (#52): the same element failing the same rule in every
 * state, viewport and colour scheme is one thing to fix. Groups are a
 * presentation layer; fingerprints, ids and decisions stay per member.
 */

const coordinateSchema = z
  .object({
    state: z.string(),
    viewport: z.string(),
    colorScheme: z.enum(["light", "dark"]).optional(),
    combination: z.string().optional(),
  })
  .strict();

const memberSchema = z
  .object({
    id: z.string().min(1),
    fingerprint: z.string(),
    commit: z.string(),
    state: z.string(),
    colorScheme: z.enum(["light", "dark"]).optional(),
    severity: z.enum(["blocker", "major", "minor"]),
    status: z.string(),
    deferred: z.literal(true).optional(),
    coordinates: z.array(coordinateSchema),
  })
  .strict();

const groupSchema = z
  .object({
    id: z.string().regex(/^group-[0-9a-f]{12}$/),
    key: z.string().min(1),
    layer: z.enum(["deterministic", "model"]),
    category: z.string(),
    rule: z.string().optional(),
    severity: z.enum(["blocker", "major", "minor"]),
    representative: z.string().min(1),
    members: z.array(memberSchema).min(1),
    coordinates: z.array(coordinateSchema),
    states: z.array(z.string()),
    viewports: z.array(z.string()),
    colorSchemes: z.array(z.enum(["light", "dark"])),
    combinations: z.array(z.string()).optional(),
  })
  .strict();

export type GroupCoordinate = TupleCoordinate;
export type FindingGroupMember = z.infer<typeof memberSchema>;
export type FindingGroup = z.infer<typeof groupSchema>;

const severityOrder = { blocker: 0, major: 1, minor: 2 } as const;

function coordinateOf(finding: {
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  combination?: string | undefined;
}): TupleCoordinate {
  return {
    state: finding.state,
    viewport: finding.viewport,
    ...(finding.colorScheme === undefined
      ? {}
      : { colorScheme: finding.colorScheme }),
    ...(finding.combination === undefined
      ? {}
      : { combination: finding.combination }),
  };
}

function uniqueCoordinates(coordinates: TupleCoordinate[]): TupleCoordinate[] {
  const byKey = new Map<string, TupleCoordinate>();
  for (const coordinate of coordinates)
    byKey.set(tupleCoordinateKey(coordinate), coordinate);
  return [...byKey.values()].sort(
    (left, right) =>
      compare(left.state, right.state) ||
      compare(left.viewport, right.viewport) ||
      compare(left.colorScheme ?? "", right.colorScheme ?? "") ||
      compare(left.combination ?? "", right.combination ?? ""),
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Every coordinate a finding was seen in, keyed by fingerprint and alias.
 * Built from drafts before viewport dedupe, which keeps only the first.
 */
export function coordinateIndex(
  drafts: FindingDraft[],
): Map<string, TupleCoordinate[]> {
  const index = new Map<string, TupleCoordinate[]>();
  for (const draft of drafts) {
    const coordinate = coordinateOf(draft.finding);
    for (const identity of new Set([
      draft.finding.fingerprint,
      ...(draft.fingerprintAliases ?? []),
    ])) {
      const list = index.get(identity) ?? [];
      list.push(coordinate);
      index.set(identity, list);
    }
  }
  return index;
}

/** The member coordinates already recorded in a set of groups. */
export function memberCoordinates(
  groups: FindingGroup[],
): Map<string, TupleCoordinate[]> {
  const index = new Map<string, TupleCoordinate[]>();
  for (const group of groups)
    for (const member of group.members)
      index.set(member.fingerprint, member.coordinates);
  return index;
}

function groupId(key: string): string {
  const hex = /^[0-9a-f]{12,}$/.test(key)
    ? key
    : createHash("sha256").update(key).digest("hex");
  return `group-${hex.slice(0, 12)}`;
}

/**
 * Group findings by element and rule. Callers pass findings ranked
 * severity-first; the first member of a group is its representative.
 */
export function groupRepeatedFindings(
  findings: Finding[],
  coordinates: Map<string, TupleCoordinate[]>,
  deferredIds: ReadonlySet<string> = new Set(),
): FindingGroup[] {
  const buckets = new Map<string, { order: number; findings: Finding[] }>();
  for (const [order, finding] of findings.entries()) {
    const key = finding.groupKey ?? `fingerprint:${finding.fingerprint}`;
    const bucket = buckets.get(key) ?? { order, findings: [] };
    bucket.findings.push(finding);
    buckets.set(key, bucket);
  }
  const groups = [...buckets.entries()].map(([key, bucket]) => {
    const members: FindingGroupMember[] = bucket.findings.map((finding) => ({
      id: finding.id,
      fingerprint: finding.fingerprint,
      commit: finding.commit,
      state: finding.state,
      ...(finding.colorScheme === undefined
        ? {}
        : { colorScheme: finding.colorScheme }),
      severity: finding.severity,
      status: finding.status,
      ...(deferredIds.has(finding.id) ? { deferred: true as const } : {}),
      coordinates: uniqueCoordinates(
        coordinates.get(finding.fingerprint) ?? [coordinateOf(finding)],
      ),
    }));
    const all = uniqueCoordinates(
      members.flatMap((member) => member.coordinates),
    );
    const combinations = unique(
      all.flatMap((coordinate) =>
        coordinate.combination === undefined ? [] : [coordinate.combination],
      ),
    );
    const representative = bucket.findings[0] as Finding;
    const group: FindingGroup = {
      id: groupId(
        representative.groupKey ?? `fingerprint:${representative.fingerprint}`,
      ),
      key,
      layer: representative.layer,
      category: representative.category,
      ...(representative.rule === undefined
        ? {}
        : { rule: representative.rule }),
      severity: members.reduce<FindingGroupMember["severity"]>(
        (worst, member) =>
          severityOrder[member.severity] < severityOrder[worst]
            ? member.severity
            : worst,
        "minor",
      ),
      representative: representative.id,
      members,
      coordinates: all,
      states: unique(all.map((coordinate) => coordinate.state)),
      viewports: unique(all.map((coordinate) => coordinate.viewport)),
      colorSchemes: unique(
        all.flatMap((coordinate) =>
          coordinate.colorScheme === undefined ? [] : [coordinate.colorScheme],
        ),
      ),
      ...(combinations.length === 0 ? {} : { combinations }),
    };
    return { group, order: bucket.order };
  });
  return groups
    .sort(
      (left, right) =>
        severityOrder[left.group.severity] -
          severityOrder[right.group.severity] ||
        right.group.coordinates.length - left.group.coordinates.length ||
        left.order - right.order,
    )
    .map(({ group }) => group);
}

/** Whether a group is worth calling out as repeated. */
export function isRepeated(group: {
  members: unknown[];
  coordinates: unknown[];
}): boolean {
  return group.members.length > 1 || group.coordinates.length > 1;
}

/** "seen in 2 states; viewports: a, b; schemes: light, dark (8 coordinates)" */
export function describeSpread(group: {
  states: string[];
  viewports: string[];
  colorSchemes: string[];
  combinations?: string[] | undefined;
  coordinates: unknown[];
}): string {
  const states = group.states.length;
  return [
    `seen in ${states} ${states === 1 ? "state" : "states"}`,
    `viewports: ${group.viewports.join(", ")}`,
    ...(group.colorSchemes.length === 0
      ? []
      : [`schemes: ${group.colorSchemes.join(", ")}`]),
    ...(group.combinations === undefined || group.combinations.length === 0
      ? []
      : [`combinations: ${group.combinations.join(", ")}`]),
  ]
    .join("; ")
    .concat(
      ` (${group.coordinates.length} ${group.coordinates.length === 1 ? "coordinate" : "coordinates"})`,
    );
}

export async function writeGroups(
  runDirectory: string,
  groups: FindingGroup[],
): Promise<string> {
  const path = join(runDirectory, "groups.json");
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(groups, null, 2)}\n`);
  await rename(temporary, path);
  return path;
}

export async function readGroups(
  runDirectory: string,
): Promise<FindingGroup[] | undefined> {
  const path = join(runDirectory, "groups.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdiomError(
      `cannot read finding groups ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = z.array(groupSchema).safeParse(value);
  if (!parsed.success)
    throw new IdiomError(
      `invalid finding groups ${path}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}
