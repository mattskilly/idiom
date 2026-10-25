import { isAbsolute, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import {
  _electron,
  type ElectronApplication,
  type JSHandle,
  type Page,
} from "playwright";
import { IdiomError } from "../errors.js";
import type { ElectronFlow } from "../schemas/flow.js";
import { checkMarks } from "../schemas/project.js";
import { deterministicScreenshotOptions } from "./browser.js";
import { type AxeFactory, collectPageEvidence } from "./page.js";
import { expandDataDirectory, expandEnvironment } from "./process.js";
import type {
  ConsoleRecord,
  ElectronLauncher,
  ElectronSession,
  ElectronTuple,
  TupleFailureStage,
  TupleResult,
} from "./types.js";

type ElectronLaunchOptions = Parameters<typeof _electron.launch>[0];

export type ElectronRuntime = {
  launch: (options: ElectronLaunchOptions) => Promise<ElectronApplication>;
  createAxe: AxeFactory;
  now: () => Date;
};

const SCALE_SWITCH = "--force-device-scale-factor=2";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(
  stage: TupleFailureStage,
  error: unknown,
  now: () => Date,
  startedAt: string,
): TupleResult {
  return {
    ok: false,
    stage,
    message: errorMessage(error),
    console: [],
    mismatches: [],
    startedAt,
    endedAt: now().toISOString(),
  };
}

function definedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function resolveLaunch(options: {
  projectDirectory: string;
  flow: ElectronFlow;
  dataDirectory: string;
  inheritedEnvironment: NodeJS.ProcessEnv;
}): { launch: ElectronLaunchOptions; environment: NodeJS.ProcessEnv } {
  const declared = options.flow.target.launch;
  if (declared.executablePath.includes("${")) {
    throw new IdiomError(
      "Electron executablePath does not support placeholders",
    );
  }
  if (
    declared.args.some((argument) =>
      argument.startsWith("--force-device-scale-factor"),
    )
  ) {
    throw new IdiomError(
      `Electron launch args must not override reserved ${SCALE_SWITCH}`,
    );
  }
  const executablePath = isAbsolute(declared.executablePath)
    ? resolve(declared.executablePath)
    : resolve(options.projectDirectory, declared.executablePath);
  const cwdTemplate = declared.cwd ?? options.projectDirectory;
  const expandedCwd = expandDataDirectory(
    cwdTemplate,
    options.dataDirectory,
    "Electron launch cwd",
  );
  const cwd = isAbsolute(expandedCwd)
    ? resolve(expandedCwd)
    : resolve(options.projectDirectory, expandedCwd);
  const args = [
    SCALE_SWITCH,
    ...declared.args.map((argument, index) =>
      expandDataDirectory(
        argument,
        options.dataDirectory,
        `Electron launch args[${index}]`,
      ),
    ),
  ];
  const environment = {
    ...definedEnvironment(options.inheritedEnvironment),
    ...expandEnvironment(declared.env, options.dataDirectory),
  };
  return {
    launch: {
      executablePath,
      args,
      cwd,
      env: definedEnvironment(environment),
      timeout: declared.timeoutMs,
    },
    environment,
  };
}

async function exactTitleWindows(
  application: ElectronApplication,
  title: string,
): Promise<Page[]> {
  const windows = application.windows();
  const titles = await Promise.all(
    windows.map(async (page) => await page.title()),
  );
  return windows.filter((_, index) => titles[index] === title);
}

export async function selectElectronWindow(
  application: ElectronApplication,
  title: string,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Electron window title ${JSON.stringify(title)} matched no loaded window within ${timeoutMs}ms`,
      );
    }
    const waiter = new AbortController();
    const nextWindow = application
      .waitForEvent("window", {
        timeout: remaining,
        signal: waiter.signal,
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    let matches: Page[];
    try {
      matches = await exactTitleWindows(application, title);
    } catch (error) {
      waiter.abort();
      await nextWindow;
      throw error;
    }
    if (matches.length > 1) {
      waiter.abort();
      await nextWindow;
      throw new Error(
        `Electron window title ${JSON.stringify(title)} matched ${matches.length} loaded windows; expected exactly one`,
      );
    }
    if (matches[0] !== undefined) {
      waiter.abort();
      await nextWindow;
      return matches[0];
    }
    const arrival = await nextWindow;
    if (!arrival.ok) {
      throw new Error(
        `Electron window title ${JSON.stringify(title)} matched no loaded window within ${timeoutMs}ms: ${errorMessage(arrival.error)}`,
      );
    }
  }
}

async function collectBufferedConsole(page: Page): Promise<ConsoleRecord[]> {
  const messages = await page.consoleMessages({ filter: "all" });
  const errors = await page.pageErrors({ filter: "all" });
  return [
    ...messages.map((message) => {
      const location = message.location();
      return {
        type: message.type(),
        text: message.text(),
        location: {
          url: location.url,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        },
      };
    }),
    ...errors.map((error) => ({ type: "pageerror", text: error.message })),
  ];
}

async function synchronizePage(
  application: ElectronApplication,
  page: Page,
  tuple: ElectronTuple,
): Promise<void> {
  const colorScheme = tuple.colorScheme ?? tuple.project.capture.colorScheme;
  await page.emulateMedia({
    colorScheme,
    reducedMotion: tuple.project.capture.reducedMotion
      ? "reduce"
      : "no-preference",
  });
  const attribute = tuple.project.capture.colorSchemeAttribute;
  if (attribute !== undefined) {
    await page.evaluate(
      ({ name, value }) => document.documentElement.setAttribute(name, value),
      { name: attribute, value: colorScheme },
    );
  }
  const browserWindow = (await application.browserWindow(page)) as JSHandle<{
    setContentSize(width: number, height: number): void;
  }>;
  await browserWindow.evaluate(
    (window, size) => window.setContentSize(size.width, size.height),
    { width: tuple.viewport.width, height: tuple.viewport.height },
  );
  await page.waitForFunction(
    ({ width, height }) =>
      window.innerWidth === width && window.innerHeight === height,
    { width: tuple.viewport.width, height: tuple.viewport.height },
  );
}

async function performSteps(tuple: ElectronTuple, page: Page): Promise<void> {
  for (const [index, step] of tuple.state.steps.entries()) {
    tuple.signal?.throwIfAborted();
    tuple.onActivity?.(
      `Electron step ${index + 1} ${step.action} ${step.selector}`,
    );
    const locator = page.locator(step.selector);
    if (step.action === "click") await locator.click();
    else if (step.action === "fill") await locator.fill(step.value);
    else await locator.press(step.key);
  }
}

async function runtimeVersion(
  application: ElectronApplication,
): Promise<string> {
  const versions = await application.evaluate(() => ({
    electron: process.versions.electron ?? "unknown",
    chromium: process.versions.chrome ?? "unknown",
  }));
  return `Electron ${versions.electron} / Chromium ${versions.chromium}`;
}

export function createElectronLauncher(
  overrides: Partial<ElectronRuntime> = {},
): ElectronLauncher {
  return async (options): Promise<ElectronSession> => {
    options.signal?.throwIfAborted();
    const runtime: ElectronRuntime = {
      launch:
        overrides.launch ??
        ((launchOptions) => _electron.launch(launchOptions)),
      createAxe:
        overrides.createAxe ??
        ((page) => new AxeBuilder({ page }).setLegacyMode(true)),
      now: overrides.now ?? (() => new Date()),
    };
    const resolved = resolveLaunch(options);
    const applications = new Set<ElectronApplication>();
    const closing = new WeakMap<ElectronApplication, Promise<void>>();
    const killTimers = new WeakMap<
      ElectronApplication,
      ReturnType<typeof setTimeout>
    >();
    const forceClose = (application: ElectronApplication) => {
      if (killTimers.has(application) || !application.process) return;
      // app.quit() can be prevented by application code or a busy main thread.
      // Leave time for graceful close, then reap the owned Electron process.
      const timer = setTimeout(() => {
        try {
          application.process().kill("SIGKILL");
        } catch {
          /* Already exited. */
        }
      }, 2000);
      timer.unref();
      killTimers.set(application, timer);
    };
    let closed = false;
    const closeApplication = (application: ElectronApplication) => {
      let pending = closing.get(application);
      if (!pending) {
        pending = application
          .close()
          .catch(() => undefined)
          .then(() => {
            clearTimeout(killTimers.get(application));
            applications.delete(application);
          });
        closing.set(application, pending);
      }
      if (options.signal?.aborted) forceClose(application);
      return pending;
    };
    const abort = () => {
      for (const application of applications)
        void closeApplication(application);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    return {
      effectiveEnvironment: resolved.environment,
      async capture(tuple) {
        tuple.signal?.throwIfAborted();
        const startedAt = runtime.now().toISOString();
        let version = "Electron unavailable / Chromium unavailable";
        let application: ElectronApplication | undefined;
        try {
          try {
            tuple.onActivity?.("Electron launch");
            application = await runtime.launch({
              ...resolved.launch,
              locale: tuple.project.capture.locale,
              timezoneId: tuple.project.capture.timezoneId,
              colorScheme:
                tuple.colorScheme ?? tuple.project.capture.colorScheme,
            });
            applications.add(application);
            if (closed || options.signal?.aborted || tuple.signal?.aborted) {
              void closeApplication(application);
              (tuple.signal?.aborted
                ? tuple.signal
                : options.signal
              )?.throwIfAborted();
              throw new Error("Electron session closed during launch");
            }
          } catch (error) {
            return {
              result: failure("launch", error, runtime.now, startedAt),
              version,
            };
          }
          version = await runtimeVersion(application).catch(() => version);
          tuple.signal?.throwIfAborted();
          let page: Page;
          try {
            tuple.onActivity?.("Electron window");
            page = await selectElectronWindow(
              application,
              options.flow.target.window.title,
              options.flow.target.window.timeoutMs,
            );
            tuple.signal?.throwIfAborted();
            const attribute = tuple.project.capture.colorSchemeAttribute;
            if (attribute !== undefined) {
              await application.context().addInitScript(
                ({ name, value }) => {
                  const apply = () => {
                    if (document.documentElement === null) return false;
                    document.documentElement.setAttribute(name, value);
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
              );
            }
          } catch (error) {
            return {
              result: failure("window", error, runtime.now, startedAt),
              version,
            };
          }
          const result = await collectPageEvidence({
            page,
            signal: tuple.signal,
            onActivity: tuple.onActivity,
            state: tuple.state,
            settleMs: tuple.state.settleMs ?? tuple.project.capture.settleMs,
            reachStage: "state",
            reach: async () => {
              await synchronizePage(
                application as ElectronApplication,
                page,
                tuple,
              );
              await performSteps(tuple, page);
              return null;
            },
            createAxe: runtime.createAxe,
            collectConsole: async () => await collectBufferedConsole(page),
            tokens: tuple.tokens ?? { status: "not-configured" },
            screenshotOptions: deterministicScreenshotOptions(tuple.project),
            now: runtime.now,
            explanation: tuple.project.checks.explanation,
            explanationWaitMs: tuple.project.checks.probe.waitMs,
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
              invariants: tuple.invariants,
              shell: tuple.shell,
              floatingOverlays:
                tuple.project.checks.shellVisibility?.floatingOverlays,
              fresh: tuple.state.fresh === true,
              marks: checkMarks(tuple.project.checks),
              emptyState: tuple.project.checks.emptyState,
              bandEdges: tuple.project.checks.bandEdges?.enabled === true,
              wordBreak: tuple.project.checks.wordBreak?.enabled === true,
            },
          });
          return { result, version };
        } finally {
          if (application) await closeApplication(application);
        }
      },
      async close() {
        closed = true;
        options.signal?.removeEventListener("abort", abort);
        await Promise.all([...applications].map(closeApplication));
      },
    };
  };
}
