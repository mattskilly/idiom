#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readlink, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const psFields = "pid=,uid=,ppid=,stat=,lstart=,args=";
export const usage = `Usage: node scripts/stop-my-tests.mjs [--dry-run]
Stop confirmed Vitest processes with cwd exactly equal to this Git worktree root.
Invocation from a subdirectory or symlink resolves to the canonical worktree root.
--dry-run lists selected PIDs without signalling. Only individual SIGTERM is sent;
there is no forced cleanup or SIGKILL escalation. Uncertain processes are skipped.`;

export function parseProcesses(output) {
  return output.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/,
    );
    if (!match) return [];
    return [
      {
        pid: Number(match[1]),
        uid: Number(match[2]),
        ppid: Number(match[3]),
        state: match[4],
        start: match[5],
        command: match[6],
      },
    ];
  });
}

export function isVitest(command) {
  if (/^node \(vitest(?: \d+)?\)$/.test(command)) return true;
  // Only a direct Node executable and a Vitest entrypoint, never arbitrary
  // arguments containing "vitest". Ambiguous command lines are left alone.
  const match = command.match(
    /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))(?=\s|$)/,
  );
  if (!match) return false;
  const executable = match[1] ?? match[2] ?? match[3];
  const script = match[4] ?? match[5] ?? match[6];
  return (
    (executable === "node" ||
      (isAbsolute(executable) && executable.endsWith("/node"))) &&
    /(?:^|\/)node_modules\/(?:vitest\/vitest\.mjs|\.bin\/vitest)$/.test(script)
  );
}

export function parseLsofCwd(output, pid) {
  // -F0 preserves whitespace (and newlines) in filenames. Newlines between
  // records are framing, not separators within an n field.
  const fields = output.split("\0").map((field) => field.replace(/^\n/, ""));
  const processes = fields.filter((field) => field.startsWith("p"));
  const names = fields.filter((field) => field.startsWith("n"));
  if (
    processes.length !== 1 ||
    processes[0] !== `p${pid}` ||
    names.length !== 1
  )
    return undefined;
  const cwd = names[0].slice(1);
  return isAbsolute(cwd) ? cwd : undefined;
}

function sameIdentity(a, b) {
  return (
    b &&
    a.pid === b.pid &&
    a.uid === b.uid &&
    a.start === b.start &&
    a.command === b.command &&
    !b.state.startsWith("Z")
  );
}

export function systemDependencies() {
  const run = (command, args) =>
    execute(command, args, {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  const ps = async (args) => {
    try {
      return parseProcesses((await run("ps", args)).stdout);
    } catch (error) {
      if (error.code === 1 && !error.stdout?.trim()) return [];
      throw new Error(
        "Cannot inspect processes with ps; ensure ps is installed and accessible.",
      );
    }
  };
  return {
    pid: process.pid,
    uid: process.getuid?.(),
    platform: process.platform,
    root: async () => {
      try {
        return await realpath(
          (await run("git", ["rev-parse", "--show-toplevel"])).stdout.replace(
            /\r?\n$/,
            "",
          ),
        );
      } catch {
        throw new Error(
          "Cannot resolve this Git worktree root; run inside an accessible Git worktree.",
        );
      }
    },
    prepare: async () => {
      if (process.platform === "darwin") {
        try {
          await run("lsof", ["-v"]);
        } catch {
          throw new Error(
            "Cannot inspect cwd: install lsof and make it accessible on PATH.",
          );
        }
      } else if (process.platform === "linux") {
        try {
          await readlink("/proc/self/cwd");
        } catch {
          throw new Error(
            "Cannot inspect cwd: mount an accessible /proc filesystem.",
          );
        }
      } else
        throw new Error(
          "Cwd inspection supports only macOS and Linux; no processes stopped.",
        );
    },
    snapshot: () => ps(["-ax", "-ww", "-o", psFields]),
    inspect: async (pid) =>
      (await ps(["-ww", "-p", String(pid), "-o", psFields]))[0],
    cwd: async (pid) => {
      let cwd;
      try {
        cwd =
          process.platform === "linux"
            ? await readlink(`/proc/${pid}/cwd`)
            : parseLsofCwd(
                (
                  await run("lsof", [
                    "-a",
                    "-p",
                    String(pid),
                    "-d",
                    "cwd",
                    "-Fn0",
                  ])
                ).stdout,
                pid,
              );
      } catch (error) {
        if (process.platform === "darwin" && error.code !== 1)
          throw new Error(
            "Cannot inspect cwd: install lsof and make it accessible on PATH.",
          );
        return undefined; // A disappearing or unreadable individual is never selected.
      }
      if (!cwd) return undefined;
      try {
        return await realpath(cwd);
      } catch {
        return undefined;
      }
    },
    signal: (pid) => process.kill(pid, "SIGTERM"),
    sleep: delay,
    now: Date.now,
    report: (message) => console.log(message),
  };
}

/** Injection is at the OS boundary: selection and revalidation always run. */
export async function stopMyTests(
  args = [],
  dependencies = systemDependencies(),
) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    dependencies.report(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    dependencies.report(usage);
    return 1;
  }
  const d = dependencies;
  const root = await d.root();
  await d.prepare();
  if (!Number.isInteger(d.uid))
    throw new Error("Cannot determine the current user; no processes stopped.");
  const processes = await d.snapshot();
  const ancestors = new Set();
  let parent = d.pid;
  while (parent > 1 && !ancestors.has(parent)) {
    const identity = processes.find((p) => p.pid === parent);
    if (!identity)
      throw new Error(
        "Cannot confirm the helper's ancestor chain; no processes stopped.",
      );
    ancestors.add(parent);
    parent = identity.ppid;
  }
  const selected = [];
  // Complete inspection before the first signal, so a missing inspection tool
  // fails the entire operation without a partial cleanup.
  for (const p of processes) {
    if (
      !Number.isSafeInteger(p.pid) ||
      p.pid <= 1 ||
      p.uid !== d.uid ||
      ancestors.has(p.pid) ||
      p.state.startsWith("Z") ||
      !isVitest(p.command)
    )
      continue;
    if ((await d.cwd(p.pid)) !== root) {
      d.report(
        `Skipped PID ${p.pid}: cwd is outside this root or cannot be confirmed.`,
      );
      continue;
    }
    selected.push(p);
    d.report(
      `Selected PID ${p.pid}${args[0] === "--dry-run" ? " (dry run)" : ""}.`,
    );
  }
  if (args[0] === "--dry-run") return 0;
  const signalled = [];
  let failed = false;
  for (const p of selected) {
    const current = await d.inspect(p.pid);
    if (!sameIdentity(p, current) || (await d.cwd(p.pid)) !== root) {
      d.report(
        `Skipped PID ${p.pid}: identity or cwd changed, vanished, or is unreadable.`,
      );
      continue;
    }
    try {
      d.signal(p.pid);
      signalled.push(p);
    } catch (error) {
      if (error.code === "ESRCH")
        d.report(`Skipped PID ${p.pid}: exited before SIGTERM.`);
      else {
        failed = true;
        d.report(
          `Failed PID ${p.pid}: SIGTERM denied (${error.code ?? "unknown error"}).`,
        );
      }
    }
  }
  const deadline = d.now() + 3_000;
  let remaining = signalled;
  while (remaining.length) {
    const alive = [];
    for (const p of remaining) {
      if (sameIdentity(p, await d.inspect(p.pid))) alive.push(p);
      else d.report(`Stopped PID ${p.pid}.`);
    }
    remaining = alive;
    if (!remaining.length || d.now() >= deadline) break;
    await d.sleep(50);
  }
  for (const p of remaining)
    d.report(
      `Surviving PID ${p.pid}: did not exit after SIGTERM; no forced cleanup.`,
    );
  if (!selected.length)
    d.report("No confirmed Vitest processes in this worktree root.");
  return failed || remaining.length ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(await realpath(process.argv[1]).catch(() => "")).href
) {
  try {
    process.exitCode = await stopMyTests(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
