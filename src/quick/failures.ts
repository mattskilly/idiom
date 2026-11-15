import {
  SCREENSHOT_ALLOWANCE_MS,
  SCREENSHOT_MIN_SHOT_MS,
  SCREENSHOT_MIN_TILE_MS,
} from "../capture/screenshot.js";
import type { CheckTuple } from "../checks/types.js";
import { IdiomError } from "../errors.js";

/** One quick-review tuple that did not capture, and why. */
export type QuickCaptureFailure = {
  state: string;
  viewport: string;
  colorScheme: string;
  stage: string;
  message: string;
  /** The tuple ran out of a time allowance (screenshot, navigation, readiness). */
  outOfTime: boolean;
};

const OUT_OF_TIME_STAGES = new Set(["screenshot", "navigation", "readiness"]);
const TIMEOUT_MESSAGE = /\bTimeout \d+ms exceeded\b|\btimed?[- ]out\b/i;

export function isOutOfTime(stage: string, message: string): boolean {
  return (
    /^screenshot out of time\b/.test(message) ||
    (OUT_OF_TIME_STAGES.has(stage) && TIMEOUT_MESSAGE.test(message))
  );
}

export function quickCaptureFailures(
  tuples: Array<
    Pick<CheckTuple, "state" | "viewport" | "colorScheme" | "failure">
  >,
): QuickCaptureFailure[] {
  return tuples.flatMap((tuple) =>
    tuple.failure
      ? [
          {
            state: tuple.state,
            viewport: tuple.viewport,
            colorScheme: tuple.colorScheme ?? "light",
            stage: tuple.failure.stage,
            message: tuple.failure.message,
            outOfTime: isOutOfTime(tuple.failure.stage, tuple.failure.message),
          },
        ]
      : [],
  );
}

/** The advice for a capture that ran out of time; never mentions ports or servers. */
export const OUT_OF_TIME_ADVICE = `The page was too slow to capture in its time allowance (screenshots get ${SCREENSHOT_ALLOWANCE_MS} ms per capture, shared by the tiles of a tall page; a screenshot starts only with at least ${SCREENSHOT_MIN_SHOT_MS} ms of it, and each later tile is still tried with at least ${SCREENSHOT_MIN_TILE_MS} ms left). Retry when the network and host are less busy, or review fewer viewports (one viewport, one URL at a time). Quick review has no setting to raise the allowance; a configured project can raise screenshotTimeoutMs per state.`;

/** One recovery sentence for a set of quick capture failures. */
export function quickCaptureAdvice(failures: QuickCaptureFailure[]): string {
  if (failures.some((failure) => failure.outOfTime)) return OUT_OF_TIME_ADVICE;
  return "Open the report to see the failed captures; retry, or review with fewer viewports.";
}

/** `"1 of 4 captures failed — page-1/mobile/dark: screenshot out of time: …"` */
export function describeQuickCaptureFailures(
  failures: QuickCaptureFailure[],
  total: number,
): string {
  return `${failures.length} of ${total} captures failed — ${failures
    .map(
      (failure) =>
        `${failure.state}/${failure.viewport}/${failure.colorScheme}: ${failure.stage === "screenshot" && failure.message.startsWith("screenshot") ? "" : `${failure.stage}: `}${failure.message}`,
    )
    .join("; ")}`;
}

/**
 * No quick capture succeeded. The message ends with its own recovery line,
 * so callers print it as-is instead of appending generic advice.
 */
export class QuickCaptureFailed extends IdiomError {
  readonly advice: string;
  constructor(
    readonly failures: QuickCaptureFailure[],
    total: number,
    reportPath: string,
  ) {
    const advice = quickCaptureAdvice(failures);
    super(
      `Quick capture failed: ${describeQuickCaptureFailures(failures, total)}. Report: ${reportPath}\n${advice}`,
    );
    this.name = "QuickCaptureFailed";
    this.advice = advice;
  }
}
