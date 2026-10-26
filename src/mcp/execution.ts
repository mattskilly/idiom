import type {
  CallToolResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { CaptureDependencies } from "../capture/run.js";

export function toolError(error: unknown): CallToolResult {
  const diagnostic = error instanceof Error ? error.message : String(error);
  const recovery =
    /executable doesn't exist|playwright install|browser.*not.*found/i.test(
      diagnostic,
    )
      ? "Install Chromium with npx playwright install chromium, then retry."
      : /EADDRINUSE|port.*(?:use|busy|pinned)|address already in use/i.test(
            diagnostic,
          )
        ? "Free the configured port or correct .idiom/project.json server settings, then retry."
        : /no \.idiom\/project.json/i.test(diagnostic)
          ? "Run idiom init in the project, or restart idiom mcp --project /absolute/project/path."
          : "Correct the reported input, configuration or evidence problem, then retry this tool. Run idiom validate for configured flows.";
  return {
    isError: true,
    content: [{ type: "text", text: `${diagnostic}\n${recovery}` }],
  };
}

export type Execution = {
  signal: AbortSignal;
  progress(message: string): void;
  capture(base?: CaptureDependencies): CaptureDependencies;
};

/** Serializes writes; discovery and cancellation never wait for the write queue. */
export class ToolExecutionQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private lifetime = new AbortController();

  close() {
    this.lifetime.abort(new Error("MCP session closed"));
    return this.tail.then(() => undefined);
  }

  async run(
    ctx: ServerContext,
    work: (execution: Execution) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const signal = AbortSignal.any([ctx.mcpReq.signal, this.lifetime.signal]);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("Tool cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    let active = false;
    let settled = false;
    let counter = 0;
    let notifications = Promise.resolve();
    const progress = (message: string) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      if (settled || signal.aborted || progressToken === undefined) return;
      const value = ++counter;
      notifications = notifications
        .then(async () => {
          if (settled || signal.aborted) return;
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken, progress: value, message },
          });
        })
        .catch(() => undefined);
    };
    try {
      await Promise.race([previous, cancelled]);
      signal.throwIfAborted();
      active = true;
      progress("Starting tool");
      const result = await work({
        signal,
        progress,
        capture: (base = {}) => ({
          ...base,
          signal: base.signal ? AbortSignal.any([base.signal, signal]) : signal,
          onActivity: (event) => {
            base.onActivity?.(event);
            progress(
              `${event.state}/${event.viewport}/${event.colorScheme}: ${event.step}`,
            );
          },
          onProbeProgress: (event) => {
            base.onProbeProgress?.(event);
            progress(
              `Probe ${event.selector}: ${event.phase} (${event.completed} completed)`,
            );
          },
        }),
      });
      signal.throwIfAborted();
      progress("Tool complete");
      await notifications;
      return result;
    } catch (error) {
      return toolError(error);
    } finally {
      settled = true;
      signal.removeEventListener("abort", abort);
      // A cancelled queued call cannot release the successor ahead of active work.
      if (active) release();
      else void previous.finally(release);
    }
  }
}
