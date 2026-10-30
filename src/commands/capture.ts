import { resolve } from "node:path";
import { type CaptureDependencies, runCapture } from "../capture/run.js";
import type { CaptureScope } from "../capture/scope.js";
import type { CaptureRunResult } from "../capture/types.js";
import { IdiomError } from "../errors.js";
import { validateProject } from "../validation.js";

export async function captureCommand(options: {
  flow: string;
  project?: string | undefined;
  out?: string | undefined;
  cwd?: string | undefined;
  prod?: boolean | undefined;
  scope?: CaptureScope | undefined;
  /** Serve the application on this port instead of a free one. */
  port?: number | undefined;
  /** Refetch pinned Figma frames. */
  refreshDesign?: boolean | undefined;
  dependencies?: CaptureDependencies | undefined;
}): Promise<CaptureRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const validated = await validateProject({
    project: options.project,
    flow: options.flow,
    cwd,
  });
  const record = validated.flows[0];
  if (record === undefined || record.flow.id !== options.flow) {
    throw new IdiomError(
      `requested flow ${JSON.stringify(options.flow)} does not match the manifest id ${JSON.stringify(record?.flow.id)}`,
    );
  }
  return await runCapture({
    projectDirectory: validated.projectDirectory,
    project: validated.project,
    flow: record.flow,
    out: options.out === undefined ? undefined : resolve(cwd, options.out),
    prod: options.prod,
    scope: options.scope,
    port: options.port,
    refreshDesign: options.refreshDesign,
    dependencies: options.dependencies,
  });
}
