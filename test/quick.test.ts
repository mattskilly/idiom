import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  BrowserLauncher,
  BrowserTuple,
  TupleResult,
} from "../src/capture/types.js";
import { run } from "../src/cli.js";
import {
  createQuickConfiguration,
  normalizeQuickUrls,
} from "../src/quick/config.js";
import { runQuick } from "../src/quick/run.js";
import { findingSchema } from "../src/schemas/finding.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-quick-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function capturedResult(tuple: BrowserTuple): TupleResult {
  return {
    ok: true,
    status: 200,
    dom: "<!doctype html><html><body><h1>Quick</h1></body></html>",
    screenshot: Buffer.from("quick-png"),
    console: [{ type: "error", text: `failure on ${tuple.state.id}` }],
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
      headings: [{ selector: "h1", level: 1, text: "Quick" }],
      tokens: { status: "not-configured" },
    },
    mismatches: [],
    startedAt: "2026-08-20T12:00:00.000Z",
    endedAt: "2026-08-20T12:00:01.000Z",
  };
}

function browserLauncher(captures: BrowserTuple[]): BrowserLauncher {
  return async () => ({
    version: "Mock Chromium",
    async capture(tuple) {
      captures.push(tuple);
      return capturedResult(tuple);
    },
    async close() {},
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("quick URL configuration normalizes inputs and preserves page order", () => {
  const configuration = createQuickConfiguration([
    "https://example.com",
    "https://example.com/account?tab=profile",
  ]);
  expect(configuration.urls).toEqual([
    "https://example.com/",
    "https://example.com/account?tab=profile",
  ]);
  expect(
    configuration.flow.states.map((state) => [state.id, state.url]),
  ).toEqual([
    ["page-1", "https://example.com/"],
    ["page-2", "https://example.com/account?tab=profile"],
  ]);
  expect(configuration.project.viewports).toEqual([
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]);
  expect(configuration.project.colorSchemes).toEqual(["light", "dark"]);
});

test.each([
  [[], "at least one URL"],
  [["/relative"], "absolute HTTP(S)"],
  [["ftp://example.com/file"], "HTTP or HTTPS"],
  [["https://user:secret@example.com/"], "must not contain credentials"],
  [["https://example.com/", "https://other.example/"], "must share one origin"],
  [
    ["https://example.com", "https://example.com/"],
    "duplicate quick review URL",
  ],
])("quick URL validation rejects %j", (urls, message) => {
  expect(() => normalizeQuickUrls(urls)).toThrow(message);
});

test("quick review captures the complete grid and emits standard capped findings", async () => {
  const directory = await temporaryDirectory();
  const captures: BrowserTuple[] = [];
  const urls = Array.from(
    { length: 6 },
    (_, index) => `http://127.0.0.1:4173/page-${index + 1}`,
  );
  const output = join(directory, "exact-output");
  const result = await runQuick({
    urls,
    cwd: directory,
    out: output,
    dependencies: {
      browserLauncher: browserLauncher(captures),
      now: () => new Date("2026-08-20T12:34:56.000Z"),
      environment: {},
    },
  });

  expect(result.runDirectory).toBe(output);
  expect(result.counts).toEqual({ passed: 24, failed: 0, total: 24 });
  expect(captures).toHaveLength(24);
  expect(
    captures.map((tuple) => [
      tuple.state.id,
      tuple.viewport.name,
      tuple.colorScheme,
      tuple.navigationUrl,
    ]),
  ).toEqual(
    urls.flatMap((url, stateIndex) =>
      ["desktop", "mobile"].flatMap((viewport) =>
        ["light", "dark"].map((scheme) => [
          `page-${stateIndex + 1}`,
          viewport,
          scheme,
          url,
        ]),
      ),
    ),
  );
  expect(
    captures.every((tuple) => tuple.tokens?.status === "not-configured"),
  ).toBe(true);
  expect(
    JSON.parse(
      await readFile(
        join(output, "page-1", "desktop", "light", "metadata.json"),
        "utf8",
      ),
    ).source,
  ).toEqual({ commit: "unavailable (quick review)", dirty: false });

  const findings = JSON.parse(await readFile(result.findingsPath, "utf8"));
  expect(findings).toHaveLength(5);
  for (const finding of findings)
    expect(findingSchema.parse(finding)).toEqual(finding);
  expect(
    findings.every((finding: { id: string }) =>
      /^finding-\d+$/.test(finding.id),
    ),
  ).toBe(true);
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("## Coverage and limits");
  expect(report).toContain("24 of 24 selected");
  expect(report.indexOf("## Coverage and limits")).toBeLessThan(
    report.indexOf("## page-1"),
  );
  expect(report).toContain("## Evaluated but not selected");
  expect(report).toContain("| spacing-rhythm | unavailable |");
  expect(report).toContain(
    "not evaluated: observations version 1 lacks structural geometry",
  );
  expect(report).toContain("## Quick-review limits");
  expect(report).toContain("authenticated surfaces");
  expect(report.trimEnd()).toMatch(
    /run `idiom init`, define a flow manifest, then run `idiom review <flow>`\.$/,
  );
  const html = await readFile(result.htmlReportPath, "utf8");
  expect(html).toContain("Coverage and limits");
  expect(html).toContain("24 of 24 selected");
  expect(html).toContain("Print or save as PDF");
  expect(html).toContain("spacing-rhythm");
  expect(html).toContain(
    "not evaluated: observations version 1 lacks structural geometry",
  );
  expect(html.indexOf("Coverage and limits")).toBeLessThan(
    html.indexOf("<h2>page-1</h2>"),
  );
  expect(html).toContain("Quick-review limits");
  expect(html).toContain("fixture-dependent error and empty states");
  expect(html.lastIndexOf("Quick-review limits")).toBeGreaterThan(
    html.lastIndexOf("Check coverage"),
  );
});

test("quick review places default output outside configured report storage", async () => {
  const directory = await temporaryDirectory();
  const result = await runQuick({
    urls: ["https://example.com/"],
    cwd: directory,
    dependencies: {
      browserLauncher: browserLauncher([]),
      now: () => new Date("2026-08-20T12:34:56.789Z"),
      environment: {},
    },
  });
  expect(result.runDirectory).toBe(
    join(directory, "idiom-quick-reports", "2026-08-20T12-34-56-789Z"),
  );
  expect(result.runDirectory).not.toContain(join(".idiom", "reports"));
});

test("quick review refuses configured projects before browser or output work", async () => {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, ".idiom"));
  await writeFile(join(directory, ".idiom", "project.json"), "{}\n");
  const child = join(directory, "nested", "working-directory");
  await mkdir(child, { recursive: true });
  const browser = vi.fn<BrowserLauncher>();
  const workspace = vi.fn();
  await expect(
    runQuick({
      urls: ["https://example.com/"],
      cwd: child,
      dependencies: {
        browserLauncher: browser,
        createArtifactWorkspace: workspace,
      },
    }),
  ).rejects.toThrow("idiom review <flow>");
  expect(browser).not.toHaveBeenCalled();
  expect(workspace).not.toHaveBeenCalled();
});

test("quick review never overwrites exact output and cleans staging on launch failure", async () => {
  const directory = await temporaryDirectory();
  const existing = join(directory, "existing");
  await mkdir(existing);
  const browser = vi.fn<BrowserLauncher>();
  await expect(
    runQuick({
      urls: ["https://example.com/"],
      cwd: directory,
      out: existing,
      dependencies: { browserLauncher: browser },
    }),
  ).rejects.toThrow("will not be overwritten");
  expect(browser).not.toHaveBeenCalled();

  const finalDirectory = join(directory, "failed-output");
  const stagingDirectory = join(directory, ".failed-output.staging-test");
  const dataDirectory = join(directory, "data-test");
  await mkdir(stagingDirectory);
  await mkdir(dataDirectory);
  const close = vi.fn(async () => undefined);
  await expect(
    runQuick({
      urls: ["https://example.com/"],
      cwd: directory,
      dependencies: {
        browserLauncher: async () => ({
          version: "Mock Chromium",
          async capture() {
            throw new Error("capture failed");
          },
          close,
        }),
        createArtifactWorkspace: async () => ({
          finalDirectory,
          stagingDirectory,
          dataDirectory,
        }),
      },
    }),
  ).rejects.toThrow("capture failed");
  expect(close).toHaveBeenCalledOnce();
  await expect(access(stagingDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(access(dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("quick CLI exposes help, success locations, and validation failures", async () => {
  const directory = await temporaryDirectory();
  const help: string[] = [];
  expect(
    await run(["node", "idiom", "quick", "--help"], {
      stdout: (message) => help.push(message),
      stderr: () => undefined,
    }),
  ).toBe(0);
  expect(help.join("")).toContain("Usage: idiom quick [options] <url...>");

  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    ["node", "idiom", "quick", "https://example.com/", "--out", "cli-output"],
    {
      cwd: directory,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      quick: {
        browserLauncher: browserLauncher([]),
        now: () => new Date("2026-08-20T12:34:56.000Z"),
        environment: {},
      },
    },
  );
  expect(code).toBe(0);
  expect(stdout.join("")).toContain("Quick review:");
  expect(stdout.join("")).toContain("Markdown:");
  expect(stdout.join("")).toContain("HTML:");
  expect(stderr).toEqual([]);

  const invalidErrors: string[] = [];
  expect(
    await run(["node", "idiom", "quick", "/relative"], {
      cwd: directory,
      stdout: () => undefined,
      stderr: (message) => invalidErrors.push(message),
    }),
  ).toBe(1);
  expect(invalidErrors.join("")).toContain("absolute HTTP(S) URL");
});

test("MCP literal quick bypasses configured guard explicitly, selects presets and avoids same-clock collisions", async () => {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, ".idiom"));
  await writeFile(
    join(directory, ".idiom/project.json"),
    "malformed config must not be read",
  );
  const captures: BrowserTuple[] = [];
  const options = {
    urls: ["https://example.com"],
    project: directory,
    literal: true,
    viewports: ["mobile" as const],
    dependencies: {
      browserLauncher: browserLauncher(captures),
      now: () => new Date("2026-08-20T12:34:56.789Z"),
    },
  };
  const first = await runQuick(options);
  const second = await runQuick(options);
  expect(first.runDirectory).not.toBe(second.runDirectory);
  expect(captures).toHaveLength(4);
  expect(captures.every((tuple) => tuple.viewport.name === "mobile")).toBe(
    true,
  );
});

test("literal capture uses the overall deadline, bounds cleanup and closes late-acquired resources", async () => {
  const { captureLiteralPages } = await import("../src/quick/run.js");
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  const directory = await temporaryDirectory();
  const configuration = createQuickConfiguration(["https://example.com"]);
  configuration.project.capture.maxMinutes = 1;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: (browser: Awaited<ReturnType<BrowserLauncher>>) => void;
  const late = new Promise<Awaited<ReturnType<BrowserLauncher>>>((resolve) => {
    release = resolve;
  });
  const before = process.listenerCount("SIGINT");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const pending = captureLiteralPages({
    directory,
    finalDirectory: join(directory, "literal"),
    configuration,
    checks: checksConfigFrom(configuration.project.checks),
    startedAt: new Date(),
    label: "test",
    dependencies: {
      browserLauncher: async () => {
        enter();
        return late;
      },
    },
  });
  const rejected = expect(pending).rejects.toThrow(
    /capture.maxMinutes=1.*browser launch/,
  );
  await entered;
  await vi.advanceTimersByTimeAsync(65000);
  await rejected;
  const close = vi.fn(async () => {});
  const capture = vi.fn();
  release({ version: "late", capture, close });
  await vi.advanceTimersByTimeAsync(1);
  vi.useRealTimers();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(capture).not.toHaveBeenCalled();
  expect(process.listenerCount("SIGINT")).toBe(before);
  await expect(access(join(directory, "literal"))).rejects.toThrow();
});

test("pre-aborted literal review launches nothing", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancel before start"));
  const launch = vi.fn();
  await expect(
    runQuick({
      urls: ["https://example.com"],
      project: await temporaryDirectory(),
      dependencies: { signal: controller.signal, browserLauncher: launch },
    }),
  ).rejects.toThrow("cancel before start");
  expect(launch).not.toHaveBeenCalled();
});

test("quick review probes each page once at the first viewport in light", async () => {
  const directory = await temporaryDirectory();
  const captures: BrowserTuple[] = [];
  const result = await runQuick({
    urls: ["http://127.0.0.1:4173/a", "http://127.0.0.1:4173/b"],
    cwd: directory,
    out: join(directory, "probed"),
    dependencies: {
      browserLauncher: browserLauncher(captures),
      now: () => new Date("2026-08-20T12:34:56.000Z"),
      environment: {},
    },
  });
  const probed = captures.filter((tuple) => tuple.probe === true);
  expect(
    probed.map((tuple) => [
      tuple.state.id,
      tuple.viewport.name,
      tuple.colorScheme,
    ]),
  ).toEqual([
    ["page-1", "desktop", "light"],
    ["page-2", "desktop", "light"],
  ]);
  for (const tuple of probed) {
    expect(tuple.probeSafety).toBe("third-party");
    expect(tuple.probePageBudgetMs).toBe(45_000);
    expect(tuple.project.checks.probe.maxControls).toBe(40);
    expect(tuple.enumerateProbe).toBeUndefined();
  }
  expect(probed[0]?.probeLedger).toBeDefined();
  expect(probed[0]?.probeLedger).toBe(probed[1]?.probeLedger);
  for (const tuple of captures.filter((tuple) => tuple.probe !== true)) {
    expect(tuple.probeSafety).toBeUndefined();
    expect(tuple.probePageBudgetMs).toBeUndefined();
  }
  // The fake browser records no probe artifact: each page says so.
  expect(result.interaction).toMatchObject({
    status: "probed",
    budgetMs: 45_000,
    maxControls: 40,
    pages: [
      { state: "page-1", probeStatus: "unavailable" },
      { state: "page-2", probeStatus: "unavailable" },
    ],
  });
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("### Interaction");
  expect(report).toContain("Idiom could not interact with");
  expect(report).toContain(
    "form submission and non-GET requests were blocked while probing",
  );
});

test("quick review probes mobile in light when only mobile is selected", async () => {
  const directory = await temporaryDirectory();
  const captures: BrowserTuple[] = [];
  await runQuick({
    urls: ["http://127.0.0.1:4173/"],
    viewports: ["mobile"],
    cwd: directory,
    out: join(directory, "mobile"),
    probeBudgetMs: 1000,
    dependencies: {
      browserLauncher: browserLauncher(captures),
      environment: {},
    },
  });
  const probed = captures.filter((tuple) => tuple.probe === true);
  expect(
    probed.map((tuple) => [
      tuple.viewport.name,
      tuple.colorScheme,
      tuple.probePageBudgetMs,
    ]),
  ).toEqual([["mobile", "light", 1000]]);
});

test("quick review without the probe is a stated static review", async () => {
  const directory = await temporaryDirectory();
  const captures: BrowserTuple[] = [];
  const result = await runQuick({
    urls: ["http://127.0.0.1:4173/"],
    cwd: directory,
    out: join(directory, "static"),
    probe: false,
    dependencies: {
      browserLauncher: browserLauncher(captures),
      environment: {},
    },
  });
  expect(captures.some((tuple) => tuple.probe !== undefined)).toBe(false);
  expect(
    captures.some(
      (tuple) =>
        tuple.probeSafety !== undefined ||
        tuple.probePageBudgetMs !== undefined,
    ),
  ).toBe(false);
  expect(captures[0]?.project.checks.probe.maxControls).toBe(80);
  expect(result.interaction).toEqual({ status: "off" });
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("Interaction probe off (--no-probe)");
  const html = await readFile(result.htmlReportPath, "utf8");
  expect(html).toContain("Interaction probe off (--no-probe)");
});

test.each([
  [{ probe: false, probeBudgetMs: 1000 }, "requires the probe"],
  [{ probeBudgetMs: 0 }, "positive integer"],
  [{ probeBudgetMs: "abc" }, "positive integer"],
  [{ probeBudgetMs: 600_001 }, "up to 600000"],
  [{ probeBudgetMs: 1.5 }, "positive integer"],
])("quick review rejects probe options %j", async (probeOptions, message) => {
  const directory = await temporaryDirectory();
  const captures: BrowserTuple[] = [];
  await expect(
    runQuick({
      urls: ["http://127.0.0.1:4173/"],
      cwd: directory,
      ...probeOptions,
      dependencies: { browserLauncher: browserLauncher(captures) },
    }),
  ).rejects.toThrow(message);
  expect(captures).toEqual([]);
});

test("quick CLI forwards --probe-budget and --no-probe and reports the probe", async () => {
  const directory = await temporaryDirectory();
  const run1 = async (args: string[]) => {
    const captures: BrowserTuple[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run(["node", "idiom", "quick", ...args], {
      cwd: directory,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      quick: { browserLauncher: browserLauncher(captures), environment: {} },
    });
    return {
      code,
      captures,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  };
  const budget = await run1([
    "https://example.com/",
    "--out",
    "budget",
    "--probe-budget",
    "2000",
  ]);
  expect(budget.code).toBe(0);
  expect(budget.captures.find((tuple) => tuple.probe)?.probePageBudgetMs).toBe(
    2000,
  );
  expect(budget.stdout).toContain("probed 0 controls, skipped 0, not probed 0");
  const off = await run1([
    "https://example.com/",
    "--out",
    "off",
    "--no-probe",
  ]);
  expect(off.code).toBe(0);
  expect(off.captures.some((tuple) => tuple.probe)).toBe(false);
  expect(off.stdout).toContain("probe off");
  for (const value of ["0", "abc", "600001"]) {
    const failed = await run1([
      "https://example.com/",
      "--probe-budget",
      value,
    ]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(
      "--probe-budget must be a positive integer",
    );
  }
  const conflict = await run1([
    "https://example.com/",
    "--no-probe",
    "--probe-budget",
    "1000",
  ]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain("requires the probe");
});
