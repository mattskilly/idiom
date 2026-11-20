#!/usr/bin/env node
// Measure `idiom check --gate` on test/fixtures/builder-app under synthetic
// load: sixteen states on one route, a change to the floating text toolbar
// that only two of them render, and a planted contrast defect in it.
//
//   bun run build && node scripts/measure-gate-surface.mjs [--gap] [--no-load]
//
// --gap edits a component no state renders and asserts the coverage-gap
// warning instead. Exits non-zero, printing no PASS, on any failed assertion.
// The load generator (scripts/measure-load.mjs) is this script's own child and is
// stopped by its PID only.
import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const cli = join(root, "build", "cli.js");
const fixture = join(root, "test", "fixtures", "builder-app");
const budgetMs = 180_000;
const gapMode = process.argv.includes("--gap");
const noLoad = process.argv.includes("--no-load");
const toolbarStates = ["text-selected", "heading-editing"];

function fail(reason) {
  console.error(`measure-gate-surface: FAILED — ${reason}`);
  process.exitCode = 1;
  throw new Error(reason);
}

async function idiom(cwd, args) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await exec("node", [cli, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, ms: performance.now() - started };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
      ms: performance.now() - started,
    };
  }
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const directory = await mkdtemp(join(tmpdir(), "idiom-gate-surface-"));
const git = (...args) => exec("git", args, { cwd: directory });
const commit = async (message) => {
  await git("add", ".");
  await git(
    "-c",
    "user.name=Measure",
    "-c",
    "user.email=measure@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  );
};
let load;
try {
  const init = await idiom(directory, ["init", "--yes"]);
  if (init.code !== 0) fail(`idiom init failed: ${init.stderr}`);
  await cp(fixture, directory, { recursive: true, force: true });
  await writeFile(
    join(directory, ".gitignore"),
    ".idiom/reports/\n.idiom/cache/\n.idiom/agent-state.json\n",
  );
  await git("init", "--quiet", "--initial-branch=main");
  await commit("builder fixture");

  // 1. Seed, before any load and outside the timed gate: every state at
  // every viewport in the default scheme; it also records the baseline.
  const seed = await idiom(directory, [
    "check",
    "editor",
    "--schemes",
    "light",
    "--json",
    "--fail-on",
    "never",
  ]);
  if (seed.code !== 0) fail(`seed check failed: ${seed.stderr.slice(-2000)}`);
  // The first check records the baseline itself; commit it at this commit.
  await commit("record baseline");

  // 2. Load: this script's own child, stopped by its PID in `finally`.
  const cores = availableParallelism();
  let achieved = loadavg()[0];
  if (!noLoad) {
    load = spawn("node", [join(root, "scripts", "measure-load.mjs")], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    load.stdout.on("data", () => {});
    const waitStarted = performance.now();
    while (loadavg()[0] < cores * 2 && performance.now() - waitStarted < 20_000)
      await sleep(1000);
    achieved = loadavg()[0];
  }

  // 3. The change, uncommitted.
  if (gapMode) {
    const path = join(directory, "components", "Unused.tsx");
    const before = await readFile(path, "utf8");
    await writeFile(
      path,
      before.replace("Not rendered by any view", "Never rendered anywhere"),
    );
  } else {
    const path = join(directory, "components", "Toolbar.module.css");
    const before = await readFile(path, "utf8");
    const after = before.replace(
      /(\.button \{[^}]*?)color: #1f2933;/,
      "$1color: #c9ccd1;",
    );
    if (after === before) fail("the toolbar stylesheet changed shape");
    await writeFile(path, after);
  }

  // 4. The gate, timed.
  const gate = await idiom(directory, [
    "check",
    "--gate",
    "--json",
    "--fail-on",
    "never",
    "--deferred",
    "warn",
  ]);
  const loadDuring = loadavg()[0];
  if (load) {
    load.kill("SIGTERM");
    load = undefined;
  }
  if (gate.code !== 0) fail(`gate failed: ${gate.stderr.slice(-3000)}`);
  const output = JSON.parse(gate.stdout);
  const plan = output.gate?.plan;
  if (!plan) fail("the gate printed no plan (did it skip?)");
  const stderr = gate.stderr.split("\n");
  const timing = stderr.filter((line) => line.startsWith("Timing:")).at(-1);
  if (!timing) fail("no Timing line");
  for (const phase of ["server start", "captures", "probe", "checks"])
    if (!timing.includes(phase)) fail(`Timing line lacks ${phase}: ${timing}`);
  for (const skip of output.gate.skippedWork)
    if (!skip.reason) fail(`a skip has no reason: ${JSON.stringify(skip)}`);
  const kept = plan.states.map(
    (state) =>
      `${state.flow}/${state.state} [surface ${state.surface?.status ?? "?"}${state.surface?.matched?.length ? `: ${state.surface.matched.join(" ")}` : ""}]`,
  );
  const skipped = output.gate.skippedWork.map(
    (skip) =>
      `${skip.kind} ${skip.state ? `${skip.flow}/${skip.state}` : (skip.viewport ?? skip.scheme ?? skip.flow)}: ${skip.reason}`,
  );
  let finding = "(gap mode: no finding expected)";
  if (gapMode) {
    if (!plan.coverageGap)
      fail(`no coverageGap in JSON: ${JSON.stringify(plan.notes)}`);
    if (!stderr.some((line) => line.startsWith("warning: coverage gap:")))
      fail("no `warning: coverage gap:` line on stderr");
  } else {
    const shown = plan.states.filter(
      (state) =>
        toolbarStates.includes(state.state) &&
        state.surface?.status === "shows",
    );
    if (!shown.length)
      fail(
        `no toolbar state kept as shows: ${kept.join("; ")} | skipped: ${skipped.join("; ")}`,
      );
    const findings = output.checks.flatMap((entry) =>
      entry.status === "checked" ? (entry.summary.findings ?? []) : [],
    );
    const planted = findings.find(
      (item) =>
        /contrast/.test(item.rule ?? "") &&
        JSON.stringify(item).includes("Toolbar_button__p7q2"),
    );
    if (!planted)
      fail(
        `no new contrast finding on the toolbar: ${JSON.stringify(findings.map((item) => [item.rule ?? item.id, item.selector]))}`,
      );
    finding = `${planted.rule} (${planted.severity}, new against the base) at ${planted.where} ${planted.selector ?? ""} — ${planted.problem}`;
  }
  if (gate.ms >= budgetMs)
    fail(`gate took ${seconds(gate.ms)} (budget ${seconds(budgetMs)})`);
  const planLine = stderr.find((line) =>
    line.startsWith("idiom check --gate:"),
  );
  console.log("measure-gate-surface: PASS");
  console.log("");
  console.log(
    `Load: ${noLoad ? "none (--no-load)" : `scripts/measure-load.mjs, ${cores * 2} workers at duty 0.9`}; loadavg(1m) ${achieved.toFixed(1)} at start, ${loadDuring.toFixed(1)} at end, ${cores} cores`,
  );
  console.log(
    `Change: ${gapMode ? "components/Unused.tsx (no state renders it)" : "components/Toolbar.module.css .button colour #1f2933 → #c9ccd1"}`,
  );
  console.log(`  ${planLine}`);
  for (const line of stderr.filter((line) => line.startsWith("surface")))
    console.log(`  ${line}`);
  console.log("Kept:");
  for (const line of kept) console.log(`  ${line}`);
  console.log(`Skipped (${skipped.length}):`);
  for (const line of skipped) console.log(`  ${line}`);
  for (const line of stderr.filter((line) => line.startsWith("warning:")))
    console.log(`  ${line}`);
  console.log(`Finding: ${finding}`);
  console.log(`Wall clock: ${seconds(gate.ms)} (budget ${seconds(budgetMs)})`);
  console.log(timing);
} catch (error) {
  if (!process.exitCode) {
    console.error(`measure-gate-surface: FAILED — ${error.message}`);
    process.exitCode = 1;
  }
} finally {
  if (load) load.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
