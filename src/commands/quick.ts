import {
  type QuickDependencies,
  type QuickRunResult,
  runQuick,
} from "../quick/run.js";

export async function quickCommand(options: {
  urls: string[];
  design?: string | undefined;
  probe?: boolean | undefined;
  probeBudgetMs?: string | number | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  out?: string | undefined;
  dependencies?: QuickDependencies | undefined;
}): Promise<QuickRunResult> {
  return await runQuick(options);
}
