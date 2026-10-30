#!/usr/bin/env node
// Field test: run the built CLI against public sites, one OSS repo and the
// local field app, then score agent/human labels into docs/field-test.md.
//
//   bun run build
//   node scripts/field-test.mjs run [--only a,b] [--out <scratch dir>]
//       [--targets <candidates.json> --results <screen.json>]  (screening)
//   node scripts/field-test.mjs labels-template
//   node scripts/field-test.mjs feel
//   node scripts/field-test.mjs score
//   node scripts/field-test.mjs rate [--out <scratch dir>] [--port <n>]
//
// Ranked data comes from the MCP `idiom_quick` tool (same runQuick as CLI
// `quick`, but it returns every ranked issue); a CLI `quick` smoke per target
// keeps the literal command under test. Repo and local targets run
// init --flows + check.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  applyHumanRating,
  classifyFailure,
  countProbeTimeouts,
  FEEL_RULES,
  feelPrecision,
  mergeLabelTemplate,
  probeTupleOverheadMs,
  ratingQueue,
  renderGenerated,
  replaceGeneratedSection,
  sumHeldReplays,
  summarizeCheckResult,
  summarizeHeldReplays,
  summarizeProbeSafety,
  summarizeQuickResult,
  sumProbeSafety,
  uniqueFeelKeys,
  validateTargets,
} from "./field-test-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const paths = {
  targets: join(root, "scripts", "field-test.targets.json"),
  results: join(root, "docs", "field-test", "results.json"),
  labels: join(root, "docs", "field-test", "labels.json"),
  doc: join(root, "docs", "field-test.md"),
  rules: join(root, "docs", "field-test"),
};
// The static quick limit plus quick review's default per-page probe budget.
const QUICK_PROBE_BUDGET_MS = 45_000;
const QUICK_TIMEOUT_MS = 10 * 60_000 + QUICK_PROBE_BUDGET_MS;
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

/** Each tuple's observations.json with its metadata.json and timelines.json. */
async function tupleDocuments(directory) {
  const found = [];
  const walk = async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some((entry) => entry.name === "observations.json"))
      found.push({
        observations: await readJson(join(path, "observations.json")).catch(
          () => undefined,
        ),
        metadata: await readJson(join(path, "metadata.json")).catch(
          () => undefined,
        ),
        timelines: await readJson(join(path, "timelines.json")).catch(
          () => undefined,
        ),
      });
    for (const entry of entries)
      if (entry.isDirectory()) await walk(join(path, entry.name));
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

async function quickTarget(target, scratch, previous) {
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
          const tuples = await tupleDocuments(runDirectory);
          const documents = tuples.map((item) => item.observations);
          const probeSafety = summarizeProbeSafety(documents);
          if (probeSafety.nonSafeSent > 0)
            record.failures.push(
              classifyFailure({
                stage: "probe safety",
                message: `probe sent ${probeSafety.nonSafeSent} non-safe request(s): ${JSON.stringify(probeSafety.sent)}`,
              }),
            );
          record.runs.push({
            url,
            attempts: attempt,
            ...summary,
            probe: countProbeTimeouts(documents),
            probeSafety,
            heldReplay: summarizeHeldReplays(
              documents,
              tuples.map((item) => item.timelines),
            ),
            probeTupleOverheadMs: probeTupleOverheadMs(
              tuples.map((item) => item.metadata),
              documents,
            ),
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
      feelIssues: record.runs.flatMap((item) => item.feelIssues ?? []),
      probe: sumProbe(record.runs.map((item) => item.probe)),
      heldReplay: sumHeldReplays(record.runs.map((item) => item.heldReplay)),
      probeSafety: sumProbeSafety(record.runs.map((item) => item.probeSafety)),
      probeTupleOverheadMs: record.runs.reduce(
        (sum, item) => sum + (item.probeTupleOverheadMs ?? 0),
        0,
      ),
    });
    // The last static (probe-free) run of this target is the baseline the
    // probe's overhead is measured against.
    const staticBaselineMs =
      previous?.probe?.ran === 0 &&
      previous?.probe?.partial === 0 &&
      previous?.probe?.timedOut === 0
        ? previous.elapsedMs
        : previous?.staticBaselineMs;
    if (typeof staticBaselineMs === "number") {
      record.staticBaselineMs = staticBaselineMs;
      record.probeOverheadMs = Math.round(record.elapsedMs - staticBaselineMs);
    }
    for (const item of record.runs) {
      delete item.topIssues;
      delete item.feelIssues;
    }
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

/** Clones and installs a pinned OSS repo, then checks it. */
async function repoTarget(target, scratch) {
  const repo = target.repo;
  const record = { mode: "repo", failures: [], steps: [] };
  const directory = join(scratch, target.id);
  const step = stepRunner(record, directory);
  try {
    await mkdir(directory, { recursive: true });
    await step(
      "clone",
      `git init -q && git remote add origin ${shellQuote(repo.url)} && git fetch -q --depth 1 origin ${repo.commit} && git checkout -q FETCH_HEAD`,
    );
    for (const command of repo.install) await step("install", command);
    await checkTarget(target, directory, record, {
      server: repo.server,
      dev: repo.dev,
      states: (flow) => flow.states.slice(0, SPEED_STATES),
    });
  } catch (error) {
    if (!record.failures.length)
      record.failures.push(
        classifyFailure({ stage: "repo", message: String(error) }),
      );
  }
  return record;
}

/**
 * Copies a fixture app from this repo into scratch (so .idiom/ never lands
 * in the repo), commits it, and checks every state, one check per state:
 * a single flow run shares its probe time by check-candidate weight, which
 * starves form-only states of their held and failure replays.
 */
async function localTarget(target, scratch) {
  const local = target.local;
  const record = { mode: "local", failures: [], steps: [] };
  const source = resolve(root, local.path);
  const directory = join(scratch, target.id);
  const step = stepRunner(record, directory);
  try {
    if (!source.startsWith(`${root}/`))
      throw new Error(`${local.path} escapes the repo`);
    await rm(directory, { recursive: true, force: true });
    await cp(source, directory, {
      recursive: true,
      filter: (path) => !path.includes("/.idiom"),
    });
    await step(
      "git init",
      "git init -q && git add -A && git -c user.name=field-test -c user.email=field-test@localhost commit -q -m fixture",
    );
    await checkTarget(target, directory, record, {
      server: local.server,
      dev: local.dev,
      states: (flow) => flow.states,
      perState: true,
    });
  } catch (error) {
    if (!record.failures.length)
      record.failures.push(
        classifyFailure({ stage: "local", message: String(error) }),
      );
  }
  return record;
}

function stepRunner(record, directory) {
  return async (name, command, options = {}) => {
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
}

/** init, server merge, init --flows and check: shared by repo and local targets. */
async function checkTarget(target, directory, record, options) {
  const idiom = (args) =>
    `${shellQuote(process.execPath)} ${shellQuote(cli)} --project ${shellQuote(directory)} ${args}`;
  const step = stepRunner(record, directory);
  let server;
  try {
    await step("init --yes", idiom("init --yes"));
    const configPath = join(directory, ".idiom", "project.json");
    const config = await readJson(configPath);
    config.server = { ...config.server, ...options.server };
    await writeJson(configPath, config);
    const [serverCommand, ...setup] = [...options.dev].reverse();
    for (const command of setup.reverse()) await step("dev setup", command);
    server = await startServer(serverCommand, {
      cwd: directory,
      url: options.server.readyUrl,
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
    const states = options.states(flow).map((state) => state.id);
    const batches = options.perState ? states.map((id) => [id]) : [states];
    const checks = [];
    for (const batch of batches) {
      const check = await step(
        "check",
        idiom(
          `check site --all --fail-on never --json --states ${shellQuote(batch.join(","))}`,
        ),
      );
      const json = JSON.parse(check.stdout);
      const runRecord = await readJson(join(json.runDirectory, "run.json"));
      const tuples = await tupleDocuments(json.runDirectory);
      const documents = tuples.map((item) => item.observations);
      checks.push({
        states: batch,
        elapsedMs: check.elapsedMs,
        summary: summarizeCheckResult(json, runRecord, {
          elapsedMs: check.elapsedMs,
          target: target.id,
        }),
        probe: countProbeTimeouts(documents),
        probeSafety: summarizeProbeSafety(documents),
        heldReplay: summarizeHeldReplays(
          documents,
          tuples.map((item) => item.timelines),
        ),
        ledger: documents.some((document) => document?.probe?.safety),
        runDirectory: json.runDirectory,
      });
    }
    const [single] = checks;
    const merged =
      checks.length === 1 && single
        ? single.summary
        : {
            elapsedMs: checks.reduce((sum, item) => sum + item.elapsedMs, 0),
            tuples: checks.reduce((sum, item) => sum + item.summary.tuples, 0),
            captures: null,
            findings: checks.reduce(
              (sum, item) => sum + item.summary.findings,
              0,
            ),
            issues: checks.reduce((sum, item) => sum + item.summary.issues, 0),
            groups: checks.reduce((sum, item) => sum + item.summary.groups, 0),
            // A per-state run has no flow-wide ranking; findings are rated, not ranked.
            topIssues: [],
            feelIssues: uniqueFeelKeys(
              checks.flatMap((item) => item.summary.feelIssues),
            ),
            timings: null,
            probeCoverage: null,
          };
    const probeSafety = sumProbeSafety(checks.map((item) => item.probeSafety));
    Object.assign(record, merged, {
      checkedStates: states,
      probe: sumProbe(checks.map((item) => item.probe)),
      probeSafety,
      // Configured flows keep no probe.safety ledger under the app policy:
      // the probe guard aborts every non-safe request instead, which the
      // field app's browser test proves against its own request counter.
      probeSafetyLedger: checks.every((item) => item.ledger)
        ? "ledger"
        : "none (app policy: non-safe requests are aborted by the probe guard)",
      heldReplay: sumHeldReplays(checks.map((item) => item.heldReplay)),
      ...(checks.length > 1
        ? {
            perState: checks.map((item) => ({
              states: item.states,
              elapsedMs: item.elapsedMs,
              findings: item.summary.findings,
              issues: item.summary.issues,
              heldReplay: item.heldReplay,
              runDirectory: item.runDirectory,
            })),
          }
        : { runDirectory: single?.runDirectory }),
    });
    if (probeSafety.nonSafeSent > 0)
      record.failures.push(
        classifyFailure({
          stage: "probe safety",
          message: `probe sent ${probeSafety.nonSafeSent} non-safe request(s): ${JSON.stringify(probeSafety.sent)}`,
        }),
      );
  } finally {
    if (server) killGroup(server);
  }
}

async function runCommand(args) {
  if (!existsSync(cli)) {
    log("dist/cli.js is missing: run bun run build first");
    process.exit(1);
  }
  // --targets/--results let a screening run use candidate targets without
  // touching the committed manifest or results.
  const targetsPath = option(args, "--targets") ?? paths.targets;
  const resultsPath = option(args, "--results") ?? paths.results;
  const targets = option(args, "--targets")
    ? await readJson(targetsPath)
    : validateTargets(await readJson(targetsPath));
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
  const previous = existsSync(resultsPath)
    ? await readJson(resultsPath)
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
    const mode = target.local ? "local" : target.repo ? "repo" : "quick";
    log(`${target.id}: ${mode}`);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const outcome = target.local
      ? await localTarget(target, scratch)
      : target.repo
        ? await repoTarget(target, scratch)
        : await quickTarget(
            target,
            scratch,
            previous?.targets?.find((item) => item.id === target.id),
          );
    results.targets.push({
      id: target.id,
      kind: target.kind,
      ...(target.stack ? { stack: target.stack } : {}),
      aiBuilt: target.aiBuilt,
      urls: target.urls,
      startedAt,
      wallMs: Math.round(performance.now() - started),
      ...outcome,
    });
    log(
      `${target.id}: ${outcome.issues ?? 0} issues, ${outcome.failures.length} failure(s)`,
    );
    await mkdir(dirname(resultsPath), { recursive: true });
    await writeJson(resultsPath, scrub(results, scratch));
  }
  log(`wrote ${resultsPath}`);
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

/**
 * Writes each feel rule's precision into docs/field-test/<rule>.json: the
 * previous block moves to history[], every other key is kept.
 */
async function feel() {
  const results = await readJson(paths.results);
  const labels = existsSync(paths.labels)
    ? await readJson(paths.labels)
    : { version: 1, labels: {} };
  const rows = feelPrecision(results, labels);
  const measuredAt = results.startedAt;
  for (const row of rows) {
    const path = join(paths.rules, `${row.rule.replace(/^idiom:/, "")}.json`);
    const current = existsSync(path)
      ? await readJson(path)
      : { rule: row.rule };
    const history = [...(current.history ?? [])];
    if (current.precision !== undefined) history.push(current.precision);
    const { history: _history, ...rest } = current;
    await writeJson(path, {
      ...rest,
      precision: {
        source: "node scripts/field-test.mjs feel",
        measuredAt,
        idiomCommit: results.idiomCommit,
        threshold: 0.8,
        minN: 5,
        public: row.public,
        fieldApp: row.fieldApp,
        combined: row.combined,
        met: row.met,
      },
      history,
    });
  }
  const show = (counts) =>
    counts.n === 0
      ? "n=0"
      : `${counts.agree}/${counts.n} = ${(counts.precision * 100).toFixed(0)}%`;
  for (const row of rows)
    log(
      `${row.rule}: public ${show(row.public)}; field app ${show(row.fieldApp)}; combined ${show(row.combined)}${row.met ? "" : " (gate not met)"}`,
    );
  log(`wrote ${FEEL_RULES.length} rule file(s) under ${paths.rules}`);
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

/** The newest default scratch directory, when `run` was not given --out. */
async function latestScratch() {
  const parent = join(tmpdir(), "idiom-field-test");
  if (!existsSync(parent)) return undefined;
  const names = (await readdir(parent)).sort();
  return names.length === 0 ? undefined : join(parent, names.at(-1));
}

/**
 * Serves a local page for the human rating pass: one queued issue at a time
 * with its evidence, rated agree/disagree/unsure into labels.json. The agent's
 * rating stays hidden until the human has rated, so it cannot anchor them.
 */
async function rate(args) {
  const scratch = option(args, "--out") ?? (await latestScratch());
  const port = Number(option(args, "--port") ?? 4791);
  const results = await readJson(paths.results);
  const expand = (path) =>
    path
      .replace("$SCRATCH", scratch ?? "$SCRATCH")
      .replace("$TMPDIR", tmpdir());
  const evidenceFor = async (item) => {
    if (item.evidence === undefined) return undefined;
    for (const directory of item.runDirectories) {
      const candidate = resolve(expand(directory), item.evidence);
      if (
        await stat(candidate).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return candidate;
    }
    return undefined;
  };
  const queue = async () => ratingQueue(results, await readJson(paths.labels));
  const save = async (key, rating, reason) => {
    const labels = applyHumanRating(
      await readJson(paths.labels),
      key,
      rating,
      reason,
    );
    const temporary = `${paths.labels}.${process.pid}.tmp`;
    await writeJson(temporary, labels);
    await rename(temporary, paths.labels);
  };
  const body = (request) =>
    new Promise((done, fail) => {
      let text = "";
      request.on("data", (chunk) => {
        text += chunk;
      });
      request.on("end", () => done(text));
      request.on("error", fail);
    });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(RATE_PAGE);
      } else if (request.method === "GET" && url.pathname === "/queue") {
        const items = await queue();
        const withEvidence = await Promise.all(
          items.map(async ({ runDirectories: _dirs, ...item }, index) => ({
            ...item,
            hasEvidence: (await evidenceFor(items[index])) !== undefined,
          })),
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(withEvidence));
      } else if (request.method === "GET" && url.pathname === "/evidence") {
        const item = (await queue()).find(
          (entry) => entry.key === url.searchParams.get("key"),
        );
        const file = item && (await evidenceFor(item));
        if (file === undefined) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "image/png" });
        response.end(await readFile(file));
      } else if (request.method === "POST" && url.pathname === "/rate") {
        const { key, rating, reason } = JSON.parse(await body(request));
        await save(key, rating, reason ?? "");
        response.writeHead(204);
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  server.listen(port, "127.0.0.1", async () => {
    const waiting = (await queue()).length;
    log(
      `${waiting} issue(s) to rate; evidence from ${scratch ?? "(no scratch dir found)"}`,
    );
    log(`open http://127.0.0.1:${port}  (Ctrl-C when done)`);
  });
}

const RATE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Field test rating</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--card:#fff;--agree:#15803d;--disagree:#b91c1c;--unsure:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--agree:#4ade80;--disagree:#f87171;--unsure:#facc15}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 120px}
header{display:flex;justify-content:space-between;gap:12px;align-items:baseline;color:var(--muted)}
progress{width:100%;height:6px;margin:8px 0 20px;accent-color:var(--fg)}
h1{font-size:18px;margin:4px 0 8px;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:4px 16px}
code{font-size:12px;overflow-wrap:anywhere}
figure{margin:16px 0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;text-align:center}
figure img{max-width:100%;max-height:60vh;object-fit:contain}
.none{color:var(--muted);padding:40px}
.bar{position:fixed;inset:auto 0 0 0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px}
.bar div{max-width:1100px;margin:0 auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button[data-r=agree]{border-color:var(--agree)}button[data-r=disagree]{border-color:var(--disagree)}button[data-r=unsure]{border-color:var(--unsure)}
input{flex:1;min-width:180px;font:inherit;padding:8px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.agent{margin-top:8px;color:var(--muted);font-size:13px}
kbd{font-size:11px;border:1px solid var(--line);border-radius:3px;padding:0 4px;margin-left:4px}
</style></head><body><main>
<header><span id="pos"></span><span>Is this a real problem a person would notice?</span></header>
<progress id="bar" value="0" max="1"></progress>
<div id="item"></div>
</main>
<div class="bar"><div>
<button data-r="agree">Agree<kbd>A</kbd></button>
<button data-r="disagree">Disagree<kbd>D</kbd></button>
<button data-r="unsure">Unsure<kbd>U</kbd></button>
<input id="reason" placeholder="Why (optional, N to focus)">
<button id="skip">Skip<kbd>S</kbd></button>
</div></div>
<script>
let queue=[],index=0,total=0,done=0,last=null;
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function load(){queue=await (await fetch("/queue")).json();total=total||queue.length;index=0;show()}
function show(){
  const pos=document.getElementById("pos"),item=document.getElementById("item");
  document.getElementById("bar").max=Math.max(total,1);document.getElementById("bar").value=done;
  const agent=last?'<p class="agent">Previous: you said <b>'+esc(last.rating)+'</b>; the agent said <b>'+esc(last.agent?.rating??"nothing")+'</b>'+(last.agent?.reason?' ('+esc(last.agent.reason)+')':'')+'</p>':'';
  if(index>=queue.length){pos.textContent=done+" rated";item.innerHTML=agent+'<h1>All done.</h1><p>Next: <code>node scripts/field-test.mjs feel</code> then <code>node scripts/field-test.mjs score</code>.</p>';return}
  const q=queue[index];
  pos.textContent=(done+1)+" of "+total+" · "+q.target+(q.topTen?" · Top 10 #"+q.rank:" · feel")+" · "+q.severity;
  item.innerHTML=agent+'<h1>'+esc(q.title)+'</h1><div class="meta"><span>'+q.rules.map(r=>'<code>'+esc(r)+'</code>').join(" ")+'</span>'+(q.where?'<span>'+esc(q.where)+'</span>':'')+(q.selector?'<span><code>'+esc(q.selector)+'</code></span>':'')+'</div>'+
    (q.hasEvidence?'<figure><img alt="Evidence for this finding" src="/evidence?key='+encodeURIComponent(q.key)+'"></figure>':'<figure><p class="none">No evidence image on disk for this run. Rate from the title, or skip.</p></figure>');
  document.getElementById("reason").value="";
}
async function rate(r){
  const q=queue[index];if(!q)return;
  const reason=document.getElementById("reason").value;
  const res=await fetch("/rate",{method:"POST",body:JSON.stringify({key:q.key,rating:r,reason})});
  if(!res.ok){alert(await res.text());return}
  last={rating:r,agent:q.agent};done++;index++;show();
}
document.querySelectorAll("[data-r]").forEach(b=>b.onclick=()=>rate(b.dataset.r));
document.getElementById("skip").onclick=()=>{index++;show()};
document.addEventListener("keydown",e=>{
  if(e.target.id==="reason"){if(e.key==="Escape")e.target.blur();return}
  const k=e.key.toLowerCase();
  if(k==="a")rate("agree");else if(k==="d")rate("disagree");else if(k==="u")rate("unsure");
  else if(k==="s"){index++;show()}else if(k==="n"){e.preventDefault();document.getElementById("reason").focus()}
});
load();
</script></body></html>
`;

const [command, ...rest] = process.argv.slice(2);
if (command === "run") await runCommand(rest);
else if (command === "labels-template") await labelsTemplate();
else if (command === "feel") await feel();
else if (command === "score") await score();
else if (command === "rate") await rate(rest);
else {
  log(
    "usage: field-test.mjs run [--only ids] [--out dir] [--targets file --results file] | labels-template | feel | score | rate [--out dir] [--port n]",
  );
  process.exit(2);
}
