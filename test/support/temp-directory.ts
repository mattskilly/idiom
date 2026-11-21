import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Error codes a recursive removal can hit when it loses a race with a writer. */
export const RETRYABLE_REMOVE_CODES = new Set([
  "ENOTEMPTY",
  "EBUSY",
  "EPERM",
  "EMFILE",
  "ENFILE",
]);

export type RemoveTempOptions = {
  /** Total removal attempts before giving up. Default 10. */
  attempts?: number;
  /** Base wait between attempts; the wait after attempt n is `delayMs * n`. Default 25. */
  delayMs?: number;
  remove?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

const defaultRemove = (path: string) =>
  rm(path, { recursive: true, force: true });
const defaultSleep = async (ms: number) => {
  await delay(ms);
};

/**
 * Remove a test's temp directory, tolerating late writes from work the test
 * abandoned. A capture a test timed out or interrupted can still write a report
 * into the directory while the recursive rm runs; its final rmdir then sees the
 * new entry and fails with ENOTEMPTY. Race-prone errors are retried a bounded
 * number of times with linear backoff. Any other error, or a removal that still
 * fails after the last attempt, throws an error naming the path and the cause.
 */
export async function removeTempDirectory(
  path: string,
  options: RemoveTempOptions = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 10);
  const delayMs = options.delayMs ?? 25;
  const remove = options.remove ?? defaultRemove;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== undefined &&
        RETRYABLE_REMOVE_CODES.has(code) &&
        attempt < attempts
      ) {
        await sleep(delayMs * attempt);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `could not remove temp directory ${path} after ${attempt} attempt(s): ${code ?? "unknown"} ${message}`,
        { cause: error },
      );
    }
  }
}
