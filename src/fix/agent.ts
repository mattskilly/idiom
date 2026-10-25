import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export type AgentName = "claude" | "codex";
export type AgentRequest = {
  agent: AgentName;
  prompt: string;
  cwd: string;
  signal?: AbortSignal | undefined;
};
export type AgentResult = { ok: boolean; diagnostic?: string | undefined };
export type ProcessRequest = {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal | undefined;
};
export type ProcessResult = {
  code: number | null;
  signal?: string | null | undefined;
  stdout: string;
  stderr: string;
  error?: string | undefined;
};
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export type AgentDependencies = {
  runner?: ProcessRunner;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export function agentArguments(agent: AgentName): string[] {
  return agent === "codex"
    ? [
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        'approval_policy="never"',
        "--color",
        "never",
        "-",
      ]
    : [
        "--print",
        "--output-format",
        "json",
        "--safe-mode",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "Read,Edit,Write,Glob,Grep",
        "--allowedTools",
        "Read,Edit,Write,Glob,Grep",
        "--disallowedTools",
        "mcp__*",
        "--strict-mcp-config",
      ];
}

/** Local transport only: provider output never establishes a finding verdict. */
export const spawnAgentProcess: ProcessRunner = (request) =>
  new Promise((accept) => {
    if (request.signal?.aborted) {
      accept({ code: null, stdout: "", stderr: "", error: "agent aborted" });
      return;
    }
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Record<"stdout" | "stderr", Buffer[]> = {
      stdout: [],
      stderr: [],
    };
    const bytes = { stdout: 0, stderr: 0 };
    let failure: string | undefined;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, signal?: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      accept({
        code,
        signal,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        ...(failure === undefined ? {} : { error: failure }),
      });
    };
    const stop = (reason: string) => {
      failure ??= reason;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        finish(null, "SIGKILL");
      }, 500);
    };
    const abort = () => stop("agent aborted");
    const timer = setTimeout(() => stop("agent timed out"), request.timeoutMs);
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    for (const stream of ["stdout", "stderr"] as const)
      child[stream].on("data", (chunk: Buffer) => {
        const remaining = request.maxOutputBytes - bytes[stream];
        if (remaining > 0) chunks[stream].push(chunk.subarray(0, remaining));
        bytes[stream] += chunk.length;
        if (bytes[stream] > request.maxOutputBytes)
          stop(`agent ${stream} exceeded output limit`);
      });
    child.on("error", (error) => {
      failure ??= error.message;
      finish(null);
    });
    child.on("close", finish);
    child.stdin.on("error", (error) => stop(`agent stdin: ${error.message}`));
    child.stdin.end(request.stdin);
  });

export function safeDiagnostic(value: unknown): string {
  return [
    ...stripVTControlCharacters(
      String(value instanceof Error ? value.message : value),
    ),
  ]
    .map((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) || code === 127
        ? " "
        : char;
    })
    .join("")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|(?:Bearer\s+)[A-Za-z0-9._-]+)/gi,
      "[redacted]",
    )
    .slice(0, 2000);
}

export async function runAgent(
  request: AgentRequest,
  dependencies: AgentDependencies = {},
): Promise<AgentResult> {
  let result: ProcessResult;
  try {
    result = await (dependencies.runner ?? spawnAgentProcess)({
      executable: request.agent,
      args: agentArguments(request.agent),
      stdin: request.prompt,
      cwd: request.cwd,
      environment: dependencies.environment ?? process.env,
      timeoutMs: dependencies.timeoutMs ?? 15 * 60 * 1000,
      maxOutputBytes: dependencies.maxOutputBytes ?? 1024 * 1024,
      signal: request.signal,
    });
  } catch (error) {
    result = {
      code: null,
      stdout: "",
      stderr: "",
      error: safeDiagnostic(error),
    };
  }
  let error = result.error;
  if (!error && (result.code !== 0 || result.signal))
    error = `agent exited ${result.code ?? result.signal ?? "without status"}`;
  if (!error && request.agent === "claude") {
    try {
      const envelope = JSON.parse(result.stdout) as Record<
        string,
        unknown
      > | null;
      if (
        envelope?.type !== "result" ||
        envelope.subtype !== "success" ||
        envelope.is_error !== false
      )
        error = "Claude did not return a successful result envelope";
    } catch {
      error = "Claude returned malformed JSON";
    }
  }
  return error
    ? {
        ok: false,
        diagnostic: safeDiagnostic(
          `${error}. ${result.stderr}. Install/update ${request.agent} on PATH and authenticate with ${request.agent === "claude" ? "claude auth login" : "codex login"}. Partial edits were preserved.`,
        ),
      }
    : { ok: true };
}
