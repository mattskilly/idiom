import { AxeBuilder } from "@axe-core/playwright";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  request as playwrightRequest,
  type Route,
} from "playwright";
import { inferredComponentInputs } from "../checks/design-components.js";
import { checksConfigFrom } from "../checks/registry.js";
import type { ActionTimelineArtifact } from "../checks/types.js";
import { navigateDesign } from "../design/source.js";
import {
  type ColorScheme,
  checkMarks,
  type Project,
} from "../schemas/project.js";
import { ExplanationCollector } from "./explanations.js";
import { FilmstripBudget, FilmstripCapture } from "./filmstrips.js";
import { sweepFocusVisible } from "./focus.js";
import { createLinkChecker, type LinkChecker } from "./links.js";
import { heldCandidate } from "./loading.js";
import { MotionCollector } from "./motion.js";
import { collectPageEvidence } from "./page.js";
import {
  createProbeSafetyLedger,
  crossOriginNavigation,
  type HeldStep,
  probeControls,
  probeRequestAllowed,
  protectProbeFocus,
  recordProbeRequest,
} from "./probe.js";
import { ProgressCollector } from "./progress.js";
import { TimelineCollector } from "./timeline.js";
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
  runAction,
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
  linkChecker: (() => LinkChecker) | undefined,
): Promise<TupleResult> {
  const records: ConsoleRecord[] = [];
  let page: Page | undefined;
  // Third-party probing shares one ledger across the sweep and the clicks.
  const safety =
    tuple.probe && tuple.probeSafety === "third-party"
      ? createProbeSafetyLedger([new URL(tuple.navigationUrl).origin])
      : undefined;
  const clock = runtime.monotonicNow ?? (() => performance.now());
  let probeStartedAt: number | undefined;
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
    const failedFonts = new Map<string, string>();
    const recordFont = (url: string, reason: string) => {
      if (!url.startsWith("data:") && !failedFonts.has(url))
        failedFonts.set(url, reason);
    };
    page.on("requestfailed", (request) => {
      if (request.resourceType() === "font")
        recordFont(
          request.url(),
          request.failure()?.errorText ?? "request failed",
        );
    });
    page.on("response", (response) => {
      if (
        response.request().resourceType() === "font" &&
        response.status() >= 400
      )
        recordFont(response.url(), `HTTP ${response.status()}`);
    });
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
    const filmstrips =
      !tuple.designReference && tuple.project.capture.filmstrips.enabled
        ? new FilmstripCapture(
            {
              ...tuple.project.capture.filmstrips,
              offsetsMs:
                tuple.filmstripRequests?.[0]?.offsetsMs ??
                tuple.project.capture.filmstrips.offsetsMs,
            },
            checksConfigFrom(tuple.project.checks),
            () => motion.evidence(),
            tuple.filmstripRequests?.map((r) => r.identity),
            tuple.filmstripBudget,
          )
        : undefined;
    const timelines = tuple.designReference
      ? undefined
      : new TimelineCollector(target, {
          clock: runtime.monotonicNow,
          motionSelectors: tuple.project.checks.motion.selectors,
          filmstrips,
        });
    let probeTimelines: ActionTimelineArtifact | undefined;
    await timelines?.beginLoad({
      source: "load",
      kind: "navigation",
      name: URL.canParse(tuple.navigationUrl)
        ? new URL(tuple.navigationUrl).pathname
        : (tuple.navigationUrl.split(/[?#]/)[0] ?? ""),
    });
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
            collect ? timelines : undefined,
          )
        : undefined;
    const runner = createRunner(true);
    const reach = async (
      active: WebStepRunner | undefined,
      activePage = target,
      through = steps,
    ) =>
      active === undefined
        ? ((await activePage.goto(tuple.navigationUrl))?.status() ?? null)
        : active.reach(tuple.navigationUrl, through, reachContext(tuple.state));
    /** Replay steps 1..n-1 on a fresh page, as restore replays them all. */
    const reachBefore = async (activePage: Page, stepIndex: number) => {
      const replay = createRunner(false, activePage);
      try {
        await reach(replay, activePage, steps.slice(0, stepIndex - 1));
        await activePage.waitForTimeout(
          tuple.state.settleMs ?? tuple.project.capture.settleMs,
        );
        await replay?.finish();
      } finally {
        await replay?.dispose();
      }
    };
    /** Web steps whose recorded action sent fetch/XHR/document requests. */
    const heldSteps = (): HeldStep[] =>
      (timelines?.evidence().actions ?? []).flatMap((action) => {
        if (action.source !== "web-step" || action.stepIndex === undefined)
          return [];
        if (!heldCandidate(action.requests)) return [];
        const stepIndex = action.stepIndex;
        const step = steps[stepIndex - 1];
        if (
          step === undefined ||
          !(
            step.action === "click" ||
            step.action === "fill" ||
            step.action === "press" ||
            step.action === "select"
          )
        )
          return [];
        const selector = step.selector;
        return [
          {
            stepIndex,
            action: step.action,
            selector,
            reach: (page: Page) => reachBefore(page, stepIndex),
            perform: (page: Page) =>
              runAction(page, step).then(() => undefined),
            repeat:
              step.action === "click"
                ? (page: Page, timeout: number) =>
                    page
                      .locator(selector)
                      .first()
                      .click({ timeout, noWaitAfter: true })
                : step.action === "press"
                  ? (page: Page, timeout: number) =>
                      page
                        .locator(selector)
                        .first()
                        .press(step.key, { timeout, noWaitAfter: true })
                  : undefined,
          },
        ];
      });
    return await collectPageEvidence({
      page,
      signal: tuple.signal,
      onActivity: tuple.onActivity,
      state: tuple.state,
      settleMs: tuple.state.settleMs ?? tuple.project.capture.settleMs,
      animationSettleMs: tuple.project.capture.animationSettleMs,
      statusExpectation: tuple.state.expect.status ?? 200,
      reachStage: "navigation",
      reach: () =>
        tuple.designReference
          ? navigateDesign(target, tuple.designReference)
          : reach(runner),
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
      timelines,
      filmstrips,
      probeTimelines: () => probeTimelines,
      motion: steps.length > 0 ? () => motion.evidence() : undefined,
      progress: steps.some((step) => "longRunning" in step && step.longRunning)
        ? () => progress.evidence()
        : undefined,
      createAxe: runtime.createAxe,
      // Freeze step evidence before replay/probe activity mutates the page.
      collectConsole: async () =>
        steps.length > 0 || safety !== undefined ? [...records] : records,
      tokens: tuple.tokens ?? { status: "not-configured" },
      screenshotOptions: deterministicScreenshotOptions(tuple.project),
      reuseScreenshot: tuple.reuseScreenshot,
      reuseScreenshotGeometry: tuple.reuseScreenshotGeometry,
      now: runtime.now,
      monotonicNow: runtime.monotonicNow,
      observe: tuple.designReference
        ? { designComparison: true }
        : {
            designComparison: tuple.state.design !== undefined,
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
            // Cheap facts, recorded even when a check is disabled so replay
            // works once it is re-enabled. Links cost network, so they follow
            // the setting.
            fonts: true,
            lineLength: true,
            orphanWord: true,
            imageRenders: true,
            layoutShift: true,
            links: linkChecker !== undefined,
          },
      imageFailures: tuple.published
        ? () => [...failedImages].map(([url, reason]) => ({ url, reason }))
        : undefined,
      fontFailures: () =>
        [...failedFonts].map(([url, reason]) => ({ url, reason })),
      checkLinks:
        linkChecker === undefined
          ? undefined
          : (records) => linkChecker().check(records),
      focusSweep: tuple.probe
        ? async () => {
            probeStartedAt ??= clock();
            if (safety) {
              const origin = new URL(target.url()).origin;
              if (!safety.origins.includes(origin)) safety.origins.push(origin);
            }
            const readonly = (route: Route) => {
              const request = route.request();
              if (safety && crossOriginNavigation(safety, request)) {
                safety.blocked.crossOriginNavigation += 1;
                recordProbeRequest(safety, request, false);
                return route.abort("blockedbyclient").catch(() => undefined);
              }
              const allowed = probeRequestAllowed(
                request,
                safety ? "third-party" : "app",
              );
              if (safety) recordProbeRequest(safety, request, allowed);
              return allowed
                ? route.fallback()
                : route.abort("blockedbyclient").catch(() => undefined);
            };
            let unprotect: (() => Promise<void>) | undefined;
            await context.route("**/*", readonly);
            try {
              await target.route("**/*", readonly);
              if (safety) unprotect = await protectProbeFocus(target, safety);
              return await sweepFocusVisible(target, {
                maxStops: tuple.project.checks.probe.maxControls,
                ignore: [
                  ...tuple.project.checks.focusVisible.ignore,
                  ...tuple.project.checks.probe.skip,
                ],
                // A page budget keeps at least two thirds for the clicks.
                budgetMs:
                  tuple.probePageBudgetMs === undefined
                    ? tuple.project.checks.probe.stateTimeoutMs
                    : Math.min(
                        tuple.project.checks.probe.stateTimeoutMs,
                        Math.max(1, Math.floor(tuple.probePageBudgetMs / 3)),
                      ),
                monotonicNow: runtime.monotonicNow,
              });
            } finally {
              await unprotect?.();
              await target.unroute("**/*", readonly).catch(() => undefined);
              await context.unroute("**/*", readonly).catch(() => undefined);
            }
          }
        : undefined,
      probe: tuple.probe
        ? () => {
            const settings = tuple.project.checks.probe;
            const target = page as Page;
            probeStartedAt ??= clock();
            const stateTimeoutMs =
              tuple.probePageBudgetMs === undefined
                ? settings.stateTimeoutMs
                : Math.max(
                    1,
                    tuple.probePageBudgetMs - (clock() - probeStartedAt),
                  );
            return probeControls({
              page: target,
              filmstrips,
              requestedActions: tuple.filmstripRequests?.map((r) => r.identity),
              enumerateOnly: tuple.enumerateProbe,
              flowBudget: tuple.probeBudget,
              signal: tuple.signal,
              onActivity: tuple.onActivity,
              onProbeProgress: tuple.onProbeProgress,
              controlTimeoutMs: settings.controlTimeoutMs,
              stateTimeoutMs,
              monotonicNow: runtime.monotonicNow,
              replacePage: () => context.newPage(),
              skip: settings.skip,
              respectControlIntent: settings.respectControlIntent,
              maxControls: settings.maxControls,
              waitMs: settings.waitMs,
              motionSelectors: tuple.project.checks.motion.selectors,
              motionMinExtentPx: tuple.project.checks.motion.minExtentPx,
              reducedMotion: tuple.project.capture.reducedMotion,
              onTimelines: (recorded) => {
                probeTimelines = recorded;
              },
              heldReplay:
                tuple.enumerateProbe || tuple.designReference
                  ? undefined
                  : {
                      delayMs: tuple.project.checks.loading.delayMs,
                      withinMs: tuple.project.checks.progressWithinMs,
                      steps: heldSteps(),
                    },
              explanation: tuple.project.checks.explanation,
              collections: tuple.project.checks.collections.map(
                ({ selector }) => selector,
              ),
              ledger: tuple.probeLedger,
              ...(safety === undefined
                ? {}
                : {
                    safety: { policy: "third-party" as const, ledger: safety },
                  }),
              stateId: tuple.state.id,
              ledgerPartition: `${tuple.viewport.name}\0${tuple.colorScheme ?? tuple.project.capture.colorScheme}`,
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
    const filmstripBudgets = new Map<string, FilmstripBudget>();
    let links: LinkChecker | undefined;
    const linkCheckerFor = (tuple: BrowserTuple) => {
      const settings = tuple.project.checks.links;
      if (!settings.enabled) return undefined;
      return () => {
        links ??= createLinkChecker({
          external: settings.external,
          timeoutMs: settings.timeoutMs,
          budgetMs: settings.budgetMs,
          concurrency: settings.concurrency,
          ignore: settings.ignore,
          monotonicNow: runtime.monotonicNow,
          request: () =>
            playwrightRequest.newContext({ ignoreHTTPSErrors: false }),
        });
        return links;
      };
    };
    const newContext = async (tuple: BrowserTuple) => {
      tuple.signal?.throwIfAborted();
      const context = await browser.newContext({
        ...deterministicContextOptions(
          tuple.project,
          tuple.viewport,
          tuple.colorScheme ?? tuple.project.capture.colorScheme,
        ),
        // A service worker's fetches bypass context routing.
        ...(tuple.probe && tuple.probeSafety === "third-party"
          ? { serviceWorkers: "block" as const }
          : {}),
      });
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
      planProbes: true,
      async capture(tuple) {
        const startedAt = runtime.now().toISOString();
        let context: BrowserContext | undefined;
        try {
          tuple.signal?.throwIfAborted();
          context = await newContext(tuple);
          const lane = `${tuple.viewport.name}\0${tuple.colorScheme ?? tuple.project.capture.colorScheme}`;
          let filmstripBudget = filmstripBudgets.get(lane);
          if (!filmstripBudget) {
            filmstripBudget = new FilmstripBudget();
            filmstripBudgets.set(lane, filmstripBudget);
          }
          return await captureInContext(
            context,
            { ...tuple, filmstripBudget },
            runtime,
            linkCheckerFor(tuple),
          );
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
        await links?.dispose();
        await browser.close();
      },
    };
  };
}
