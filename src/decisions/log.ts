import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import { type Decision, decisionSchema } from "../schemas/decision.js";
import type { Finding } from "../schemas/finding.js";

export type DecisionViews = {
  byFindingId: Map<string, Decision>;
  byRuleFingerprint: Map<string, Decision>;
};

export function decisionLogPath(projectDirectory: string): string {
  return join(projectDirectory, ".idiom", "decisions.jsonl");
}

function parseLine(source: string, path: string, lineNumber: number): Decision {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new IdiomError(
      `invalid decision log ${path} at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new IdiomError(
      `invalid decision log ${path} at line ${lineNumber}: ${issues}`,
    );
  }
  return parsed.data;
}

export async function readDecisionLog(
  projectDirectory: string,
): Promise<Decision[]> {
  const path = decisionLogPath(projectDirectory);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IdiomError(
      `cannot read decision log ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const records: Decision[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    records.push(parseLine(line, path, index + 1));
  }
  return records;
}

export function decisionViews(decisions: readonly Decision[]): DecisionViews {
  const byFindingId = new Map<string, Decision>();
  const byRuleFingerprint = new Map<string, Decision>();
  for (const decision of decisions) {
    byFindingId.set(decision.findingId, decision);
    if (decision.scope === "rule")
      byRuleFingerprint.set(decision.fingerprint, decision);
  }
  return { byFindingId, byRuleFingerprint };
}

export function isFingerprintSuppressed(
  fingerprint: string,
  views: DecisionViews,
): boolean {
  return views.byRuleFingerprint.get(fingerprint)?.decision === "reject";
}

export async function appendDecision(options: {
  projectDirectory: string;
  finding: Pick<Finding, "id" | "fingerprint" | "commit">;
  decision: "accept" | "reject";
  scope: "instance" | "rule";
  reason?: string | undefined;
  now?: (() => Date) | undefined;
}): Promise<{ path: string; record: Decision }> {
  // Validate the complete existing boundary before extending it.
  await readDecisionLog(options.projectDirectory);
  const path = decisionLogPath(options.projectDirectory);
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new IdiomError(
        `cannot read decision log ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const record = decisionSchema.parse({
    at: (options.now?.() ?? new Date()).toISOString(),
    commit: options.finding.commit,
    findingId: options.finding.id,
    fingerprint: options.finding.fingerprint,
    decision: options.decision,
    scope: options.scope,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    actor: "human",
  });
  const prefix = source.length > 0 && !source.endsWith("\n") ? "\n" : "";
  try {
    await appendFile(path, `${prefix}${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot append decision log ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path, record };
}
