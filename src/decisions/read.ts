import type { Decision } from "../schemas/decision.js";
import { readDecisionLog } from "./log.js";

export async function readDecisions(
  projectDirectory: string,
): Promise<Decision[]> {
  try {
    return await readDecisionLog(projectDirectory);
  } catch (error) {
    if (error instanceof Error)
      error.message = error.message.replace(
        /invalid decision log .*?decisions.jsonl at line (\d+): /,
        ".idiom/decisions.jsonl:$1: ",
      );
    throw error;
  }
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
