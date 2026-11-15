#!/usr/bin/env node
// Time to first finding from a clean install, following the getting-started
// page literally.
//
//   bun run measure:first-run                       package.json's version from npm
//   bun run measure:first-run --version 0.22.0      a given published version
//   bun run measure:first-run --tarball <path>      a local npm pack tarball
//   options: --record <file> (default docs/first-run.json), --no-record, --keep
//
// It reads the install and review commands from site/docs/getting-started.md
// (any line it cannot follow is a docs-drift failure, never worked around),
// runs them from an empty temporary HOME, npm cache and prefix with an
// environment built from scratch, serves a bundled sample page for the doc's
// localhost placeholder, and times install, browser download and the first
// finding against a five-minute budget. The result is appended to the record.
//
// Needs network access. Each step is spawned as its own process group; on a
// timeout only that group, by the PID this script spawned, is killed. Never
// kill by name or pattern: parallel builds share this host.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, cpus, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  appendRun,
  BUDGET_MS,
  cleanEnvironment,
  evaluateRun,
  formatTable,
  installCommand,
  PACKAGE_NAME,
  parseGettingStarted,
  parseQuickSummary,
  quickCommand,
} from "./first-run-lib.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const STEP_TIMEOUT_MS = 600_000;

const { values: args } = parseArgs({
  options: {
    version: { type: "string" },
    tarball: { type: "string" },
    record: { type: "string" },
    "no-record": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});
if (args.version && args.tarball) {
  console.error("first-run: pass --version or --tarball, not both");
  process.exit(2);
}

const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const tarball = args.tarball ? resolve(args.tarball) : undefined;
const version = tarball ? undefined : (args.version ?? packageJson.version);
const recordPath = resolve(
  repositoryRoot,
  args.record ?? join("docs", "first-run.json"),
);

/** Spawns one step in its own process group and times it. */
function runStep(id, argv, { env, cwd, timeoutMs, onStdoutLine }) {
  return new Promise((resolveStep) => {
    const started = performance.now();
    let ms;
    let stdout = "";
    const stderrTail = [];
    let settled = false;
    let timedOut = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    const stopClock = () => {
      ms ??= performance.now() - started;
    };
    const lines = (stream, onLine) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) onLine(line);
      });
      stream.on("end", () => {
        if (buffer) onLine(buffer);
      });
    };
    lines(child.stdout, (line) => {
      stdout += `${line}\n`;
      console.log(`[${id}] ${line}`);
      if (onStdoutLine?.(line)) stopClock();
    });
    lines(child.stderr, (line) => {
      console.error(`[${id}] ${line}`);
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopClock();
      resolveStep({
        ms,
        code,
        stdout,
        stderrTail,
        timedOut,
        error: error?.message,
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

function stepNote(result) {
  if (result.timedOut) return `timed out after ${STEP_TIMEOUT_MS / 1000}s`;
  if (result.error) return result.error;
  const tail = result.stderrTail.filter(Boolean).slice(-3).join(" | ");
  return `exit ${result.code}${tail ? `: ${tail}` : ""}`;
}

function toolVersion(command, env) {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function docsCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function serveSample() {
  const page = await readFile(
    join(repositoryRoot, "scripts", "fixtures", "first-run", "index.html"),
  );
  const server = createServer((request, response) => {
    request.resume();
    if ((request.url ?? "/").split("?")[0] === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(page);
    } else {
      response.statusCode = 404;
      response.end("not found");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

const docsPath = join(repositoryRoot, "site", "docs", "getting-started.md");
const docs = parseGettingStarted(await readFile(docsPath, "utf8"));
const docsProblems = docs.ok ? [] : [...docs.problems];

const nodeBin = dirname(process.execPath);
for (const tool of ["npm", "npx"]) {
  if (!existsSync(join(nodeBin, tool))) {
    console.error(
      `first-run: ${tool} is not next to node in ${nodeBin}; run with a Node install that ships npm and npx`,
    );
    process.exit(2);
  }
}

const root = await mkdtemp(join(tmpdir(), "idiom-first-run-"));
const env = cleanEnvironment({
  root,
  nodeBin,
  lang: process.env.LANG,
  term: process.env.TERM,
});
for (const directory of [
  env.HOME,
  env.TMPDIR,
  env.npm_config_cache,
  env.npm_config_prefix,
  join(root, "work"),
]) {
  await mkdir(directory, { recursive: true });
}
await writeFile(env.npm_config_userconfig, "");
const work = join(root, "work");

const steps = [];
let firstFinding = null;
let idiomVersion = tarball ? null : version;
let browserCacheInsideHome = false;
let sample;
let exitCode = 1;

try {
  if (docs.ok) {
    // 1. install: the documented npm line, pinned to the measured version.
    const install = installCommand({
      npmLine: docs.install.npmLine,
      version,
      tarball,
    });
    const installResult = await runStep("install", install, {
      env,
      cwd: work,
      timeoutMs: STEP_TIMEOUT_MS,
    });
    const installOk = installResult.code === 0;
    steps.push({
      id: "install",
      docLine: docs.install.npmLine,
      command: tarball
        ? `npm install -g ${basename(tarball)}`
        : install.join(" "),
      ms: Math.round(installResult.ms),
      ok: installOk,
      ...(installOk ? {} : { note: stepNote(installResult) }),
    });

    if (installOk) {
      const installed = toolVersion(
        join(env.npm_config_prefix, "bin", "idiom"),
        env,
      );
      if (tarball) idiomVersion = installed?.split(/\s/)[0] ?? null;
      else if (!installed?.startsWith(version))
        docsProblems.push(
          `installed idiom --version printed ${JSON.stringify(installed)}, expected ${version}`,
        );
      const installedPackage = JSON.parse(
        await readFile(
          join(
            env.npm_config_prefix,
            "lib",
            "node_modules",
            PACKAGE_NAME,
            "package.json",
          ),
          "utf8",
        ),
      );
      const pin = installedPackage.dependencies?.playwright;
      if (pin !== docs.install.playwrightPin)
        docsProblems.push(
          `docs install Chromium for playwright@${docs.install.playwrightPin} but the package depends on playwright ${pin}`,
        );
    }

    // 2. browser: the documented npx line, verbatim.
    if (installOk && docsProblems.length === 0) {
      const browserArgv = docs.install.playwrightLine.split(" ");
      const browserResult = await runStep("browser", browserArgv, {
        env,
        cwd: work,
        timeoutMs: STEP_TIMEOUT_MS,
      });
      browserCacheInsideHome = [
        join(env.HOME, "Library", "Caches", "ms-playwright"),
        join(env.XDG_CACHE_HOME, "ms-playwright"),
      ].some((path) => existsSync(path));
      const browserOk = browserResult.code === 0 && browserCacheInsideHome;
      steps.push({
        id: "browser",
        docLine: docs.install.playwrightLine,
        command: docs.install.playwrightLine,
        ms: Math.round(browserResult.ms),
        ok: browserOk,
        ...(browserOk
          ? {}
          : {
              note:
                browserResult.code === 0
                  ? "browser cache not inside temporary home"
                  : stepNote(browserResult),
            }),
      });

      // 3. first-finding: the documented quick line on the bundled sample.
      if (browserOk) {
        sample = await serveSample();
        const quick = quickCommand({
          quickLine: docs.review.quickLine,
          placeholderUrl: docs.review.placeholderUrl,
          sampleUrl: sample.url,
        });
        const quickResult = await runStep("first-finding", quick, {
          env,
          cwd: work,
          timeoutMs: STEP_TIMEOUT_MS,
          onStdoutLine: (line) => parseQuickSummary(line) !== null,
        });
        const summary = parseQuickSummary(quickResult.stdout);
        const quickOk = quickResult.code === 0 && summary !== null;
        if (summary && summary.count > 0) {
          let first;
          try {
            const findings = JSON.parse(
              await readFile(
                join(dirname(summary.reportPath), "findings.json"),
                "utf8",
              ),
            );
            first = Array.isArray(findings) ? findings[0] : undefined;
          } catch {}
          firstFinding = {
            count: summary.count,
            ruleId: first?.rule ?? first?.category ?? null,
            title: first?.explanation
              ? first.explanation.split("\n")[0].slice(0, 200)
              : null,
          };
        } else if (summary)
          firstFinding = { count: 0, ruleId: null, title: null };
        steps.push({
          id: "first-finding",
          docLine: docs.review.quickLine,
          command: `idiom quick ${docs.review.placeholderUrl} → ${quick.join(" ")}`,
          ms: Math.round(quickResult.ms),
          ok: quickOk,
          ...(quickOk
            ? {}
            : {
                note:
                  quickResult.code === 0
                    ? "no Quick review summary line"
                    : stepNote(quickResult),
              }),
        });
      }
    }
  }

  const decision = evaluateRun({
    steps,
    firstFinding,
    docsProblems,
    budgetMs: BUDGET_MS,
  });
  const run = {
    measuredAt: new Date().toISOString(),
    idiomVersion,
    source: tarball
      ? {
          kind: "tarball",
          path: basename(tarball),
          sha512: createHash("sha512")
            .update(await readFile(tarball))
            .digest("base64"),
        }
      : { kind: "npm", spec: `${PACKAGE_NAME}@${version}` },
    docsCommit: docsCommit(),
    machine: {
      platform: process.platform,
      release: release(),
      arch: arch(),
      cpuModel: cpus()[0]?.model ?? null,
      cpuCount: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
      npm: toolVersion(join(nodeBin, "npm"), env),
    },
    docsCommands: docs.ok
      ? [
          docs.install.npmLine,
          docs.install.playwrightLine,
          docs.review.quickLine,
        ]
      : [],
    steps,
    totalMs: decision.totalMs,
    budgetMs: BUDGET_MS,
    notCounted: ["sample server start"],
    firstFinding,
    isolation: { browserCacheInsideHome },
    passed: decision.passed,
    failure: decision.failure,
  };

  if (!args["no-record"]) {
    const existing = existsSync(recordPath)
      ? await readFile(recordPath, "utf8")
      : undefined;
    await writeFile(recordPath, appendRun(existing, run));
    console.log(`first-run: recorded in ${recordPath}`);
  }
  console.log(formatTable(run));
  exitCode = run.passed ? 0 : 1;
} finally {
  await sample?.close();
  if (args.keep) console.log(`first-run: kept ${root}`);
  else await rm(root, { recursive: true, force: true });
}
process.exit(exitCode);
