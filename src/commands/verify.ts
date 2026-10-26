import {
  runVerify,
  type VerifyDependencies,
  type VerifyRunResult,
} from "../verify/run.js";

export async function verifyCommand(options: {
  flow: string;
  spec: string;
  project?: string | undefined;
  cwd?: string | undefined;
  against?: string | undefined;
  out?: string | undefined;
  refreshDesign?: boolean | undefined;
  fullFlow?: boolean | undefined;
  dependencies?: VerifyDependencies | undefined;
}): Promise<VerifyRunResult> {
  return runVerify(options);
}
