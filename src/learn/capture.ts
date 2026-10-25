import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveStoredRun } from "../review/artifacts.js";

export type StateCapture = {
  runId: string;
  viewport: string;
  /** Absolute path of the captured DOM. */
  domPath: string;
  /** Report-relative screenshot path, when one was captured. */
  screenshot?: string | undefined;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function capturedFlow(tuple: string): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(join(tuple, "metadata.json"), "utf8"),
    ) as { flow?: { id?: unknown } };
    return typeof metadata.flow?.id === "string" ? metadata.flow.id : undefined;
  } catch {
    return undefined;
  }
}

/** The tuple directory of one viewport: flat, or one per colour scheme. */
async function tupleDirectory(
  viewportDirectory: string,
  colorScheme: string,
): Promise<string | undefined> {
  if (await exists(join(viewportDirectory, "dom.html")))
    return viewportDirectory;
  const schemes = await directories(viewportDirectory);
  for (const scheme of [
    colorScheme,
    ...schemes.filter((s) => s !== colorScheme),
  ])
    if (await exists(join(viewportDirectory, scheme, "dom.html")))
      return join(viewportDirectory, scheme);
  return undefined;
}

/**
 * The newest stored capture of a flow state (or exactly `from`), preferring
 * the project's first viewport and its capture colour scheme. Learn reads the
 * DOM to resolve what the human named and records the run as the regression
 * reference.
 */
export async function findStateCapture(options: {
  projectDirectory: string;
  flow: string;
  state: string;
  viewports: string[];
  colorScheme: string;
  from?: string | undefined;
}): Promise<StateCapture | undefined> {
  const reports = join(options.projectDirectory, ".idiom", "reports");
  const runs =
    options.from === undefined
      ? (await directories(reports)).reverse()
      : [options.from];
  for (const runId of runs) {
    const runDirectory = resolveStoredRun(options.projectDirectory, runId);
    const stateDirectory = join(runDirectory, options.state);
    const present = await directories(stateDirectory);
    const ordered = [
      ...options.viewports.filter((viewport) => present.includes(viewport)),
      ...present.filter((viewport) => !options.viewports.includes(viewport)),
    ];
    for (const viewport of ordered) {
      const tuple = await tupleDirectory(
        join(stateDirectory, viewport),
        options.colorScheme,
      );
      if (tuple === undefined) continue;
      if ((await capturedFlow(tuple)) !== options.flow) continue;
      const screenshot = join(tuple, "screenshot.png");
      return {
        runId,
        viewport,
        domPath: join(tuple, "dom.html"),
        ...((await exists(screenshot))
          ? { screenshot: relative(runDirectory, screenshot) }
          : {}),
      };
    }
  }
  return undefined;
}
