import { IdiomError } from "../errors.js";
import {
  type RulingResolution,
  scaleTokenSchema,
  type UnruledDecision,
} from "../schemas/ruling.js";
import { scaleRulingText } from "./law.js";
export type RulingAnswer = {
  candidate?: string | number | undefined;
  wording?: string | undefined;
  noRule?: boolean | undefined;
  addStep?: boolean | undefined;
  token?: string | undefined;
  drift?: boolean | undefined;
  reason?: string | undefined;
};
export function rulingAnswer(
  decision: UnruledDecision,
  options: RulingAnswer,
  recordedAt: string,
): RulingResolution {
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
    return resolution;
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
  return resolution;
}
