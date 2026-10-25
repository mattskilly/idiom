import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { IdiomError } from "../errors.js";
import { type Decision, decisionSchema } from "../schemas/decision.js";

export async function readDecisions(
  projectDirectory: string,
): Promise<Decision[]> {
  const path = join(projectDirectory, ".idiom", "decisions.jsonl");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IdiomError(
      `${relative(projectDirectory, path)}: could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const decisions: Decision[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new IdiomError(
        `.idiom/decisions.jsonl:${index + 1}: malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = decisionSchema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      throw new IdiomError(`.idiom/decisions.jsonl:${index + 1}: ${issues}`);
    }
    decisions.push(parsed.data);
  }
  return decisions;
}

export function standingRuleRejections(decisions: Decision[]): Decision[] {
  const standing = new Map<string, Decision>();
  for (const decision of decisions) {
    if (decision.scope === "rule") standing.set(decision.fingerprint, decision);
  }
  return [...standing.values()].filter(
    (decision) => decision.decision === "reject",
  );
}
