// One timed child process per step, shared by the first-run and build-setup
// checks. Each step is spawned as its own process group; on a timeout only
// that group, by the PID this module spawned, is killed. Never kill by name or
// pattern: parallel builds share this host.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { performance } from "node:perf_hooks";

/**
 * Spawns one step in its own process group and times it. `onStdoutLine`
 * returning true stops the clock early (the process keeps running). `stdin`
 * is written then closed; without it stdin is closed at once. `logFile` tees
 * stdout and stderr to a file (agent transcripts). `quiet` keeps the lines off
 * this process's console.
 */
export function runStep(
  id,
  argv,
  { env, cwd, timeoutMs, onStdoutLine, stdin, logFile, quiet = false },
) {
  return new Promise((resolveStep) => {
    const started = performance.now();
    let ms;
    let stdout = "";
    let stderr = "";
    const stderrTail = [];
    let settled = false;
    let timedOut = false;
    const log = logFile ? createWriteStream(logFile) : undefined;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
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
        log?.write(chunk);
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
      if (!quiet) console.log(`[${id}] ${line}`);
      if (onStdoutLine?.(line)) stopClock();
    });
    lines(child.stderr, (line) => {
      stderr += `${line}\n`;
      if (!quiet) console.error(`[${id}] ${line}`);
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
    });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopClock();
      const done = () =>
        resolveStep({
          ms,
          code,
          stdout,
          stderr,
          stderrTail,
          timedOut,
          timeoutMs,
          error: error?.message,
        });
      if (log) log.end(done);
      else done();
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

/** A short failure note: timeout, spawn error, or exit code and stderr tail. */
export function stepNote(result) {
  if (result.timedOut) return `timed out after ${result.timeoutMs / 1000}s`;
  if (result.error) return result.error;
  const tail = result.stderrTail.filter(Boolean).slice(-3).join(" | ");
  return `exit ${result.code}${tail ? `: ${tail}` : ""}`;
}
