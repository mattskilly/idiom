import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { IdiomError } from "../errors.js";
import { findStateCapture } from "../learn/capture.js";
import {
  collectMissEvidence,
  humanFoundLine,
  learnedRule,
  missStatuses,
  readLearnedLog,
  summarizeStatuses,
} from "../learn/misses.js";
import type { BrowserLaunch } from "../learn/target.js";
import { validateProject } from "../validation.js";
import { atomicWrite } from "./learn.js";

type ProjectOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
};

export async function learnListCommand(options: ProjectOptions) {
  const { projectDirectory } = await validateProject(options);
  const entries = await readLearnedLog(projectDirectory, { strict: true });
  const statuses = missStatuses(
    entries,
    await collectMissEvidence(projectDirectory, entries),
  );
  return { summary: summarizeStatuses(statuses), statuses };
}

export function renderLearnList(
  result: Awaited<ReturnType<typeof learnListCommand>>,
  now = new Date(),
): string {
  if (!result.summary)
    return 'No human-found misses logged yet (idiom learn "<observation>").';
  return [
    ...result.statuses.map((status) => {
      const { entry } = status;
      const label =
        status.status === "open"
          ? "open"
          : status.via === "mark"
            ? `covered by ${status.by} (marked ${status.at})`
            : `covered by ${status.rule} (run ${status.runId}, ${status.at})`;
      return `${entry.id}  ${label}  ${entry.flow}/${entry.state}  ${entry.kind}  ${JSON.stringify(entry.observation)}`;
    }),
    humanFoundLine(result.summary, now),
  ].join("\n");
}

export async function learnCoveredCommand(
  options: ProjectOptions & {
    id: string;
    by: string;
    clock?: (() => Date) | undefined;
  },
) {
  const by = options.by.trim();
  if (!by)
    throw new IdiomError("pass a nonblank --by <rule|fixture> with --covered");
  const { projectDirectory } = await validateProject(options);
  const entries = await readLearnedLog(projectDirectory, { strict: true });
  const path = join(projectDirectory, ".idiom", "learned.jsonl");
  const lines = (await readFile(path, "utf8")).split("\n");
  const lineId = (line: string): unknown => {
    try {
      return line.trim() === "" ? undefined : JSON.parse(line)?.id;
    } catch {
      return undefined;
    }
  };
  const entry = entries.find((entry) => entry.id === options.id);
  if (!entry) {
    if (lines.some((line) => lineId(line) === options.id))
      throw new IdiomError(
        `${options.id} was written by a newer Idiom; upgrade to mark it covered`,
      );
    throw new IdiomError(`unknown learned id ${options.id}`);
  }
  if (entry.covered)
    throw new IdiomError(
      `${entry.id} is already marked covered by ${entry.covered.by} (${entry.covered.at})`,
    );
  const index = lines.findIndex((line) => lineId(line) === entry.id);
  lines[index] = JSON.stringify({
    ...entry,
    covered: { by, at: (options.clock ?? (() => new Date()))().toISOString() },
  });
  await atomicWrite(path, lines.join("\n"));
  return { id: entry.id, by };
}

export async function learnFixtureCommand(
  options: ProjectOptions & {
    id: string;
    out: string;
    launch?: BrowserLaunch | undefined;
  },
) {
  const validated = await validateProject(options);
  const entries = await readLearnedLog(validated.projectDirectory, {
    strict: true,
  });
  const entry = entries.find((entry) => entry.id === options.id);
  if (!entry) throw new IdiomError(`unknown learned id ${options.id}`);
  const status = missStatuses(
    [entry],
    await collectMissEvidence(validated.projectDirectory, [entry]),
  )[0];
  if (status?.status === "covered")
    throw new IdiomError(
      `${entry.id} is covered by ${status.via === "mark" ? status.by : `${status.rule} (run ${status.runId})`}; fixtures require an open entry`,
    );
  const selector = entry.target.selector;
  if (!selector)
    throw new IdiomError(`${entry.id} names no element (no target selector)`);
  if (!options.out.trim())
    throw new IdiomError("pass --out <dir> for the fixture");
  const directory = join(
    resolve(options.cwd ?? process.cwd(), options.out),
    entry.id,
  );
  const paths = [
    join(directory, "snippet.html"),
    join(directory, "expectation.json"),
  ] as const;
  for (const path of [directory, ...paths]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info && (path !== directory || !info.isDirectory()))
      throw new IdiomError(`refusing to overwrite fixture path ${path}`);
  }
  const captureOptions = {
    projectDirectory: validated.projectDirectory,
    flow: entry.flow,
    state: entry.state,
    viewports: entry.capture
      ? [entry.capture.viewport]
      : validated.project.viewports.map((viewport) => viewport.name),
    colorScheme: validated.project.capture.colorScheme,
  };
  const capture =
    (entry.capture
      ? await findStateCapture({ ...captureOptions, from: entry.capture.runId })
      : undefined) ?? (await findStateCapture(captureOptions));
  if (!capture)
    throw new IdiomError(`no captured DOM for ${entry.flow}/${entry.state}`);
  const browser = await (
    options.launch ?? (() => chromium.launch({ headless: true }))
  )();
  let snippets: string[];
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    // Captured markup is data: exporting a fixture must not contact its URLs.
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(await readFile(capture.domPath, "utf8"), {
      waitUntil: "domcontentloaded",
    });
    snippets = await page.evaluate(
      (selector) =>
        [...document.querySelectorAll(selector)]
          .slice(0, 10)
          .map((element) => element.outerHTML),
      selector,
    );
  } finally {
    await browser.close();
  }
  if (snippets.length === 0)
    throw new IdiomError(
      `selector ${selector} matches no elements in run ${capture.runId}`,
    );
  const header =
    `idiom ${entry.id}: ${entry.flow}/${entry.state} @ ${capture.viewport}, run ${capture.runId}, selector ${selector}`.replaceAll(
      "--",
      "- -",
    );
  const expectation = {
    version: 1,
    learned: entry.id,
    flow: entry.flow,
    state: entry.state,
    viewport: capture.viewport,
    runId: capture.runId,
    kind: entry.kind,
    ...(learnedRule(entry) ? { rule: learnedRule(entry)?.check } : {}),
    selector,
    observation: entry.observation,
    expect: entry.entry,
    recordedAt: entry.recordedAt,
    snippet: "snippet.html",
  };
  await mkdir(directory, { recursive: true });
  // Recheck after mkdir so a pre-existing symlink cannot redirect writes.
  if (!(await lstat(directory)).isDirectory())
    throw new IdiomError(`fixture directory is not a directory: ${directory}`);
  const written: string[] = [];
  try {
    for (const [index, content] of [
      `<!-- ${header} -->\n${snippets.join("\n")}\n`,
      `${JSON.stringify(expectation, null, 2)}\n`,
    ].entries()) {
      const path = paths[index] as string;
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
      written.push(path);
    }
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw error;
  }
  return { paths };
}
