import { errors, type Page } from "playwright";
import type {
  AttemptTimeouts,
  BrowserTuple,
  TimeoutDiagnostic,
} from "./types.js";

export class TupleTimeoutError extends Error {
  constructor(
    readonly timeout: TimeoutDiagnostic,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
export function attemptTimeouts(
  tuple: Pick<BrowserTuple, "timeoutFactor" | "timeouts">,
): AttemptTimeouts {
  const factor = tuple.timeoutFactor ?? 1;
  return {
    navigation: (tuple.timeouts?.navigation ?? 30000) * factor,
    readiness: (tuple.timeouts?.readiness ?? 10000) * factor,
    quiet: (tuple.timeouts?.quiet ?? 5000) * factor,
  };
}
export async function withTimeoutDiagnostic<T>(
  kind: TimeoutDiagnostic["kind"],
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof errors.TimeoutError)
      throw new TupleTimeoutError({ kind, timeoutMs }, error);
    throw error;
  }
}
export function navigate(
  page: Page,
  url: string,
  timeoutMs: number,
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit",
) {
  return withTimeoutDiagnostic("navigation", timeoutMs, async () => {
    try {
      return await page.goto(url, {
        timeout: timeoutMs,
        ...(waitUntil ? { waitUntil } : {}),
      });
    } catch (error) {
      if (error instanceof errors.TimeoutError) {
        // A stalled document request can leave evaluate() waiting for its
        // execution context even after goto expires. Stop that request before
        // collecting partial evidence or closing the failed attempt.
        const session = await page
          .context()
          .newCDPSession(page)
          .catch(() => undefined);
        try {
          await session?.send("Page.stopLoading").catch(() => undefined);
        } finally {
          await session?.detach().catch(() => undefined);
        }
      }
      throw error;
    }
  });
}
