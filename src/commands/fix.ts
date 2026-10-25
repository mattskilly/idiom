import { type FixOptions, runFix } from "../fix/run.js";

export async function fixCommand(options: FixOptions) {
  return runFix(options);
}
