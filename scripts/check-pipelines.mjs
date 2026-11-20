#!/usr/bin/env node
// Does Idiom catch one planted UI regression in each way people build?
//
//   bun run check:pipelines                         package.json's version from npm
//   bun run check:pipelines --version 0.23.0        a given published version
//   bun run check:pipelines --tarball <path>        a local npm pack tarball
//   options: --only <id> (repeatable: autobuild, github-action, claude-code,
//            codex, cursor), --cursor-result <file>, --model-key-env,
//            --record <file> (default docs/pipelines.json), --no-record, --keep
//
// From an empty temporary home it installs Idiom the documented way, builds a
// small sample app repo (main clean, a `regression` branch with one planted
// contrast defect), and drives each setup that can run headless in its own
// clone and home, following only the published docs. A step the docs do not
// support is reported as docs drift, never worked around; places where the
// harness stands in for infrastructure (no GitHub runner, no Autobuild agent)
// are declared substitutions. A setup that cannot run here is recorded as not
// run with the reason, never as passed. Cursor cannot run headless: the check
// prints a manual checklist and accepts its recorded result.
//
// Needs network access. Never forwards credentials unless --model-key-env is
// passed, and then only an API key variable already set in this process.
// Each step is its own process group; on a timeout only that group, by the
// PID this script spawned, is killed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, cpus, release, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import {
  appendRun,
  applyLine,
  cursorChecklist,
  evaluateSetup,
  formatTable,
  HEADLESS_IDS,
  manualPending,
  overallVerdict,
  parseAutobuildWiring,
  SETUP_IDS,
  TASK_PROMPT,
  validateCursorResult,
} from "./check-pipelines-lib.mjs";
import {
  cleanEnvironment,
  installCommand,
  PACKAGE_NAME,
  parseGettingStarted,
} from "./first-run-lib.mjs";
import { GIT_IDENTITY } from "./pipelines/common.mjs";
import { runStep, stepNote } from "./process-step.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = join(repositoryRoot, "scripts", "fixtures", "pipelines");
const DEFAULT_GATE = "idiom check --gate --fail-on major --deferred warn";

const { values: args } = parseArgs({
  options: {
    version: { type: "string" },
    tarball: { type: "string" },
    only: { type: "string", multiple: true },
    "cursor-result": { type: "string" },
    "model-key-env": { type: "boolean", default: false },
    record: { type: "string" },
    "no-record": { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});
if (args.version && args.tarball) {
  console.error("check:pipelines: pass --version or --tarball, not both");
  process.exit(2);
}
const selected = args.only?.length ? args.only : SETUP_IDS;
for (const id of selected)
  if (!SETUP_IDS.includes(id)) {
    console.error(
      `check:pipelines: unknown setup ${id}; one of ${SETUP_IDS.join(", ")}`,
    );
    process.exit(2);
  }

const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const tarball = args.tarball ? resolve(args.tarball) : undefined;
const version = tarball ? undefined : (args.version ?? packageJson.version);
const recordPath = resolve(
  repositoryRoot,
  args.record ?? join("docs", "pipelines.json"),
);
const regression = JSON.parse(
  await readFile(join(fixtureRoot, "regression.json"), "utf8"),
);

// Validate a supplied Cursor result before spending minutes on the rest.
let cursorRecorded;
if (args["cursor-result"]) {
  try {
    cursorRecorded = validateCursorResult(
      JSON.parse(await readFile(resolve(args["cursor-result"]), "utf8")),
    );
  } catch (error) {
    console.error(`check:pipelines: ${error.message}`);
    process.exit(2);
  }
}

const gettingStarted = await readFile(
  join(repositoryRoot, "site", "docs", "getting-started.md"),
  "utf8",
);
const configuration = await readFile(
  join(repositoryRoot, "docs", "configuration.md"),
  "utf8",
);
const install = parseGettingStarted(gettingStarted);
const autobuildWiring = parseAutobuildWiring(configuration);

const nodeBin = dirname(process.execPath);
// Real path: macOS tmp is a /var → /private/var symlink, which breaks
// entry-point guards that compare argv[1] with import.meta.url.
const root = await realpath(await mkdtemp(join(tmpdir(), "idiom-pipelines-")));
const evidenceRoot = join(root, "evidence");
await mkdir(evidenceRoot, { recursive: true });
const started = performance.now();

function gitSync(cwd, gitArgs, env) {
  const result = spawnSync("git", [...GIT_IDENTITY, ...gitArgs], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `git ${gitArgs.join(" ")}: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}

/** main = the clean fixture; `regression` = one planted line; a bare origin. */
async function buildSampleRepo(env) {
  const sample = join(root, "sample");
  cpSync(join(fixtureRoot, "app"), sample, { recursive: true });
  gitSync(sample, ["init", "--quiet", "-b", "main"], env);
  gitSync(sample, ["add", "-A"], env);
  gitSync(sample, ["commit", "--quiet", "-m", "Corner Table sample app"], env);
  gitSync(sample, ["checkout", "--quiet", "-b", regression.branch], env);
  const file = join(sample, regression.file);
  await writeFile(
    file,
    applyLine(
      await readFile(file, "utf8"),
      regression.line,
      regression.regression,
    ),
  );
  gitSync(sample, ["commit", "--quiet", "-am", regression.commitMessage], env);
  gitSync(sample, ["checkout", "--quiet", "main"], env);
  const origin = join(root, "origin.git");
  gitSync(root, ["clone", "--quiet", "--bare", sample, origin], env);
  gitSync(origin, ["symbolic-ref", "HEAD", "refs/heads/main"], env);
  return origin;
}

const shared = cleanEnvironment({
  root: join(root, "shared"),
  nodeBin,
  lang: process.env.LANG,
  term: process.env.TERM,
});
shared.GIT_TERMINAL_PROMPT = "0";
for (const directory of [
  shared.HOME,
  shared.TMPDIR,
  shared.npm_config_cache,
  shared.npm_config_prefix,
])
  await mkdir(directory, { recursive: true });
await writeFile(shared.npm_config_userconfig, "");

const installSteps = [];
const installDrift = [];
let idiomVersion = tarball ? null : version;
const setups = [];
let exitCode = 1;

try {
  // 1. Install once, the documented npm line pinned to the measured version.
  if (!install.ok)
    for (const problem of install.problems)
      installDrift.push({
        step: "install",
        doc: "site/docs/getting-started.md#1-install",
        expected: "the documented install block",
        found: problem,
      });
  if (!autobuildWiring.ok)
    console.log(
      `check:pipelines: configuration.md gate command unreadable (${autobuildWiring.problems.join("; ")}); post-checks use ${DEFAULT_GATE}`,
    );
  let installOk = false;
  const headless = HEADLESS_IDS.some((id) => selected.includes(id));
  if (install.ok && headless) {
    const argv = installCommand({
      npmLine: install.install.npmLine,
      version,
      tarball,
    });
    const result = await runStep("install", argv, {
      env: shared,
      cwd: join(root, "shared"),
      timeoutMs: 600_000,
    });
    installOk = result.code === 0;
    installSteps.push({
      id: "install",
      doc: "site/docs/getting-started.md#1-install",
      command: tarball ? `npm install -g ${basename(tarball)}` : argv.join(" "),
      ms: Math.round(result.ms),
      ok: installOk,
      ...(installOk ? {} : { note: stepNote(result) }),
    });
    if (installOk) {
      const printed = spawnSync(
        join(shared.npm_config_prefix, "bin", "idiom"),
        ["--version"],
        { env: shared, encoding: "utf8" },
      );
      const installed = printed.status === 0 ? printed.stdout.trim() : null;
      if (tarball) idiomVersion = installed?.split(/\s/)[0] ?? null;
      else if (!installed?.startsWith(version))
        installDrift.push({
          step: "install",
          doc: "site/docs/getting-started.md#1-install",
          expected: `idiom --version prints ${version}`,
          found: String(installed),
        });
    }
  }

  const originPath = await buildSampleRepo(shared);
  const context = {
    root,
    evidenceRoot,
    nodeBin,
    lang: process.env.LANG,
    term: process.env.TERM,
    prefix: shared.npm_config_prefix,
    originPath,
    regression,
    idiomVersion,
    playwrightLine: install.ok ? install.install.playwrightLine : null,
    gateCommand: autobuildWiring.ok
      ? autobuildWiring.value.command
      : DEFAULT_GATE,
    docs: { gettingStarted, configuration },
    modelKeyEnv: args["model-key-env"],
    actionRepository: "mattskilly/idiom",
  };

  for (const id of HEADLESS_IDS) {
    if (!selected.includes(id)) continue;
    console.log(`\ncheck:pipelines: ${id}`);
    if (!installOk || installDrift.length) {
      setups.push(
        evaluateSetup({
          id,
          steps: [...installSteps],
          docsDrift: [...installDrift],
          installedVersion: idiomVersion,
        }),
      );
      continue;
    }
    const setupStarted = performance.now();
    try {
      const driver = await import(`./pipelines/${id}.mjs`);
      const result = await driver.run(context);
      setups.push({ ...result, steps: [...installSteps, ...result.steps] });
    } catch (error) {
      console.error(error);
      setups.push(
        evaluateSetup({
          id,
          steps: [
            ...installSteps,
            {
              id: "driver",
              command: `scripts/pipelines/${id}.mjs`,
              ms: Math.round(performance.now() - setupStarted),
              ok: false,
              note: error.message,
            },
          ],
          installedVersion: idiomVersion,
          wallMs: Math.round(performance.now() - setupStarted),
        }),
      );
    }
  }

  if (selected.includes("cursor")) {
    console.log(
      `\n${cursorChecklist({
        installLines: install.ok
          ? [install.install.npmLine, install.install.playwrightLine]
          : ["(install block unreadable: see docs drift)"],
        regressionBranch: regression.branch,
        repoPath: args.keep
          ? originPath
          : "<sample origin: rerun with --keep and use the origin.git path it prints>",
        taskPrompt: TASK_PROMPT,
        recordCommand:
          "bun run check:pipelines --only cursor --cursor-result <file>",
      })}\n`,
    );
    setups.push(
      cursorRecorded ??
        manualPending(
          "cursor",
          "manual: follow the printed checklist, then rerun with --only cursor --cursor-result <file>",
        ),
    );
  }

  const verdict = overallVerdict(setups);
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
    docsCommit: gitSync(repositoryRoot, ["rev-parse", "HEAD"]),
    machine: {
      platform: process.platform,
      release: release(),
      arch: arch(),
      cpuModel: cpus()[0]?.model ?? null,
      cpuCount: cpus().length,
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
    },
    only: args.only?.length ? args.only : undefined,
    taskPrompt: TASK_PROMPT,
    regression: {
      rule: regression.rule,
      file: regression.file,
      branch: regression.branch,
    },
    setups,
    verdict: verdict.verdict,
    notRun: verdict.notRun,
    totalMs: Math.round(performance.now() - started),
  };
  if (!args["no-record"]) {
    const existing = existsSync(recordPath)
      ? await readFile(recordPath, "utf8")
      : undefined;
    await writeFile(recordPath, appendRun(existing, run));
    console.log(`check:pipelines: recorded in ${recordPath}`);
  }
  console.log(formatTable(run));
  for (const setup of setups)
    if (setup.substitutions.length)
      console.log(
        `  ${setup.id} substitutions:\n${setup.substitutions.map((line) => `    - ${line}`).join("\n")}`,
      );
  exitCode = verdict.exitCode;
} finally {
  if (args.keep)
    console.log(`check:pipelines: kept ${root} (evidence in ${evidenceRoot})`);
  else await rm(root, { recursive: true, force: true });
}
process.exit(exitCode);
