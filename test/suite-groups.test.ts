import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { glob } from "tinyglobby";
import { expect, test } from "vitest";
import config, { suiteConfig } from "../vitest.config.js";
import { resourceScanner } from "./support/suite-dependencies.js";
import {
  heavyForks,
  injectedResources,
  suiteExclude,
  suiteFor,
  suiteInclude,
  unitFiles,
} from "./support/suite-groups.js";

const root = resolve(import.meta.dirname, "..");

test("every discovered test selects exactly one project; new files start bounded", async () => {
  const all = await glob(suiteInclude, {
    cwd: root,
    ignore: suiteExclude,
    dot: true,
    expandDirectories: false,
  });
  expect(new Set(unitFiles).size).toBe(unitFiles.length);
  expect(unitFiles.filter((file) => !all.includes(file))).toEqual([]);
  expect(config.test).toEqual(suiteConfig.test);
  const projects = suiteConfig.test.projects;
  const selections = await Promise.all(
    projects.map((project) =>
      glob(project.test.include, {
        cwd: root,
        ignore: project.test.exclude,
        dot: true,
        expandDirectories: false,
      }),
    ),
  );
  expect(selections.flat().sort()).toEqual(all.sort());
  expect(new Set(selections.flat()).size).toBe(all.length);
  expect(suiteFor("test/new-browser.test.ts")).toBe("heavy");
  expect(suiteFor("test/capture.test.ts")).toBe("heavy");
  expect(suiteFor("test/sweep-all-browser.test.ts")).toBe("heavy");
  expect(suiteFor("test/capture-deadline.test.ts")).toBe("unit");
  // The config uses these same selectors, including the default discovery
  // universe and linked-worktree exclusion, rather than a second test tree.
  expect(projects.map((project) => project.test.name)).toEqual([
    "unit",
    "heavy",
  ]);
  expect(projects.map((project) => project.test.pool)).toEqual([
    "threads",
    "forks",
  ]);
  expect(suiteConfig.test).not.toHaveProperty("maxWorkers");
  expect(suiteConfig.test.poolOptions.forks).toEqual({
    minForks: 1,
    maxForks: heavyForks(availableParallelism()),
  });
  expect([2, 4, 8, 11, 64].map(heavyForks)).toEqual([2, 2, 4, 4, 4]);
  expect(suiteConfig.test.poolOptions).not.toHaveProperty("threads");
  for (const project of projects) {
    expect(project.test.environment).toBe("node");
    expect(project.test.testTimeout).toBe(30_000);
    expect(project.test.hookTimeout).toBe(60_000);
    expect(project.test).not.toHaveProperty("isolate", false);
    expect(project.test.exclude).toContain("**/.autobuild/**");
    expect(project.test.setupFiles).toEqual([
      "./test/support/signal-guard-setup.ts",
    ]);
  }
  expect(suiteConfig.test.globalSetup).toEqual([
    "./test/support/signal-guard-global.ts",
  ]);
});

test("reviewed unit files cannot acquire real browser, server or process dependencies", () => {
  const scan = resourceScanner(root);
  const violations: Array<{ test: string; file: string; resource: string }> =
    [];
  const used = new Set<string>();
  const exceptionKey = (entry: {
    test: string;
    file: string;
    resource: string;
  }) => `${entry.test}:${entry.file}:${entry.resource}`;
  expect(new Set(injectedResources.map(exceptionKey)).size).toBe(
    injectedResources.length,
  );
  for (const file of unitFiles) {
    for (const resource of scan(file)) {
      const exception = injectedResources.find(
        (entry) =>
          entry.test === file &&
          entry.file === resource.file &&
          entry.resource === resource.resource,
      );
      if (exception) {
        used.add(exceptionKey(exception));
        expect(exception.reason.length).toBeGreaterThan(20);
      } else violations.push({ test: file, ...resource });
    }
  }
  expect(violations).toEqual([]);
  expect(
    injectedResources.filter((entry) => !used.has(exceptionKey(entry))),
  ).toEqual([]);
});

function uses(files: Record<string, string>) {
  return resourceScanner("/repo", (file) => files[file])("test/new.test.ts");
}

test.each([
  [
    "a direct browser import",
    {
      "/repo/test/new.test.ts":
        'import { chromium } from "playwright"; chromium.launch();',
    },
  ],
  [
    "an indirect helper launch with .js resolution",
    {
      "/repo/test/new.test.ts":
        'import { launch } from "./helper.js"; launch();',
      "/repo/test/helper.ts":
        'import { chromium } from "playwright"; export const launch = () => chromium.launch();',
    },
  ],
  [
    "a dynamic runtime import",
    {
      "/repo/test/new.test.ts":
        'const { chromium } = await import("playwright"); await chromium.launch();',
    },
  ],
  [
    "a runtime require",
    {
      "/repo/test/new.test.ts":
        'const { spawn } = require("node:child_process"); spawn("node");',
    },
  ],
  [
    "the real fixture-server helper",
    {
      "/repo/test/new.test.ts":
        'import { fixtureCommand } from "./support/fixture-server.js";',
    },
  ],
  [
    "an HTTP server",
    {
      "/repo/test/new.test.ts":
        'import { createServer } from "node:http"; createServer().listen(0);',
    },
  ],
  [
    "an aliased net server constructor",
    {
      "/repo/test/new.test.ts":
        'import { createServer as serve } from "node:net"; serve().listen(0);',
    },
  ],
  [
    "an invoked script helper",
    {
      "/repo/test/new.test.ts":
        'import { run } from "../scripts/probe.mjs"; run();',
      "/repo/scripts/probe.mjs":
        'import { spawn } from "node:child_process"; export function run() { spawn("node"); }',
    },
  ],
  [
    "a source capture seam",
    {
      "/repo/test/new.test.ts":
        'import { capture } from "../src/capture.js"; capture();',
      "/repo/src/capture.ts":
        'import { chromium } from "playwright"; export function capture() { return chromium.launch(); }',
    },
  ],
  [
    "a re-export behind a cycle",
    {
      "/repo/test/new.test.ts": 'import { launch } from "./a.js"; launch();',
      "/repo/test/a.ts": 'export * from "./b.js";',
      "/repo/test/b.ts":
        'export * from "./a.js"; export { chromium as launch } from "playwright";',
    },
  ],
  [
    "a computed runtime import",
    { "/repo/test/new.test.ts": "await import(process.env.DRIVER);" },
  ],
])("unit admission rejects %s", (_name, files) => {
  expect(uses(files as Record<string, string>).length).toBeGreaterThan(0);
});

test("type-only browser imports and type re-exports do not launch a browser", () => {
  expect(
    uses({
      "/repo/test/new.test.ts":
        'import type { Browser } from "playwright"; import { type Page } from "playwright"; export type { BrowserContext } from "playwright"; type Context = import("playwright").BrowserContext;',
    }),
  ).toEqual([]);
});

test("a pure source export does not inherit an unused launcher's resources", () => {
  expect(
    uses({
      "/repo/test/new.test.ts":
        'import { label } from "../src/driver.js"; label();',
      "/repo/src/driver.ts":
        'import { chromium } from "playwright"; export const label = () => "label"; export const launch = () => chromium.launch();',
    }),
  ).toEqual([]);
});
