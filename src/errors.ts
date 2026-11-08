import { EXIT_CODES } from "./interface/version.js";

export class DecisionNeeded extends Error {}

export class DeferredCheck extends Error {}

export class IdiomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdiomError";
  }
}

/** Exit code for a run that could not happen; findings and other errors use 1. */
export const RUN_FAILURE_EXIT_CODE = EXIT_CODES["run-failure"];

export type RunFailureStage = "preflight" | "server" | "capture";

export type RunFailureJson = {
  stage: RunFailureStage;
  cause: string;
  hint: string;
  message: string;
  paths?: string[];
};

/**
 * A run that could not happen: a refused precondition, a server that never
 * became ready, or a capture that could not start. The headline is the one
 * line a wrapper script or CI log reads first.
 */
export class RunFailure extends IdiomError {
  readonly stage: RunFailureStage;
  readonly cause: string;
  readonly headline: string;
  readonly hint: string;
  readonly detail: string | undefined;
  readonly paths: string[] | undefined;

  constructor(options: {
    stage: RunFailureStage;
    cause: string;
    headline: string;
    hint: string;
    detail?: string | undefined;
    paths?: string[] | undefined;
  }) {
    super(
      options.detail === undefined || options.detail === ""
        ? options.headline
        : `${options.headline}\n${options.detail}`,
    );
    this.name = "RunFailure";
    this.stage = options.stage;
    this.cause = options.cause;
    this.headline = options.headline;
    this.hint = options.hint;
    this.detail = options.detail;
    this.paths = options.paths;
  }

  /** The same failure with more detail appended, keeping its type and fields. */
  withDetail(extra: string): RunFailure {
    return new RunFailure({
      stage: this.stage,
      cause: this.cause,
      headline: this.headline,
      hint: this.hint,
      detail: this.detail === undefined ? extra : `${this.detail}${extra}`,
      paths: this.paths,
    });
  }

  failureJson(): RunFailureJson {
    return {
      stage: this.stage,
      cause: this.cause,
      hint: this.hint,
      message: this.headline,
      ...(this.paths === undefined ? {} : { paths: this.paths }),
    };
  }
}
