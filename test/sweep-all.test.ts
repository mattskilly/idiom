import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import type { BrowserLauncher } from "../src/capture/types.js";
import { sweepCommand } from "../src/commands/sweep.js";
import { productFixture } from "./sweep-all-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const emptyBrowser: BrowserLauncher = async () => ({
  version: "fixture",
  async capture(tuple) {
    return {
      ok: true,
      status: 200,
      dom: "<html></html>",
      screenshot: PNG.sync.write(
        new PNG({ width: tuple.viewport.width, height: tuple.viewport.height }),
      ),
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
        headings: [],
        tokens: { status: "not-configured" },
      },
      console: [],
      axe: { violations: [] },
      mismatches: [],
      startedAt: "2026-10-27T00:00:00Z",
      endedAt: "2026-10-27T00:00:01Z",
    };
  },
  async close() {},
});

test.each([
  {},
  { all: true, flow: "alpha" },
  { all: true, from: "old" },
  { all: true, latest: true },
  { all: true, maxTickets: 0 },
  { all: true, maxTickets: 1.5 },
  { all: true, maxTickets: Number.MAX_SAFE_INTEGER + 1 },
])(
  "invalid sweep selectors/budgets fail before project reads: %j",
  async (options) => {
    await expect(
      sweepCommand({ ...options, project: "/does/not/exist" }),
    ).rejects.toThrow(/select exactly|fresh captures|positive safe/);
  },
);

test("all-flow validation rejects a filename/id mismatch before launching the browser", async () => {
  const project = await productFixture(directories);
  const file = join(project, ".idiom/flows/beta.json");
  const flow = JSON.parse(await readFile(file, "utf8"));
  flow.id = "alpha";
  await writeFile(file, JSON.stringify(flow));
  await expect(
    sweepCommand({
      all: true,
      project,
      deterministicOnly: true,
      dependencies: {
        capture: {
          browserLauncher: async () => {
            throw new Error("must not launch");
          },
        },
      },
    }),
  ).rejects.toThrow(/filename.*unique manifest/);
});

test("recoverable capture errors keep later flows and disclose incomplete coverage", async () => {
  const project = await productFixture(directories);
  let launches = 0;
  const result = await sweepCommand({
    all: true,
    project,
    deterministicOnly: true,
    dependencies: {
      capture: {
        browserLauncher: async (args) => {
          if (++launches === 1) throw new Error("capture service unavailable");
          return emptyBrowser(args);
        },
      },
    },
  });
  expect(result.flows[0]).toMatchObject({
    flow: "alpha",
    status: "failed",
    reason: expect.stringContaining("unavailable"),
  });
  expect(result.flows[1]).toMatchObject({ flow: "beta", status: "reviewed" });
  expect(result.outcome.kind).toBe("degraded");
  expect(result.findings.length).toBeGreaterThan(0);
});

test("cancellation stops before the next flow", async () => {
  const project = await productFixture(directories);
  const controller = new AbortController();
  let calls = 0;
  await expect(
    sweepCommand({
      all: true,
      project,
      deterministicOnly: true,
      dependencies: {
        capture: {
          signal: controller.signal,
          browserLauncher: async () => {
            calls++;
            controller.abort();
            throw new DOMException("cancelled", "AbortError");
          },
        },
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
