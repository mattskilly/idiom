import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { IdiomError } from "../errors.js";
import { scaleRulingText } from "../rulings/law.js";
import { lookupUnruledDecision } from "../rulings/lookup.js";
import { type RulingConfirmation, recordRuling } from "../rulings/record.js";
import { type RulingResolution, scaleTokenSchema } from "../schemas/ruling.js";
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
  const modes = [
    options.candidate !== undefined,
    options.wording !== undefined,
    options.noRule === true,
  ].filter(Boolean).length;
  const scaleModes = [options.addStep === true, options.drift === true].filter(
    Boolean,
  ).length;
  if (options.token !== undefined && options.addStep !== true)
    throw new IdiomError("--token is only used with --add-step");
  const generic = () =>
    new IdiomError(
      "provide exactly one of --candidate, --wording, or --no-rule",
    );
  // No mode at all is judged after lookup: a scale question names its own.
  if (scaleModes === 0 && modes > 1) throw generic();
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

  const recordedAt = (
    options.dependencies?.clock ?? (() => new Date())
  )().toISOString();
  const reason = options.reason?.trim() || undefined;
  const cluster = decision.scaleCluster;
  if (cluster !== undefined) {
    if (modes > 0 || scaleModes !== 1)
      throw new IdiomError(
        `scale question ${decision.id} takes --add-step or --drift`,
      );
    const scale =
      options.addStep === true
        ? {
            answer: "add-step" as const,
            property: cluster.property,
            value: cluster.value,
            context: cluster.context,
            token: (options.token ?? cluster.suggestedToken).trim(),
          }
        : {
            answer: "drift" as const,
            property: cluster.property,
            value: cluster.value,
            context: cluster.context,
          };
    if (
      scale.answer === "add-step" &&
      !scaleTokenSchema.safeParse(scale.token).success
    )
      throw new IdiomError(
        `--token ${JSON.stringify(scale.token)} must start with a letter or digit and use only letters, digits, '.', '_' or '-' (at most 64 characters)`,
      );
    const resolution: RulingResolution = {
      id: decision.id,
      fingerprint: decision.fingerprint,
      choiceKey: decision.choiceKey,
      outcome: scale.answer === "add-step" ? "rule" : "no-rule",
      ...(scale.answer === "add-step"
        ? { wording: scaleRulingText(scale) }
        : {}),
      ...(reason === undefined ? {} : { reason }),
      recordedAt,
      scale,
    };
    return recordRuling({
      designPath,
      displayPath: context.project.design.designFile,
      resolution,
      confirm: options.dependencies?.confirm ?? defaultConfirmation,
      write: options.write,
    });
  }
  if (scaleModes > 0)
    throw new IdiomError(
      `--add-step and --drift answer design-system questions; ${decision.id} is not one`,
    );
  if (modes !== 1) throw generic();

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
    recordedAt,
  };
  return recordRuling({
    designPath,
    displayPath: context.project.design.designFile,
    resolution,
    confirm: options.dependencies?.confirm ?? defaultConfirmation,
    write: options.write,
  });
}
