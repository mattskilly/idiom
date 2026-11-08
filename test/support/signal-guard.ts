import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

/**
 * A SIGTERM or SIGINT aimed at the Vitest main process, its process group,
 * the caller's own group (0) or every permitted process (-1) ends the whole
 * run with no failing test: Bun reports `script "test" was terminated by
 * signal SIGTERM`. Tests signal only processes they started. SIGKILL to a
 * test's own detached group stays allowed: that group is never the main one.
 */
export type SignalGuardContext = {
  mainPid: number;
  mainPgid: number | undefined;
  violations: string;
};

export const guardedSignals = new Set(["SIGTERM", "SIGINT"]);
const signalNumbers: Record<number, string> = { 2: "SIGINT", 15: "SIGTERM" };

export function signalName(signal: unknown): string | undefined {
  if (signal === undefined) return "SIGTERM";
  if (typeof signal === "number") return signalNumbers[signal];
  return typeof signal === "string" ? signal.toUpperCase() : undefined;
}

export function isGuardedTarget(input: {
  target: number;
  signal: unknown;
  mainPid: number;
  mainPgid: number | undefined;
}): boolean {
  const name = signalName(input.signal);
  if (!name || !guardedSignals.has(name)) return false;
  const { target, mainPid, mainPgid } = input;
  return (
    target === mainPid ||
    target === 0 ||
    target === -1 ||
    (mainPgid !== undefined && target === -mainPgid)
  );
}

export function processGroup(pid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const value = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    );
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function recordViolation(path: string, line: string): void {
  appendFileSync(path, `${line}\n`);
}

export function readViolations(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

/** Drops one file's recorded violations; only the guard's own test uses it. */
export function clearViolations(path: string, file: string): void {
  const kept = readViolations(path).filter((line) => !line.includes(file));
  writeFileSync(path, kept.map((line) => `${line}\n`).join(""));
}
