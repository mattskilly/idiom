import { redact } from "./server-diagnosis.js";

/** One line an owned server printed, stamped when Idiom received it. */
export type ServerLogLine = {
  /** Epoch ms. */
  at: number;
  stream: "stdout" | "stderr";
  text: string;
};

export const SERVER_LOG_LIMIT_BYTES = 2 * 1024 * 1024;

const renderLine = (line: ServerLogLine) =>
  `${new Date(line.at).toISOString()} ${line.stream} ${line.text}`;

/** The rendered form of server log lines, one per line as in `server.log`. */
export function renderServerLogLines(lines: readonly ServerLogLine[]): string {
  return lines.map(renderLine).join("\n");
}

function truncateToBytes(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  // Drop a split trailing character rather than emit a replacement mark.
  return bytes.subarray(0, limit).toString("utf8").replace(/�$/, "");
}

/**
 * The stdout and stderr of a server Idiom started, kept in memory for
 * `server.log`. Lines are redacted on receipt and capped by rendered UTF-8
 * size, dropping the oldest first.
 */
export class ServerLog {
  private readonly entries: { line: ServerLogLine; bytes: number }[] = [];
  private readonly partial = { stdout: "", stderr: "" };
  private bytes = 0;

  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly limit = SERVER_LOG_LIMIT_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  append(stream: ServerLogLine["stream"], chunk: string): void {
    const parts = (this.partial[stream] + chunk).split(/\r?\n/);
    this.partial[stream] = parts.pop() ?? "";
    for (const text of parts) this.push(stream, text);
  }

  /** Keep a last line that had no trailing newline. */
  flush(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      if (this.partial[stream].length > 0)
        this.push(stream, this.partial[stream]);
      this.partial[stream] = "";
    }
  }

  lines(): ServerLogLine[] {
    return this.entries.map((entry) => entry.line);
  }

  render(): string {
    const rendered = renderServerLogLines(this.lines());
    return rendered.length === 0 ? "" : `${rendered}\n`;
  }

  private push(stream: ServerLogLine["stream"], raw: string): void {
    const line: ServerLogLine = {
      at: this.now(),
      stream,
      text: redact(raw, this.environment),
    };
    // Each rendered line costs its bytes plus a newline.
    let bytes = Buffer.byteLength(renderLine(line), "utf8") + 1;
    if (bytes > this.limit) {
      const prefix = renderLine({ ...line, text: "" });
      line.text = truncateToBytes(
        line.text,
        Math.max(0, this.limit - 1 - Buffer.byteLength(prefix, "utf8")),
      );
      bytes = Buffer.byteLength(renderLine(line), "utf8") + 1;
    }
    this.entries.push({ line, bytes });
    this.bytes += bytes;
    while (this.bytes > this.limit && this.entries.length > 0) {
      const dropped = this.entries.shift();
      if (dropped !== undefined) this.bytes -= dropped.bytes;
    }
  }
}
