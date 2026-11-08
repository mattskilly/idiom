import type { ValidationResult } from "../validation.js";

/** Source belongs to the captured revision; all durable state belongs to the caller. */
export type CaptureExecutionContext = {
  sourceProjectDirectory: string;
  stateProjectDirectory: string;
  commit: string;
  validated: ValidationResult;
  signal: AbortSignal;
};
