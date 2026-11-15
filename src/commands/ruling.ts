import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { IdiomError } from "../errors.js";
import { sentence } from "../learn/candidate.js";
import { fileDiff } from "../learn/diff.js";
import {
  compileLaw,
  lawConfigEdit,
  lawEditText,
  lawSummary,
} from "../learn/law.js";
import { rulingAnswer } from "../rulings/answer.js";
import { lookupUnruledDecision } from "../rulings/lookup.js";
import {
  type RulingConfirmation,
  type RulingExtraWrite,
  recordRuling,
} from "../rulings/record.js";
import { projectSchema } from "../schemas/project.js";
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
  /** The check the ruling's law configured, when its words state one. */
  compiled?: { check: string; scope?: string | undefined } | undefined;
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
  const compiled =
    resolution.outcome === "rule" &&
    resolution.scale === undefined &&
    resolution.wording !== undefined
      ? await compiledLaw(context.projectDirectory, resolution.wording)
      : undefined;
  const recorded = await recordRuling({
    designPath,
    displayPath: context.project.design.designFile,
    resolution,
    confirm: options.dependencies?.confirm ?? defaultConfirmation,
    write: options.write,
    ...(compiled === undefined
      ? {}
      : {
          preface: compiled.preface,
          extraWrites: compiled.write === undefined ? [] : [compiled.write],
        }),
  });
  return {
    ...recorded,
    ...(compiled === undefined || !recorded.recorded
      ? {}
      : { compiled: compiled.compiled }),
  };
}

/**
 * A ruling whose words state a measurable law also configures the check that
 * measures it. Only the fixed surface vocabulary applies here: a ruling has
 * no capture to resolve another surface from, so that law stays prose.
 */
async function compiledLaw(
  projectDirectory: string,
  wording: string,
): Promise<
  | {
      preface: string;
      write?: RulingExtraWrite | undefined;
      compiled: { check: string; scope?: string | undefined };
    }
  | undefined
> {
  const compilation = compileLaw(wording);
  if (compilation === undefined || !("law" in compilation)) return undefined;
  const { law } = compilation;
  if (law.scope !== undefined && law.scope.selector === undefined)
    return undefined;
  const path = join(projectDirectory, ".idiom", "project.json");
  const before = await readFile(path, "utf8");
  const value = JSON.parse(before) as Record<string, unknown>;
  const edit = lawConfigEdit(
    value,
    law,
    sentence(wording),
    law.scope?.selector,
  );
  const compiled = {
    check: edit.check,
    ...(edit.scope === undefined ? {} : { scope: edit.scope }),
  };
  const summary = lawSummary(law);
  if (edit.edit === undefined)
    return {
      preface: `${summary}\n${law.check} already enforces this as configured; .idiom/project.json is unchanged.`,
      compiled,
    };
  const parsed = projectSchema.safeParse(value);
  if (!parsed.success)
    throw new IdiomError(
      `the law would make .idiom/project.json invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`,
    );
  const after = lawEditText(before, edit.edit, value);
  return {
    preface: summary,
    write: {
      path,
      after,
      diff: fileDiff(".idiom/project.json", before, after),
    },
    compiled,
  };
}
