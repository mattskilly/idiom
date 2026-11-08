import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isCompleteRun } from "../capture/run-lifecycle.js";
import { IdiomError } from "../errors.js";
import type { UnruledDecision } from "../schemas/ruling.js";
import { type GitTopology, primaryCheckout } from "../verify/baseline.js";
import { readUnruledDecisions } from "./artifacts.js";
import { readEffectiveLaw } from "./effective.js";

async function locate(
  projectDirectories: string[],
  id: string,
): Promise<UnruledDecision> {
  const runs = new Map<string, string>();
  for (const projectDirectory of projectDirectories) {
    const reports = join(projectDirectory, ".idiom", "reports");
    let entries: Dirent<string>[];
    try {
      entries = await readdir(reports, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        !runs.has(entry.name) &&
        (await isCompleteRun(join(reports, entry.name)))
      )
        runs.set(entry.name, join(reports, entry.name));
  }
  for (const [, directory] of [...runs].sort(([a], [b]) =>
    b.localeCompare(a),
  )) {
    try {
      await readFile(join(directory, "unruled-decisions.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const match = (await readUnruledDecisions(directory)).find(
      (decision) => decision.id === id,
    );
    if (match) return match;
  }
  throw new IdiomError(`unknown unruled decision ${JSON.stringify(id)}`);
}

export async function lookupUnruledDecision(options: {
  projectDirectory: string;
  designPath: string;
  id: string;
  gitTopology?: GitTopology | undefined;
  allowResolved?: boolean | undefined;
}): Promise<UnruledDecision> {
  let primary: string | undefined;
  try {
    const candidate = await (options.gitTopology ?? primaryCheckout)(
      options.projectDirectory,
    );
    if (
      candidate !== undefined &&
      resolve(candidate) !== resolve(options.projectDirectory)
    )
      primary = resolve(candidate);
  } catch {
    primary = undefined;
  }
  const decision = await locate(
    [options.projectDirectory, ...(primary === undefined ? [] : [primary])],
    options.id,
  );
  const law = await readEffectiveLaw(
    options.designPath,
    options.projectDirectory,
  );
  if (
    !options.allowResolved &&
    law.resolutions.some(
      (resolution) =>
        resolution.id === decision.id ||
        resolution.fingerprint === decision.fingerprint,
    )
  )
    throw new IdiomError(
      `ruling ${decision.id} has already been recorded in the design law`,
    );
  return decision;
}
