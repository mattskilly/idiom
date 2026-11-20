// Helpers shared by the build-setup drivers: isolated homes, host tools,
// per-setup sample clones, the documented browser step and the independent
// post-check. Kills only ever go through process-step.mjs, by own PID.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { applyLine, plantedInCheckJson } from "../check-pipelines-lib.mjs";
import { cleanEnvironment } from "../first-run-lib.mjs";
import { runStep, stepNote } from "../process-step.mjs";

export const GIT_IDENTITY = [
  "-c",
  "user.name=Idiom Pipelines",
  "-c",
  "user.email=pipelines@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

/**
 * A fresh home for one setup: cleanEnvironment under root/setups/<id>, plus
 * CLAUDE_CONFIG_DIR and CODEX_HOME inside it. PATH holds the setup's own
 * hostbin (only the tools it links), the shared install prefix's bin, then
 * node and the system directories.
 */
export async function isolatedHome(context, id) {
  const setupRoot = join(context.root, "setups", id);
  const env = cleanEnvironment({
    root: setupRoot,
    nodeBin: context.nodeBin,
    lang: context.lang,
    term: context.term,
  });
  const hostbin = join(setupRoot, "hostbin");
  env.PATH = [
    hostbin,
    join(context.prefix, "bin"),
    ...env.PATH.split(":").slice(1),
  ].join(":");
  env.npm_config_prefix = context.prefix;
  env.CLAUDE_CONFIG_DIR = join(env.HOME, ".claude");
  env.CODEX_HOME = join(env.HOME, ".codex");
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  for (const directory of [
    env.HOME,
    env.TMPDIR,
    env.npm_config_cache,
    env.CLAUDE_CONFIG_DIR,
    env.CODEX_HOME,
    hostbin,
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(env.npm_config_userconfig, "");
  const evidence = join(context.evidenceRoot, id);
  await mkdir(evidence, { recursive: true });
  return { root: setupRoot, env, hostbin, evidence };
}

const isShellWrapper = async (path) => {
  try {
    const head = (await readFile(path)).subarray(0, 64).toString("utf8");
    return /^#!\s*\/(usr\/)?bin\/(env\s+)?(ba|z)?sh\b/.test(head);
  } catch {
    return true;
  }
};

/**
 * Finds a host tool in the parent PATH, skipping shell wrappers that search
 * PATH themselves, and links only that executable into the setup's hostbin so
 * nothing else from the parent environment is inherited.
 */
export async function hostTool(
  name,
  home,
  parentPath = process.env.PATH ?? "",
) {
  const candidates = [];
  for (const directory of parentPath.split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, name);
    if (existsSync(path) && !candidates.includes(path)) candidates.push(path);
  }
  if (candidates.length === 0)
    return { missing: `${name} is not installed on this machine` };
  let real;
  for (const candidate of candidates) {
    const resolved = await realpath(candidate);
    if (!(await isShellWrapper(resolved))) {
      real = resolved;
      break;
    }
  }
  if (!real)
    return {
      missing: `${name} on PATH is only a shell wrapper (${candidates.join(", ")}); no real executable found`,
    };
  const link = join(home.hostbin, name);
  if (!existsSync(link)) await symlink(real, link);
  const version = spawnSync(link, ["--version"], {
    env: home.env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (version.status !== 0)
    return {
      missing: `${name} --version failed in the clean environment: ${(version.stderr || version.stdout || version.error?.message || "").trim().slice(0, 300)}`,
    };
  return { path: real, version: version.stdout.trim() };
}

/** git with the fixed identity, synchronously; throws on failure. */
export function git(cwd, args, env) {
  const result = spawnSync("git", [...GIT_IDENTITY, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout.trim();
}

/** One setup's own clone of the sample origin, never shared. */
export async function sampleRepo(context, home, branch) {
  const repo = join(home.root, "sample");
  git(home.root, ["clone", "--quiet", context.originPath, repo], home.env);
  if (branch) git(repo, ["checkout", "--quiet", branch], home.env);
  // Harness scratch never shows up as a change.
  await writeFile(join(repo, ".git", "info", "exclude"), ".ab/\n");
  return repo;
}

/**
 * Wraps runStep for a driver: records a step entry and returns the raw
 * result. `doc` names the doc line the step follows, when there is one.
 */
export function stepper(home, steps) {
  return async function step(id, argv, options = {}) {
    const result = await runStep(`${options.label ?? ""}${id}`, argv, {
      env: options.env ?? home.env,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 600_000,
      stdin: options.stdin,
      logFile: options.logFile,
      quiet: options.quiet,
    });
    const ok = options.expect ? options.expect(result) : result.code === 0;
    steps.push({
      id,
      command: options.display ?? argv.join(" "),
      ...(options.doc ? { doc: options.doc } : {}),
      ms: Math.round(result.ms),
      ok,
      ...(ok ? {} : { note: options.note?.(result) ?? stepNote(result) }),
    });
    return { ...result, ok };
  };
}

/** The documented browser line, run in this setup's home. */
export async function installBrowser(context, home, step) {
  return step("browser", context.playwrightLine.split(" "), {
    cwd: home.root,
    doc: "site/docs/getting-started.md#1-install",
  });
}

/**
 * The independent verdict: the documented gate command with --json, run with
 * the documented global install in the given working tree.
 */
export async function postCheck(context, repo, step, id) {
  const result = await step(id, [...context.gateCommand.split(" "), "--json"], {
    cwd: repo,
    expect: (raw) => raw.code === 0 || raw.code === 1,
    quiet: true,
    timeoutMs: 900_000,
  });
  let parsed = null;
  try {
    parsed = plantedInCheckJson(JSON.parse(result.stdout), context.regression);
  } catch {}
  return {
    exitCode: result.code,
    planted: parsed?.planted ?? null,
    skipped: parsed?.skipped ?? null,
    findings: parsed?.findings ?? [],
  };
}

/** Applies the regression file's line swap and commits it. */
export async function commitLine(repo, home, regression, from, to, message) {
  const path = join(repo, regression.file);
  await writeFile(path, applyLine(await readFile(path, "utf8"), from, to));
  git(repo, ["commit", "--quiet", "-am", message], home.env);
  return git(repo, ["rev-parse", "HEAD"], home.env);
}
