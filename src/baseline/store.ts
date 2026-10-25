import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IdiomError } from "../errors.js";
import type { Project } from "../schemas/project.js";
import { type TupleCoordinate, tupleCoordinateKey } from "./coordinate.js";
import {
  type BaselineFile,
  type BaselineRecord,
  baselineFileSchema,
} from "./schema.js";

export const MAX_RECORDS = 20;
export function baselineDirectory(
  projectDirectory: string,
  project: Project,
): string {
  return resolve(
    projectDirectory,
    project.baselines?.directory ?? ".idiom/baselines",
  );
}
export function baselinePath(directory: string, flow: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flow))
    throw new IdiomError(`invalid baseline flow: ${flow}`);
  return join(directory, `${flow}.json`);
}
/** Committed screenshots a published flow's pixel budget compares against. */
export function pixelBaselineDirectory(
  directory: string,
  flow: string,
): string {
  return join(dirname(baselinePath(directory, flow)), `${flow}.pixels`);
}
export function pixelBaselineName(coordinate: TupleCoordinate): string {
  const segments = [
    coordinate.state,
    coordinate.viewport,
    ...(coordinate.colorScheme === undefined ? [] : [coordinate.colorScheme]),
    ...(coordinate.combination === undefined
      ? []
      : [coordinate.combination.replace(/[^A-Za-z0-9._-]+/g, "-")]),
  ];
  for (const segment of segments) {
    if (
      segment === "" ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("..")
    )
      throw new IdiomError(
        `invalid pixel baseline segment: ${JSON.stringify(segment)}`,
      );
  }
  return `${segments.join("--")}.png`;
}
export function pixelBaselinePath(
  directory: string,
  flow: string,
  coordinate: TupleCoordinate,
): string {
  return join(
    pixelBaselineDirectory(directory, flow),
    pixelBaselineName(coordinate),
  );
}
export async function readBaselineFile(
  path: string,
): Promise<BaselineFile | undefined> {
  try {
    return baselineFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdiomError(
      `cannot read baseline ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function writeBaselineRecord(
  path: string,
  flow: string,
  record: BaselineRecord,
): Promise<{ replaced: boolean }> {
  const existing = await readBaselineFile(path);
  if (existing !== undefined && existing.flow !== flow)
    throw new IdiomError(
      `baseline ${path} belongs to flow ${existing.flow}, not ${flow}`,
    );
  const replaced =
    existing?.records.some((item) => item.commit === record.commit) ?? false;
  const sorted = {
    ...record,
    tuples: record.tuples
      .map((tuple) => ({
        ...tuple,
        findings: [...tuple.findings].sort((a, b) =>
          a.fingerprint.localeCompare(b.fingerprint),
        ),
      }))
      .sort((a, b) =>
        tupleCoordinateKey(a).localeCompare(tupleCoordinateKey(b)),
      ),
  };
  const file = baselineFileSchema.parse({
    version: 1,
    flow,
    records: [
      sorted,
      ...(existing?.records.filter((item) => item.commit !== record.commit) ??
        []),
    ].slice(0, MAX_RECORDS),
  });
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { replaced };
}
