import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type FigmaRef, parseFigmaUrl } from "../design/figma/url.js";
import { IdiomError } from "../errors.js";
import { findProjectDirectory, resolveProjectArgument } from "../project.js";
import { writeHtmlFile } from "../report/html.js";
import type { OpenReportDependencies } from "../report/open.js";
import { launchHtmlFile } from "../report/open.js";
import { collectSystemPage, type SystemDependencies } from "./collect.js";
import { renderSystemPage } from "./html.js";
import {
  runSystemLearning,
  type SystemLearningDependencies,
  type SystemLearningResult,
} from "./learn/run.js";

export type SystemRunDependencies = SystemDependencies &
  OpenReportDependencies &
  SystemLearningDependencies;

export type SystemRunResult = {
  projectDirectory: string;
  reportPath: string;
  learning?: SystemLearningResult | undefined;
};

export async function runSystem(options: {
  learn?: boolean | undefined;
  /** `--learn <figma-file-url>`: learn tokens from the file's variables. */
  learnSource?: string | undefined;
  refreshDesign?: boolean | undefined;
  yes?: boolean | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  dependencies?: SystemRunDependencies | undefined;
  now?: (() => Date) | undefined;
}): Promise<SystemRunResult> {
  if (options.yes && !options.learn)
    throw new IdiomError("--yes requires --learn");
  const resolvedProject = await findProjectDirectory(
    resolveProjectArgument(options.project, options.cwd),
  );
  let figma: FigmaRef | undefined;
  if (options.learnSource !== undefined) {
    figma = parseFigmaUrl(options.learnSource);
    if (!figma)
      throw new IdiomError(
        `--learn takes a Figma file URL (https://www.figma.com/design/<file>/…); got ${JSON.stringify(options.learnSource)}`,
      );
  }
  const learning = options.learn
    ? await runSystemLearning(resolvedProject, {
        yes: options.yes,
        dependencies: options.dependencies,
        source: { figma, refresh: options.refreshDesign },
      })
    : undefined;
  const model = learning?.model ?? (await collectSystemPage(options));
  const reportsDirectory = join(resolvedProject, ".idiom", "reports");
  await mkdir(reportsDirectory, { recursive: true });
  const reportPath = await writeHtmlFile(
    reportsDirectory,
    "system.html",
    renderSystemPage(model),
  );
  await launchHtmlFile(reportPath, options.dependencies);
  return {
    projectDirectory: resolvedProject,
    reportPath,
    ...(learning === undefined ? {} : { learning }),
  };
}
