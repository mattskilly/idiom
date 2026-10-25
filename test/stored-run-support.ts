import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { observePage } from "../src/checks/observe.js";
import { initProject } from "../src/commands/init.js";
import { fixture } from "./benchmark-support.js";

const run = promisify(execFile);

export type StoredState = {
  state: string;
  /** A benchmark fixture name, unless `content` supplies the page itself. */
  html: string;
  content?: string;
  /** Extra metadata `state` fields, such as a sibling declaration. */
  declares?: Record<string, string>;
};

/**
 * Write a stored capture of the benchmark fixtures for the studio-lab flow,
 * one tuple per state at the desktop viewport, the way capture lays it out.
 */
export async function storedRun(
  project: string,
  runId: string,
  commit: string,
  states: StoredState[] = [{ state: "editor", html: "before.html" }],
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const { state, html, content, declares } of states) {
      const tuple = join(project, ".idiom", "reports", runId, state, "desktop");
      await mkdir(tuple, { recursive: true });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      await page.setContent(content ?? (await fixture(html)));
      const observations = await observePage(page, {
        status: "not-configured",
      });
      await Promise.all([
        writeFile(
          join(tuple, "observations.json"),
          JSON.stringify(observations),
        ),
        writeFile(join(tuple, "screenshot.png"), await page.screenshot()),
        writeFile(join(tuple, "dom.html"), await page.content()),
        writeFile(join(tuple, "console.jsonl"), ""),
        writeFile(join(tuple, "axe.json"), JSON.stringify({ violations: [] })),
        writeFile(
          join(tuple, "metadata.json"),
          JSON.stringify({
            source: { commit, dirty: false },
            flow: { id: "studio-lab", title: "Studio" },
            state: { id: state, description: state, ...declares },
            viewport: {
              name: "desktop",
              width: 1440,
              height: 900,
              deviceScaleFactor: 2,
            },
            url: {
              kind: "literal",
              origin: "http://127.0.0.1:3100",
              url: `http://127.0.0.1:3100/lab/${state}`,
            },
            timestamps: {
              startedAt: "2026-10-22T12:00:00.000Z",
              endedAt: "2026-10-22T12:00:01.000Z",
            },
            status: 200,
            expectations: { passed: true, mismatches: [] },
            failure: null,
          }),
        ),
      ]);
      await page.close();
    }
    await writeFile(
      join(project, ".idiom", "reports", runId, "baseline.md"),
      `# Capture\n\nFlow \`studio-lab\`: ${states.length} passed, 0 failed, ${states.length} total.\n`,
    );
  } finally {
    await browser.close();
  }
}

async function commitAll(project: string, message: string): Promise<void> {
  await run("git", ["add", "-A"], { cwd: project });
  await run(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      message,
    ],
    { cwd: project },
  );
}

/** An initialised, committed project with a studio-lab flow of these states. */
export async function studioProject(
  directories: string[],
  states: string[] = ["editor"],
): Promise<{ project: string; commit: string }> {
  const project = await mkdtemp(join(tmpdir(), "idiom-studio-"));
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "studio-lab.json"),
    JSON.stringify({
      id: "studio-lab",
      title: "Studio",
      intent: ["Editor chrome"],
      setup: [],
      viewports: ["desktop"],
      states: states.map((state) => ({
        id: state,
        description: state,
        url: `/lab/${state}`,
        expect: { status: 200 },
      })),
    }),
  );
  await run("git", ["init", "-q"], { cwd: project });
  await writeFile(join(project, ".gitignore"), ".idiom/reports/\n");
  await commitAll(project, "init");
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: project });
  return { project, commit: stdout.trim() };
}
