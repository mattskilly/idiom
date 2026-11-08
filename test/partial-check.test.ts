import { execFile } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import type { CaptureDependencies } from "../src/capture/run.js";
import { run as runCli } from "../src/cli.js";
import { mcpClient, toolData } from "./mcp-support.js";
import { productionFixture } from "./production-support.js";

// On the first check, a failed tuple no longer voids the review of the rest:
// findings for the successful tuples are reported and no baseline is recorded.

const exec = promisify(execFile);
const MESSAGE =
  "Baseline not recorded: 1 of 3 tuples failed (broken/desktop/light). Findings for the other 2 are above.";

const capture: CaptureDependencies = {
  readHost: () => ({ load: [0, 0, 0], coreCount: 11 }),
  measureReadyUrl: async () => 1,
  browserLauncher: async () => ({
    version: "test",
    close: async () => {},
    capture: async (tuple) =>
      tuple.state.id === "broken"
        ? {
            ok: false as const,
            stage: "expectation",
            message: "expected text missing",
            console: [],
            mismatches: [],
            startedAt: "2026-11-06T00:00:00Z",
            endedAt: "2026-11-06T00:00:00Z",
          }
        : {
            ok: true as const,
            status: 200,
            dom: '<html lang="en"><title>Ready</title><body><button id="save"></button></body></html>',
            screenshot: PNG.sync.write(new PNG({ width: 1, height: 1 })),
            axe: {
              violations:
                tuple.state.id === "home"
                  ? [
                      {
                        id: "button-name",
                        impact: "critical",
                        nodes: [
                          {
                            target: ["#save"],
                            html: '<button id="save"></button>',
                          },
                        ],
                      },
                    ]
                  : [],
            },
            console: [],
            observations: {
              version: 2 as const,
              viewport: { width: 800, height: 600 },
              document: {
                scrollWidth: 800,
                scrollHeight: 600,
                clientWidth: 800,
                clientHeight: 600,
              },
              elements: [],
              headings: [],
              tokens: { status: "not-configured" as const },
              maskMembership: [],
            },
            mismatches: [],
            startedAt: "2026-11-06T00:00:00Z",
            endedAt: "2026-11-06T00:00:00Z",
          },
  }),
};

async function firstBaselineProject() {
  const f = await productionFixture({}, true);
  await writeFile(
    join(f.directory, ".idiom/flows/fixture.json"),
    JSON.stringify({
      ...f.flow,
      states: ["home", "other", "broken"].map((id) => ({
        id,
        description: id,
        url: "/",
        expect: {},
      })),
    }),
  );
  await exec("git", ["add", "."], { cwd: f.directory });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "three states",
    ],
    { cwd: f.directory },
  );
  return f;
}

async function noBaseline(directory: string) {
  await expect(
    access(join(directory, ".idiom/baselines/fixture.json")),
  ).rejects.toThrow();
  await expect(
    access(join(directory, ".idiom/baselines/fixture")),
  ).rejects.toThrow();
}

test.each([false, true])(
  "CLI check prints findings, then fails without a baseline (json %s, fail-on never)",
  async (json) => {
    const f = await firstBaselineProject();
    try {
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        [
          "node",
          "idiom",
          "check",
          "fixture",
          "--fail-on",
          "never",
          ...(json ? ["--json"] : []),
        ],
        {
          cwd: f.directory,
          capture,
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
      );
      expect(code, stderr).toBe(1);
      expect(stderr.split(MESSAGE).length - 1).toBe(1);
      await noBaseline(f.directory);
      if (json) {
        const summary = JSON.parse(stdout);
        expect(summary.baselineRecorded).toBeUndefined();
        expect(summary.baselineNotRecorded).toEqual({
          failed: 1,
          total: 3,
          successful: 2,
          coordinates: [
            { state: "broken", viewport: "desktop", colorScheme: "light" },
          ],
          message: MESSAGE,
        });
        expect(summary.captureFailures).toEqual([
          expect.objectContaining({ state: "broken", stage: "expectation" }),
        ]);
        expect(
          summary.findings.some(
            (finding: { category: string }) =>
              finding.category === "a11y-label",
          ),
        ).toBe(true);
        expect(stderr).not.toContain("Error:");
      } else {
        expect(stdout).toContain("a11y-label");
        expect(stdout).toContain("Coverage gaps:");
        expect(stdout).toContain(
          "broken/desktop/light: expectation: expected text missing",
        );
        expect(stdout).not.toContain(MESSAGE);
      }
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
  60_000,
);

test("MCP check returns partial findings and the failed tuples instead of an error", async () => {
  const f = await firstBaselineProject();
  const session = await mcpClient({
    project: f.directory,
    dependencies: { capture },
  });
  try {
    const response = await session.client.callTool({
      name: "idiom_check",
      arguments: { flow: "fixture" },
    });
    expect(response.isError).toBeFalsy();
    const data = toolData<{
      baselineNotRecorded: { message: string; failed: number; total: number };
      captureFailures: Array<{ state: string }>;
      counts: { captures: { total: number; failed: number } };
      reports: unknown;
    }>(response);
    expect(data.baselineNotRecorded).toMatchObject({
      message: MESSAGE,
      failed: 1,
      total: 3,
    });
    expect(data.captureFailures.map((tuple) => tuple.state)).toEqual([
      "broken",
    ]);
    expect(data.counts.captures).toEqual({ total: 3, failed: 1 });
    expect(JSON.stringify(response.content)).toContain(MESSAGE);
    expect(JSON.stringify(data)).toContain("a11y-label");
    await noBaseline(f.directory);
  } finally {
    await session.close();
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
