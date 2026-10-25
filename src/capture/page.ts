import type { Page } from "playwright";
import { PNG } from "pngjs";
import { type ObserveOptions, observePage } from "../checks/observe.js";
import type {
  FailedImageRequest,
  MotionArtifact,
  ObservationArtifact,
  ProbeArtifact,
  ProgressArtifact,
} from "../checks/types.js";
import { ExplanationCollector, mergeExplanations } from "./explanations.js";
import { sampleMediaFrames } from "./media-bands.js";
import { mergeMotion } from "./motion.js";
import { diagnoseTouchReachability, parkPointer } from "./touch.js";
import type {
  ConsoleRecord,
  ExpectationMismatch,
  FlowState,
  TupleFailureStage,
  TupleResult,
} from "./types.js";

import { type StepHealthGuard, WebStepFailure } from "./web-steps.js";

export type AxeFactory = (page: Page) => {
  analyze(): Promise<unknown>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectPageEvidence(options: {
  page: Page;
  signal?: AbortSignal | undefined;
  onActivity?: ((step: string) => void) | undefined;
  state: FlowState;
  settleMs: number;
  statusExpectation?: number | undefined;
  reachStage: "navigation" | "state";
  reach: () => Promise<number | null>;
  healthGuard?: StepHealthGuard | undefined;
  assertDestination?: (() => void) | undefined;
  createAxe: AxeFactory;
  collectConsole: () => Promise<ConsoleRecord[]>;
  tokens: Parameters<typeof observePage>[1];
  screenshotOptions: Parameters<Page["screenshot"]>[0];
  reuseScreenshot?: Buffer | undefined;
  now: () => Date;
  monotonicNow?: (() => number) | undefined;
  observe?: ObserveOptions | undefined;
  /** Runs last, after console collection, on a page it may freely mutate. */
  probe?: (() => Promise<ProbeArtifact>) | undefined;
  motion?: (() => MotionArtifact | undefined) | undefined;
  explanations?: ExplanationCollector | undefined;
  explanation?: "default" | "visible" | undefined;
  explanationWaitMs?: number | undefined;
  imageFailures?: (() => FailedImageRequest[]) | undefined;
  progress?: (() => ProgressArtifact | undefined) | undefined;
}): Promise<TupleResult> {
  const clock = options.monotonicNow ?? (() => performance.now());
  let probeMs: number | undefined;
  const startedAt = options.now().toISOString();
  const mismatches: ExpectationMismatch[] = [];
  let status: number | null | undefined;
  let dom: string | undefined;
  let screenshot: Buffer | undefined;
  let axe: unknown;
  let observations: ObservationArtifact | undefined;
  let stage: TupleFailureStage = options.reachStage;
  let failure: unknown;
  const activity = (step: string) => {
    options.signal?.throwIfAborted();
    options.onActivity?.(step);
  };
  const explanations =
    options.explanations ??
    (options.explanation === "visible"
      ? new ExplanationCollector(
          options.page,
          "capture",
          options.explanationWaitMs,
        )
      : undefined);

  try {
    activity(options.reachStage);
    status = await options.reach();
    await options.healthGuard?.checkpoint();
    activity("settle");
    await options.page.waitForTimeout(options.settleMs);
    await options.healthGuard?.checkpoint();

    stage = "expectation";
    activity(stage);
    options.assertDestination?.();
    const bodyText = await options.page.locator("body").innerText();
    if (
      options.statusExpectation !== undefined &&
      status !== options.statusExpectation
    ) {
      mismatches.push({
        kind: "status",
        expected: options.statusExpectation,
        actual: status ?? "no response",
      });
    }
    for (const text of options.state.expect.textPresent) {
      if (!bodyText.includes(text)) {
        mismatches.push({ kind: "text-present", expected: text });
      }
    }
    for (const selector of options.state.expect.selectorPresent) {
      if ((await options.page.locator(selector).count()) === 0) {
        mismatches.push({ kind: "selector-present", expected: selector });
      }
    }
    for (const selector of options.state.expect.selectorAbsent) {
      const count = await options.page.locator(selector).count();
      if (count > 0) {
        mismatches.push({
          kind: "selector-absent",
          expected: selector,
          actual: count,
        });
      }
    }

    const focus = (options.state as { focus?: string | undefined }).focus;
    if (focus !== undefined) {
      const target = options.page.locator(focus).first();
      if ((await target.count()) === 0) {
        mismatches.push({ kind: "selector-present", expected: focus });
      } else {
        const window = await explanations?.start();
        let reason: string | undefined;
        try {
          await target.focus();
          await options.page.waitForTimeout(50);
        } catch (error) {
          reason = "state focus failed";
          throw error;
        } finally {
          await window?.finish(reason);
          await window?.dispose();
        }
      }
    }

    if (options.observe?.touchReachability) await parkPointer(options.page);
    await options.healthGuard?.checkpoint();
    stage = "dom";
    activity(stage);
    dom = await options.page.content();
    await options.healthGuard?.checkpoint();
    stage = "axe";
    activity(stage);
    axe = await options.createAxe(options.page).analyze();
    await options.healthGuard?.checkpoint();
    stage = "observations";
    activity(stage);
    observations = await observePage(
      options.page,
      options.tokens,
      axe,
      options.state.mask,
      options.observe,
    );
    await options.healthGuard?.checkpoint();
    if (observations.version === 2)
      observations = {
        ...observations,
        motion: options.motion?.(),
        ...(explanations ? { explanations: explanations.evidence() } : {}),
        ...(options.progress ? { progress: options.progress() } : {}),
      };
    if (observations.version === 2 && options.imageFailures !== undefined)
      observations = {
        ...observations,
        failedImageRequests: options.imageFailures(),
      };
    if (options.assertDestination !== undefined) {
      stage = "expectation";
      activity(stage);
      try {
        options.assertDestination();
      } catch (error) {
        dom = undefined;
        axe = undefined;
        observations = undefined;
        throw error;
      }
    }
    stage = "screenshot";
    activity(stage);
    screenshot =
      options.reuseScreenshot ??
      (await options.page.screenshot(options.screenshotOptions));
    if (
      observations.version === 2 &&
      observations.mediaFrames !== undefined &&
      observations.mediaFrames.length > 0
    ) {
      const image = screenshot;
      const tolerance = options.observe?.mediaFill?.tolerance ?? 8;
      observations = {
        ...observations,
        mediaFill: { tolerance },
        mediaFrames: sampleMediaFrames(
          observations.mediaFrames,
          () => PNG.sync.read(image),
          observations.viewport.width,
          tolerance,
        ),
      };
    }
    await options.healthGuard?.finish();
  } catch (error) {
    failure = error;
    if (!(error instanceof WebStepFailure)) {
      try {
        await options.healthGuard?.checkpoint();
      } catch (healthError) {
        failure = healthError;
      }
    }
    if (failure instanceof WebStepFailure) {
      stage = "step";
      status = failure.status;
      screenshot = failure.screenshot;
    }
  } finally {
    await options.healthGuard?.dispose();
  }

  let records: ConsoleRecord[] = [];
  try {
    stage = failure === undefined ? "console" : stage;
    activity("console");
    records = await options.collectConsole();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  let probeBlocked: string | undefined;
  if (
    failure === undefined &&
    options.observe?.touchReachability !== undefined &&
    observations?.version === 2
  ) {
    // After saved evidence, before the mutating probe: forced pseudo states
    // must not reach the screenshot, and the probe must not see them either.
    const touchReachability = await diagnoseTouchReachability(
      options.page,
      options.observe.touchReachability,
    );
    observations = { ...observations, touchReachability };
    if (!touchReachability.restored)
      probeBlocked =
        "probe skipped: touch diagnostic could not restore the resting state";
  }
  if (
    failure === undefined &&
    probeBlocked !== undefined &&
    options.probe !== undefined &&
    observations?.version === 2
  ) {
    observations = {
      ...observations,
      probe: { status: "partial", reason: probeBlocked, results: [] },
    };
  } else if (
    failure === undefined &&
    options.probe !== undefined &&
    observations?.version === 2
  ) {
    const probeStarted = clock();
    try {
      activity("probe");
      const probe = await options.probe();
      observations = {
        ...observations,
        probe,
        motion: mergeMotion(observations.motion, probe.motion),
        explanations: mergeExplanations(
          observations.explanations,
          probe.explanations,
        ),
      };
    } catch (error) {
      observations = {
        ...observations,
        probe: {
          status: "partial",
          reason: `probe failed: ${errorMessage(error).split("\n")[0]}`,
          results: [],
        },
      };
    } finally {
      probeMs = Math.max(0, clock() - probeStarted);
    }
  }
  options.signal?.throwIfAborted();
  const endedAt = options.now().toISOString();
  if (failure !== undefined) {
    return {
      ok: false,
      probeMs,
      stage,
      message: errorMessage(failure),
      status,
      dom,
      screenshot,
      console: records,
      axe,
      observations,
      mismatches,
      startedAt,
      endedAt,
    };
  }
  return {
    ok: true,
    probeMs,
    status: status ?? null,
    dom: dom as string,
    screenshot: screenshot as Buffer,
    console: records,
    axe,
    observations,
    mismatches,
    startedAt,
    endedAt,
  };
}
