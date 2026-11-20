import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  assertCompleteRun,
  completeRunNames,
} from "../capture/run-lifecycle.js";
import { isSimpleRunId, resolveStoredRun } from "../review/artifacts.js";

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

/**
 * The stored runs a scan reads, newest first: complete runs with simple run
 * IDs. Any other folder under `.idiom/reports/` (hidden, hand-made, or an
 * unfinished run) is skipped, never validated as if the user had typed it.
 */
async function scannedRunIds(reports: string): Promise<string[]> {
  try {
    return (await completeRunNames(reports)).filter(isSimpleRunId);
  } catch {
    return [];
  }
}

/**
 * The run directories to read, newest first: exactly `from` when given (it
 * is validated and must be complete), else every scanned run.
 */
export async function runsToRead(
  projectDirectory: string,
  from: string | undefined,
): Promise<Array<{ runId: string; runDirectory: string }>> {
  if (from !== undefined) {
    const runDirectory = resolveStoredRun(projectDirectory, from);
    await assertCompleteRun(runDirectory);
    return [{ runId: from, runDirectory }];
  }
  const reports = join(projectDirectory, ".idiom", "reports");
  return (await scannedRunIds(reports)).map((runId) => ({
    runId,
    runDirectory: join(reports, runId),
  }));
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
 * reference. Folders under `.idiom/reports/` that are not complete runs with
 * simple run IDs are skipped; only an explicit `from` is validated. `accept`
 * may reject a run that captured the state (replay rejects runs with no
 * review evidence); the search then moves on to the next-newest run.
 */
export async function findStateCapture(options: {
  projectDirectory: string;
  flow: string;
  state: string;
  viewports: string[];
  colorScheme: string;
  from?: string | undefined;
  accept?:
    | ((runId: string, runDirectory: string) => Promise<boolean>)
    | undefined;
}): Promise<StateCapture | undefined> {
  runs: for (const { runId, runDirectory } of await runsToRead(
    options.projectDirectory,
    options.from,
  )) {
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
      if (
        options.accept !== undefined &&
        !(await options.accept(runId, runDirectory))
      )
        continue runs;
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

/**
 * The flow ids a stored run's capture tuples name, read from each tuple's
 * `metadata.json` (state → viewport → flat or colour-scheme tuple).
 */
export async function runCapturedFlows(
  runDirectory: string,
): Promise<Set<string>> {
  const flows = new Set<string>();
  for (const state of await directories(runDirectory))
    for (const viewport of await directories(join(runDirectory, state))) {
      const viewportDirectory = join(runDirectory, state, viewport);
      const tuples = (await exists(join(viewportDirectory, "dom.html")))
        ? [viewportDirectory]
        : (await directories(viewportDirectory)).map((scheme) =>
            join(viewportDirectory, scheme),
          );
      for (const tuple of tuples) {
        const flow = await capturedFlow(tuple);
        if (flow !== undefined) flows.add(flow);
      }
    }
  return flows;
}

/** One stored capture tuple with a screenshot, for screenshot matching. */
export type ListedStateCapture = StateCapture & {
  flow: string;
  state: string;
  colorScheme?: string | undefined;
  /** Absolute path of the tuple's screenshot. */
  screenshotPath: string;
};

/**
 * The newest complete capture with a screenshot of every (flow, state,
 * viewport, colour scheme) the current flows still declare, newest run
 * first. `flow` narrows to one flow; `from` reads exactly that run. Folders
 * that are not complete runs with simple run IDs are skipped.
 */
export async function listStateCaptures(options: {
  projectDirectory: string;
  /** Flow id → the state ids it declares. */
  declared: ReadonlyMap<string, ReadonlySet<string>>;
  flow?: string | undefined;
  from?: string | undefined;
}): Promise<ListedStateCapture[]> {
  const runs = await runsToRead(options.projectDirectory, options.from);
  const declaredStates = new Set(
    [...options.declared]
      .filter(([flow]) => options.flow === undefined || flow === options.flow)
      .flatMap(([, states]) => [...states]),
  );
  const seen = new Set<string>();
  const captures: ListedStateCapture[] = [];
  for (const { runId, runDirectory } of runs) {
    for (const state of await directories(runDirectory)) {
      if (!declaredStates.has(state)) continue;
      for (const viewport of await directories(join(runDirectory, state))) {
        const viewportDirectory = join(runDirectory, state, viewport);
        const tuples: Array<{ path: string; colorScheme?: string }> =
          (await exists(join(viewportDirectory, "dom.html")))
            ? [{ path: viewportDirectory }]
            : (await directories(viewportDirectory)).map((scheme) => ({
                path: join(viewportDirectory, scheme),
                colorScheme: scheme,
              }));
        for (const tuple of tuples) {
          const screenshotPath = join(tuple.path, "screenshot.png");
          if (
            !(await exists(join(tuple.path, "dom.html"))) ||
            !(await exists(screenshotPath))
          )
            continue;
          const flow = await capturedFlow(tuple.path);
          if (
            flow === undefined ||
            (options.flow !== undefined && flow !== options.flow) ||
            options.declared.get(flow)?.has(state) !== true
          )
            continue;
          const key = JSON.stringify([
            flow,
            state,
            viewport,
            tuple.colorScheme ?? null,
          ]);
          if (seen.has(key)) continue;
          seen.add(key);
          captures.push({
            runId,
            viewport,
            domPath: join(tuple.path, "dom.html"),
            screenshot: relative(runDirectory, screenshotPath),
            flow,
            state,
            ...(tuple.colorScheme === undefined
              ? {}
              : { colorScheme: tuple.colorScheme }),
            screenshotPath,
          });
        }
      }
    }
  }
  return captures;
}
