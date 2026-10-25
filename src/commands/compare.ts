import { runCompare } from "../compare/run.js";

export async function compareCommand(
  options: Parameters<typeof runCompare>[0],
) {
  return runCompare(options);
}
