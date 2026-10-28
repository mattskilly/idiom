import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { selectColorSchemes, selectViewports } from "../capture/resolve.js";
import { loadReferenceContext } from "../critique/context.js";
import { IdiomError } from "../errors.js";
import { parseRulingBlocks } from "../rulings/law.js";
import { lookupUnruledDecision } from "../rulings/lookup.js";
import { explorationSteeringSchema } from "../schemas/exploration.js";
import { loadProjectContext, validateNamedFlow } from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";
import type { ExplorationContext } from "./types.js";

async function required(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot load ${label} for exploration from ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function explorationQuestionFingerprint(question: string): string {
  return createHash("sha256")
    .update(
      question.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(),
    )
    .digest("hex");
}

export async function loadExplorationContext(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow: string;
  state: string;
  question?: string | undefined;
  decision?: string | undefined;
  gitTopology?: GitTopology | undefined;
}): Promise<ExplorationContext> {
  const steering = explorationSteeringSchema.safeParse({
    ...(options.question === undefined ? {} : { question: options.question }),
    ...(options.decision === undefined ? {} : { decision: options.decision }),
  });
  if (!steering.success)
    throw new IdiomError(
      "provide exactly one of --question <text> or --decision <ruling-N>",
    );

  const context = await loadProjectContext(options);
  const record = await validateNamedFlow(context, options.flow);
  const state = record.flow.states.find(
    (candidate) => candidate.id === options.state,
  );
  if (state === undefined)
    throw new IdiomError(
      `unknown state ${JSON.stringify(options.state)} in flow ${JSON.stringify(options.flow)}`,
    );
  const designPath = join(
    context.projectDirectory,
    context.project.design.designFile,
  );
  const designMd = await required(designPath, "design guidance");
  const parsedLaw = parseRulingBlocks(designMd);
  const decision =
    steering.data.decision === undefined
      ? undefined
      : await lookupUnruledDecision({
          projectDirectory: context.projectDirectory,
          designPath,
          id: steering.data.decision,
          gitTopology: options.gitTopology,
        });
  if (decision?.scaleCluster !== undefined)
    throw new IdiomError(
      `${decision.id} is a design system question; answer it with idiom ruling --decision ${decision.id} --add-step or --drift`,
    );
  const question =
    decision?.question ?? (steering.data.question as string).trim();
  const viewports = selectViewports(context.project, record.flow);
  const schemes = selectColorSchemes(context.project, record.flow);
  return {
    projectDirectory: context.projectDirectory,
    project: context.project,
    flow: record.flow,
    state,
    question,
    ...(decision === undefined ? {} : { decision }),
    productMd: await required(
      join(context.projectDirectory, context.project.design.productFile),
      "product guidance",
    ),
    designMd,
    rulings: parsedLaw.resolutions,
    references: await loadReferenceContext(context.projectDirectory),
    tuples: viewports.flatMap((viewport) =>
      schemes.map((colorScheme) => ({
        state: state.id,
        viewport: viewport.name,
        colorScheme,
      })),
    ),
  };
}
