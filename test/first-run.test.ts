import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error The first-run helpers are plain Node ESM without declarations.
import * as lib from "../scripts/first-run-lib.mjs";

const {
  appendRun,
  BUDGET_MS,
  cleanEnvironment,
  evaluateRun,
  formatTable,
  installCommand,
  parseGettingStarted,
  parseQuickSummary,
  quickCommand,
} = lib;

const repositoryRoot = join(import.meta.dirname, "..");

type Step = { id: string; ms: number; ok: boolean; note?: string };

function doc({
  install = [
    "npm install -g @mattskilly/idiom",
    "npx playwright@1.62.1 install chromium",
  ],
  review = ["idiom quick http://localhost:3000"],
  reviewHeading = "## 2. Review a page",
}: {
  install?: string[];
  review?: string[] | null;
  reviewHeading?: string;
} = {}): string {
  const parts = [
    "# Getting started",
    "",
    "## 1. Install",
    "",
    "```sh",
    ...install,
    "```",
    "",
  ];
  if (review)
    parts.push(reviewHeading, "", "```sh", ...review, "```", "", "## 3. Next");
  return parts.join("\n");
}

describe("parseGettingStarted", () => {
  test("follows the real getting-started page, with the package's Playwright pin", async () => {
    const [markdown, packageText] = await Promise.all([
      readFile(
        join(repositoryRoot, "site", "docs", "getting-started.md"),
        "utf8",
      ),
      readFile(join(repositoryRoot, "package.json"), "utf8"),
    ]);
    const parsed = parseGettingStarted(markdown);
    expect(parsed.problems).toBeUndefined();
    expect(parsed.ok).toBe(true);
    expect(parsed.install.npmLine).toBe("npm install -g @mattskilly/idiom");
    expect(parsed.install.playwrightPin).toBe(
      JSON.parse(packageText).dependencies.playwright,
    );
    expect(parsed.review.quickLine).toMatch(/^idiom quick https?:\/\//);
  });

  test("reads the synthetic page", () => {
    expect(parseGettingStarted(doc())).toEqual({
      ok: true,
      install: {
        npmLine: "npm install -g @mattskilly/idiom",
        playwrightLine: "npx playwright@1.62.1 install chromium",
        playwrightPin: "1.62.1",
      },
      review: {
        quickLine: "idiom quick http://localhost:3000",
        placeholderUrl: "http://localhost:3000",
      },
    });
  });

  test("ignores blank and comment lines", () => {
    const parsed = parseGettingStarted(
      doc({
        install: [
          "# the CLI",
          "npm install -g @mattskilly/idiom",
          "",
          "npx playwright@1.62.1 install chromium",
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  test("reports an extra install line by name", () => {
    const parsed = parseGettingStarted(
      doc({
        install: [
          "npm install -g @mattskilly/idiom",
          "npx playwright@1.62.1 install chromium",
          "idiom setup",
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.problems).toEqual([
      'unrecognised install line: "idiom setup"',
    ]);
  });

  test("reports an install path it does not follow", () => {
    const parsed = parseGettingStarted(
      doc({
        install: [
          "bun add -g @mattskilly/idiom",
          "npx playwright@1.62.1 install chromium",
        ],
      }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.problems).toContain(
      'unrecognised install line: "bun add -g @mattskilly/idiom"',
    );
    expect(parsed.problems).toContain(
      'install block has no "npm install -g @mattskilly/idiom" line',
    );
  });

  test("reports a missing or renamed review section", () => {
    expect(parseGettingStarted(doc({ review: null })).problems).toEqual([
      'missing section "## 2. Review a page"',
    ]);
    expect(
      parseGettingStarted(doc({ reviewHeading: "## 3. Review a page" }))
        .problems,
    ).toEqual(['missing section "## 2. Review a page"']);
  });

  test("reports a review command it does not follow", () => {
    const parsed = parseGettingStarted(doc({ review: ["idiom check"] }));
    expect(parsed.problems).toEqual([
      'unrecognised review line: "idiom check"',
      'review block has no "idiom quick <url>" line',
    ]);
  });
});

describe("commands", () => {
  test("installCommand pins the documented line to a version or a tarball", () => {
    const npmLine = "npm install -g @mattskilly/idiom";
    expect(installCommand({ npmLine, version: "0.22.0" })).toEqual([
      "npm",
      "install",
      "-g",
      "@mattskilly/idiom@0.22.0",
    ]);
    expect(
      installCommand({ npmLine, tarball: "/tmp/mattskilly-idiom-0.22.0.tgz" }),
    ).toEqual(["npm", "install", "-g", "/tmp/mattskilly-idiom-0.22.0.tgz"]);
    expect(() =>
      installCommand({ npmLine: "npm i -g other", version: "1.0.0" }),
    ).toThrow(/unexpected install line/);
    expect(() =>
      installCommand({ npmLine, version: "1.0.0", tarball: "/x.tgz" }),
    ).toThrow(/not both/);
  });

  test("quickCommand swaps only the documented placeholder", () => {
    expect(
      quickCommand({
        quickLine: "idiom quick http://localhost:3000",
        placeholderUrl: "http://localhost:3000",
        sampleUrl: "http://127.0.0.1:5000/",
      }),
    ).toEqual(["idiom", "quick", "http://127.0.0.1:5000/"]);
    expect(() =>
      quickCommand({
        quickLine: "idiom quick --literal http://localhost:3000",
        placeholderUrl: "http://localhost:3000",
        sampleUrl: "http://127.0.0.1:5000/",
      }),
    ).toThrow(/unexpected review line/);
  });
});

describe("cleanEnvironment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  test("carries nothing from the parent process", () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/shared/browsers";
    process.env.npm_config_registry = "https://registry.example";
    process.env.NODE_OPTIONS = "--inspect";
    const env = cleanEnvironment({ root: "/r", nodeBin: "/node/bin" });
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "LANG",
        "PATH",
        "TERM",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "npm_config_cache",
        "npm_config_prefix",
        "npm_config_userconfig",
      ].sort(),
    );
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH.split(":").slice(0, 2)).toEqual([
      "/r/prefix/bin",
      "/node/bin",
    ]);
    expect(env.HOME).toBe("/r/home");
    expect(env.XDG_CACHE_HOME).toBe("/r/home/.cache");
    expect(env.npm_config_userconfig).toBe("/r/home/.npmrc");
  });
});

describe("parseQuickSummary", () => {
  test("reads the CLI's summary line", () => {
    const stdout = [
      "Capturing…",
      "Quick review: 3 finding(s), 8 capture(s) — probed 1 page(s) — Markdown: /x/run/report.md — HTML: /x/run/report.html",
    ].join("\n");
    expect(parseQuickSummary(stdout)).toEqual({
      count: 3,
      reportPath: "/x/run/report.md",
    });
  });

  test("reads zero findings and rejects anything else", () => {
    expect(
      parseQuickSummary(
        "Quick review: 0 finding(s), 4 capture(s) — not probed — Markdown: /y/report.md — HTML: /y/report.html",
      ),
    ).toEqual({ count: 0, reportPath: "/y/report.md" });
    expect(parseQuickSummary("error: could not reach the page")).toBeNull();
    expect(parseQuickSummary("")).toBeNull();
  });
});

describe("evaluateRun", () => {
  const steps = (...ms: number[]): Step[] =>
    ["install", "browser", "first-finding"].map((id, index) => ({
      id,
      ms: ms[index] ?? 0,
      ok: true,
    }));
  const finding = { count: 2, ruleId: "contrast", title: "Low contrast" };

  test("passes under budget", () => {
    expect(
      evaluateRun({
        steps: steps(10_000, 60_000, 20_000),
        firstFinding: finding,
      }),
    ).toEqual({ totalMs: 90_000, passed: true, failure: null });
  });

  test("names the slowest step when over budget", () => {
    const result = evaluateRun({
      steps: steps(30_000, 250_000, 40_000),
      firstFinding: finding,
    });
    expect(result.passed).toBe(false);
    expect(result.totalMs).toBe(320_000);
    expect(result.failure).toBe(
      "total 320.0s exceeds 300.0s budget (slowest step: browser 250.0s)",
    );
    expect(BUDGET_MS).toBe(300_000);
  });

  test("fails when no finding appears", () => {
    expect(
      evaluateRun({
        steps: steps(1, 1, 1),
        firstFinding: { count: 0, ruleId: null, title: null },
      }).failure,
    ).toBe("no finding appeared");
    expect(
      evaluateRun({ steps: steps(1, 1, 1), firstFinding: null }).failure,
    ).toBe("no finding appeared");
  });

  test("names a failed step", () => {
    const failed = steps(1, 1);
    failed[1] = { id: "browser", ms: 1, ok: false, note: "exit 1" };
    expect(evaluateRun({ steps: failed, firstFinding: null }).failure).toBe(
      "step browser failed: exit 1",
    );
  });

  test("reports docs drift ahead of everything else", () => {
    const result = evaluateRun({
      steps: [{ id: "install", ms: 5, ok: false }],
      firstFinding: null,
      docsProblems: ['unrecognised install line: "idiom setup"'],
    });
    expect(result).toEqual({
      totalMs: 5,
      passed: false,
      failure: 'docs drift: unrecognised install line: "idiom setup"',
    });
  });
});

describe("record", () => {
  const run = {
    idiomVersion: "0.22.0",
    source: { kind: "npm", spec: "@mattskilly/idiom@0.22.0" },
    steps: [{ id: "install", command: "npm install -g x", ms: 1000, ok: true }],
    totalMs: 1000,
    budgetMs: 300_000,
    firstFinding: { count: 1, ruleId: "contrast", title: "Low contrast" },
    passed: true,
    failure: null,
  };

  test("appendRun creates, appends and pretty-prints", () => {
    const created = appendRun(undefined, run);
    expect(created.endsWith("}\n")).toBe(true);
    expect(JSON.parse(created)).toEqual({ version: 1, runs: [run] });
    expect(created).toContain('\n  "runs": [\n');
    const appended = appendRun(created, { ...run, totalMs: 2000 });
    expect(JSON.parse(appended).runs.map((r: typeof run) => r.totalMs)).toEqual(
      [1000, 2000],
    );
  });

  test("appendRun refuses an unknown record version", () => {
    expect(() => appendRun('{"version":2,"runs":[]}', run)).toThrow(
      /unsupported first-run record version: 2/,
    );
  });

  test("formatTable prints each step, the total and the verdict", () => {
    const table = formatTable(run);
    expect(table).toContain("install");
    expect(table).toContain("1.0s");
    expect(table).toContain("1 finding(s); first: contrast — Low contrast");
    expect(table).toContain("not counted: sample server start");
    expect(table.endsWith("first-run: PASSED")).toBe(true);
    expect(
      formatTable({ ...run, passed: false, failure: "no finding appeared" }),
    ).toContain("first-run: FAILED — no finding appeared");
  });
});
