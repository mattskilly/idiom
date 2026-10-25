import type { CheckTuple } from "../checks/types.js";
import { buildCritiqueContext } from "../critique/context.js";
import { validateCritiqueResult } from "../critique/schema.js";
import type {
  CritiqueInput,
  CritiqueResult,
  ModelFindingCandidate,
  ScreenshotRef,
} from "../critique/types.js";
import type { Decision } from "../schemas/decision.js";
import type { Finding } from "../schemas/finding.js";
import type { Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import type { RuleOverride } from "../schemas/rules.js";
import type {
  DecisionObservation,
  RulingResolution,
} from "../schemas/ruling.js";
import { sweepCrops } from "./crops.js";
import { surfaceGeometry } from "./geometry.js";

/**
 * Model findings one surface may return. A sweep is uncapped overall, but a
 * per-surface allowance keeps one noisy surface from crowding out the rest.
 */
export const SWEEP_SURFACE_ALLOWANCE = 12;

export type SweepSurface = {
  state: string;
  status: "ok" | "failed";
  reason?: string | undefined;
  screenshots: string[];
  crops: string[];
  geometryRows: number;
  modelFindings: number;
};

export type SweepCritique = {
  findings: ModelFindingCandidate[];
  decisionObservations: DecisionObservation[];
  discardedDecisionObservations: number;
  screenshots: ScreenshotRef[];
  rulingResolutions: RulingResolution[];
  surfaces: SweepSurface[];
};

type SweepAdapter = {
  critique(
    input: CritiqueInput,
  ): Promise<CritiqueResult | ModelFindingCandidate[]>;
};

/**
 * Critique a flow one surface (state) at a time, each with zoomed crops, the
 * measured geometry and the design spec. A failing surface is recorded and
 * the sweep moves on, so one bad response does not discard the others.
 */
export async function sweepCritique(options: {
  projectDirectory: string;
  runDirectory: string;
  project: Project;
  flow: Flow;
  tuples: CheckTuple[];
  priorDecisions: Decision[];
  priorRules: RuleOverride[];
  deterministicFindings: Finding[];
  adapter: SweepAdapter;
  spec?: { file: string; content: string } | undefined;
  describeFailure: (error: unknown) => string;
}): Promise<SweepCritique> {
  const states = [...new Set(options.tuples.map((tuple) => tuple.state))];
  const result: SweepCritique = {
    findings: [],
    decisionObservations: [],
    discardedDecisionObservations: 0,
    screenshots: [],
    rulingResolutions: [],
    surfaces: [],
  };
  for (const state of states) {
    const tuples = options.tuples.filter((tuple) => tuple.state === state);
    const deterministicFindings = options.deterministicFindings.filter(
      (finding) => finding.state === state,
    );
    const context = await buildCritiqueContext({
      projectDirectory: options.projectDirectory,
      runDirectory: options.runDirectory,
      project: options.project,
      flow: options.flow,
      tuples,
      priorDecisions: options.priorDecisions,
      priorRules: options.priorRules,
      deterministicFindings,
      modelCandidateAllowance: SWEEP_SURFACE_ALLOWANCE,
    });
    result.screenshots.push(...context.screenshots);
    if (result.rulingResolutions.length === 0)
      result.rulingResolutions = context.rulingResolutions;
    const geometry = tuples.map(surfaceGeometry);
    const surface: SweepSurface = {
      state,
      status: "ok",
      screenshots: context.screenshots.map((screenshot) => screenshot.label),
      crops: [],
      geometryRows: geometry.reduce(
        (total, item) => total + item.rows.length,
        0,
      ),
      modelFindings: 0,
    };
    result.surfaces.push(surface);
    try {
      const crops = await sweepCrops({
        runDirectory: options.runDirectory,
        tuples,
        findings: deterministicFindings,
      });
      surface.crops = crops.map((crop) => crop.path);
      const input: CritiqueInput = {
        ...context,
        crops,
        geometry,
        ...(options.spec === undefined ? {} : { spec: options.spec }),
      };
      const critique = validateCritiqueResult({
        result: await options.adapter.critique(input),
        screenshots: context.screenshots,
        references: context.references,
        designMd: context.designMd,
        specAvailable: options.spec !== undefined,
      });
      surface.modelFindings = critique.findings.length;
      result.findings.push(...critique.findings);
      result.decisionObservations.push(...critique.decisionObservations);
      result.discardedDecisionObservations +=
        critique.discardedDecisionObservations;
    } catch (error) {
      surface.status = "failed";
      surface.reason = options.describeFailure(error);
    }
  }
  return result;
}
