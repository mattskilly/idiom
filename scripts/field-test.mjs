#!/usr/bin/env node
// Field test: run the built CLI against public sites and one OSS repo, then
// score agent/human labels into docs/field-test.md.
//
//   bun run build
//   node scripts/field-test.mjs run [--only a,b] [--out <scratch dir>]
//   node scripts/field-test.mjs labels-template
//   node scripts/field-test.mjs score
//
// Ranked data comes from the MCP `idiom_quick` tool (same runQuick as CLI
// `quick`, but it returns every ranked issue); a CLI `quick` smoke per target
// keeps the literal command under test. Repo targets run init --flows + check.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  classifyFailure,
  countProbeTimeouts,
  mergeLabelTemplate,
  renderGenerated,
  replaceGeneratedSection,
  summarizeCheckResult,
  summarizeQuickResult,
  validateTargets,
} from "./field-test-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const paths = {
  targets: join(root, "scripts", "field-test.targets.json"),
  results: join(root, "docs", "field-test", "results.json"),
  labels: join(root, "docs", "field-test", "labels.json"),
  doc: join(root, "docs", "field-test.md"),
};
const QUICK_TIMEOUT_MS = 10 * 60_000;
const SMOKE_TIMEOUT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 15 * 60_000;
const SPEED_STATES = 10;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const log = (message) => process.stderr.write(`[field-test] ${message}\n`);

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Runs a shell command in its own process group with an outer kill guard. */
function run(command, { cwd, timeoutMs = STEP_TIMEOUT_MS, env } = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        elapsedMs: Math.round(performance.now() - started),
      });
    });
  });
}

/** Starts a long-running server; resolves once `url` answers. */
async function startServer(command, { cwd, url, timeoutMs = 120_000 }) {
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`server exited early: ${stderr.slice(-400)}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return child;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  killGroup(child);
  throw new Error(`server did not answer ${url} within ${timeoutMs} ms`);
}

function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

async function observations(directory) {
  const found = [];
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name === "observations.json")
        found.push(await readJson(next).catch(() => undefined));
    }
  };
  if (directory && existsSync(directory)) await walk(directory);
  return found;
}

function stepFailure(stage, result) {
  return classifyFailure({
    stage,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    signal: result.signal,
    message: (result.stderr || result.stdout).slice(-600),
  });
}

async function quickTarget(target, scratch) {
  const record = { mode: "quick", failures: [], runs: [] };
  const project = await mkdtemp(join(scratch, `${target.id}-mcp-`));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--project", project, "mcp"],
    stderr: "pipe",
    maxBufferSize: 64 * 1024 * 1024,
  });
  const client = new Client({ name: "idiom-field-test", version: "1" });
  try {
    await client.connect(transport);
    // The Top 10 is per target; a target's first URL supplies it.
    for (const url of target.urls) {
      const started = performance.now();
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          const response = await client.callTool(
            { name: "idiom_quick", arguments: { url } },
            { timeout: QUICK_TIMEOUT_MS },
          );
          const elapsedMs = performance.now() - started;
          if (response.isError) {
            const text = response.content
              ?.map((part) => part.text ?? "")
              .join(" ");
            throw new Error(text || "idiom_quick returned isError");
          }
          const summary = summarizeQuickResult(response.structuredContent, {
            elapsedMs,
            target: target.id,
          });
          const runDirectory = response.structuredContent.runDirectory;
          record.runs.push({
            url,
            attempts: attempt,
            ...summary,
            probe: countProbeTimeouts(await observations(runDirectory)),
            runDirectory,
          });
          break;
        } catch (error) {
          const failure = classifyFailure({
            stage: `mcp idiom_quick ${url}`,
            message: String(error?.message ?? error),
          });
          // One retry for transient network trouble; keep both attempts.
          if (
            attempt === 1 &&
            /net::|ECONN|ENOTFOUND|EAI_AGAIN/.test(failure.message)
          ) {
            record.failures.push({ ...failure, retried: true });
            continue;
          }
          record.failures.push(failure);
          break;
        }
      }
    }
  } catch (error) {
    record.failures.push(
      classifyFailure({ stage: "mcp connect", message: String(error) }),
    );
  } finally {
    await client.close().catch(() => {});
  }
  const first = record.runs[0];
  if (first) {
    Object.assign(record, {
      elapsedMs: record.runs.reduce((sum, item) => sum + item.elapsedMs, 0),
      tuples: record.runs.reduce((sum, item) => sum + item.tuples, 0),
      findings: record.runs.reduce((sum, item) => sum + item.findings, 0),
      issues: record.runs.reduce((sum, item) => sum + item.issues, 0),
      topIssues: first.topIssues,
      probe: sumProbe(record.runs.map((item) => item.probe)),
    });
    for (const item of record.runs) delete item.topIssues;
  }
  const smokeProject = await mkdtemp(join(scratch, `${target.id}-cli-`));
  const smoke = await run(
    [
      process.execPath,
      cli,
      "--project",
      smokeProject,
      "quick",
      target.urls[0],
      "--out",
      join(smokeProject, "out"),
    ]
      .map(shellQuote)
      .join(" "),
    { timeoutMs: SMOKE_TIMEOUT_MS },
  );
  record.cliSmoke = {
    url: target.urls[0],
    exitCode: smoke.exitCode,
    signal: smoke.signal,
    timedOut: smoke.timedOut,
    elapsedMs: smoke.elapsedMs,
    ...(smoke.exitCode === 0
      ? { stdout: smoke.stdout.trim().replaceAll(scratch, "$SCRATCH") }
      : { stderrTail: smoke.stderr.slice(-600) }),
  };
  if (smoke.exitCode !== 0)
    record.failures.push(stepFailure("cli quick smoke", smoke));
  return record;
}

function sumProbe(items) {
  return items.reduce(
    (sum, item) => ({
      ran: sum.ran + item.ran,
      partial: sum.partial + item.partial,
      timedOut: sum.timedOut + item.timedOut,
      partialTimedOut: sum.partialTimedOut + item.partialTimedOut,
    }),
    { ran: 0, partial: 0, timedOut: 0, partialTimedOut: 0 },
  );
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

async function repoTarget(target, scratch) {
  const repo = target.repo;
  const record = { mode: "repo", failures: [], steps: [] };
  const directory = join(scratch, target.id);
  const idiom = (args) =>
    `${shellQuote(process.execPath)} ${shellQuote(cli)} --project ${shellQuote(directory)} ${args}`;
  const step = async (name, command, options = {}) => {
    const result = await run(command, { cwd: directory, ...options });
    record.steps.push({
      name,
      exitCode: result.exitCode,
      elapsedMs: result.elapsedMs,
    });
    if (result.exitCode !== 0) {
      record.failures.push(stepFailure(name, result));
      throw new Error(`${name} failed`);
    }
    return result;
  };
  let server;
  try {
    await mkdir(directory, { recursive: true });
    await step(
      "clone",
      `git init -q && git remote add origin ${shellQuote(repo.url)} && git fetch -q --depth 1 origin ${repo.commit} && git checkout -q FETCH_HEAD`,
    );
    for (const command of repo.install) await step("install", command);
    await step("init --yes", idiom("init --yes"));
    const configPath = join(directory, ".idiom", "project.json");
    const config = await readJson(configPath);
    config.server = { ...config.server, ...repo.server };
    await writeJson(configPath, config);
    const [serverCommand, ...setup] = [...repo.dev].reverse();
    for (const command of setup.reverse()) await step("dev setup", command);
    server = await startServer(serverCommand, {
      cwd: directory,
      url: repo.server.readyUrl,
    });
    const flows = await step("init --flows", idiom("init --yes --flows"));
    killGroup(server);
    server = undefined;
    const counts = flows.stdout.match(
      /\((\d+) routes, (\d+) candidate states, (\d+) setup-required/,
    );
    const flow = await readJson(
      join(directory, ".idiom", "flows", "site.json"),
    );
    record.init = {
      routes: counts ? Number(counts[1]) : null,
      states: flow.states.length,
      setupRequired: counts ? Number(counts[3]) : null,
      stateIds: flow.states.map((state) => state.id),
    };
    const states = flow.states.slice(0, SPEED_STATES).map((state) => state.id);
    const check = await step(
      "check",
      idiom(
        `check site --all --fail-on never --json --states ${shellQuote(states.join(","))}`,
      ),
    );
    const json = JSON.parse(check.stdout);
    const runRecord = await readJson(join(json.runDirectory, "run.json"));
    const summary = summarizeCheckResult(json, runRecord, {
      elapsedMs: check.elapsedMs,
      target: target.id,
    });
    Object.assign(record, summary, {
      checkedStates: states,
      probe: countProbeTimeouts(await observations(json.runDirectory)),
      runDirectory: json.runDirectory,
    });
  } catch (error) {
    if (!record.failures.length)
      record.failures.push(
        classifyFailure({ stage: "repo", message: String(error) }),
      );
  } finally {
    if (server) killGroup(server);
  }
  return record;
}

async function runCommand(args) {
  if (!existsSync(cli)) {
    log("dist/cli.js is missing: run bun run build first");
    process.exit(1);
  }
  const targets = validateTargets(await readJson(paths.targets));
  const only = option(args, "--only")?.split(",");
  const scratch =
    option(args, "--out") ??
    join(
      tmpdir(),
      "idiom-field-test",
      new Date().toISOString().replaceAll(":", "-"),
    );
  await mkdir(scratch, { recursive: true });
  log(`scratch: ${scratch}`);
  const previous = existsSync(paths.results)
    ? await readJson(paths.results)
    : undefined;
  const commit = await run("git rev-parse HEAD", { cwd: root });
  const results = {
    version: 1,
    startedAt: new Date().toISOString(),
    idiomCommit: commit.stdout.trim(),
    node: process.version,
    machine: {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
    },
    targets: [],
  };
  for (const target of targets) {
    if (only && !only.includes(target.id)) {
      const kept = previous?.targets?.find((item) => item.id === target.id);
      if (kept) results.targets.push(kept);
      continue;
    }
    log(`${target.id}: ${target.repo ? "repo" : "quick"}`);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const outcome = target.repo
      ? await repoTarget(target, scratch)
      : await quickTarget(target, scratch);
    results.targets.push({
      id: target.id,
      kind: target.kind,
      aiBuilt: target.aiBuilt,
      urls: target.urls,
      startedAt,
      wallMs: Math.round(performance.now() - started),
      ...outcome,
    });
    log(
      `${target.id}: ${outcome.issues ?? 0} issues, ${outcome.failures.length} failure(s)`,
    );
    await mkdir(dirname(paths.results), { recursive: true });
    await writeJson(paths.results, scrub(results, scratch));
  }
  log(`wrote ${paths.results}`);
}

/** Scratch paths never reach committed results. */
function scrub(value, scratch) {
  // macOS reports /var/folders but children may resolve /private/var/folders.
  const text = JSON.stringify(value)
    .replaceAll(`/private${scratch}`, "$SCRATCH")
    .replaceAll(scratch, "$SCRATCH")
    .replaceAll(`/private${tmpdir()}`, "$TMPDIR")
    .replaceAll(tmpdir(), "$TMPDIR");
  return JSON.parse(text);
}

async function labelsTemplate() {
  const results = await readJson(paths.results);
  const labels = existsSync(paths.labels)
    ? await readJson(paths.labels)
    : undefined;
  const merged = mergeLabelTemplate(results, labels);
  await writeJson(paths.labels, merged.labels);
  log(`${merged.added} label slot(s) added to ${paths.labels}`);
}

async function score() {
  const results = await readJson(paths.results);
  const labels = existsSync(paths.labels)
    ? await readJson(paths.labels)
    : { version: 1, labels: {} };
  const document = await readFile(paths.doc, "utf8");
  await writeFile(
    paths.doc,
    replaceGeneratedSection(document, renderGenerated(results, labels)),
  );
  log(`updated ${paths.doc}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "run") await runCommand(rest);
else if (command === "labels-template") await labelsTemplate();
else if (command === "score") await score();
else {
  log(
    "usage: field-test.mjs run [--only ids] [--out dir] | labels-template | score",
  );
  process.exit(2);
}
