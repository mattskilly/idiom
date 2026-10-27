import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { checkCommand } from "../src/commands/check.js";
import { decideCommand } from "../src/commands/decide.js";
import { initProject } from "../src/commands/init.js";
import { appendDecision } from "../src/decisions/log.js";
import {
  eligibleRecords,
  selectTargets,
  takeFixSnapshot,
} from "../src/fix/check.js";
import { repairPrompt } from "../src/fix/prompt.js";
import { loadRunTuples } from "../src/review/artifacts.js";
import { checkpointLineageStatus } from "../src/review/catalog.js";
import { validateProject } from "../src/validation.js";
import { parseFindingBlocks } from "../src/verify/spec.js";

const execute = promisify(execFile);
const directories: string[] = [];
const fixtureRoot = resolve(import.meta.dirname, "fixtures/fix-loop");
const cli = resolve(import.meta.dirname, "../dist/cli.js");
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(mode = "all", count = 2) {
  const cwd = await mkdtemp(join(tmpdir(), "idiom-fix-cli-"));
  directories.push(cwd);
  await initProject({ project: cwd, yes: true });
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((accept) => server.close(() => accept()));
  await writeFile(
    join(cwd, ".idiom/project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "fix fixture", framework: "other" },
      server: {
        build: "node -e 0",
        start: `node ${JSON.stringify(join(fixtureRoot, "server.mjs"))}`,
        readyUrl: `http://127.0.0.1:${port}`,
        port,
        env: { PORT: String(port) },
        startupTimeoutMs: 5000,
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: {},
      checks: { probe: { enabled: false }, targetSize: { fine: 24 } },
      design: {},
      model: { provider: "claude-code", model: "unused", maxFindings: 1 },
    }),
  );
  await rm(join(cwd, ".idiom/flows"), { recursive: true, force: true });
  await mkdir(join(cwd, ".idiom/flows"));
  await writeFile(
    join(cwd, ".idiom/flows/settings.json"),
    JSON.stringify({
      id: "settings",
      title: "Settings page",
      intent: [],
      setup: [],
      states: [
        { id: "settings", description: "Settings page", url: "/", expect: {} },
      ],
    }),
  );
  let html = await readFile(join(fixtureRoot, "before.html"), "utf8");
  if (count > 2)
    html = html.replace(
      "</main>",
      `${Array.from(
        { length: count - 2 },
        (_, i) =>
          `<div class="target-row"><button id="extra${i}" style="width:12px;height:12px" aria-label="Extra"></button><a class="neighbor" href="/neighbor" aria-label="Neighbor extra ${i}"></a></div>`,
      ).join("")}</main>`,
    );
  await writeFile(join(cwd, "page.html"), html);
  await writeFile(join(cwd, "unrelated.txt"), "original");
  await writeFile(
    join(cwd, ".gitignore"),
    ".idiom/reports/\n.idiom/finding-names.json\nbin/\nagent-log.jsonl\n",
  );
  await execute("git", ["init", "-q"], { cwd });
  await execute("git", ["add", "."], { cwd });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd },
  );
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd })).stdout;
  const index = (await execute("git", ["write-tree"], { cwd })).stdout;
  await writeFile(join(cwd, "unrelated.txt"), "user edits");
  await mkdir(join(cwd, "nested"));
  await mkdir(join(cwd, "bin"));
  for (const name of ["claude", "codex"]) {
    const path = join(cwd, "bin", name);
    await writeFile(
      path,
      `#!${process.execPath}\nimport(${JSON.stringify(join(fixtureRoot, "agent.mjs"))});\n`,
    );
    await chmod(path, 0o755);
  }
  return {
    cwd,
    head,
    index,
    env: {
      ...process.env,
      PATH: `${join(cwd, "bin")}:${process.env.PATH}`,
      FIX_STUB_MODE: mode,
    },
  };
}
async function invoke(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  try {
    const result = await execute(
      process.execPath,
      [cli, "--project", f.cwd, "fix", "settings", ...args],
      { cwd: join(f.cwd, "nested"), env: f.env, timeout: 90_000 },
    );
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as Error & {
      stdout: string;
      stderr: string;
      code: number;
    };
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  }
}
async function summary(cwd: string) {
  const root = join(cwd, ".idiom/reports");
  const directory = (await readdir(root)).find((name) =>
    name.startsWith("fix-"),
  );
  if (!directory) throw new Error("no fix summary");
  return JSON.parse(
    await readFile(join(root, directory, "summary.json"), "utf8"),
  );
}
for (const agent of ["claude", "codex"])
  test(`built CLI repairs using stub ${agent}, verifies, and preserves user edits/HEAD/index`, async () => {
    const f = await fixture();
    const result = await invoke(f, ["--agent", agent]);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const report = await summary(f.cwd);
    expect(report).toMatchObject({
      passed: true,
      reason: "clean",
      remaining: 0,
    });
    expect(report.rounds[0].verifiedFixed).toHaveLength(2);
    expect(
      report.rounds[0].verification.verdicts.map(
        (v: { status: string }) => v.status,
      ),
    ).toEqual(["fixed", "fixed"]);
    const source = parseFindingBlocks(
      await readFile(report.rounds[0].specPath, "utf8"),
    );
    const original = JSON.parse(
      await readFile(join(report.initialRun, "findings.json"), "utf8"),
    );
    expect(source).toEqual(original);
    expect(
      await readFile(report.rounds[0].verification.reportPath, "utf8"),
    ).toContain("fixed");
    expect(
      await readFile(
        join(report.rounds[0].verification.outputDirectory, "attachments.json"),
        "utf8",
      ),
    ).toContain("before");
    expect(
      (await execute("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout,
    ).toBe(f.head);
    expect((await execute("git", ["write-tree"], { cwd: f.cwd })).stdout).toBe(
      f.index,
    );
    expect(await readFile(join(f.cwd, "unrelated.txt"), "utf8")).toBe(
      "user edits",
    );
    expect(await readFile(join(f.cwd, "page.html"), "utf8")).toBe(
      await readFile(join(fixtureRoot, "after.html"), "utf8"),
    );
    const calls = (await readFile(join(f.cwd, "agent-log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(await realpath(f.cwd));
    expect(calls[0].prompt).toContain("#first");
    expect(calls[0].prompt).toContain("12");
    expect(calls[0].prompt).toContain("/crops/");
  }, 100_000);
for (const [mode, reason] of [
  ["noop", "no verified progress"],
  ["regress", "regression"],
  ["one", "clean"],
  ["fail", "repair attempt failed"],
])
  test(`real capture/verify loop: ${mode}`, async () => {
    const f = await fixture(mode);
    const result = await invoke(f, ["--agent", "codex", "--top", "1"]);
    expect(result.code, result.stderr + result.stdout).toBe(
      mode === "one" ? 0 : 1,
    );
    const report = await summary(f.cwd);
    expect(report.reason).toContain(reason);
    expect(report.rounds).toHaveLength(mode === "one" ? 2 : 1);
    if (mode === "regress") {
      expect(report.rounds[0].changes.introduced.length).toBeGreaterThan(0);
      expect(report.rounds[0].changes.introduced[0].severity).toBe("minor");
      expect(report.rounds[0].verification.reportPath).toBeTruthy();
    }
    if (mode === "fail") {
      expect(report.rounds[0].changes.fixed).toHaveLength(2);
      expect(report.rounds[0].verifiedFixed).toHaveLength(0);
    }
  }, 100_000);
test("dry run is the exact uncapped filtered prompt and works without executable", async () => {
  const f = await fixture("all", 7);
  const ordinary = await checkCommand({
    flow: "settings",
    project: f.cwd,
    all: true,
  });
  const normalFindings = JSON.parse(
    await readFile(join(ordinary.runDirectory, "findings.json"), "utf8"),
  );
  expect(normalFindings).toHaveLength(1);
  const snapshot = await takeFixSnapshot({ flow: "settings", project: f.cwd });
  expect(snapshot.records).toHaveLength(7);
  const rejected = selectTargets(
    snapshot,
    await eligibleRecords(snapshot),
    1,
  )[0];
  if (!rejected) throw new Error("no finding");
  await appendDecision({
    projectDirectory: f.cwd,
    finding: rejected.finding,
    decision: "reject",
    scope: "instance",
  });
  const source = await readFile(join(f.cwd, "page.html"), "utf8");
  const decisions = await readFile(
    join(f.cwd, ".idiom/decisions.jsonl"),
    "utf8",
  );
  const current = await takeFixSnapshot({ flow: "settings", project: f.cwd });
  const eligible = await eligibleRecords(current);
  const prompt = await repairPrompt(
    current,
    selectTargets(current, eligible, 10),
    eligible,
  );
  expect(prompt).not.toContain(`# Finding ${rejected.finding.id}\n`);
  expect(prompt).not.toContain(`${rejected.finding.id}:`);
  expect(selectTargets(current, eligible, 10)).toHaveLength(6);
  await rm(join(f.cwd, "bin"), { recursive: true });
  const result = await invoke(f, [
    "--dry-run",
    "--agent",
    "codex",
    "--top",
    "10",
  ]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Selected assignments:");
  expect(result.stdout).not.toContain("Fix settings:");
  expect(result.stdout).not.toContain(rejected.finding.id);
  const normalizeRun = (text: string) =>
    text.replace(/reports\/\d{4}-[^/]+\//g, "reports/<run>/");
  expect(normalizeRun(result.stdout)).toBe(normalizeRun(prompt));
  expect(
    (await readdir(join(f.cwd, ".idiom/reports"))).some((name) =>
      name.startsWith("fix-"),
    ),
  ).toBe(false);
  expect(await readFile(join(f.cwd, "page.html"), "utf8")).toBe(source);
  expect(await readFile(join(f.cwd, ".idiom/decisions.jsonl"), "utf8")).toBe(
    decisions,
  );
  await expect(readFile(join(f.cwd, "agent-log.jsonl"))).rejects.toThrow();
}, 100_000);
for (const args of [
  ["--agent", "other"],
  ...["0", "-1", "1.5", "abc"].flatMap((value) => [
    ["--top", value],
    ["--max-rounds", value],
  ]),
])
  test(`invalid args fail before capture: ${args.join(" ")}`, async () => {
    let stderr = "";
    const code = await run(["node", "idiom", "fix", "settings", ...args], {
      cwd: "/nonexistent",
      stdout: () => {},
      stderr: (s) => {
        stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/positive integer|Allowed choices/);
  });

test("top above five verifies every exact uncapped baseline record", async () => {
  const f = await fixture("all", 7);
  const result = await invoke(f, ["--agent", "codex", "--top", "10"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const report = await summary(f.cwd);
  expect(report.rounds[0].selected).toHaveLength(7);
  expect(report.rounds[0].verifiedFixed).toHaveLength(7);
  expect(
    parseFindingBlocks(await readFile(report.rounds[0].specPath, "utf8")).sort(
      (a, b) => a.id.localeCompare(b.id),
    ),
  ).toEqual(
    JSON.parse(
      await readFile(join(report.initialRun, "findings.json"), "utf8"),
    ).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
  );
}, 100_000);

test("full snapshot retains independent collapsed combinations, viewports, and schemes", async () => {
  const f = await fixture();
  const projectPath = join(f.cwd, ".idiom/project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.colorSchemes = ["light", "dark"];
  project.viewports.push({ name: "wide", width: 1000, height: 600 });
  await writeFile(projectPath, JSON.stringify(project));
  const flowPath = join(f.cwd, ".idiom/flows/settings.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8"));
  flow.toggles = { panel: { closed: [], open: [] } };
  flow.toggleRegions = ["main"];
  await writeFile(flowPath, JSON.stringify(flow));
  const snapshot = await takeFixSnapshot({ project: f.cwd, flow: "settings" });
  const validated = await validateProject({ project: f.cwd, flow: "settings" });
  const validatedFlow = validated.flows[0]?.flow;
  if (!validatedFlow) throw new Error("missing flow");
  const loaded = await loadRunTuples(
    validated,
    validatedFlow,
    snapshot.runDirectory,
  );
  expect(loaded.collapsedCount).toBeGreaterThan(0);
  expect(
    snapshot.raw.filter((item) => item.category === "target-size"),
  ).toHaveLength(24);
  expect(
    snapshot.eligible.filter((item) => item.category === "target-size"),
  ).toHaveLength(24);
  expect(new Set(snapshot.raw.map((item) => item.key)).size).toBe(12);
  expect(
    snapshot.raw.some((item) => item.coordinate.combination !== undefined),
  ).toBe(true);
}, 100_000);

test("failed expectation coverage cannot be declared clean or sent to an agent", async () => {
  const f = await fixture();
  const flowPath = join(f.cwd, ".idiom/flows/settings.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8"));
  flow.states[0].expect = { selectorPresent: ["#absent"] };
  await writeFile(flowPath, JSON.stringify(flow));
  const result = await invoke(f, ["--agent", "codex"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "complete successful full-flow capture coverage",
  );
  await expect(readFile(join(f.cwd, "agent-log.jsonl"))).rejects.toThrow();
  expect(
    (await readdir(join(f.cwd, ".idiom/reports"))).some((name) =>
      name.startsWith("fix-"),
    ),
  ).toBe(false);
}, 100_000);

test("group-rejected work never reaches the editing executable's stdin", async () => {
  const f = await fixture();
  const flowPath = join(f.cwd, ".idiom/flows/settings.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8"));
  flow.states.push({ ...flow.states[0], id: "other" });
  await writeFile(flowPath, JSON.stringify(flow));
  const snapshot = await takeFixSnapshot({ project: f.cwd, flow: "settings" });
  const group = snapshot.summary.groups?.[0];
  if (!group) throw new Error("missing group");
  expect(group.members).toHaveLength(2);
  await decideCommand({
    project: f.cwd,
    group: group.id,
    reject: true,
    scope: "instance",
    write: () => {},
  });
  const decisions = await readFile(
    join(f.cwd, ".idiom/decisions.jsonl"),
    "utf8",
  );
  const result = await invoke(f, ["--agent", "codex", "--top", "1"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const calls = (await readFile(join(f.cwd, "agent-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(1);
  for (const member of group.members)
    expect(calls[0].prompt).not.toContain(member.id);
  expect(await readFile(join(f.cwd, ".idiom/decisions.jsonl"), "utf8")).toBe(
    decisions,
  );
}, 100_000);

for (const status of ["ticketed", "verified-fixed", "verify-failed"] as const) {
  test(`flow with only ${status} lineages is clean without invoking an agent`, async () => {
    const f = await fixture();
    const before = await takeFixSnapshot({ project: f.cwd, flow: "settings" });
    expect(before.records).toHaveLength(2);
    for (const record of before.records) {
      await checkpointLineageStatus({
        catalog: before.catalog,
        findingId: record.finding.id,
        status: "ticketed",
      });
      if (status !== "ticketed")
        await checkpointLineageStatus({
          catalog: before.catalog,
          findingId: record.finding.id,
          status,
        });
    }
    const check = await checkCommand({
      project: f.cwd,
      flow: "settings",
      all: true,
    });
    expect(check.findings).toHaveLength(0);
    const snapshot = await takeFixSnapshot({
      project: f.cwd,
      flow: "settings",
    });
    expect(snapshot.raw).toHaveLength(2);
    expect(
      snapshot.records.every((record) => record.finding.status === status),
    ).toBe(true);
    expect(snapshot.eligible).toHaveLength(0);
    expect(await eligibleRecords(snapshot)).toHaveLength(0);
    const source = await readFile(join(f.cwd, "page.html"), "utf8");
    const dryRun = await invoke(f, ["--dry-run"]);
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toBe("");
    const result = await invoke(f, []);
    expect(result.code, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("clean (passed)");
    expect(result.stdout).toContain("0 eligible occurrences remaining");
    expect(
      (await readdir(join(f.cwd, ".idiom/reports"))).some((name) =>
        name.startsWith("fix-"),
      ),
    ).toBe(false);
    await expect(readFile(join(f.cwd, "agent-log.jsonl"))).rejects.toThrow();
    expect(await readFile(join(f.cwd, "page.html"), "utf8")).toBe(source);
  }, 100_000);
}

test("repairing open work reaches clean while a ticketed lineage still reproduces", async () => {
  const f = await fixture("one");
  const before = await takeFixSnapshot({ project: f.cwd, flow: "settings" });
  const ticketed = before.records.find(
    (record) => record.finding.verification.params?.selector === "#second",
  );
  if (!ticketed) throw new Error("missing ticketed target");
  await checkpointLineageStatus({
    catalog: before.catalog,
    findingId: ticketed.finding.id,
    status: "ticketed",
  });
  const result = await invoke(f, ["--agent", "codex", "--top", "1"]);
  expect(result.code, result.stderr + result.stdout).toBe(0);
  const report = await summary(f.cwd);
  expect(report).toMatchObject({ passed: true, reason: "clean", remaining: 0 });
  expect(report.rounds).toHaveLength(1);
  expect(report.rounds[0].selected).toHaveLength(1);
  expect(report.rounds[0].selected).not.toContain(ticketed.finding.id);
  expect(report.rounds[0].verifiedFixed).toHaveLength(1);
  const calls = (await readFile(join(f.cwd, "agent-log.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).not.toContain(ticketed.finding.id);
  const after = await takeFixSnapshot({ project: f.cwd, flow: "settings" });
  expect(after.raw.map((item) => item.selector)).toEqual(["#second"]);
  expect(after.eligible).toHaveLength(0);
  expect(after.records[0]?.finding.status).toBe("ticketed");
}, 100_000);
