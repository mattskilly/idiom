import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error The build-setup helpers are plain Node ESM without declarations.
import * as lib from "../scripts/check-pipelines-lib.mjs";
// @ts-expect-error The step runner is plain Node ESM without declarations.
import { runStep, stepNote } from "../scripts/process-step.mjs";
import { githubWriter, PR_DISCOVERY } from "../src/wiring/github.js";
import type { WiringDetection } from "../src/wiring/types.js";

const {
  agentSignals,
  appendRun,
  applyLine,
  autobuildWired,
  claudeShellEquivalents,
  cursorChecklist,
  evaluateSetup,
  formatTable,
  manualPending,
  notRun,
  outputNamesRule,
  overallVerdict,
  parseAgentInstall,
  parseAutobuildSetup,
  parseAutobuildWiring,
  parseStepOutputs,
  parseWorkflowJob,
  plantedInCheckJson,
  resolveExpressions,
  TASK_PROMPT,
  validateCursorResult,
} = lib;

const repositoryRoot = join(import.meta.dirname, "..");
/** A literal GitHub expression, `${{ inner }}`. */
const expr = (inner: string) => `\${{ ${inner} }}`;
const fixtureRoot = join(repositoryRoot, "scripts", "fixtures", "pipelines");
const regression = JSON.parse(
  readFileSync(join(fixtureRoot, "regression.json"), "utf8"),
);
const gettingStarted = readFileSync(
  join(repositoryRoot, "site", "docs", "getting-started.md"),
  "utf8",
);
const configuration = readFileSync(
  join(repositoryRoot, "docs", "configuration.md"),
  "utf8",
);

const ok = (id: string) => ({ id, command: id, ms: 1, ok: true });
const passing = (id: string) =>
  evaluateSetup({ id, steps: [ok("a")], caught: true, fixVerified: true });

describe("setup results", () => {
  test("notRun is never passed, keeps install steps and needs a reason", () => {
    const result = notRun("codex", "codex is not installed", {
      steps: [ok("install-1")],
      installedVersion: "0.23.0",
    });
    expect(result.status).toBe("not-run");
    expect(result.caught).toBeNull();
    expect(result.fixVerified).toBeNull();
    expect(result.steps).toHaveLength(1);
    expect(result.installedVersion).toBe("0.23.0");
    expect(() => notRun("codex", "")).toThrow(/reason/);
    expect(() => notRun("codex", "   ")).toThrow(/reason/);
  });

  test("evaluateSetup orders drift, failed steps, signals, catch, verify", () => {
    const drift = { step: "install", doc: "d", expected: "e", found: "f" };
    expect(
      evaluateSetup({
        id: "codex",
        steps: [ok("a")],
        caught: true,
        fixVerified: true,
        docsDrift: [drift],
      }),
    ).toMatchObject({ status: "failed", reason: "docs drift: install: f" });
    expect(
      evaluateSetup({
        id: "codex",
        steps: [{ ...ok("a"), ok: false, note: "exit 1" }],
        caught: true,
        fixVerified: true,
      }).reason,
    ).toBe("step a failed: exit 1");
    expect(
      evaluateSetup({
        id: "claude-code",
        steps: [ok("a")],
        caught: true,
        fixVerified: true,
        extra: { required: { reminderFired: false } },
      }).reason,
    ).toBe("required signal missing: reminderFired");
    expect(
      evaluateSetup({
        id: "codex",
        steps: [],
        caught: false,
        fixVerified: true,
      }).reason,
    ).toMatch(/not caught/);
    expect(
      evaluateSetup({ id: "codex", steps: [], caught: true, fixVerified: null })
        .reason,
    ).toMatch(/not verified/);
    expect(passing("codex")).toMatchObject({ status: "passed", reason: null });
  });

  test("overallVerdict: passed, failed and incomplete", () => {
    const cursor = validateCursorResult({
      recordedAt: "2026-11-15T00:00:00Z",
      installedVersion: "0.23.0",
      caught: true,
      fixVerified: true,
      wallMs: 1000,
      docsDrift: [],
    });
    const headless = ["autobuild", "github-action", "claude-code", "codex"].map(
      passing,
    );
    expect(overallVerdict([...headless, cursor])).toEqual({
      verdict: "passed",
      exitCode: 0,
      notRun: [],
    });
    expect(
      overallVerdict([
        ...headless.slice(0, 3),
        evaluateSetup({ id: "codex", steps: [], caught: false }),
        cursor,
      ]),
    ).toMatchObject({ verdict: "failed", exitCode: 1 });
    const incomplete = overallVerdict([
      ...headless.slice(0, 2),
      notRun("claude-code", "no model credentials"),
      notRun("codex", "codex is not installed"),
      cursor,
    ]);
    expect(incomplete).toEqual({
      verdict: "incomplete",
      exitCode: 0,
      notRun: [
        { id: "claude-code", reason: "no model credentials" },
        { id: "codex", reason: "codex is not installed" },
      ],
    });
    const pending = overallVerdict([
      ...headless,
      manualPending("cursor", "manual"),
    ]);
    expect(pending).toMatchObject({ verdict: "incomplete", exitCode: 0 });
    expect(pending.notRun).toEqual([{ id: "cursor", reason: "manual" }]);
  });

  test("appendRun creates, appends and rejects a wrong version", () => {
    const first = appendRun(undefined, { measuredAt: "a" });
    expect(JSON.parse(first)).toEqual({
      version: 1,
      runs: [{ measuredAt: "a" }],
    });
    const second = appendRun(first, { measuredAt: "b" });
    expect(JSON.parse(second).runs).toHaveLength(2);
    expect(() => appendRun('{"version":9,"runs":[]}', {})).toThrow(/version/);
  });

  test("formatTable prints a NOT RUN row with its reason, never as passed", () => {
    const run = {
      idiomVersion: "0.23.0",
      source: { kind: "npm" },
      setups: [
        passing("autobuild"),
        notRun("claude-code", "no model credentials in the isolated home"),
      ],
      verdict: "incomplete",
    };
    const table = formatTable(run);
    const row = table
      .split("\n")
      .find((line: string) => line.trim().startsWith("claude-code"));
    expect(row).toMatch(/NOT RUN/);
    expect(row).not.toMatch(/passed/);
    expect(table).toMatch(
      /claude-code: no model credentials in the isolated home/,
    );
    expect(table).toMatch(/INCOMPLETE/);
  });
});

describe("docs parsers", () => {
  test("parseAgentInstall reads the real getting-started page", () => {
    const parsed = parseAgentInstall(gettingStarted);
    expect(parsed.problems).toBeUndefined();
    expect(parsed.value.claude.lines).toEqual([
      "/plugin marketplace add mattskilly/idiom",
      "/plugin install idiom@idiom",
    ]);
    expect(parsed.value.codex.lines).toHaveLength(3);
    const version = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ).version;
    expect(parsed.value.codex.urlVersion).toBe(version);
    expect(claudeShellEquivalents(parsed.value.claude.lines)).toEqual([
      ["claude", "plugin", "marketplace", "add", "mattskilly/idiom"],
      ["claude", "plugin", "install", "idiom@idiom"],
    ]);
  });

  test("parseAgentInstall reports drift on a mutated page", () => {
    expect(
      parseAgentInstall(
        gettingStarted.replace("/plugin install idiom@idiom\n", ""),
      ).problems,
    ).toContain('Claude Code block has no "/plugin install" line');
    const mismatched = gettingStarted.replace(
      /download\/v(\d+\.\d+\.\d+)\//,
      "download/v9.9.9/",
    );
    expect(parseAgentInstall(mismatched).problems?.[0]).toMatch(
      /unexpected release package URL/,
    );
    expect(
      parseAgentInstall(
        gettingStarted.replace("## 3. Hand it", "## 3. Give it"),
      ).problems,
    ).toEqual(['missing section "## 3. Hand it to your agent"']);
  });

  test("parseAutobuildWiring reads configuration.md's manual wiring", () => {
    const parsed = parseAutobuildWiring(configuration);
    expect(parsed.problems).toBeUndefined();
    expect(parsed.value.command).toBe(
      "idiom check --gate --fail-on major --deferred warn",
    );
    expect(parsed.value.verify).toEqual({
      kind: "agent",
      skill: "idiom-verify",
    });
    expect(
      autobuildWired(
        `[commands]\nidiom-check = "${parsed.value.command}"\n[verify]\nsteps = ["test", "idiom-check"]\n[verify.idiom-check]\nkind = "agent"\nskill = "idiom-verify"\n`,
      ),
    ).toEqual({
      command: parsed.value.command,
      inSteps: true,
      verify: { kind: "agent", skill: "idiom-verify" },
      designReview: false,
    });
    const missing = configuration.replace(
      /```toml\n\[commands\]\nidiom-check = [^\n]+\n/,
      "```toml\n[commands]\n",
    );
    expect(parseAutobuildWiring(missing).ok).toBe(false);
  });

  test("parseAutobuildSetup reads the documented noninteractive setup command", () => {
    expect(parseAutobuildSetup(configuration)).toEqual({
      ok: true,
      value: { argv: ["idiom", "upgrade", "--yes"] },
    });
    const withoutSetup = configuration.replace(
      /^idiom upgrade --yes {2,}#[^\n]*\n/m,
      "",
    );
    expect(withoutSetup).not.toBe(configuration);
    expect(parseAutobuildSetup(withoutSetup).ok).toBe(false);
    expect(
      parseAutobuildSetup(
        "## Autobuild\n\n```sh\nidiom upgrade --yes --dry-run\n```\n",
      ).ok,
    ).toBe(false);
    expect(parseAutobuildSetup("## Other\n").ok).toBe(false);
  });
});

const npmDetection: WiringDetection = {
  signals: {},
  agents: { claude: false, codex: false },
  defaultBranch: "main",
  branchReason: "test",
  setup: { manager: "npm", command: "npm ci" },
};

describe("workflow", () => {
  test("parseWorkflowJob reads the workflow githubWriter writes", () => {
    const { candidate } = githubWriter("", npmDetection, false);
    const parsed = parseWorkflowJob(candidate);
    expect(parsed.problems).toBeUndefined();
    const kinds = parsed.value.steps.map((step: { kind: string }) => step.kind);
    expect(kinds).toEqual([
      "infrastructure",
      "infrastructure",
      "run",
      "action",
    ]);
    const flowStep = parsed.value.steps[2];
    expect(flowStep.id).toBe("flow");
    const action = parsed.value.steps[3];
    expect(action.ref).toBe("main");
    expect(action.with.flow).toBe(expr("steps.flow.outputs.flow"));
  });

  test("a bun workflow's setup-bun step is unsupported", () => {
    const { candidate } = githubWriter(
      "",
      { ...npmDetection, setup: { manager: "bun", command: "bun install" } },
      false,
    );
    const parsed = parseWorkflowJob(candidate);
    const unsupported = parsed.value.steps.filter(
      (step: { kind: string }) => step.kind === "unsupported",
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0].uses).toMatch(/^oven-sh\/setup-bun@/);
  });

  test("a workflow without the Action step is drift", () => {
    expect(
      parseWorkflowJob(
        "jobs:\n  pull-request:\n    steps:\n      - run: echo hi\n",
      ).problems,
    ).toEqual(["pull-request job has no mattskilly/idiom@<ref> step"]);
    expect(parseWorkflowJob("jobs: {}\n").problems).toEqual([
      "workflow has no pull-request job",
    ]);
  });

  test("resolveExpressions resolves step outputs and github context, never passes through", () => {
    expect(
      resolveExpressions(expr("steps.flow.outputs.flow"), {
        steps: { flow: { flow: "home" } },
      }),
    ).toEqual({ ok: true, value: "home" });
    expect(
      resolveExpressions(expr("github.event.pull_request.head.sha"), {
        github: { event: { pull_request: { head: { sha: "abc" } } } },
      }),
    ).toEqual({ ok: true, value: "abc" });
    expect(
      resolveExpressions(expr("steps.flow.outputs.flow"), { steps: {} }),
    ).toEqual({ ok: false, unresolved: [expr("steps.flow.outputs.flow")] });
    expect(resolveExpressions(`x-${expr("secrets.X")}`, {})).toEqual({
      ok: false,
      unresolved: [expr("secrets.X")],
    });
    expect(resolveExpressions("npm ci", {})).toEqual({
      ok: true,
      value: "npm ci",
    });
  });

  test("parseStepOutputs handles key=value and heredoc lines", () => {
    expect(
      parseStepOutputs("flow=home\nbody<<EOF\nline 1\nline 2\nEOF\nempty=\n"),
    ).toEqual({ flow: "home", body: "line 1\nline 2", empty: "" });
  });

  test("the real PR discovery script outputs flow=home for the fixture", () => {
    const work = mkdtempSync(join(tmpdir(), "idiom-pipelines-test-"));
    try {
      cpSync(join(fixtureRoot, "app"), work, { recursive: true });
      const output = join(work, "github-output");
      const script = `node <<'IDIOM_NODE'\n${PR_DISCOVERY}\nIDIOM_NODE`;
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
        {
          cwd: work,
          env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
          encoding: "utf8",
        },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(parseStepOutputs(readFileSync(output, "utf8"))).toEqual({
        flow: "home",
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("agent signals", () => {
  const claudeLine = (value: unknown) => JSON.stringify(value);
  const toolUse = (id: string, name: string, input: object) =>
    claudeLine({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
  const toolResult = (id: string, content: string) =>
    claudeLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
    });
  const hook = claudeLine({
    type: "system",
    subtype: "hook_response",
    output: "UI changed: public/index.html. Run idiom check.",
  });
  const caughtOutput = "1. [major] contrast — home/desktop/light — .note";

  test("reminder, check, fix and verify in order", () => {
    const signals = agentSignals(
      [
        toolUse("1", "Edit", { file_path: "/r/public/index.html" }),
        hook,
        toolUse("2", "mcp__plugin_idiom_idiom__check", { flow: "home" }),
        toolResult("2", caughtOutput),
        toolUse("3", "Edit", { file_path: "/r/public/styles.css" }),
        toolUse("4", "Bash", { command: "idiom check --changed" }),
        toolResult("4", "clean"),
      ],
      "claude-code",
      regression,
    );
    expect(signals).toMatchObject({
      reminderFired: true,
      checkRan: true,
      caught: true,
      fixed: true,
      verifyRan: true,
    });
  });

  test("a check before the fix is not a verify", () => {
    const signals = agentSignals(
      [
        toolUse("2", "Bash", { command: "idiom check --changed" }),
        toolResult("2", caughtOutput),
        toolUse("3", "Bash", { command: "idiom check --changed" }),
        toolUse("4", "Edit", { file_path: "/r/public/styles.css" }),
      ],
      "claude-code",
      regression,
    );
    expect(signals).toMatchObject({
      reminderFired: false,
      caught: true,
      fixed: true,
      verifyRan: false,
    });
  });

  test("codex exec --json items", () => {
    const item = (value: object) =>
      JSON.stringify({ type: "item.completed", item: value });
    const signals = agentSignals(
      [
        item({
          type: "command_execution",
          command: "bash -lc 'idiom check --changed'",
          aggregated_output: caughtOutput,
        }),
        item({
          type: "file_change",
          changes: [{ path: "/r/public/styles.css", kind: "update" }],
        }),
        item({
          type: "mcp_tool_call",
          server: "idiom",
          tool: "check",
          result: { content: [] },
        }),
      ],
      "codex",
      regression,
    );
    expect(signals).toMatchObject({
      reminderFired: null,
      caught: true,
      fixed: true,
      verifyRan: true,
    });
  });

  test("check output matchers", () => {
    expect(outputNamesRule(caughtOutput, regression)).toBe(true);
    expect(outputNamesRule("[minor] contrast", regression)).toBe(false);
    expect(outputNamesRule("Rules: axe:color-contrast", regression)).toBe(true);
    expect(
      plantedInCheckJson(
        {
          gate: { plan: { skipped: false } },
          checks: [
            {
              summary: {
                findings: [
                  {
                    category: "contrast",
                    rule: "axe:color-contrast",
                    severity: "major",
                  },
                ],
              },
            },
          ],
        },
        regression,
      ).planted,
    ).toBe(true);
  });
});

describe("cursor", () => {
  const valid = {
    recordedAt: "2026-11-15T00:00:00Z",
    installedVersion: "0.23.0",
    caught: true,
    fixVerified: false,
    wallMs: 1200,
    docsDrift: [],
  };

  test("validateCursorResult accepts a result and names a bad field", () => {
    expect(validateCursorResult(valid)).toMatchObject({
      id: "cursor",
      status: "failed",
      reason: "the fix was not verified",
    });
    expect(validateCursorResult({ ...valid, fixVerified: true }).status).toBe(
      "manual-recorded",
    );
    expect(() => validateCursorResult({ ...valid, caught: "yes" })).toThrow(
      /caught must be a boolean/,
    );
    const { wallMs: _, ...noWall } = valid;
    expect(() => validateCursorResult(noWall)).toThrow(/wallMs/);
    expect(() =>
      validateCursorResult({ ...valid, docsDrift: [{ step: 1 }] }),
    ).toThrow(/docsDrift/);
  });

  test("the checklist names install, prompt, record command and every field", () => {
    const text = cursorChecklist({
      installLines: [
        "npm install -g @mattskilly/idiom",
        "npx playwright@1.62.1 install chromium",
      ],
      regressionBranch: "regression",
      repoPath: "/tmp/origin.git",
      taskPrompt: TASK_PROMPT,
      recordCommand:
        "bun run check:pipelines --only cursor --cursor-result <file>",
    });
    expect(text).toContain("npm install -g @mattskilly/idiom");
    expect(text).toContain("npx playwright@1.62.1 install chromium");
    expect(text).toContain(".cursor/rules/idiom.mdc");
    expect(text).toContain(TASK_PROMPT);
    expect(text).toContain("--cursor-result <file>");
    for (const field of [
      "recordedAt",
      "installedVersion",
      "caught",
      "fixVerified",
      "wallMs",
      "docsDrift",
    ])
      expect(text).toContain(`${field}:`);
  });
});

describe("fixture", () => {
  test("applyLine needs exactly one match", () => {
    expect(applyLine("a\nb\nc", "b", "x")).toBe("a\nx\nc");
    expect(() => applyLine("a\nc", "b", "x")).toThrow(/found 0/);
    expect(() => applyLine("b\nb", "b", "x")).toThrow(/found 2/);
  });

  test("the planted regression and fix are each one line", async () => {
    const clean = await readFile(
      join(fixtureRoot, "app", regression.file),
      "utf8",
    );
    const planted = applyLine(clean, regression.line, regression.regression);
    const fixed = applyLine(planted, regression.regression, regression.fix);
    const differing = (a: string, b: string) => {
      const left = a.split("\n");
      const right = b.split("\n");
      expect(left).toHaveLength(right.length);
      return left.filter((line, index) => line !== right[index]).length;
    };
    expect(differing(clean, planted)).toBe(1);
    expect(differing(planted, fixed)).toBe(1);
    expect(regression.fix).not.toBe(regression.line);
  });

  test("the base fixture carries no agent, CI or Autobuild wiring", () => {
    for (const path of [
      "AGENTS.md",
      "CLAUDE.md",
      ".cursor",
      ".github",
      "autobuild.toml",
    ])
      expect(() => readFileSync(join(fixtureRoot, "app", path))).toThrow();
  });
});

describe("process-step", () => {
  test("a step past its timeout is killed by its own PID and reported", async () => {
    const result = await runStep(
      "sleep",
      [process.execPath, "-e", "setTimeout(() => {}, 1e5)"],
      { env: process.env, cwd: repositoryRoot, timeoutMs: 200, quiet: true },
    );
    expect(result.timedOut).toBe(true);
    expect(stepNote(result)).toBe("timed out after 0.2s");
  });
});

describe("release docs", () => {
  test("releases.md and package.json carry the check", () => {
    const releases = readFileSync(
      join(repositoryRoot, "docs", "releases.md"),
      "utf8",
    );
    expect(releases).toContain("bun run check:pipelines");
    expect(releases).toContain("docs/pipelines.json");
    const scripts = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ).scripts;
    expect(scripts["check:pipelines"]).toBe("node scripts/check-pipelines.mjs");
  });
});
