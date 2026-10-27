import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { BrowserLauncher, BrowserTuple } from "../src/capture/types.js";
import { run } from "../src/cli.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function cli(argv: string[], cwd?: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captures: BrowserTuple[] = [];
  const browserLauncher: BrowserLauncher = async () => ({
    version: "Mock Chromium",
    async capture(tuple) {
      captures.push(tuple);
      return {
        ok: true,
        status: 200,
        dom: "<!doctype html><html><body><h1>Page</h1></body></html>",
        screenshot: Buffer.from("page-png"),
        console: [],
        axe: { violations: [] },
        observations: {
          version: 1,
          viewport: {
            width: tuple.viewport.width,
            height: tuple.viewport.height,
          },
          document: {
            scrollWidth: tuple.viewport.width,
            scrollHeight: tuple.viewport.height,
            clientWidth: tuple.viewport.width,
            clientHeight: tuple.viewport.height,
          },
          elements: [],
          headings: [{ selector: "h1", level: 1, text: "Page" }],
          tokens: { status: "not-configured" },
        },
        mismatches: [],
        startedAt: "2026-10-23T12:00:00.000Z",
        endedAt: "2026-10-23T12:00:01.000Z",
      };
    },
    async close() {},
  });
  const code = await run(["node", "idiom", ...argv], {
    ...(cwd === undefined ? {} : { cwd }),
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    page: { capture: { browserLauncher } },
  });
  return {
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    captures,
  };
}

test.each([
  [[], "review needs a flow id, or --page <url>"],
  [["booking", "--page", "https://example.test/"], "not both"],
  [
    ["--page", "https://example.test/", "--from", "run-1"],
    "--from reviews a stored flow capture",
  ],
  [["--page", "https://example.test/", "--latest"], "--latest reviews"],
  [
    ["--page", "https://example.test/", "--since-baseline"],
    "--since-baseline reviews",
  ],
  [
    ["--page", "https://example.test/", "--fail-on", "minor"],
    "--fail-on gates new findings against a flow baseline",
  ],
  [["booking", "--brief", "brief.md"], "--brief requires --page <url>"],
  [["booking", "--focus", "jargon"], "--focus requires --page <url>"],
  [["booking", "--model", "m"], "--model requires --page <url>"],
  [
    ["--page", "https://example.test/", "--focus", "hierarchy,colour"],
    'unknown --focus area "colour"',
  ],
  [
    ["--page", "https://example.test/", "--max-findings", "0"],
    "--max-findings must be a positive integer",
  ],
])("review %j is rejected before any capture", async (argv, message) => {
  const result = await cli(["review", ...argv]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.captures).toEqual([]);
});

test("review --page captures the page at desktop and mobile, light only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-page-cli-"));
  directories.push(directory);
  const result = await cli(
    [
      "review",
      "--page",
      "https://example.test/landing",
      "--deterministic-only",
      "--focus",
      "hierarchy",
      "jargon",
      "--out",
      "report",
    ],
    directory,
  );
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(
    /^Page review https:\/\/example\.test\/landing: \d+ finding\(s\) — Markdown: .*report\.md — HTML: .*report\.html\n$/,
  );
  expect(
    result.captures.map((tuple) => [
      tuple.state.id,
      tuple.viewport.name,
      tuple.colorScheme,
    ]),
  ).toEqual([
    ["page-1", "desktop", "light"],
    ["page-1", "mobile", "light"],
  ]);
  // Page review stays a static capture; only quick review probes.
  expect(
    result.captures.some(
      (tuple) =>
        tuple.probe !== undefined ||
        tuple.probeSafety !== undefined ||
        tuple.probePageBudgetMs !== undefined,
    ),
  ).toBe(false);
});

test("review --page without a model warns that critique degraded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-page-cli-"));
  directories.push(directory);
  const result = await cli(
    ["review", "--page", "https://example.test/", "--json"],
    directory,
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).outcome.kind).toBe("degraded");
  expect(result.stderr).toContain(
    "Warning: Model critique degraded: no model configured",
  );
});
