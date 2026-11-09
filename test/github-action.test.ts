import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
// @ts-expect-error Action helpers run directly in Node without package dependencies.
import * as commentHelpers from "../scripts/github-action/comment.mjs";
// @ts-expect-error Action helpers run directly in Node without package dependencies.
import * as commonHelpers from "../scripts/github-action/common.mjs";
import { fixtureCommand } from "./support/fixture-server.js";

const { marker, publishResult, renderComment, upsertComment } = commentHelpers;
const { childEnvironment, evidencePath, gate, validateInputs } = commonHelpers;

// @ts-expect-error The production helper's executable seam uses the built npm CLI.
import { runAction } from "../scripts/github-action/run.mjs";
import { baselineRecordCommand } from "../src/commands/baseline.js";
import {
  baselineProject,
  commit,
  git,
  storedBaselineRun,
} from "./baseline-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const inputs = {
  flow: "studio",
  project: ".",
  version: "latest",
  failOn: "minor",
  setup:
    "node -e 'if(process.env.IDIOM_ACTION_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN) process.exit(1)'",
};
const fixture = join(import.meta.dirname, "fixtures/github-action");
const cli = [process.execPath, resolve("build/cli.js")];
async function graph(temporal = false) {
  const { project, configPath } = await baselineProject();
  directories.push(project);
  const temporary = await mkdtemp(join(tmpdir(), "idiom-action-test-"));
  directories.push(temporary);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.server = {
    build: "node --check server.mjs",
    start: fixtureCommand("server.mjs"),
    port: 3123,
    readyUrl: "http://127.0.0.1:3123",
    env: {},
  };
  config.capture = {
    settleMs: 0,
    ...(temporal
      ? { reducedMotion: false, filmstrips: { actions: ["#show"] } }
      : {}),
  };
  config.checks = { probe: { enabled: false } };
  config.baselines = { directory: join(temporary, "shared-baselines") };
  await writeFile(configPath, JSON.stringify(config));
  const flow = JSON.parse(
    await readFile(join(project, ".idiom/flows/studio.json"), "utf8"),
  );
  flow.states[0].expect = { status: 200 };
  if (temporal) flow.states[0].steps = [{ action: "click", selector: "#show" }];
  await writeFile(
    join(project, ".idiom/flows/studio.json"),
    JSON.stringify(flow),
  );
  await copyFile(join(fixture, "server.mjs"), join(project, "server.mjs"));
  await copyFile(
    join(fixture, temporal ? "temporal-base.html" : "before.html"),
    join(project, "index.html"),
  );
  const baseline = await commit(project, "common ancestor");
  await git(project, "checkout", "-qb", "feature");
  await copyFile(
    join(fixture, temporal ? "temporal-regression.html" : "after.html"),
    join(project, "index.html"),
  );
  const head = await commit(project, "add regression");
  // Commit a nearer accepted baseline on head that would hide the new finding.
  await storedBaselineRun(project, "accepted-head", head, [
    {
      html: await readFile(join(fixture, "after.html"), "utf8"),
      mismatches: [],
    },
  ]);
  await baselineRecordCommand({
    project,
    flow: "studio",
    from: "accepted-head",
  });
  const shared = await readFile(
    join(temporary, "shared-baselines/studio.json"),
    "utf8",
  );
  await cp(
    join(temporary, "shared-baselines"),
    join(project, ".idiom/baselines"),
    { recursive: true },
  );
  const finalHead = await commit(project, "accept head findings");
  await git(project, "checkout", "-q", "main");
  await writeFile(
    join(project, "base-only.txt"),
    "base advanced independently",
  );
  const baseTip = await commit(project, "advance base");
  const event = {
    pull_request: {
      number: 42,
      base: { sha: baseTip, repo: { full_name: "owner/repo" } },
      head: { sha: finalHead, repo: { full_name: "owner/repo" } },
    },
  };
  return { project, temporary, baseline, head: finalHead, event, shared };
}

test("Action without a flow input plans the affected flow, runs the built CLI at a diverging merge base, preserves the checkout, stages actual crops/composites, and ignores head acceptance", async () => {
  const context = await graph();
  const beforeStatus = await git(context.project, "status", "--porcelain");
  const result = await runAction({
    inputs: { ...inputs, flow: "" },
    event: context.event,
    cwd: context.project,
    temporary: context.temporary,
    cli,
    env: {
      ...process.env,
      IDIOM_ACTION_TOKEN: "private-token",
      GITHUB_TOKEN: "private-token",
      GH_TOKEN: "private-token",
      GITHUB_OUTPUT: join(context.temporary, "outputs"),
    },
  });
  expect(result.result.operationalErrors).toEqual([]);
  expect(result.result.plannedFlows).toEqual(["studio"]);
  expect(result.result.plan).toContain("idiom check --gate");
  const entry = result.result.flows[0];
  const flowEvidence = join(result.evidence, "studio");
  expect(entry.flow).toBe("studio");
  const outputs = await readFile(join(context.temporary, "outputs"), "utf8");
  expect(outputs).toContain(`baseline-sha=${context.baseline}`);
  expect(outputs).toContain("new-findings=1");
  expect(outputs).toContain("outcome=checked");
  expect(outputs).toContain(`evidence-directory=${result.evidence}`);
  expect(
    await readFile(join(result.evidence, "diagnostics.log"), "utf8"),
  ).not.toContain("private-token");
  expect(result.result.baseline).toBe(context.baseline);
  expect(result.result.baseline).not.toBe(context.event.pull_request.base.sha);
  expect(entry.summary.findings).toHaveLength(1);
  expect(entry.summary.preExistingFindings).toHaveLength(1);
  expect(entry.summary.findings[0].selector).toBe("#regression");
  expect(entry.crops).toHaveLength(1);
  expect(entry.crops[0].label).toBe("Element crop");
  expect(entry.composites).toHaveLength(1);
  for (const item of [...entry.crops, ...entry.composites])
    expect(
      PNG.sync.read(await readFile(join(flowEvidence, item.path))).width,
    ).toBeGreaterThan(0);
  const index = await readFile(join(flowEvidence, "index.html"), "utf8");
  expect(index).toContain('href="../result.json"');
  expect(
    await readFile(join(flowEvidence, "comparison.json"), "utf8"),
  ).toContain(context.baseline);
  expect(await readFile(join(result.evidence, "index.html"), "utf8")).toContain(
    'href="studio/index.html"',
  );
  expect(index).toContain(`src="${entry.crops[0].path}"`);
  expect(index).toContain(`src="${entry.composites[0].path}"`);
  expect(await git(context.project, "rev-parse", "HEAD")).toBe(
    context.event.pull_request.base.sha,
  );
  expect(await git(context.project, "status", "--porcelain")).toBe(
    beforeStatus,
  );
  expect(
    await git(context.project, "worktree", "list", "--porcelain"),
  ).not.toContain("scratch");
  expect(await readdir(dirname(result.evidence))).toEqual(["evidence"]);
  expect(
    await readFile(
      join(context.temporary, "shared-baselines/studio.json"),
      "utf8",
    ),
  ).toBe(context.shared);
  expect(() => gate(result.result)).toThrow("1 new finding");
  expect(() => gate({ ...result.result, failOn: "never" })).not.toThrow();
}, 60_000);

test("Action operational errors survive never: missing history/flow, setup and capture/compare/JSON failures", async () => {
  const context = await graph();
  const cases = [
    {
      options: { inputs: { ...inputs, flow: "missing" } },
      match: /missing\.json/,
    },
    {
      options: {
        event: {
          pull_request: {
            ...context.event.pull_request,
            base: { sha: "f".repeat(40) },
          },
        },
      },
      match: /Missing commit/,
    },
    { options: { inputs: { ...inputs, setup: "exit 7" } }, match: /exited 7/ },
  ];
  for (const item of cases) {
    const { result } = await runAction({
      inputs,
      event: context.event,
      cwd: context.project,
      temporary: context.temporary,
      cli,
      ...item.options,
    });
    expect(result.operationalErrors.join("\n")).toMatch(item.match);
    expect(() => gate({ ...result, failOn: "never" })).toThrow();
  }
  for (const mode of ["capture", "compare", "json"]) {
    const wrapper = join(context.temporary, `fail-${mode}.mjs`);
    await writeFile(
      wrapper,
      `import { spawnSync } from 'node:child_process'; const args=process.argv.slice(2); if (${JSON.stringify(mode)}==='json' && args[0]==='check') { console.log('broken JSON'); } else if(args[0]===${JSON.stringify(mode)}) { process.exit(9); } else { const r=spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cli[1])},...args], {stdio:'inherit'}); process.exit(r.status ?? 1); }`,
    );
    const { result, evidence } = await runAction({
      inputs,
      event: context.event,
      cwd: context.project,
      temporary: context.temporary,
      cli: [process.execPath, wrapper],
    });
    if (mode === "compare") {
      const [entry] = result.flows;
      expect(entry.crops).toHaveLength(1);
      expect(
        PNG.sync.read(
          await readFile(join(evidence, "studio", entry.crops[0].path)),
        ).width,
      ).toBeGreaterThan(0);
    }
    expect(result.operationalErrors.length).toBeGreaterThan(0);
    expect(() => gate({ ...result, failOn: "never" })).toThrow();
    expect(
      await git(context.project, "worktree", "list", "--porcelain"),
    ).not.toContain("scratch");
  }
  const clone = join(context.temporary, "shallow");
  await git(
    context.project,
    "clone",
    "--depth=1",
    `file://${context.project}`,
    clone,
  );
  const { result } = await runAction({
    inputs,
    event: context.event,
    cwd: clone,
    temporary: context.temporary,
    cli,
  });
  expect(result.operationalErrors.join("\n")).toContain("fetch-depth: 0");
}, 60_000);

async function branchCommit(
  project: string,
  from: string,
  path: string,
  content: string,
) {
  await git(project, "checkout", "-q", "--detach", from);
  await mkdir(dirname(join(project, path)), { recursive: true });
  await writeFile(join(project, path), content);
  const sha = await commit(project, `change ${path}`);
  await git(project, "checkout", "-q", "main");
  return sha;
}

test("a backend-only change skips before browsers, setup or capture", async () => {
  const context = await graph();
  const head = await branchCommit(
    context.project,
    context.head,
    "docs/notes.md",
    "# Backend notes\n",
  );
  let browsers = 0;
  const marker = join(context.temporary, "setup-ran");
  const { result, evidence } = await runAction({
    inputs: { ...inputs, flow: "", setup: `touch '${marker}'` },
    event: {
      pull_request: {
        number: 43,
        base: { sha: context.head, repo: { full_name: "owner/repo" } },
        head: { sha: head, repo: { full_name: "owner/repo" } },
      },
    },
    cwd: context.project,
    temporary: context.temporary,
    cli,
    installBrowsers: async () => {
      browsers += 1;
    },
    env: { ...process.env, GITHUB_OUTPUT: join(context.temporary, "out") },
  });
  expect(result.operationalErrors).toEqual([]);
  expect(result.skipped.line).toMatch(
    /^no UI changes since [0-9a-f]{12}; skipped$/,
  );
  expect(browsers).toBe(0);
  await expect(readFile(marker)).rejects.toThrow();
  const log = await readFile(join(evidence, "diagnostics.log"), "utf8");
  expect(log).toContain("--plan-only");
  expect(log).not.toMatch(/ capture /);
  expect(result.flows).toEqual([]);
  expect(gate(result)).toMatchObject({ skipped: result.skipped });
  expect(await readFile(join(context.temporary, "out"), "utf8")).toContain(
    "outcome=skipped",
  );
  expect(
    await git(context.project, "worktree", "list", "--porcelain"),
  ).not.toContain("scratch");
}, 60_000);

test("push compares the previous commit on the branch, falling back to the parent for a new branch", async () => {
  const context = await graph();
  const pushed = await runAction({
    inputs: { ...inputs, flow: "" },
    event: { before: context.baseline, after: context.head },
    cwd: context.project,
    temporary: context.temporary,
    cli,
    env: { ...process.env, GITHUB_EVENT_NAME: "push" },
  });
  expect(pushed.result.operationalErrors).toEqual([]);
  expect(pushed.result.mode).toBe("push");
  expect(pushed.result.baseline).toBe(context.baseline);
  expect(pushed.result.pr).toBeUndefined();
  expect(pushed.result.flows[0].summary.findings).toHaveLength(1);
  expect(pushed.result.flows[0].previousHead).toBeUndefined();
  expect(() => gate(pushed.result)).toThrow("1 new finding");
  expect(renderComment(pushed.result, artifact)).toContain(
    `previous commit: ${context.baseline}`,
  );
  const created = await runAction({
    inputs,
    event: { before: "0".repeat(40), after: context.head },
    cwd: context.project,
    temporary: context.temporary,
    cli,
    env: { ...process.env, GITHUB_EVENT_NAME: "push" },
  });
  expect(created.result.operationalErrors).toEqual([]);
  expect(created.result.baseline).toBe(
    await git(context.project, "rev-parse", `${context.head}^`),
  );
}, 120_000);

test("schedule checks every flow once against the newest recorded baseline", async () => {
  const context = await graph();
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_SHA: context.head,
    GITHUB_OUTPUT: join(context.temporary, "out"),
  };
  const options = {
    inputs: { ...inputs, flow: "" },
    event: {},
    cwd: context.project,
    temporary: context.temporary,
    cli,
    env,
  };
  const { result, evidence } = await runAction(options);
  expect(result.operationalErrors).toEqual([]);
  expect(result.mode).toBe("schedule");
  expect(result.baseline).toBeUndefined();
  expect(result.plannedFlows).toEqual(["studio"]);
  const [entry] = result.flows;
  expect(entry.summary.baseline.commit).toBe(
    await git(context.project, "rev-parse", `${context.head}^`),
  );
  expect(entry.comparison).toBeUndefined();
  const log = await readFile(join(evidence, "diagnostics.log"), "utf8");
  expect(log.match(/ capture studio /g)).toHaveLength(1);
  expect(log).not.toContain("scratch/before");
  expect(() => gate(result)).not.toThrow();
  expect(await readFile(join(context.temporary, "out"), "utf8")).toContain(
    "baseline-sha=\n",
  );
  expect(renderComment(result, artifact)).toContain("recorded baseline");
  await rm(join(context.temporary, "shared-baselines"), {
    recursive: true,
    force: true,
  });
  const missing = await runAction(options);
  expect(missing.result.operationalErrors.join("\n")).toContain(
    "idiom baseline record",
  );
}, 120_000);

test("an unsupported event is an operational error", async () => {
  const context = await graph();
  const { result } = await runAction({
    inputs,
    event: context.event,
    cwd: context.project,
    temporary: context.temporary,
    cli,
    env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch" },
  });
  expect(result.operationalErrors).toEqual([
    "this action supports pull_request, push and schedule events",
  ]);
  expect(() => gate(result)).toThrow();
}, 60_000);

test("a busy host defers the flow as neutral; an idiom without --plan-only still checks a named flow", async () => {
  const context = await graph();
  const wrapper = join(context.temporary, "busy.mjs");
  await writeFile(
    wrapper,
    `import { spawnSync } from 'node:child_process'; const args=process.argv.slice(2); if (args.includes('--plan-only')) { console.error("error: unknown option '--plan-only'"); process.exit(1); } if (args[0]==='check') { console.log(JSON.stringify({ verdict: 'deferred', timedOutTuples: [{ state: 'editor', viewport: 'desktop', colorScheme: 'light' }] })); process.exit(3); } const r=spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cli[1])},...args], {stdio:'inherit'}); process.exit(r.status ?? 1);`,
  );
  const options = {
    event: context.event,
    cwd: context.project,
    temporary: context.temporary,
    cli: [process.execPath, wrapper],
    env: { ...process.env, GITHUB_OUTPUT: join(context.temporary, "out") },
  };
  const { result } = await runAction({ ...options, inputs });
  expect(result.operationalErrors).toEqual([]);
  expect(result.notices.join()).toContain("lacks --plan-only");
  expect(result.flows[0].deferred.reason).toBe(
    "host busy: 1 tuple(s) timed out (editor/desktop/light)",
  );
  expect(gate(result).deferred).toEqual([
    { flow: "studio", reason: result.flows[0].deferred.reason },
  ]);
  expect(await readFile(join(context.temporary, "out"), "utf8")).toContain(
    "outcome=deferred",
  );
  expect(renderComment(result, artifact)).toContain("Deferred studio");
  const flowless = await runAction({
    ...options,
    inputs: { ...inputs, flow: "" },
  });
  expect(flowless.result.operationalErrors.join()).toContain("newer than");
}, 60_000);

const summary = {
  flow: "studio",
  baseline: { commit: "a".repeat(40) },
  findings: [
    {
      id: "f1",
      severity: "major",
      where: "editor/desktop",
      problem: "Small <script>alert(1)</script> [link](bad)",
      fix: ["Make it larger"],
    },
  ],
  fixed: [],
  preExistingFindings: [],
};
const report = {
  flow: "studio",
  head: "b".repeat(40),
  baseline: "a".repeat(40),
  failOn: "major",
  operationalErrors: [],
  summary,
  crops: [{ finding: 0, path: "crops/1.png", label: "Element crop" }],
  composites: [{ key: "editor/desktop", path: "compare/before-after.png" }],
  comparison: {
    changed: [{}],
    unchanged: [],
    onlyBefore: [],
    onlyAfter: [],
    notComparable: [],
  },
  unavailable: [],
};
const artifact = "https://github.com/owner/repo/actions/runs/123/artifacts/456";
test.each(["blocker", "major", "minor", "never"])(
  "gate applies %s only to complete new findings",
  (failOn) => {
    for (const severity of ["blocker", "major", "minor"] as const) {
      const result = {
        ...report,
        failOn,
        summary: {
          ...summary,
          findings: [{ ...summary.findings[0], severity }],
        },
      };
      const fails =
        failOn !== "never" &&
        ["blocker", "major", "minor"].indexOf(severity) <=
          ["blocker", "major", "minor"].indexOf(failOn);
      if (fails) expect(() => gate(result)).toThrow();
      else expect(() => gate(result)).not.toThrow();
    }
  },
);

function response(value: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => value };
}
const bot = (id: number, body: string) => ({ id, body, user: { type: "Bot" } });
test("paginated bot comment upsert uses exact PATCH; clean reruns replace failures", async () => {
  const calls: Array<{
    url: string;
    options: { method: string; body?: string; headers: Record<string, string> };
  }> = [];
  const body = renderComment(
    { ...report, summary: { ...summary, findings: [] } },
    artifact,
  );
  const fetch = async (
    url: string,
    options: (typeof calls)[number]["options"],
  ) => {
    calls.push({ url, options });
    if (options.method === "PATCH") return response(bot(456, body));
    if (url.endsWith("page=1"))
      return response(
        Array.from({ length: 100 }, (_, index) => bot(index + 1, "unrelated")),
      );
    return response([bot(456, `${marker}\nOld failure`)]);
  };
  await upsertComment({
    fetch,
    repository: "owner/repo",
    number: 42,
    token: "token",
    body,
  });
  expect(calls.map((call) => call.options.method)).toEqual([
    "GET",
    "GET",
    "PATCH",
  ]);
  expect(calls[2]?.url).toBe(
    "https://api.github.com/repos/owner/repo/issues/comments/456",
  );
  expect(JSON.parse(calls[2]?.options.body ?? "")).toEqual({ body });
  expect(calls[2]?.options.headers["X-GitHub-Api-Version"]).toBe("2026-03-10");
  expect(body).toContain("New: 0");
});

test("comment creates once, discloses read-only forks and rejects malformed or unexpected API errors", async () => {
  const calls: Array<{ method: string; body?: string }> = [];
  await upsertComment({
    repository: "owner/repo",
    number: 42,
    token: "token",
    body: "body",
    fetch: async (_url: string, options: { method: string; body?: string }) => {
      calls.push(options);
      return options.method === "GET"
        ? response([])
        : response(bot(4, "body"), 201);
    },
  });
  expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  expect(calls[1]?.body).toBe(JSON.stringify({ body: "body" }));
  const warnings: string[] = [];
  await upsertComment({
    repository: "owner/repo",
    number: 42,
    token: "token",
    body: "body",
    fork: true,
    warn: (message: string) => warnings.push(message),
    fetch: async () => response({}, 403),
  });
  expect(warnings.join()).toContain("read-only token");
  for (const value of [{}, [{ id: "bad" }]])
    await expect(
      upsertComment({
        repository: "owner/repo",
        number: 42,
        token: "t",
        body: "b",
        fetch: async () => response(value),
      }),
    ).rejects.toThrow("malformed");
  await expect(
    upsertComment({
      repository: "owner/repo",
      number: 42,
      token: "t",
      body: "b",
      fetch: async () => response({}, 500),
    }),
  ).rejects.toThrow("500");
});

test("comment escapes and bounds details, uses download links and filenames, and preserves upload failures", async () => {
  const body = renderComment(report, artifact);
  expect(body).not.toContain("<script>");
  expect(body).toContain("&lt;script&gt;");
  expect(body).toContain("crops/1");
  expect(body).toContain(artifact);
  expect(body).not.toContain("![");
  const huge = renderComment(
    {
      ...report,
      summary: {
        ...summary,
        findings: Array.from({ length: 1000 }, () => ({
          ...summary.findings[0],
          problem: "x".repeat(1000),
        })),
      },
    },
    artifact,
  );
  expect(huge.length).toBeLessThan(60000);
  expect(huge).toContain("Further details omitted");
  const path = await mkdtemp(join(tmpdir(), "idiom-comment-"));
  directories.push(path);
  const resultFile = join(path, "result.json");
  await writeFile(resultFile, JSON.stringify(report));
  const result = await publishResult({
    resultFile,
    artifactUrl: "",
    uploadOutcome: "failure",
    token: "t",
    repository: "owner/repo",
    event: {
      pull_request: {
        number: 42,
        base: { sha: report.baseline },
        head: { sha: report.head },
      },
    },
    summaryPath: join(path, "summary.md"),
    fetch: async (_url: string, options: { method: string }) =>
      options.method === "GET"
        ? response([])
        : response(bot(1, "published"), 201),
  });
  expect(result.operationalErrors).toContain("Evidence artifact upload failed");
  expect(() => gate({ ...result, failOn: "never" })).toThrow();
  expect(await readFile(join(path, "summary.md"), "utf8")).toContain(
    "Evidence upload unavailable",
  );
});

test("Action metadata uses action_path, environment inputs and upload → comment → gate wiring; child processes receive no token", async () => {
  const action = parse(await readFile(resolve("action.yml"), "utf8"));
  expect(action.runs.using).toBe("composite");
  const steps = action.runs.steps;
  expect(steps[0].uses).toBe("actions/setup-node@v6");
  expect(steps[0].with["package-manager-cache"]).toBe(false);
  expect(steps.map((step: { id?: string }) => step.id).filter(Boolean)).toEqual(
    ["run", "upload", "comment"],
  );
  expect(steps[2].uses).toBe("actions/upload-artifact@v7");
  expect(steps[2].with["if-no-files-found"]).toBe("error");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub expression contract.
  expect(steps[3].env.IDIOM_ACTION_TOKEN).toBe("${{ inputs.token }}");
  for (const step of steps.filter((step: { run?: string }) => step.run)) {
    expect(step.shell).toBe("bash");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub expression contract.
    expect(step.env.IDIOM_ACTION_PATH).toBe("${{ github.action_path }}");
    expect(step.run).not.toContain("${{ inputs.");
  }
  expect(steps.at(-1).run).toContain("gate");
  expect(action.inputs.flow.required).toBe(false);
  expect(action.inputs.flow.default).toBe("");
  expect(action.outputs.outcome.value).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub expression contract.
    "${{ steps.run.outputs.outcome }}",
  );
  expect(steps[2].with.name).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub expression contract.
    "idiom-${{ github.event.pull_request.number || github.event_name }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  expect(action.outputs["artifact-url"].value).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub expression contract.
    "${{ steps.upload.outputs.artifact-url }}",
  );
  expect(
    childEnvironment({
      GITHUB_TOKEN: "a",
      IDIOM_ACTION_TOKEN: "b",
      GH_TOKEN: "c",
      INPUT_TOKEN: "d",
      PATH: "keep",
    }),
  ).toEqual({ PATH: "keep" });
  for (const bad of [
    { flow: "../escape" },
    { project: "../outside" },
    { project: "/absolute" },
    { version: "file:/payload" },
    { failOn: "all" },
  ])
    expect(() => validateInputs({ ...inputs, ...bad })).toThrow();
});

test("evidence copying rejects lexical and symlink escapes from its capture root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-evidence-"));
  directories.push(directory);
  const run = join(directory, "capture");
  await mkdir(run);
  await writeFile(join(directory, "private.txt"), "private");
  await symlink(join(directory, "private.txt"), join(run, "outside.png"));
  await expect(evidencePath(run, "../private.txt")).rejects.toThrow("escapes");
  await expect(evidencePath(run, "outside.png")).rejects.toThrow("escapes");
});

test("final executable gate preserves upload/publication outcomes even with never", async () => {
  const path = await mkdtemp(join(tmpdir(), "idiom-gate-"));
  directories.push(path);
  const resultFile = join(path, "result.json");
  await writeFile(resultFile, JSON.stringify({ ...report, failOn: "never" }));
  const args = [resolve("scripts/github-action/run.mjs"), "gate"];
  const env = {
    ...process.env,
    IDIOM_ACTION_RESULT: resultFile,
    IDIOM_ACTION_UPLOAD_OUTCOME: "success",
    IDIOM_ACTION_COMMENT_OUTCOME: "success",
  };
  // Spawn directly: `execute` deliberately strips IDIOM_ACTION_* from children.
  const gateRun = (gateEnv: NodeJS.ProcessEnv) =>
    new Promise<{ code: number; stderr: string }>((done) => {
      execFile(process.execPath, args, { env: gateEnv }, (error, _, stderr) =>
        done({ code: error ? Number(error.code ?? 1) : 0, stderr }),
      );
    });
  await expect(gateRun(env)).resolves.toEqual({ code: 0, stderr: "" });
  for (const key of [
    "IDIOM_ACTION_UPLOAD_OUTCOME",
    "IDIOM_ACTION_COMMENT_OUTCOME",
  ]) {
    const failed = await gateRun({ ...env, [key]: "failure" });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(key);
  }
});

test("a real synchronize fix updates the same comment, stages temporal before/after, and preserves surviving and pre-existing findings", async () => {
  const context = await graph(true);
  const options = {
    inputs: { ...inputs, failOn: "major" },
    cwd: context.project,
    temporary: context.temporary,
    cli,
  };
  const failed = await runAction({ ...options, event: context.event });
  expect(failed.result.operationalErrors).toEqual([]);
  expect(() => gate(failed.result)).toThrow();
  const temporal = failed.result.flows[0].summary.findings.find(
    (finding: { timeline?: unknown }) => finding.timeline,
  );
  expect(temporal).toBeDefined();
  expect(temporal.fingerprint).toBeTruthy();
  const firstIndex = await readFile(
    join(failed.evidence, "studio/index.html"),
    "utf8",
  );
  expect(firstIndex).toContain('src="filmstrips/current/');
  expect(renderComment(failed.result, artifact)).toContain(
    "studio/filmstrips/current/",
  );
  expect(renderComment(failed.result, artifact)).not.toContain("![");
  let managed: ReturnType<typeof bot> | undefined;
  const writes: Array<{ method: string; url: string; body: string }> = [];
  const fetch = async (
    url: string,
    options: { method: string; body?: string },
  ) => {
    if (options.method === "GET") return response(managed ? [managed] : []);
    const body = JSON.parse(options.body ?? "").body;
    managed = bot(321, body);
    writes.push({ method: options.method, url, body });
    return response(managed, options.method === "POST" ? 201 : 200);
  };
  await publishResult({
    resultFile: failed.resultFile,
    artifactUrl: artifact,
    uploadOutcome: "success",
    token: "t",
    repository: "owner/repo",
    event: context.event,
    fetch,
  });
  await git(context.project, "checkout", "-q", "feature");
  await copyFile(
    join(fixture, "temporal-fixed.html"),
    join(context.project, "index.html"),
  );
  const fixedHead = await commit(
    context.project,
    "resolve temporal regression, keep small target",
  );
  await git(context.project, "checkout", "-q", "main");
  const beforeStatus = await git(context.project, "status", "--porcelain");
  const event = {
    ...context.event,
    action: "synchronize",
    before: context.head,
    after: fixedHead,
    pull_request: {
      ...context.event.pull_request,
      head: { ...context.event.pull_request.head, sha: fixedHead },
    },
  };
  const fixed = await runAction({ ...options, event });
  expect(fixed.result.operationalErrors).toEqual([]);
  expect(fixed.result.flows[0].resolutionNotices).toEqual([]);
  expect(() => gate(fixed.result)).not.toThrow();
  expect(
    fixed.result.flows[0].summary.findings.some(
      (finding: { selector: string }) => finding.selector === "#regression",
    ),
  ).toBe(true);
  expect(
    fixed.result.flows[0].summary.preExistingFindings.some(
      (finding: { selector: string }) => finding.selector === "#existing",
    ),
  ).toBe(true);
  const resolved = fixed.result.flows[0].resolved.find(
    (entry: { fingerprint: string }) =>
      entry.fingerprint === temporal.fingerprint,
  );
  expect(resolved).toBeDefined();
  expect(resolved.origin).toBe("previous-push");
  expect(resolved.beforeCommit).toBe(context.head);
  expect(resolved.afterCommit).toBe(fixedHead);
  expect(resolved.before.images[0].label).toBe("Filmstrip contact sheet");
  expect(resolved.after.images[0].label).toBe("Settled tuple screenshot");
  expect(resolved.after.reasons.join()).toContain("not a filmstrip");
  expect(
    fixed.result.flows[0].resolved.every(
      (entry: { fingerprint: string }) =>
        entry.fingerprint !==
        fixed.result.flows[0].summary.findings[0].fingerprint,
    ),
  ).toBe(true);
  const index = await readFile(
    join(fixed.evidence, "studio/index.html"),
    "utf8",
  );
  for (const match of index.matchAll(/src="([^"]+)"/g))
    expect(
      PNG.sync.read(
        await readFile(join(fixed.evidence, "studio", match[1] ?? "")),
      ).width,
    ).toBeGreaterThan(0);
  await publishResult({
    resultFile: fixed.resultFile,
    artifactUrl: artifact,
    uploadOutcome: "success",
    token: "t",
    repository: "owner/repo",
    event,
    fetch,
  });
  expect(writes.map((write) => write.method)).toEqual(["POST", "PATCH"]);
  expect(writes[1]?.url).toContain("/issues/comments/321");
  expect(writes[0]?.body).not.toContain("#### Blocks merge (0)");
  expect(writes[1]?.body).toContain("#### Blocks merge (0)");
  expect(writes[1]?.body).toContain("#### Should fix (1)");
  expect(writes[1]?.body).toContain("since previous push");
  expect(writes[1]?.body).toContain(context.head);
  expect(await git(context.project, "status", "--porcelain")).toBe(
    beforeStatus,
  );
  expect(
    await git(context.project, "worktree", "list", "--porcelain"),
  ).not.toContain("scratch");
  expect(await readdir(dirname(fixed.evidence))).toEqual(["evidence"]);
  // Harness allowance, not a product deadline: over 90s under three concurrent
  // gates (file-293 proof) and max 58.1s with two
  // (docs/testing/give-four-more.md). ~3x headroom; still a real end-to-end
  // synchronize with the same comment and temporal before/after.
}, 270_000);

test("read-only fork publication retains tiered job summary, artifact result and gate with a warning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-fork-summary-"));
  directories.push(directory);
  const resultFile = join(directory, "result.json"),
    summaryPath = join(directory, "summary.md");
  await writeFile(resultFile, JSON.stringify({ ...report, fork: true }));
  const { vi } = await import("vitest");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await publishResult({
      resultFile,
      artifactUrl: artifact,
      uploadOutcome: "success",
      token: "read-only",
      repository: "owner/repo",
      event: {
        pull_request: {
          number: 42,
          base: { sha: report.baseline },
          head: { sha: report.head },
        },
      },
      summaryPath,
      fetch: async () => response({}, 403),
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("read-only token"),
    );
    expect(result.operationalErrors).toEqual([]);
    expect(() => gate(result)).toThrow("1 new finding");
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("### Blocks merge (1)");
    expect(summary).toContain(artifact);
  } finally {
    warning.mockRestore();
  }
});
