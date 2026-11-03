import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { formatCritiqueTimeout } from "../duration.js";
import { redactCredentials } from "./redact.js";

const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export type CritiqueProcessRequest = {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdin: string;
  signal?: AbortSignal | undefined;
  /** Names the tool in the overflow failure; defaults to "Claude Code". */
  label?: string | undefined;
  /** Stderr budget; defaults to the stdout budget of 1 MiB. */
  maxStderrBytes?: number | undefined;
  /**
   * Wall-clock bound; on expiry the child is SIGKILLed and the call rejects
   * with `CritiqueProcessTimeoutError`. Unbounded when omitted.
   */
  timeoutMs?: number | undefined;
  /** Sees each stdout chunk as it arrives, e.g. to count streamed events. */
  onStdout?: ((chunk: string) => void) | undefined;
};

export type CritiqueProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type CritiqueProcessRunner = (
  request: CritiqueProcessRequest,
) => Promise<CritiqueProcessResult>;

export { formatCritiqueTimeout } from "../duration.js";

export class CritiqueProcessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} did not finish within ${formatCritiqueTimeout(timeoutMs)}`);
    this.name = "CritiqueProcessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function sanitizeCritiqueDiagnostic(
  value: unknown,
  limit = 500,
): string {
  const source = value instanceof Error ? value.message : String(value);
  return redactCredentials(source)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, limit));
}

/** Runs a local agent CLI with bounded output, without a shell. */
export const runCritiqueProcess: CritiqueProcessRunner = (request) =>
  new Promise((accept, reject) => {
    const label = request.label ?? "Claude Code";
    const limits = {
      stdout: DEFAULT_MAX_PROCESS_OUTPUT_BYTES,
      stderr: request.maxStderrBytes ?? DEFAULT_MAX_PROCESS_OUTPUT_BYTES,
    };
    if (request.signal?.aborted) {
      reject(new Error(`${label} invocation aborted`));
      return;
    }
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const bytes = { stdout: 0, stderr: 0 };
    // Keeps a multi-byte character split across chunks whole for onStdout.
    const decoder = new StringDecoder("utf8");
    let outputFailure: Error | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const timeoutMs = request.timeoutMs;
    if (
      timeoutMs !== undefined &&
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0
    ) {
      timer = setTimeout(() => {
        if (settled) return;
        outputFailure ??= new CritiqueProcessTimeoutError(label, timeoutMs);
        child.kill("SIGKILL");
        // A grandchild holding the stdio pipes would delay `close` past the
        // child's exit, so release the pipes once the child itself is gone.
        const release = () => {
          child.stdout.destroy();
          child.stderr.destroy();
        };
        if (child.exitCode !== null || child.signalCode !== null) release();
        else child.once("exit", release);
      }, timeoutMs);
    }

    const abort = () => {
      outputFailure ??= new Error(`${label} invocation aborted`);
      child.kill("SIGKILL");
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    const fail = (error: unknown) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      reject(error);
    };
    const collect =
      (target: Buffer[], stream: "stdout" | "stderr") =>
      (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes[stream] += buffer.byteLength;
        if (bytes[stream] > limits[stream]) {
          outputFailure ??= new Error(
            `${label} ${stream} exceeded ${limits[stream]} bytes`,
          );
          child.kill("SIGKILL");
          return;
        }
        target.push(buffer);
        if (stream === "stdout") request.onStdout?.(decoder.write(buffer));
      };

    child.once("error", fail);
    child.stdout.on("data", collect(stdout, "stdout"));
    child.stderr.on("data", collect(stderr, "stderr"));
    child.stdin.once("error", fail);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (outputFailure !== undefined) {
        reject(outputFailure);
        return;
      }
      accept({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
      });
    });
    child.stdin.end(request.stdin);
  });
