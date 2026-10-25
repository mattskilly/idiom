import { AxeBuilder } from "@axe-core/playwright";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import { inferredComponentInputs } from "../checks/design-components.js";
import {
  type ColorScheme,
  checkMarks,
  type Project,
} from "../schemas/project.js";
import { ExplanationCollector } from "./explanations.js";
import { MotionCollector } from "./motion.js";
import { collectPageEvidence } from "./page.js";
import { probeControls } from "./probe.js";
import { ProgressCollector } from "./progress.js";
import type {
  BrowserLauncher,
  BrowserSession,
  BrowserTuple,
  ConsoleRecord,
  FlowState,
  TupleResult,
} from "./types.js";

import {
  consoleIsAllowed,
  type ReachContext,
  WebStepRunner,
} from "./web-steps.js";

export type BrowserRuntime = {
  launch: () => Promise<Browser>;
  createAxe: (page: Page) => {
    analyze(): Promise<unknown>;
  };
  now: () => Date;
  monotonicNow?: (() => number) | undefined;
};

function reachContext(state: FlowState): ReachContext {
  return {
    state: state.id,
    reachedFrom: "reachedFrom" in state ? state.reachedFrom : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function deterministicContextOptions(
  project: Project,
  viewport: Project["viewports"][number],
  colorScheme: ColorScheme = project.capture.colorScheme,
) {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    ...(viewport.touch === true ? { hasTouch: true } : {}),
    deviceScaleFactor: 2,
    locale: project.capture.locale,
    timezoneId: project.capture.timezoneId,
    colorScheme,
    reducedMotion: project.capture.reducedMotion
      ? ("reduce" as const)
      : ("no-preference" as const),
  };
}

export function deterministicScreenshotOptions(project: Project) {
  return {
    fullPage: project.capture.fullPage,
    animations: "disabled" as const,
    type: "png" as const,
  };
}

export async function captureReferenceUrl(options: {
  url: string;
  project: Project;
  viewport: Project["viewports"][number];
  launch?: (() => Promise<Browser>) | undefined;
}): Promise<Buffer> {
  const browser = await (
    options.launch ?? (() => chromium.launch({ headless: true }))
  )();
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await browser.newContext(
      deterministicContextOptions(options.project, options.viewport),
    );
    page = await context.newPage();
    const response = await page.goto(options.url);
    const status = response?.status();
    if (status === undefined || status < 200 || status >= 300)
      throw new Error(
        status === undefined
          ? "navigation returned no HTTP response"
          : `navigation returned HTTP ${status}`,
      );
    await page.waitForTimeout(options.project.capture.settleMs);
    return await page.screenshot({
      ...deterministicScreenshotOptions(options.project),
      fullPage: false,
    });
  } finally {
    await closeWithin(() => page?.close());
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function captureInContext(
  context: BrowserContext,
  tuple: BrowserTuple,
  runtime: BrowserRuntime,
): Promise<TupleResult> {
  const records: ConsoleRecord[] = [];
  let page: Page | undefined;
  try {
    page = await context.newPage();
    const steps = "health" in tuple.state ? tuple.state.steps : [];
    const health = tuple.health ?? {
      allow:
        "health" in tuple.state
          ? tuple.state.health.allow
          : { urls: [], console: [] },
    };
    const annotate = (record: ConsoleRecord): ConsoleRecord =>
      steps.length > 0 && consoleIsAllowed(record, health)
        ? { ...record, healthAllowed: true }
        : record;
    page.on("console", (message) => {
      const location = message.location();
      records.push(
        annotate({
          type: message.type(),
          text: message.text(),
          location: {
            url: location.url,
            lineNumber: location.lineNumber,
            columnNumber: location.columnNumber,
          },
        }),
      );
    });
    page.on("pageerror", (error) => {
      records.push(annotate({ type: "pageerror", text: error.message }));
    });
    const failedImages = new Map<string, string>();
    if (tuple.published) {
      const recordImage = (url: string, reason: string) => {
        if (!url.startsWith("data:") && !failedImages.has(url))
          failedImages.set(url, reason);
      };
      page.on("requestfailed", (request) => {
        if (request.resourceType() === "image")
          recordImage(
            request.url(),
            request.failure()?.errorText ?? "request failed",
          );
      });
      page.on("response", (response) => {
        if (
          response.request().resourceType() === "image" &&
          response.status() >= 400
        )
          recordImage(response.url(), `HTTP ${response.status()}`);
      });
    }
    const target = page;
    const screenshotOptions = deterministicScreenshotOptions(tuple.project);
    const explanations =
      tuple.project.checks.explanation === "visible"
        ? new ExplanationCollector(
            target,
            "capture",
            tuple.project.checks.probe.waitMs,
          )
        : undefined;
    const motion = new MotionCollector(
      target,
      tuple.project.checks.motion.selectors,
    );
    const progress = new ProgressCollector(
      target,
      tuple.project.checks.progressWithinMs,
    );
    const createRunner = (collect = false, activePage = target) =>
      steps.length > 0
        ? new WebStepRunner(
            activePage,
            health,
            screenshotOptions,
            collect ? motion : undefined,
            collect ? progress : undefined,
            collect ? explanations : undefined,
            tuple.onActivity,
            tuple.signal,
          )
        : undefined;
    const runner = createRunner(true);
    const reach = async (
      active: WebStepRunner | undefined,
      activePage = target,
    ) =>
      active === undefined
        ? ((await activePage.goto(tuple.navigationUrl))?.status() ?? null)
        : active.reach(tuple.navigationUrl, steps, reachContext(tuple.state));
    return await collectPageEvidence({
      page,
      signal: tuple.signal,
      onActivity: tuple.onActivity,
      state: tuple.state,
      settleMs: tuple.state.settleMs ?? tuple.project.capture.settleMs,
      statusExpectation: tuple.state.expect.status ?? 200,
      reachStage: "navigation",
      reach: () => reach(runner),
      healthGuard: runner,
      assertDestination:
        "path" in tuple.state.expect && tuple.state.expect.path !== undefined
          ? () => {
              const actual = new URL(target.url());
              const expected = tuple.state.expect as { path: string };
              // Discovery normalizes route identities before authentication can
              // reveal the app's canonical trailing-slash convention.
              const routePath = (path: string) =>
                path.replace(/\/+$/, "") || "/";
              if (
                actual.origin !== new URL(tuple.navigationUrl).origin ||
                routePath(actual.pathname) !== routePath(expected.path)
              )
                throw new Error(
                  `State ${tuple.state.id}: expected settled path ${expected.path} on the capture origin, received ${actual.href}. Check missing setup or an unexpected redirect.`,
                );
            }
          : undefined,
      explanations,
      motion: steps.length > 0 ? () => motion.evidence() : undefined,
      progress: steps.some((step) => "longRunning" in step && step.longRunning)
        ? () => progress.evidence()
        : undefined,
      createAxe: runtime.createAxe,
      // Freeze step evidence before replay/probe activity mutates the page.
      collectConsole: async () => (steps.length > 0 ? [...records] : records),
      tokens: tuple.tokens ?? { status: "not-configured" },
      screenshotOptions: deterministicScreenshotOptions(tuple.project),
      reuseScreenshot: tuple.reuseScreenshot,
      now: runtime.now,
      monotonicNow: runtime.monotonicNow,
      observe: {
        touchReachability: tuple.project.checks.touchReachability,
        liveness: tuple.project.checks.liveness,
        mediaFill: tuple.project.checks.mediaFill,
        ...(tuple.project.checks.collections.length === 0
          ? {}
          : {
              collections: tuple.project.checks.collections.map(
                ({ selector }) => ({ selector }),
              ),
            }),
        components: tuple.project.checks.components,
        inferredComponents: inferredComponentInputs(tuple.designComponents),
        invariants: tuple.invariants,
        shell: tuple.shell,
        floatingOverlays:
          tuple.project.checks.shellVisibility?.floatingOverlays,
        fresh: tuple.state.fresh === true,
        marks: checkMarks(tuple.project.checks),
        ...(tuple.published ? { images: true } : {}),
        emptyState: tuple.project.checks.emptyState,
        bandEdges: tuple.project.checks.bandEdges?.enabled === true,
        wordBreak: tuple.project.checks.wordBreak?.enabled === true,
      },
      imageFailures: tuple.published
        ? () => [...failedImages].map(([url, reason]) => ({ url, reason }))
        : undefined,
      probe: tuple.probe
        ? () => {
            const settings = tuple.project.checks.probe;
            const target = page as Page;
            return probeControls({
              page: target,
              signal: tuple.signal,
              onActivity: tuple.onActivity,
              onProbeProgress: tuple.onProbeProgress,
              controlTimeoutMs: settings.controlTimeoutMs,
              stateTimeoutMs: settings.stateTimeoutMs,
              monotonicNow: runtime.monotonicNow,
              replacePage: () => context.newPage(),
              skip: settings.skip,
              respectControlIntent: settings.respectControlIntent,
              maxControls: settings.maxControls,
              waitMs: settings.waitMs,
              motionSelectors: tuple.project.checks.motion.selectors,
              explanation: tuple.project.checks.explanation,
              collections: tuple.project.checks.collections.map(
                ({ selector }) => selector,
              ),
              restore: async (activePage) => {
                const replay = createRunner(false, activePage);
                try {
                  await reach(replay, activePage);
                  await activePage.waitForTimeout(
                    tuple.state.settleMs ?? tuple.project.capture.settleMs,
                  );
                  await replay?.finish();
                } finally {
                  await replay?.dispose();
                }
              },
            });
          }
        : undefined,
    });
  } finally {
    await closeWithin(() => page?.close());
  }
}

/**
 * Page and context teardown can wait forever on a page the probe left
 * mid-navigation or behind native UI; capture must move on regardless.
 */
const CLOSE_TIMEOUT_MS = 10_000;
async function closeWithin(
  close: () => Promise<unknown> | undefined,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve(close()).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}

export function createBrowserLauncher(
  overrides: Partial<BrowserRuntime> = {},
): BrowserLauncher {
  return async (options): Promise<BrowserSession> => {
    options?.signal?.throwIfAborted();
    const runtime: BrowserRuntime = {
      launch: overrides.launch ?? (() => chromium.launch({ headless: true })),
      createAxe:
        overrides.createAxe ??
        ((page) => new AxeBuilder({ page }) as { analyze(): Promise<unknown> }),
      now: overrides.now ?? (() => new Date()),
      monotonicNow: overrides.monotonicNow,
    };
    const browser = await runtime.launch();
    if (options?.signal?.aborted) {
      void browser.close().catch(() => undefined);
      options.signal.throwIfAborted();
    }
    const abort = () => {
      void browser.close().catch(() => undefined);
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    const newContext = async (tuple: BrowserTuple) => {
      tuple.signal?.throwIfAborted();
      const context = await browser.newContext(
        deterministicContextOptions(
          tuple.project,
          tuple.viewport,
          tuple.colorScheme ?? tuple.project.capture.colorScheme,
        ),
      );
      if (tuple.signal?.aborted) {
        void context.close().catch(() => undefined);
        tuple.signal.throwIfAborted();
      }
      const attribute = tuple.project.capture.colorSchemeAttribute;
      if (attribute !== undefined) {
        await context
          .addInitScript(
            ({ name, value }: { name: string; value: string }) => {
              const apply = () => {
                const root = document.documentElement;
                if (root === null) return false;
                root.setAttribute(name, value);
                return true;
              };
              if (!apply()) {
                const observer = new MutationObserver((_, active) => {
                  if (apply()) active.disconnect();
                });
                observer.observe(document, {
                  childList: true,
                  subtree: true,
                });
              }
            },
            {
              name: attribute,
              value: tuple.colorScheme ?? tuple.project.capture.colorScheme,
            },
          )
          .catch(async (error: unknown) => {
            await context.close().catch(() => undefined);
            throw error;
          });
      }
      return context;
    };
    return {
      version: browser.version(),
      async capture(tuple) {
        const startedAt = runtime.now().toISOString();
        let context: BrowserContext | undefined;
        try {
          tuple.signal?.throwIfAborted();
          context = await newContext(tuple);
          return await captureInContext(context, tuple, runtime);
        } catch (error) {
          return {
            ok: false,
            stage: "navigation",
            message: errorMessage(error),
            console: [],
            mismatches: [],
            startedAt,
            endedAt: runtime.now().toISOString(),
          };
        } finally {
          await closeWithin(() => context?.close());
        }
      },
      async measure(tuple, selectors) {
        let context: BrowserContext | undefined;
        let runner: WebStepRunner | undefined;
        try {
          tuple.signal?.throwIfAborted();
          context = await newContext(tuple);
          const page = await context.newPage();
          const steps = "health" in tuple.state ? tuple.state.steps : [];
          const health = tuple.health ?? {
            allow:
              "health" in tuple.state
                ? tuple.state.health.allow
                : { urls: [], console: [] },
          };
          if (steps.length > 0) {
            runner = new WebStepRunner(
              page,
              health,
              deterministicScreenshotOptions(tuple.project),
              undefined,
              undefined,
              undefined,
              tuple.onActivity,
              tuple.signal,
            );
            await runner.reach(
              tuple.navigationUrl,
              steps,
              reachContext(tuple.state),
            );
          } else {
            await page.goto(tuple.navigationUrl);
          }
          await page.waitForTimeout(
            tuple.state.settleMs ?? tuple.project.capture.settleMs,
          );
          if (tuple.state.focus !== undefined) {
            const target = page.locator(tuple.state.focus).first();
            if ((await target.count()) === 0) return undefined;
            await target.focus();
            await page.waitForTimeout(50);
          }
          await runner?.checkpoint();
          const rects = await page.evaluate((list: string[]) => {
            const round = (value: number) => Math.round(value * 100) / 100;
            return list.map((selector) =>
              Array.from(document.querySelectorAll(selector), (element) => {
                const rect = element.getBoundingClientRect();
                return [rect.x, rect.y, rect.width, rect.height]
                  .map(round)
                  .join(",");
              }),
            );
          }, selectors);
          return JSON.stringify(rects);
        } catch {
          tuple.signal?.throwIfAborted();
          // An unmeasurable combination is captured and judged on its own.
          return undefined;
        } finally {
          await runner?.dispose().catch(() => undefined);
          await context?.close().catch(() => undefined);
        }
      },
      async close() {
        options?.signal?.removeEventListener("abort", abort);
        await browser.close();
      },
    };
  };
}
