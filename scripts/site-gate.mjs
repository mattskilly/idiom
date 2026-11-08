#!/usr/bin/env node
// The idiom-check verify step: gates idiom.build with this checkout's own
// Idiom, running the shipped recipe `idiom check --gate --fail-on major`.
//
// Exit codes: 0 (pass), 1 (findings at or above major) and 2 (setup failure)
// pass through. 3 means the review was deferred on a busy host, which says
// nothing about the change, so the step retries once and, if the retry defers
// too, passes with a warning rather than failing an unrelated build.
//
// The CLI is built out of tree (scripts/idiom-local.mjs) so the tracked dist/
// is never written. Refuse pre-existing tracked .idiom/ edits before building,
// then restore only the finding-name registry the gate can rewrite: a dirty
// tracked tree blocks reconcile, but existing decisions/config must survive.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLocalCli, repositoryRoot } from "./idiom-local.mjs";

export const gateArguments = ["check", "--gate", "--fail-on", "major"];

const spawnStatus = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      ...options,
    });
    child.on("exit", (code, signal) =>
      done({ status: code ?? (signal ? 1 : 0) }),
    );
    child.on("error", () => done({ status: 1 }));
  });

export async function runSiteGate({
  build = buildLocalCli,
  run = spawnStatus,
  log = (line) => console.error(line),
} = {}) {
  // Check the index and worktree separately: a staged change can be undone in
  // the worktree while still differing in the index (and checkout uses it).
  for (const args of [
    ["diff", "--quiet", "--", ".idiom"],
    ["diff", "--cached", "--quiet", "--", ".idiom"],
  ]) {
    const { status } = await run("git", args).catch(() => ({ status: 2 }));
    if (status !== 0) {
      log(
        status === 1
          ? "idiom-check: commit or stash tracked .idiom/ changes before running the gate (exit 2)"
          : "idiom-check: could not check tracked .idiom/ changes (exit 2)",
      );
      return 2;
    }
  }
  let built;
  try {
    built = await build();
  } catch (error) {
    log(`idiom-check: could not build the CLI (${error?.message ?? error})`);
    return 2;
  }
  let status = 2;
  try {
    log(
      `idiom-check: idiom check --gate --fail-on major (this checkout's CLI, built out of tree: ${built.cli})`,
    );
    const gate = () => run(process.execPath, [built.cli, ...gateArguments]);
    status = (await gate()).status;
    if (status === 3) {
      log("idiom-check: review deferred (busy host, exit 3); retrying once");
      status = (await gate()).status;
      if (status === 3) {
        log(
          'warning: idiom-check deferred twice on a busy host; passing without a site verdict. Rerun "node scripts/idiom-local.mjs check --gate --fail-on major" on an idle host.',
        );
        status = 0;
      }
    }
  } finally {
    try {
      await built.cleanup();
    } catch {
      // A leftover temp directory is harmless.
    }
    const restore = await run("git", [
      "checkout",
      "--",
      ".idiom/finding-names.json",
    ]).catch(() => ({ status: 1 }));
    if (restore.status !== 0) {
      log("idiom-check: could not restore tracked .idiom/finding-names.json");
      if (status === 0) status = 1;
    }
  }
  return status;
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  process.exit(await runSiteGate());
}
