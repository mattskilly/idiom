import type { DoctorDependencies, DoctorReport } from "../doctor/run.js";
import {
  inspectSurfaces,
  renderSurfaces,
  type SurfacesReport,
} from "../doctor/surfaces.js";
import { RunFailure, type RunFailureJson } from "../errors.js";
import { validateForRun } from "../preflight.js";
import { resolveProjectArgument } from "../project.js";
import { renderDoctorReport, runDoctor } from "./doctor.js";

export type InitValidateReport = {
  ready: boolean;
  validate:
    | {
        ok: true;
        projectDirectory: string;
        flows: { id: string; file: string }[];
      }
    | { ok: false; failure: RunFailureJson };
  /** Null when validation failed, so no flow was booted. */
  doctor: DoctorReport | null;
  /** Where Idiom is wired; present even when validation failed. */
  surfaces: SurfacesReport;
};

export type InitValidateProblem = {
  headline: string;
  hint: string;
  stage: RunFailureJson["stage"];
  cause: string;
};

const NO_FLOWS = ".idiom/flows: no flow manifests found";

/** The validate half of readiness, with setup-specific wording for the two first-run gaps. */
function validationFailure(
  error: RunFailure,
  project: string | undefined,
  cwd: string | undefined,
): RunFailureJson {
  const failure = error.failureJson();
  if (failure.cause === "no-project")
    return {
      ...failure,
      message: `Idiom is not initialized here (no .idiom/project.json in ${resolveProjectArgument(project, cwd)} or any parent directory)`,
      hint: "run idiom init",
    };
  if (failure.message.endsWith(NO_FLOWS))
    return {
      ...failure,
      hint: "generate a flow with idiom init --flows --yes, or author .idiom/flows/<id>.json",
    };
  return failure;
}

/**
 * Read-only readiness: validate every flow, then boot the first (or named)
 * flow's server once. Nothing is created.
 */
export async function initValidate(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  signal?: AbortSignal | undefined;
  dependencies?: DoctorDependencies | undefined;
}): Promise<InitValidateReport> {
  const surfaces = await inspectSurfaces({
    project: options.project,
    cwd: options.cwd,
    dependencies: options.dependencies?.surfaces,
  });
  let validated: Awaited<ReturnType<typeof validateForRun>>;
  try {
    validated = await validateForRun({
      project: options.project,
      cwd: options.cwd,
    });
  } catch (error) {
    if (!(error instanceof RunFailure)) throw error;
    return {
      ready: false,
      validate: {
        ok: false,
        failure: validationFailure(error, options.project, options.cwd),
      },
      doctor: null,
      surfaces,
    };
  }
  const flows = validated.flows.map(({ file, flow }) => ({
    id: flow.id,
    file,
  }));
  const flow = options.flow ?? flows[0]?.id;
  const doctor = await runDoctor({
    flow,
    project: options.project,
    cwd: options.cwd,
    signal: options.signal,
    surfaces: false,
    dependencies: options.dependencies,
  });
  return {
    ready: doctor.ok,
    validate: { ok: true, projectDirectory: validated.projectDirectory, flows },
    doctor,
    surfaces,
  };
}

/** The first thing standing between the project and ready, if anything. */
export function initValidateProblem(
  report: InitValidateReport,
): InitValidateProblem | undefined {
  if (report.ready) return undefined;
  const failure = report.validate.ok
    ? report.doctor?.failure
    : report.validate.failure;
  if (failure === undefined) return undefined;
  return {
    headline: `not ready: ${failure.message.replace(/^config invalid: /, "")}`,
    hint: failure.hint,
    stage: failure.stage,
    cause: failure.cause,
  };
}

/**
 * The stdout lines. A ready project ends with `ready`; otherwise the verdict
 * is the failure the CLI raises on stderr, so it is not printed twice.
 */
export function renderInitValidate(report: InitValidateReport): string[] {
  const lines = [
    report.validate.ok
      ? `validate: ${report.validate.flows.length} flow(s) valid (${report.validate.flows.map((flow) => flow.id).join(", ")})`
      : "validate: failed",
  ];
  if (report.doctor !== null)
    lines.push(...renderDoctorReport(report.doctor).trimEnd().split("\n"));
  lines.push("", ...renderSurfaces(report.surfaces));
  if (report.ready) lines.push("ready");
  return lines;
}
