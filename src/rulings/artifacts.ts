import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { IdiomError } from "../errors.js";
import {
  type UnruledDecision,
  unruledDecisionSchema,
} from "../schemas/ruling.js";

const artifactSchema = z.array(unruledDecisionSchema);

export async function writeUnruledDecisions(
  runDirectory: string,
  decisions: UnruledDecision[],
): Promise<string> {
  const parsed = artifactSchema.parse(decisions);
  const path = join(runDirectory, "unruled-decisions.json");
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return path;
}

export async function readUnruledDecisions(
  runDirectory: string,
): Promise<UnruledDecision[]> {
  const path = join(runDirectory, "unruled-decisions.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new IdiomError(
      `cannot read unruled decisions ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = artifactSchema.safeParse(value);
  if (!parsed.success)
    throw new IdiomError(
      `invalid unruled decisions ${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  return parsed.data;
}
