import { runSystem, type SystemRunDependencies } from "../system/run.js";

export async function systemCommand(options: {
  learn?: boolean | undefined;
  learnSource?: string | undefined;
  refreshDesign?: boolean | undefined;
  yes?: boolean | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  dependencies?: SystemRunDependencies | undefined;
}) {
  return runSystem(options);
}
