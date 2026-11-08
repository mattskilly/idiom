import {
  type BisectDependencies,
  type BisectResult,
  bisectFinding,
} from "../attribution/bisect.js";

export type { BisectResult } from "../attribution/bisect.js";

/** `idiom bisect <finding>`; text lines stream through `write` unless `json`. */
export async function bisectCommand(options: {
  finding: string;
  project?: string | undefined;
  cwd?: string | undefined;
  json?: boolean | undefined;
  write?: ((line: string) => void) | undefined;
  dependencies?: BisectDependencies | undefined;
}): Promise<BisectResult> {
  return bisectFinding({
    finding: options.finding,
    project: options.project,
    cwd: options.cwd,
    onLine: options.json === true ? undefined : options.write,
    dependencies: options.dependencies,
  });
}
