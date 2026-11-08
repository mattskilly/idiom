import { ChildProcess } from "node:child_process";
import { expect, inject } from "vitest";
import { isGuardedTarget, recordViolation } from "./signal-guard.js";

// Runs in every worker, both pools. A threads worker shares the main pid, so
// `process.kill(process.pid, "SIGTERM")` there is the same mistake as aiming
// at the main pid from a fork. The call is refused, not sent.
export const signalGuardInstalled = Symbol.for("idiom.signalGuard");

const context = inject("signalGuard");
const host = process as typeof process & { [signalGuardInstalled]?: true };

function currentFile(): string {
  const worker = (globalThis as { __vitest_worker__?: { filepath?: string } })
    .__vitest_worker__;
  return expect.getState().testPath ?? worker?.filepath ?? "an unknown file";
}

function refuse(target: number, signal: unknown): never {
  const message = `signal guard: ${currentFile()} tried to send ${String(signal ?? "SIGTERM")} to the Vitest main process or its process group (target ${target})`;
  recordViolation(context.violations, message);
  throw new Error(message);
}

if (context && !host[signalGuardInstalled]) {
  host[signalGuardInstalled] = true;
  const kill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number) => {
    if (isGuardedTarget({ target: pid, signal, ...context }))
      refuse(pid, signal);
    return kill(pid, signal);
  }) as typeof process.kill;
  const childKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function (
    this: ChildProcess,
    signal?: NodeJS.Signals | number,
  ) {
    if (
      this.pid !== undefined &&
      isGuardedTarget({ target: this.pid, signal, ...context })
    )
      refuse(this.pid, signal);
    return childKill.call(this, signal);
  };
}
