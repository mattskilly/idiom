import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IdiomError } from "../errors.js";
import type { UnruledDecision } from "../schemas/ruling.js";
import { type GitTopology, primaryCheckout } from "../verify/baseline.js";
import { readUnruledDecisions } from "./artifacts.js";
import { parseRulingBlocks } from "./law.js";

async function locate(
  projectDirectories: string[],
  id: string,
): Promise<UnruledDecision> {
  for (const projectDirectory of projectDirectories) {
    const reports = join(projectDirectory, ".idiom", "reports");
    let entries: Dirent<string>[];
    try {
      entries = (await readdir(reports, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => right.name.localeCompare(left.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw error;
    }
    for (const entry of entries) {
      try {
        const match = (
          await readUnruledDecisions(join(reports, entry.name))
        ).find((decision) => decision.id === id);
        if (match !== undefined) return match;
      } catch (error) {
        const path = join(reports, entry.name, "unruled-decisions.json");
        try {
          await readFile(path);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
        throw error;
      }
    }
  }
  throw new IdiomError(`unknown unruled decision ${JSON.stringify(id)}`);
}

export async function lookupUnruledDecision(options: {
  projectDirectory: string;
  designPath: string;
  id: string;
  gitTopology?: GitTopology | undefined;
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
  const law = parseRulingBlocks(await readFile(options.designPath, "utf8"));
  if (
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
