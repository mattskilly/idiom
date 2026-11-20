import type { LockOptions } from "../baseline/lock.js";
import { IdiomError } from "../errors.js";
import { readEscalationAnswers } from "../escalations/log.js";
import {
  newestFirst,
  renderEscalationHistory,
  renderEscalationPass,
} from "../escalations/render.js";
import { type EscalationPass, runEscalationPass } from "../escalations/run.js";
import type { Exec } from "../learn/harvest-sources.js";
import type { EscalationAnswer } from "../schemas/escalation-answer.js";
import { validateProjectConfiguration } from "../validation.js";

export type EscalationsDependencies = {
  environment?: NodeJS.ProcessEnv | undefined;
  exec?: Exec | undefined;
  now?: (() => Date) | undefined;
  lock?: Partial<LockOptions> | undefined;
};

export type EscalationsResult =
  | { kind: "history"; history: EscalationAnswer[]; text: string }
  | { kind: "pass"; pass: EscalationPass; text: string; warnings: string[] };

/**
 * `idiom escalations`: list the repository's open autobuild escalations,
 * find the precedent that settles each design question, and with `--answer`
 * answer the settled ones through `ab answer`. `--history` lists what Idiom
 * answered.
 */
export async function escalationsCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  answer?: boolean | undefined;
  history?: boolean | undefined;
  dependencies?: EscalationsDependencies | undefined;
}): Promise<EscalationsResult> {
  if (options.answer && options.history)
    throw new IdiomError("--history cannot be combined with --answer");
  const dependencies = options.dependencies ?? {};
  const { projectDirectory, project } = await validateProjectConfiguration({
    project: options.project,
    cwd: options.cwd,
  });
  if (options.history) {
    const history = newestFirst(await readEscalationAnswers(projectDirectory));
    return { kind: "history", history, text: renderEscalationHistory(history) };
  }
  const answer = options.answer === true;
  const pass = await runEscalationPass({
    projectDirectory,
    stateProjectDirectory: projectDirectory,
    designFile: project.design.designFile,
    answer,
    environment: dependencies.environment ?? process.env,
    exec: dependencies.exec,
    now: dependencies.now,
    lock: dependencies.lock,
  });
  if (pass.status === "unavailable")
    throw new IdiomError(
      `idiom escalations needs the autobuild CLI (ab) on PATH: ${pass.reason}`,
    );
  return {
    kind: "pass",
    pass,
    text: renderEscalationPass(pass, { answer }),
    warnings: pass.warnings,
  };
}
