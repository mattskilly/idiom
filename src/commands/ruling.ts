import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { rulingAnswer } from "../rulings/answer.js";
import { lookupUnruledDecision } from "../rulings/lookup.js";
import { type RulingConfirmation, recordRuling } from "../rulings/record.js";
import type { RulingResolution } from "../schemas/ruling.js";
import { loadProjectContext } from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";

export type { RulingConfirmation } from "../rulings/record.js";

export type RulingDependencies = {
  confirm?: RulingConfirmation | undefined;
  clock?: (() => Date) | undefined;
  gitTopology?: GitTopology | undefined;
};

async function defaultConfirmation(): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question("Record this ruling? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

export async function rulingCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  decision: string;
  candidate?: string | number | undefined;
  wording?: string | undefined;
  noRule?: boolean | undefined;
  /** Design-system questions: add the value as a step for its context. */
  addStep?: boolean | undefined;
  /** With addStep: the token name; defaults to the suggestion. */
  token?: string | undefined;
  /** Design-system questions: keep reporting the value as drift. */
  drift?: boolean | undefined;
  /** Recorded with the answer (MCP supplies one). */
  reason?: string | undefined;
  dependencies?: RulingDependencies | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<{
  recorded: boolean;
  path: string;
  resolution?: RulingResolution | undefined;
}> {
  const context = await loadProjectContext(options);
  const designPath = join(
    context.projectDirectory,
    context.project.design.designFile,
  );
  const decision = await lookupUnruledDecision({
    projectDirectory: context.projectDirectory,
    designPath,
    id: options.decision,
    gitTopology: options.dependencies?.gitTopology,
  });

  const recordedAt = (
    options.dependencies?.clock ?? (() => new Date())
  )().toISOString();
  const resolution = rulingAnswer(decision, options, recordedAt);
  return recordRuling({
    designPath,
    displayPath: context.project.design.designFile,
    resolution,
    confirm: options.dependencies?.confirm ?? defaultConfirmation,
    write: options.write,
  });
}
