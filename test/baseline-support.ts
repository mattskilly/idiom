import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import type { ExpectationMismatch } from "../src/capture/types.js";
import { observePage } from "../src/checks/observe.js";
import type { ObservationArtifact } from "../src/checks/types.js";
import { initProject } from "../src/commands/init.js";

const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}
export async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, "add", "-A");
  await git(
    cwd,
    "-c",
    "user.name=Baseline test",
    "-c",
    "user.email=baseline@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    message,
  );
  return await git(cwd, "rev-parse", "HEAD");
}
export async function baselineProject(
  options: {
    mobile?: boolean;
    schemes?: boolean;
    required?: string[];
    maxFindings?: number;
    states?: string[];
    viewports?: Array<{ name: string; width: number; height: number }>;
  } = {},
) {
  const project = await mkdtemp(join(tmpdir(), "idiom-baseline-"));
  await initProject({ project, yes: true });
  const configPath = join(project, ".idiom/project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.viewports = options.viewports ?? [
    { name: "desktop", width: 800, height: 600 },
    ...(options.mobile ? [{ name: "mobile", width: 390, height: 844 }] : []),
  ];
  if (options.schemes) config.colorSchemes = ["light", "dark"];
  config.model.maxFindings = options.maxFindings ?? 5;
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(project, ".idiom/flows/studio.json"),
    JSON.stringify({
      id: "studio",
      title: "Studio",
      intent: [],
      setup: [],
      states: (options.states ?? ["editor"]).map((id) => ({
        id,
        description: `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`,
        url: "/",
        expect: { selectorPresent: options.required ?? ["#required"] },
      })),
    }),
  );
  await git(project, "init", "-q", "-b", "main");
  return { project, configPath, commit: await commit(project, "initial") };
}
export const cleanHtml =
  '<!doctype html><html lang="en"><head><title>Studio</title><style>body{color:#182030;background:#fff;font:16px sans-serif;margin:32px}main{width:240px}</style></head><body><main><h1>Studio</h1><p id="required">Required content</p></main></body></html>';
export type StoredTuple = {
  viewport?: string;
  /** Required for viewports other than desktop/mobile. */
  size?: { width: number; height: number };
  scheme?: "light" | "dark";
  state?: string;
  html?: string;
  mismatches?: ExpectationMismatch[];
  failure?: { stage: string; message: string };
  dirty?: boolean;
  observations?: ObservationArtifact;
  combination?: {
    base: string;
    label: string;
    options: Record<string, string>;
    equivalent: string[];
  };
  layoutRepresentative?: string;
};
export async function storedBaselineRun(
  project: string,
  runId: string,
  sourceCommit: string,
  tuples: StoredTuple[] = [{}],
) {
  const runDirectory = join(project, ".idiom/reports", runId);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const tuple of tuples) {
      const viewport = tuple.viewport ?? "desktop";
      const size =
        tuple.size ??
        (viewport === "desktop"
          ? { width: 800, height: 600 }
          : { width: 390, height: 844 });
      const directory = join(
        runDirectory,
        tuple.state ?? "editor",
        viewport,
        ...(tuple.scheme === undefined ? [] : [tuple.scheme]),
      );
      await mkdir(directory, { recursive: true });
      const page = await browser.newPage({ viewport: size });
      await page.setContent(tuple.html ?? cleanHtml);
      const observations =
        tuple.observations ??
        (await observePage(page, { status: "not-configured" }));
      await Promise.all([
        writeFile(
          join(directory, "observations.json"),
          JSON.stringify(observations),
        ),
        writeFile(join(directory, "screenshot.png"), await page.screenshot()),
        writeFile(join(directory, "dom.html"), await page.content()),
        writeFile(join(directory, "console.jsonl"), ""),
        writeFile(
          join(directory, "axe.json"),
          JSON.stringify({ violations: [] }),
        ),
        writeFile(
          join(directory, "metadata.json"),
          JSON.stringify({
            source: { commit: sourceCommit, dirty: tuple.dirty ?? false },
            flow: { id: "studio" },
            state: { id: tuple.state ?? "editor" },
            viewport: { name: viewport, ...size },
            ...(tuple.scheme === undefined
              ? {}
              : { colorScheme: tuple.scheme, colorSchemeAxis: true }),
            ...(tuple.combination === undefined
              ? {}
              : { combination: tuple.combination }),
            ...(tuple.layoutRepresentative === undefined
              ? {}
              : { layoutRepresentative: tuple.layoutRepresentative }),
            timestamps: { startedAt: "2026-10-23T12:00:00.000Z" },
            status: 200,
            url: {
              kind: "literal",
              origin: "http://localhost:3100",
              url: "http://localhost:3100/",
            },
            expectations: { mismatches: tuple.mismatches ?? [] },
            failure: tuple.failure ?? null,
          }),
        ),
      ]);
      await page.close();
    }
    await writeFile(
      join(runDirectory, "baseline.md"),
      `# Capture\n\nFlow \`studio\`: ${tuples.length} passed, 0 failed, ${tuples.length} total.\n`,
    );
  } finally {
    await browser.close();
  }
  return runDirectory;
}
export const missing = (expected = "#required"): ExpectationMismatch => ({
  kind: "selector-present",
  expected,
});
