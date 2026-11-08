import type { Page } from "playwright";
import { PNG } from "pngjs";
import type { LoadingStuckEvidence } from "../checks/blank-schema.js";
import { type ObserveOptions, observePage } from "../checks/observe.js";
import type {
  ActionTimelineArtifact,
  FailedImageRequest,
  FocusVisibleObservation,
  GeometryScan,
  LinkObservation,
  MotionArtifact,
  ObservationArtifact,
  ProbeArtifact,
  ProgressArtifact,
  ScreenshotGeometry,
} from "../checks/types.js";
import { inventoryBlankMedia } from "../checks/visual-blank-dom.js";
import { classifyDocument } from "../document.js";
import { settleAnimations } from "./animation-settle.js";
import { ExplanationCollector, mergeExplanations } from "./explanations.js";
import {
  disposeLoadingObservation,
  readLoadingObservation,
  startLoadingObservation,
} from "./loading-stuck.js";
import { sampleMediaFrames, sampleOrphanInk } from "./media-bands.js";
import { mergeMotion } from "./motion.js";
import {
  captureScreenshot,
  fullPageSize,
  withScreenshotGeometry,
} from "./screenshot.js";
import {
  mergeTimelines,
  type TimelineCollector,
  withTimelineIds,
} from "./timeline.js";
import { TupleTimeoutError } from "./timeouts.js";
import { diagnoseTouchReachability, parkPointer } from "./touch.js";
import type {
  ConsoleRecord,
  ExpectationMismatch,
  FlowState,
  TupleFailureStage,
  TupleResult,
} from "./types.js";
import { sampleBlankMedia } from "./visual-blank.js";

import { type StepHealthGuard, WebStepFailure } from "./web-steps.js";

/** Matches the media-fill default: compression noise on a flat background stays inside it. */
const orphanInkTolerance = 8;

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
  animationSettleMs?: number | undefined;
  statusExpectation?: number | undefined;
  reachStage: "navigation" | "state";
  reach: () => Promise<number | null>;
  /** Final URL of the document response `reach` navigated to, after redirects. */
  documentUrl?: (() => string | undefined) | undefined;
  healthGuard?: StepHealthGuard | undefined;
  assertDestination?: (() => void) | undefined;
  createAxe: AxeFactory;
  collectConsole: () => Promise<ConsoleRecord[]>;
  tokens: Parameters<typeof observePage>[1];
  screenshotOptions: Parameters<Page["screenshot"]>[0];
  maxFullPageHeight?: number | undefined;
  reuseScreenshot?: Buffer | undefined;
  /** Geometry of `reuseScreenshot`, recorded when it was taken. */
  reuseScreenshotGeometry?: ScreenshotGeometry | undefined;
  now: () => Date;
  monotonicNow?: (() => number) | undefined;
  observe?: ObserveOptions | undefined;
  /** Runs last, after console collection, on a page it may freely mutate. */
  probe?: (() => Promise<ProbeArtifact>) | undefined;
  motion?: (() => MotionArtifact | undefined) | undefined;
  /** Load and web-step timelines; the load window is already open. */
  timelines?: TimelineCollector | undefined;
  filmstrips?: import("./filmstrips.js").FilmstripCapture | undefined;
  /** Probe-click timelines, read after the probe has run. */
  probeTimelines?: (() => ActionTimelineArtifact | undefined) | undefined;
  explanations?: ExplanationCollector | undefined;
  explanation?: "default" | "visible" | undefined;
  explanationWaitMs?: number | undefined;
  imageFailures?: (() => FailedImageRequest[]) | undefined;
  /** Failed web font requests, merged into observations.fonts. */
  fontFailures?: (() => FailedImageRequest[]) | undefined;
  /** Resolves the observed links (run-scoped cache); web captures only. */
  checkLinks?:
    | ((records: LinkObservation[]) => Promise<GeometryScan<LinkObservation>>)
    | undefined;
  /** Keyboard focus sweep; runs in the probe branch before the click probe. */
  focusSweep?:
    | (() => Promise<GeometryScan<FocusVisibleObservation>>)
    | undefined;
  progress?: (() => ProgressArtifact | undefined) | undefined;
}): Promise<TupleResult> {
  const clock = options.monotonicNow ?? (() => performance.now());
  let probeMs: number | undefined;
  const startedAt = options.now().toISOString();
  const mismatches: ExpectationMismatch[] = [];
  let status: number | null | undefined;
  let dom: string | undefined;
  let screenshot: Buffer | undefined;
  let screenshotGeometry: ScreenshotGeometry | undefined;
  let observedSize: { width: number; height: number } | undefined;
  let axe: unknown;
  let nonHtml = false;
  let loading: LoadingStuckEvidence | undefined;
  let loadingStarted = false;
  const loadingWindow = options.state.loadingSettleMs ?? 5000;
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
    stage = "expectation";
    options.assertDestination?.();
    if (options.observe?.loadingStuck) {
      const html = await options.page.evaluate(() =>
        /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
          document.contentType,
        ),
      );
      if (html && !options.state.loading) {
        await startLoadingObservation(
          options.page,
          loadingWindow,
          options.state.mask,
        );
        loadingStarted = true;
      } else
        loading = {
          status: "skipped",
          reason: html ? "intentional loading state" : "non-HTML document",
          windowMs: loadingWindow,
          observedMs: 0,
          intentional: options.state.loading === true,
          records: [],
        };
    }
    await options.healthGuard?.checkpoint();
    activity("settle");
    await options.page.waitForTimeout(options.settleMs);
    await options.healthGuard?.checkpoint();

    // Reach is complete: a client redirect that lands during the animation
    // wait destroys the evaluate context; that is an expectation failure the
    // destination guard names.
    stage = "expectation";
    activity("animation settle");
    const animations = await settleAnimations(
      options.page,
      options.animationSettleMs ?? 1500,
      options.signal,
      () => options.healthGuard?.checkpoint() ?? Promise.resolve(),
    ).catch((error: unknown) => {
      options.assertDestination?.();
      throw error;
    });

    activity(stage);
    options.assertDestination?.();
    const documentType = await options.page.evaluate(() => ({
      contentType: document.contentType,
    }));
    nonHtml = classifyDocument(documentType.contentType) === "non-html";
    // Already finished, unsettled, when web steps began.
    await options.timelines?.finishLoad(
      nonHtml ? "non-html document" : undefined,
      true,
      true,
    );

    if (!nonHtml && options.observe?.designComparison) {
      activity("design resources");
      await options.page.evaluate(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await document.fonts.ready;
              await Promise.all(
                [...document.images]
                  .filter((image) => image.complete || image.currentSrc)
                  .map((image) => image.decode().catch(() => undefined)),
              );
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Design comparison resources did not settle within 30 seconds",
                    ),
                  ),
                30_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      options.signal?.throwIfAborted();
    }
    if (loadingStarted) {
      activity("loading settle");
      let elapsed =
        (await readLoadingObservation(options.page))?.observedMs ?? 0;
      while (elapsed < loadingWindow) {
        options.signal?.throwIfAborted();
        await options.page.waitForTimeout(
          Math.min(100, Math.ceil(loadingWindow - elapsed)),
        );
        await options.healthGuard?.checkpoint();
        elapsed =
          (await readLoadingObservation(options.page))?.observedMs ??
          loadingWindow;
      }
    } else {
      // Reach waits only for DOM-ready; without the loading window, resources
      // such as images still need the load event before the screenshot.
      activity("load settle");
      await options.page
        .waitForLoadState("load", { timeout: loadingWindow })
        .catch(() => undefined);
      options.signal?.throwIfAborted();
      await options.healthGuard?.checkpoint();
    }
    const bodyText = nonHtml
      ? await options.page.evaluate(
          () => (document.body ?? document.documentElement)?.textContent ?? "",
        )
      : await options.page.locator("body").innerText();
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
    if (!nonHtml && focus !== undefined) {
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

    if (!nonHtml && options.observe?.touchReachability)
      await parkPointer(options.page);
    await options.healthGuard?.checkpoint();
    stage = "dom";
    activity(stage);
    dom = await options.page.content();
    await options.healthGuard?.checkpoint();
    stage = "axe";
    activity(stage);
    const axeDocument = await options.page.evaluate(() => ({
      contentType: document.contentType,
    }));
    nonHtml = classifyDocument(axeDocument.contentType) === "non-html";
    axe = nonHtml
      ? { violations: [] }
      : await options.createAxe(options.page).analyze();
    await options.healthGuard?.checkpoint();
    stage = "observations";
    activity(stage);
    // The size a full-page shot would capture before observing starts,
    // compared after the shot: layout that moves during or after observe
    // (observe itself takes seconds on large pages) leaves its rects stale.
    observedSize = nonHtml ? undefined : await fullPageSize(options.page);
    observations = await observePage(
      options.page,
      options.tokens,
      axe,
      options.state.mask,
      options.observe,
    );
    nonHtml =
      classifyDocument(observations.document.contentType) === "non-html";
    if (nonHtml) axe = { violations: [] };
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
    if (
      observations.version === 2 &&
      observations.fonts !== undefined &&
      options.fontFailures !== undefined
    ) {
      const known = new Set(
        observations.fonts.failedRequests.map(({ url }) => url),
      );
      observations = {
        ...observations,
        fonts: {
          ...observations.fonts,
          failedRequests: [
            ...observations.fonts.failedRequests,
            ...options.fontFailures().filter(({ url }) => !known.has(url)),
          ],
        },
      };
    }
    if (
      !nonHtml &&
      observations.version === 2 &&
      observations.links !== undefined &&
      options.checkLinks !== undefined
    ) {
      const scan = observations.links;
      const checked = await options.checkLinks(scan.records);
      observations = {
        ...observations,
        links:
          scan.status === "ran" || checked.status !== "ran"
            ? checked
            : { ...scan, records: checked.records },
      };
      await options.healthGuard?.checkpoint();
    }
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
    if (
      !nonHtml &&
      observations.version === 2 &&
      options.observe?.visualBlank?.enabled
    )
      observations = {
        ...observations,
        visualBlank: await inventoryBlankMedia(
          options.page,
          options.observe.visualBlank.swatchSelectors,
          options.state.mask,
        ),
      };
    const reused =
      !loadingStarted &&
      !(observations.version === 2 && observations.visualBlank) &&
      !animations.hadAnimations
        ? options.reuseScreenshot
        : undefined;
    let geometry: Omit<ScreenshotGeometry, "drift" | "rects"> | undefined;
    if (reused !== undefined) {
      screenshot = reused;
      geometry = options.reuseScreenshotGeometry;
    } else {
      const captured = await captureScreenshot(
        options.page,
        animations.unresolved
          ? { ...options.screenshotOptions, animations: "allow" }
          : options.screenshotOptions,
        { maxFullPageHeight: options.maxFullPageHeight },
      );
      screenshot = captured.buffer;
      geometry = captured.geometry;
    }
    if (geometry !== undefined) {
      const {
        drift: _drift,
        rects: _rects,
        ...own
      } = geometry as ScreenshotGeometry;
      screenshotGeometry =
        !nonHtml && observations.version === 2
          ? await withScreenshotGeometry(options.page, own, observedSize, [
              ...observations.elements.map((element) => element.selector),
              ...(observations.visualBlank?.records.map((r) => r.selector) ??
                []),
            ])
          : own;
      if (observations.version === 2)
        observations = { ...observations, screenshot: screenshotGeometry };
    }
    if (!nonHtml && observations.version === 2) {
      if (loadingStarted)
        loading = await readLoadingObservation(options.page, true);
      if (loading) observations = { ...observations, loadingStuck: loading };
      const image = screenshot;
      // One lazy decode serves every pixel sampler below.
      let decoded: PNG | undefined;
      let decodeAttempted = false;
      let decodeError: unknown;
      const decode = () => {
        if (!decodeAttempted) {
          decodeAttempted = true;
          try {
            decoded = PNG.sync.read(image);
          } catch (error) {
            decodeError = error;
          }
        }
        if (!decoded)
          throw decodeError ?? new Error("screenshot PNG could not be decoded");
        return decoded;
      };
      if (
        observations.mediaFrames !== undefined &&
        observations.mediaFrames.length > 0
      ) {
        const tolerance = options.observe?.mediaFill?.tolerance ?? 8;
        observations = {
          ...observations,
          mediaFill: { tolerance },
          mediaFrames: sampleMediaFrames(
            observations.mediaFrames,
            decode,
            observations.viewport.width,
            tolerance,
          ),
        };
      }
      if (observations.visualBlank)
        observations = {
          ...observations,
          visualBlank: sampleBlankMedia(
            observations.visualBlank,
            decode,
            observations.viewport,
            screenshotGeometry,
            observations.document.scrollWidth,
          ),
        };
      const orphans = observations.orphanWords;
      if (orphans !== undefined && orphans.status !== "unavailable")
        observations = {
          ...observations,
          orphanWords: {
            ...orphans,
            records: sampleOrphanInk(
              orphans.records,
              decode,
              observations.viewport,
              observations.document.scrollWidth,
              orphanInkTolerance,
            ),
          },
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
      if (status !== undefined) {
        try {
          options.assertDestination?.();
        } catch (destinationError) {
          failure = destinationError;
          stage = "expectation";
          dom = undefined;
          axe = undefined;
          observations = undefined;
          screenshot = undefined;
          screenshotGeometry = undefined;
        }
      }
    }
    if (failure instanceof WebStepFailure) {
      stage = "step";
      status = failure.status;
      screenshot = failure.screenshot;
      screenshotGeometry = failure.screenshotGeometry;
      if (observations?.version === 2) {
        if (screenshotGeometry)
          screenshotGeometry = await withScreenshotGeometry(
            options.page,
            screenshotGeometry,
            observedSize,
            observations.elements.map((element) => element.selector),
          ).catch(() =>
            failure instanceof WebStepFailure
              ? failure.screenshotGeometry
              : undefined,
          );
        observations = { ...observations, screenshot: screenshotGeometry };
      }
    }
  } finally {
    if (loadingStarted) await disposeLoadingObservation(options.page);
    await options.healthGuard?.dispose();
    await options.timelines?.finishLoad("state did not settle");
  }

  let records: ConsoleRecord[] = [];
  try {
    stage = failure === undefined ? "console" : stage;
    activity("console");
    records = await options.collectConsole();
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  await options.timelines?.waitVisual();
  let probeBlocked: string | undefined;
  if (
    failure === undefined &&
    !nonHtml &&
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
    !nonHtml &&
    options.probe !== undefined &&
    observations?.version === 2
  ) {
    const probeStarted = clock();
    try {
      activity("probe");
      if (options.focusSweep !== undefined) {
        let focusVisible: GeometryScan<FocusVisibleObservation>;
        try {
          focusVisible = await options.focusSweep();
        } catch (error) {
          focusVisible = {
            status: "partial",
            reason: `focus sweep failed: ${errorMessage(error).split("\n")[0]}`,
            records: [],
          };
        }
        observations = { ...observations, focusVisible };
      }
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
  await options.filmstrips?.dispose();
  options.signal?.throwIfAborted();
  const endedAt = options.now().toISOString();
  const timelines = options.timelines
    ? withTimelineIds(
        mergeTimelines(
          options.timelines.evidence(),
          options.probeTimelines?.(),
        ),
      )
    : undefined;
  // Read after reach either way: a reach that throws after goto still navigated.
  const documentUrl = options.documentUrl?.();
  if (failure !== undefined) {
    const cause = failure instanceof WebStepFailure ? failure.cause : failure;
    return {
      ok: false,
      probeMs,
      stage,
      message: errorMessage(failure),
      timeout: cause instanceof TupleTimeoutError ? cause.timeout : undefined,
      status,
      ...(documentUrl === undefined ? {} : { documentUrl }),
      dom,
      screenshot,
      screenshotGeometry,
      console: records,
      axe,
      observations,
      timelines,
      filmstrips: options.filmstrips,
      mismatches,
      startedAt,
      endedAt,
    };
  }
  return {
    ok: true,
    probeMs,
    status: status ?? null,
    ...(documentUrl === undefined ? {} : { documentUrl }),
    dom: dom as string,
    screenshot: screenshot as Buffer,
    screenshotGeometry,
    console: records,
    axe,
    observations,
    timelines,
    filmstrips: options.filmstrips,
    mismatches,
    startedAt,
    endedAt,
  };
}
