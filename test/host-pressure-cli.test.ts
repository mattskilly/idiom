import { execFile } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { CaptureDependencies } from "../src/capture/run.js";
import { run as runCli } from "../src/cli.js";
import { checkWithReview, renderCheckSummary } from "../src/commands/check.js";
import { productionFixture } from "./production-support.js";

const exec = promisify(execFile);
function capture(load: number): CaptureDependencies {
  return {
    readHost: () => ({ load: [load, 0, 0], coreCount: 11 }),
    measureReadyUrl: async () => 1,
    browserLauncher: async () => ({
      version: "test",
      close: async () => {},
      capture: async (tuple) => ({
        ok: false,
        stage: "navigation",
        message: "navigation expired",
        timeout: {
          kind: "navigation",
          timeoutMs: (tuple.timeoutFactor ?? 1) * 30000,
        },
        console: [],
        mismatches: [],
        startedAt: "2026-11-06T00:00:00Z",
        endedAt: "2026-11-06T00:00:00Z",
      }),
    }),
  };
}
async function commit(directory: string) {
  await exec("git", ["add", "."], { cwd: directory });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "configure fixture",
    ],
    { cwd: directory },
  );
}

test("busy capture skips baseline initialization, preserves failed coverage and replays as a single deferred JSON object", async () => {
  const f = await productionFixture({}, true);
  try {
    // The controller's automatic baseline path requires a clean committed tree.
    await writeFile(
      join(f.directory, ".idiom/project.json"),
      JSON.stringify({
        ...f.project,
        capture: { ...f.project.capture, hostPressureThreshold: 1.5 },
      }),
    );
    await commit(f.directory);
    const checked = await checkWithReview({
      project: f.directory,
      flow: "fixture",
      dependencies: { capture: capture(64) },
    });
    const summary = checked.summary;
    expect(summary.verdict).toBe("deferred");
    expect(summary.timedOutTuples).toEqual([
      { state: "home", viewport: "desktop", colorScheme: "light" },
    ]);
    expect(summary.blocking).toBe(0);
    expect(
      summary.findings.filter(
        (finding) => finding.category === "missing-state",
      ),
    ).toEqual([]);
    expect(summary.baselineRecorded).toBeUndefined();
    expect(summary.baselineNotApplied).toContain(
      "initialization did not occur",
    );
    expect(summary.coverage?.successfulTuples).toBe(0);
    expect(summary.coverage?.failedTuples).toHaveLength(1);
    await expect(
      access(join(f.directory, ".idiom/baselines/fixture.json")),
    ).rejects.toThrow();
    const rendered = renderCheckSummary(summary);
    expect(rendered.match(/Host busy:/g)).toHaveLength(1);
    expect(rendered).not.toContain("clean —");
    for (const path of [
      checked.review.reportPath,
      checked.review.htmlReportPath,
    ])
      expect((await readFile(path, "utf8")).match(/Host busy:/g)).toHaveLength(
        1,
      );
    // Edited current config and the current host must not change retained evidence.
    await writeFile(
      join(f.directory, ".idiom/project.json"),
      JSON.stringify({
        ...f.project,
        capture: { ...f.project.capture, hostPressureThreshold: 100 },
      }),
    );
    const replay = await exec(
      process.execPath,
      [
        resolve("build/cli.js"),
        "check",
        "fixture",
        "--all",
        "--from",
        basename(summary.runDirectory),
        "--project",
        f.directory,
        "--json",
        "--fail-on",
        "never",
      ],
      { env: { ...process.env, IDIOM_NO_UPDATE_CHECK: "1" } },
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error) => error as { stdout: string; stderr: string; code: number },
    );
    expect(replay.code, replay.stderr + replay.stdout).toBe(3);
    const json = JSON.parse(replay.stdout);
    expect(json.verdict).toBe("deferred");
    expect(json.timedOutTuples).toEqual(summary.timedOutTuples);
    expect(json.failure).toBeUndefined();
    expect(replay.stderr).not.toContain("Error:");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test.each([
  [64, "fail"],
  [64, "warn"],
  [0, "fail"],
  [0, "warn"],
] as const)(
  "CLI busy/idle exits with deferral policy (load %s, %s)",
  async (load, policy) => {
    const f = await productionFixture();
    try {
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        [
          "node",
          "idiom",
          "check",
          "fixture",
          "--all",
          "--json",
          ...(load ? ["--fail-on", "never"] : []),
          "--deferred",
          policy,
        ],
        {
          cwd: f.directory,
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
          capture: capture(load),
        },
      );
      expect(code).toBe(load ? (policy === "warn" ? 0 : 3) : 1);
      expect(stderr.includes("Warning: host busy")).toBe(
        load > 0 && policy === "warn",
      );
      const json = JSON.parse(stdout);
      expect(json.verdict).toBe(load ? "deferred" : undefined);
      expect(json.blocking).toBe(load ? 0 : 1);
      expect(stderr.includes("Error: check failed")).toBe(!load);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.each([
  [false, "fail"],
  [false, "warn"],
  [true, "fail"],
  [true, "warn"],
] as const)(
  "changed/gate JSON propagates flow-qualified deferral (gate %s, %s)",
  async (gate, policy) => {
    const { changedFixture } = await import("./changed-support.js");
    const f = await changedFixture();
    try {
      const flow = JSON.parse(
        await readFile(join(f.directory, ".idiom/flows/site.json"), "utf8"),
      );
      await f.write(
        ".idiom/flows/other.json",
        JSON.stringify({
          ...flow,
          id: "other",
          states: flow.states.slice(0, 1),
        }),
      );
      await f.commit();
      await f.write(
        "app/r0/page.tsx",
        "export default function Page() { return <article /> }",
      );
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        [
          "node",
          "idiom",
          "check",
          "--changed",
          ...(gate ? ["--gate"] : ["--all"]),
          "--deferred",
          policy,
          "--json",
          "--fail-on",
          "never",
        ],
        {
          cwd: f.directory,
          capture: capture(64),
          stdout: (value) => {
            stdout += value;
          },
          stderr: (value) => {
            stderr += value;
          },
        },
      );
      expect(code, stderr).toBe(policy === "warn" ? 0 : 3);
      expect(stderr.includes("Warning: host busy")).toBe(policy === "warn");
      const json = JSON.parse(stdout);
      expect(json.verdict).toBe("deferred");
      expect(json.timedOutTuples).toEqual(
        expect.arrayContaining([
          { flow: "site", state: "s0", viewport: "wide", colorScheme: "light" },
          {
            flow: "other",
            state: "s0",
            viewport: "wide",
            colorScheme: "light",
          },
        ]),
      );
      expect(
        json.checks.every(
          (entry: { summary: { verdict: string } }) =>
            entry.summary.verdict === "deferred",
        ),
      ).toBe(true);
      expect(stderr).not.toContain("Error:");
    } finally {
      await f.cleanup();
    }
  },
);

test("MCP forwards deferred coordinates and truthful capture failure counts", async () => {
  const { mcpClient, toolData } = await import("./mcp-support.js");
  const f = await productionFixture();
  const session = await mcpClient({
    project: f.directory,
    dependencies: { capture: capture(64) },
  });
  try {
    const response = await session.client.callTool({
      name: "idiom_check",
      arguments: { flow: "fixture", all: true },
    });
    const data = toolData<{
      verdict: string;
      timedOutTuples: unknown[];
      counts: { captures: { total: number; failed: number }; blocking: number };
    }>(response);
    expect(data.verdict).toBe("deferred");
    expect(data.timedOutTuples).toHaveLength(1);
    expect(data.counts.captures).toEqual({ total: 1, failed: 1 });
    expect(data.counts.blocking).toBe(0);
    expect(JSON.stringify(response.content)).toContain("Host busy:");
    expect(JSON.stringify(response.content)).toContain(
      "Probe produced no evidence for home: the state timed out",
    );
  } finally {
    await session.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("recorded comparison preserves genuine findings and never infers fixes for host-deferred coordinates", async () => {
  const { PNG } = await import("pngjs");
  const f = await productionFixture({}, true);
  try {
    const flow = {
      ...f.flow,
      states: [
        ...f.flow.states,
        { id: "other", description: "Other", url: "/", expect: {} },
      ],
    };
    await writeFile(
      join(f.directory, ".idiom/flows/fixture.json"),
      JSON.stringify(flow),
    );
    await commit(f.directory);
    const success = () => ({
      ok: true as const,
      status: 200,
      dom: "<html lang=en><title>Ready</title><body>Ready</body></html>",
      screenshot: PNG.sync.write(new PNG({ width: 1, height: 1 })),
      axe: { violations: [] },
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
    });
    const initial = await checkWithReview({
      project: f.directory,
      flow: "fixture",
      dependencies: {
        capture: {
          ...capture(0),
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async (tuple) => ({
              ...success(),
              mismatches:
                tuple.state.id === "home"
                  ? [
                      {
                        kind: "text-present" as const,
                        expected: "Baseline defect",
                      },
                    ]
                  : [],
            }),
          }),
        },
      },
    });
    expect(initial.summary.baselineRecorded).toBeDefined();
    await commit(f.directory);
    const busy = capture(64);
    const checked = await checkWithReview({
      project: f.directory,
      flow: "fixture",
      dependencies: {
        capture: {
          ...busy,
          browserLauncher: async (hooks) => {
            const failed = await busy.browserLauncher?.(hooks);
            if (!failed) throw new Error("missing fixture session");
            return {
              ...failed,
              capture: async (tuple) =>
                tuple.state.id === "home"
                  ? failed.capture(tuple)
                  : {
                      ...success(),
                      mismatches: [
                        { kind: "text-present", expected: "Required message" },
                      ],
                    },
            };
          },
        },
      },
    });
    expect(checked.summary.verdict).toBe("deferred");
    expect(checked.summary.baseline).toBeDefined();
    expect(checked.summary.blocking).toBe(1);
    expect(
      checked.summary.findings.some((finding) =>
        finding.where.includes("other"),
      ),
    ).toBe(true);
    expect(
      checked.summary.findings.every(
        (finding) => !finding.where.includes("home"),
      ),
    ).toBe(true);
    expect(checked.summary.fixed).toEqual([]);
    expect(checked.summary.baseline?.uncoveredTuples).toContain("home/desktop");
    expect(renderCheckSummary(checked.summary)).not.toContain("clean —");
    let stdout = "";
    let stderr = "";
    const code = await runCli(
      [
        "node",
        "idiom",
        "check",
        "fixture",
        "--from",
        basename(checked.summary.runDirectory),
        "--deferred",
        "warn",
        "--json",
      ],
      {
        cwd: f.directory,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      },
    );
    expect(code, stderr).toBe(1);
    expect(JSON.parse(stdout).verdict).toBe("deferred");
    expect(stderr).toContain("Warning: host busy");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("warn never hides a run failure and invalid deferral policies are rejected", async () => {
  const f = await productionFixture();
  try {
    const code = await runCli(
      ["node", "idiom", "check", "fixture", "--deferred", "warn"],
      {
        cwd: f.directory,
        stdout: () => {},
        stderr: () => {},
        capture: {
          ...capture(64),
          browserLauncher: async () => {
            throw new Error("capture infrastructure unavailable");
          },
        },
      },
    );
    expect(code).toBe(2);
    let stderr = "";
    expect(
      await runCli(
        ["node", "idiom", "check", "fixture", "--deferred", "ignore"],
        {
          cwd: f.directory,
          stdout: () => {},
          stderr: (value) => {
            stderr += value;
          },
        },
      ),
    ).not.toBe(0);
    expect(stderr).toContain("Allowed choices are fail, warn");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("recorded comparison keeps the deferred verdict when a host-deferred tuple and an ordinary failure share a run", async () => {
  const { PNG } = await import("pngjs");
  const f = await productionFixture({}, true);
  try {
    const flow = {
      ...f.flow,
      states: [
        ...f.flow.states,
        { id: "other", description: "Other", url: "/", expect: {} },
      ],
    };
    await writeFile(
      join(f.directory, ".idiom/flows/fixture.json"),
      JSON.stringify(flow),
    );
    await commit(f.directory);
    const success = () => ({
      ok: true as const,
      status: 200,
      dom: "<html lang=en><title>Ready</title><body>Ready</body></html>",
      screenshot: PNG.sync.write(new PNG({ width: 1, height: 1 })),
      axe: { violations: [] },
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
    });
    const initial = await checkWithReview({
      project: f.directory,
      flow: "fixture",
      dependencies: {
        capture: {
          ...capture(0),
          browserLauncher: async () => ({
            version: "test",
            close: async () => {},
            capture: async () => success(),
          }),
        },
      },
    });
    expect(initial.summary.baselineRecorded).toBeDefined();
    await commit(f.directory);
    const busy = capture(64);
    const checked = await checkWithReview({
      project: f.directory,
      flow: "fixture",
      dependencies: {
        capture: {
          ...busy,
          browserLauncher: async (hooks) => {
            const failed = await busy.browserLauncher?.(hooks);
            if (!failed) throw new Error("missing fixture session");
            return {
              ...failed,
              capture: async (tuple) =>
                tuple.state.id === "home"
                  ? failed.capture(tuple)
                  : {
                      ok: false as const,
                      stage: "expectation" as const,
                      message: "expected text missing",
                      console: [],
                      mismatches: [],
                      startedAt: "2026-11-06T00:00:00Z",
                      endedAt: "2026-11-06T00:00:00Z",
                    },
            };
          },
        },
      },
    });
    expect(checked.summary.verdict).toBe("deferred");
    expect(checked.summary.timedOutTuples).toEqual([
      expect.objectContaining({ state: "home" }),
    ]);
    expect(checked.summary.captureFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "other", stage: "expectation" }),
      ]),
    );
    expect(checked.summary.baselineNotRecorded).toBeUndefined();
    expect(renderCheckSummary(checked.summary)).not.toContain("clean —");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
