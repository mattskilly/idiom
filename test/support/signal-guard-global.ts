import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { processGroup, readViolations } from "./signal-guard.js";

// Runs once in the Vitest main process. Hands every worker the main pid and
// process group (test/support/signal-guard-setup.ts refuses SIGTERM/SIGINT
// aimed at either), logs any SIGTERM/SIGINT that reaches this process, and
// fails the run if a test tried to send one, even when the test swallowed the
// thrown error. Vitest's own exit handlers are left in place.
//
// What it cannot catch: a signal sent from outside the worker, such as a
// spawned grandchild or another process on the host (`pkill -f vitest` from a
// sibling worktree). The arrival log on stderr is the evidence for those.
export default function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "idiom-signal-guard-"));
  const violations = join(dir, "violations.log");
  project.provide("signalGuard", {
    mainPid: process.pid,
    mainPgid: processGroup(process.pid),
    violations,
  });
  const started = Date.now();
  const arrived = (signal: NodeJS.Signals) => {
    process.stderr.write(
      `signal guard: the Vitest main process (pid ${process.pid}, parent ${process.ppid}) received ${signal} ${Math.round((Date.now() - started) / 1000)}s into the run from outside the test workers (a test's own process.kill is refused, not sent)\n`,
    );
  };
  // Vitest's own handler exits the process, so this one goes first.
  process.prependListener("SIGTERM", arrived);
  process.prependListener("SIGINT", arrived);
  return () => {
    process.off("SIGTERM", arrived);
    process.off("SIGINT", arrived);
    const lines = readViolations(violations);
    rmSync(dir, { recursive: true, force: true });
    if (lines.length > 0) {
      throw new Error(
        `signal guard: tests tried to signal the Vitest run:\n${lines.join("\n")}`,
      );
    }
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    signalGuard: {
      mainPid: number;
      mainPgid: number | undefined;
      violations: string;
    };
  }
}
