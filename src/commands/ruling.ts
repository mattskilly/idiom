import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { IdiomError } from "../errors.js";
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
  dependencies?: RulingDependencies | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<{
  recorded: boolean;
  path: string;
  resolution?: RulingResolution | undefined;
}> {
  const modes = [
    options.candidate !== undefined,
    options.wording !== undefined,
    options.noRule === true,
  ].filter(Boolean).length;
  if (modes !== 1)
    throw new IdiomError(
      "provide exactly one of --candidate, --wording, or --no-rule",
    );
  if (options.wording !== undefined && options.wording.trim() === "")
    throw new IdiomError("--wording must not be blank");

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

  let wording: string | undefined;
  if (options.candidate !== undefined) {
    const index = Number(options.candidate);
    if (!Number.isSafeInteger(index) || index < 1)
      throw new IdiomError("--candidate must be a positive one-based index");
    wording = decision.candidates[index - 1]?.wording;
    if (wording === undefined)
      throw new IdiomError(
        `candidate ${index} does not exist for ${decision.id}`,
      );
  } else if (options.wording !== undefined) wording = options.wording.trim();

  const resolution: RulingResolution = {
    id: decision.id,
    fingerprint: decision.fingerprint,
    choiceKey: decision.choiceKey,
    outcome: options.noRule === true ? "no-rule" : "rule",
    ...(wording === undefined ? {} : { wording }),
    recordedAt: (
      options.dependencies?.clock ?? (() => new Date())
    )().toISOString(),
  };
  return recordRuling({
    designPath,
    displayPath: context.project.design.designFile,
    resolution,
    confirm: options.dependencies?.confirm ?? defaultConfirmation,
    write: options.write,
  });
}
