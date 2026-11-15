import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  type ConsoleMessage,
  errors,
  type Page,
  type Request,
  type Response,
} from "playwright";
import { targetVisibility } from "../checks/visibility-dom.js";
import {
  holdsPointer,
  isReadinessStep,
  projectLogPathSchema,
  type ReachedFrom,
  stateChainLabel,
  type WebHealth,
  type WebHealthAllow,
  type WebStep,
} from "../schemas/flow.js";
import type { ExplanationCollector } from "./explanations.js";
import type { MotionCollector } from "./motion.js";
import type { ProgressCollector } from "./progress.js";
import { type CapturedScreenshot, captureScreenshot } from "./screenshot.js";
import type { TimelineCollector } from "./timeline.js";
import {
  navigate,
  TupleTimeoutError,
  withTimeoutDiagnostic,
} from "./timeouts.js";
import type { AttemptTimeouts, ConsoleRecord } from "./types.js";

export type ResolvedWebHealth = {
  allow: WebHealthAllow;
  serverLog?: string | undefined;
  serverErrorPatterns?: string[] | undefined;
};

export function resolveWebHealth(
  projectDirectory: string,
  flow: WebHealth,
  state: { allow: WebHealthAllow },
): ResolvedWebHealth {
  let serverLog: string | undefined;
  if (flow.serverLog !== undefined) {
    const path = projectLogPathSchema.parse(flow.serverLog);
    serverLog = resolve(projectDirectory, path.replaceAll("\\", "/"));
    const within = relative(resolve(projectDirectory), serverLog);
    if (within === ".." || within.startsWith("../") || isAbsolute(within)) {
      throw new Error("serverLog must remain inside the project");
    }
  }
  return {
    allow: {
      urls: [...flow.allow.urls, ...state.allow.urls],
      console: [...flow.allow.console, ...state.allow.console],
    },
    serverLog,
    serverErrorPatterns: flow.serverErrorPatterns,
  };
}

export function consoleIsAllowed(
  record: ConsoleRecord,
  health: ResolvedWebHealth,
): boolean {
  return (
    health.allow.console.some((source) =>
      new RegExp(source).test(record.text),
    ) ||
    (record.location !== undefined &&
      health.allow.urls.some((source) =>
        new RegExp(source).test(record.location?.url ?? ""),
      ))
  );
}

/** The collector recognizes this error without losing the original navigation status. */
export class WebStepFailure extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly screenshot: Buffer | undefined,
    readonly cause?: unknown,
    readonly screenshotGeometry?: CapturedScreenshot["geometry"] | undefined,
  ) {
    super(message, { cause });
  }
}

type Owner = {
  index: number;
  action: WebStep["action"];
  /** `of "<state>" reaching <chain>` for steps of a state declared with `from`. */
  label?: string;
};

/** Which state a reached tuple belongs to, for naming failed chained steps. */
export type ReachContext = {
  state: string;
  reachedFrom?: ReachedFrom | undefined;
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A continuous byte cursor; each read opens/closes its handle, including on errors. */
class ServerLogCursor {
  private identity: string | undefined;
  private offset = 0;
  private decoder = new StringDecoder("utf8");
  private fragment = "";
  private exists = false;

  constructor(
    private path: string,
    private patterns: RegExp[],
  ) {}

  async read(snapshot = false): Promise<{ activity: boolean; error?: string }> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("not a regular file");
      const identity = `${stat.dev}:${stat.ino}`;
      this.exists = true;
      if (snapshot) {
        this.identity = identity;
        this.offset = stat.size;
        return { activity: false };
      }
      if (identity !== this.identity || stat.size < this.offset) {
        this.identity = identity;
        this.offset = 0;
        this.decoder = new StringDecoder("utf8");
        this.fragment = "";
      }
      const size = stat.size - this.offset;
      if (size === 0) return { activity: false };
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
      this.offset += bytesRead;
      this.fragment += this.decoder.write(buffer.subarray(0, bytesRead));
      const lines = this.fragment.split(/\r?\n/);
      this.fragment = lines.pop() ?? "";
      // Keep incomplete lines until the next read: chunk boundaries must not
      // turn a prefix such as "ERROR" in "ERRORS=0" into a whole-word match.
      const error = lines.find((line) =>
        this.patterns.some((pattern) => pattern.test(line)),
      );
      return {
        activity: bytesRead > 0,
        ...(error === undefined ? {} : { error }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.exists = false;
        return { activity: false };
      }
      throw new Error(`server log ${this.path}: ${messageOf(error)}`);
    } finally {
      await handle?.close();
    }
  }

  unfinishedError(): string | undefined {
    return this.patterns.some((pattern) => pattern.test(this.fragment))
      ? this.fragment
      : undefined;
  }

  assertExists() {
    if (!this.exists) throw new Error(`server log ${this.path} is missing`);
  }
}

export interface StepHealthGuard {
  checkpoint(): Promise<void>;
  finish(): Promise<void>;
  dispose(): Promise<void>;
}

/** Installed before navigation; owns events only once the first declared action begins. */
export class WebStepRunner implements StepHealthGuard {
  private owner: Owner | undefined;
  private motionWindow:
    | Awaited<ReturnType<MotionCollector["start"]>>
    | undefined;
  private requests = new Map<Request, Owner>();
  private pending = new Set<Request>();
  private diagnostic:
    | { owner: Owner; message: string; cause?: unknown }
    | undefined;
  private failureScreenshot: Promise<Buffer | undefined> | undefined;
  private failureGeometry: CapturedScreenshot["geometry"] | undefined;
  private lastActivity = performance.now();
  private log: ServerLogCursor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: Promise<void> | undefined;
  private disposed = false;
  private status: number | null = null;
  private responseUrl: string | undefined;
  private logReads: Promise<void> = Promise.resolve();
  private signalFailure!: () => void;
  private failureSignal = new Promise<void>((accept) => {
    this.signalFailure = accept;
  });
  private urls: RegExp[];
  private pointerHeld = false;

  constructor(
    private page: Page,
    private health: ResolvedWebHealth,
    private screenshotOptions: Parameters<Page["screenshot"]>[0],
    private motion?: MotionCollector,
    private progress?: ProgressCollector,
    private explanations?: ExplanationCollector,
    private onActivity?: ((step: string) => void) | undefined,
    private signal?: AbortSignal | undefined,
    private timelines?: TimelineCollector | undefined,
    private timeouts: AttemptTimeouts = {
      navigation: 30000,
      readiness: 10000,
      quiet: 5000,
    },
    private maxFullPageHeight = 16000,
  ) {
    this.urls = health.allow.urls.map((source) => new RegExp(source));
    if (health.serverLog !== undefined) {
      this.log = new ServerLogCursor(
        health.serverLog,
        health.serverErrorPatterns?.map((source) => new RegExp(source)) ?? [
          /\b(?:ERROR|FATAL)\b/i,
          /uncaught[\s_-]*(?:exception|error)/i,
        ],
      );
    }
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfinished", this.onFinished);
    page.on("requestfailed", this.onFinished);
    page.on("console", this.onConsole);
    page.on("pageerror", this.onPageError);
  }

  private activity = () => {
    this.lastActivity = performance.now();
  };
  private allowedUrl = (url: string) =>
    this.urls.some((pattern) => pattern.test(url));
  private fail(message: string, owner = this.owner, cause?: unknown) {
    if (owner !== undefined && this.diagnostic === undefined) {
      this.diagnostic = { owner, message, cause };
      this.failureScreenshot = this.captureFailure();
      this.signalFailure();
    }
  }
  private async captureFailure(): Promise<Buffer | undefined> {
    try {
      await this.motionWindow?.finish("step failed; screenshot follows");
      const shot = await captureScreenshot(this.page, this.screenshotOptions, {
        maxFullPageHeight: this.maxFullPageHeight,
      });
      this.failureGeometry = shot.geometry;
      return shot.buffer;
    } catch {
      return undefined;
    }
  }
  private onRequest = (request: Request) => {
    if (this.owner === undefined || this.allowedUrl(request.url())) return;
    this.requests.set(request, this.owner);
    this.pending.add(request);
    this.activity();
  };
  private onResponse = (response: Response) => {
    const owner = this.requests.get(response.request());
    if (owner === undefined) return;
    this.activity();
    if (response.status() >= 400 && !this.allowedUrl(response.url())) {
      this.fail(`HTTP ${response.status()} ${response.url()}`, owner);
    }
  };
  private onFinished = (request: Request) => {
    if (this.pending.delete(request)) this.activity();
    this.requests.delete(request);
  };
  private onConsole = (message: ConsoleMessage) => {
    if (this.owner === undefined) return;
    this.activity();
    const record = {
      type: message.type(),
      text: message.text(),
      location: message.location(),
    };
    if (record.type === "error" && !consoleIsAllowed(record, this.health)) {
      this.fail(`console.error: ${record.text} (${record.location.url})`);
    }
  };
  private onPageError = (error: Error) => {
    if (this.owner === undefined) return;
    this.activity();
    if (
      !consoleIsAllowed({ type: "pageerror", text: error.message }, this.health)
    ) {
      this.fail(`uncaught page error: ${error.message}`);
    }
  };

  private readLog(snapshot = false): Promise<void> {
    const read = this.logReads.then(() => this.readLogOnce(snapshot));
    this.logReads = read;
    return read;
  }
  private async readLogOnce(snapshot: boolean) {
    try {
      const result = await this.log?.read(snapshot);
      if (result?.activity) this.activity();
      if (result?.error !== undefined) this.fail(`server log: ${result.error}`);
    } catch (error) {
      this.fail(messageOf(error));
    }
  }
  private schedulePoll() {
    if (this.disposed || this.log === undefined) return;
    this.timer = setTimeout(() => {
      this.poll = this.readLog().finally(() => {
        this.poll = undefined;
        this.schedulePoll();
      });
    }, 50);
  }
  private async tail() {
    await this.poll;
    await this.readLog();
  }

  async checkpoint(): Promise<void> {
    this.signal?.throwIfAborted();
    if (this.owner !== undefined) await this.tail();
    const diagnostic = this.diagnostic;
    if (diagnostic === undefined) return;
    const screenshot = await this.failureScreenshot;
    throw new WebStepFailure(
      `Step ${diagnostic.owner.index} (${diagnostic.owner.action})${diagnostic.owner.label === undefined ? "" : ` ${diagnostic.owner.label}`}: ${diagnostic.message}`,
      this.status,
      screenshot,
      diagnostic.cause,
      this.failureGeometry,
    );
  }

  private async drain() {
    const deadline = performance.now() + this.timeouts.quiet;
    while (true) {
      await this.checkpoint();
      const now = performance.now();
      if (this.pending.size === 0 && now - this.lastActivity >= 250) break;
      if (now >= deadline) {
        this.fail(
          `step-health timeout after ${this.timeouts.quiet} ms; pending URLs: ${[...this.pending].map((request) => request.url()).join(", ") || "none (persistent activity)"}`,
          this.owner,
          new TupleTimeoutError(
            { kind: "readiness", timeoutMs: this.timeouts.quiet },
            new errors.TimeoutError("readiness drain expired"),
          ),
        );
        await this.checkpoint();
      }
      await new Promise((accept) => setTimeout(accept, 25));
    }
    try {
      this.log?.assertExists();
    } catch (error) {
      this.fail(messageOf(error));
    }
    await this.checkpoint();
  }

  async reach(
    url: string,
    steps: WebStep[],
    context?: ReachContext,
  ): Promise<number | null> {
    this.signal?.throwIfAborted();
    this.onActivity?.("navigation");
    const response = await navigate(
      this.page,
      url,
      this.timeouts.navigation,
      "domcontentloaded",
    );
    this.status = response?.status() ?? null;
    this.responseUrl = response?.url();
    await this.motion?.initialize();
    const reachedFrom = context?.reachedFrom;
    for (const [index, step] of steps.entries()) {
      this.signal?.throwIfAborted();
      this.onActivity?.(
        `web step ${index + 1} ${step.action}${"selector" in step ? ` ${step.selector}` : ""}`,
      );
      await this.checkpoint();
      this.owner = {
        index: index + 1,
        action: step.action,
        ...(context === undefined || reachedFrom === undefined
          ? {}
          : {
              label: `of ${JSON.stringify(reachedFrom.stepStates[index] ?? context.state)} reaching ${stateChainLabel({ id: context.state, reachedFrom })}`,
            }),
      };
      if (index === 0) {
        // The load timeline ends where the user's first action begins.
        await this.timelines?.finishLoad();
        await this.readLog(true);
        this.schedulePoll();
      }
      this.activity();
      await this.checkpoint();
      const mutation = [
        "click",
        "dblclick",
        "drag",
        "fill",
        "press",
        "select",
      ].includes(step.action);
      const recording = await this.timelines?.start({
        source: "web-step",
        kind: step.action,
        ...("selector" in step ? { selector: step.selector } : {}),
        name: step.action,
        stepIndex: index + 1,
      });
      const window =
        mutation && "selector" in step
          ? await this.motion?.start(
              {
                source: "web-step",
                selector: step.selector,
                name: step.action,
                stepIndex: index + 1,
              },
              recording?.key,
            )
          : undefined;
      const explanationWindow = mutation
        ? await this.explanations?.start()
        : undefined;
      this.motionWindow = window;
      const watch =
        "longRunning" in step && step.longRunning
          ? await this.progress?.start(
              {
                stepIndex: index + 1,
                action: step.action,
                selector: step.selector,
              },
              { waitForAction: true },
            )
          : undefined;
      const started = performance.now();
      let failed = false;
      // Set before the drag runs: a failure signalled mid-drag still lifts
      // the pointer through releasePointer, and an extra mouse-up is harmless.
      if (holdsPointer(step)) this.pointerHeld = true;
      try {
        const action = runAction(
          this.page,
          step,
          this.timeouts.readiness,
        ).catch((error) => {
          this.fail(messageOf(error), this.owner, error);
        });
        await Promise.race([action, this.failureSignal]);
        // Actionability/assertion waits cannot count toward post-action quiet.
        this.activity();
        await this.checkpoint();
        await this.drain();
        await watch?.markSettled();
        if (window)
          await this.page.waitForTimeout(
            Math.max(0, 350 - (performance.now() - started)),
          );
        await watch?.finish();
        await recording?.finish();
        await window?.finish();
        await recording?.finishVisual(this.motion?.evidence());
        await this.checkpoint();
      } catch (error) {
        await watch?.finish({
          reason: "step failed; progress evidence unavailable",
        });
        failed = true;
        throw error;
      } finally {
        await window?.finish(
          failed
            ? "step failed; negative motion evidence unavailable"
            : undefined,
        );
        await window?.dispose();
        await recording?.finish("step failed", false);
        await recording?.dispose();
        await watch?.dispose();
        await explanationWindow?.finish(failed ? "step failed" : undefined);
        await explanationWindow?.dispose();
        this.motionWindow = undefined;
      }
    }
    return this.status;
  }

  /** Final URL of the last navigation's document response, after redirects. */
  get documentUrl(): string | undefined {
    return this.responseUrl;
  }

  async finish() {
    await this.drain();
    const line = this.log?.unfinishedError();
    if (line !== undefined) this.fail(`server log: ${line}`);
    await this.checkpoint();
  }

  /** True while a held drag keeps the pointer down. */
  get holdingPointer(): boolean {
    return this.pointerHeld;
  }

  /** Lift a held drag's pointer; a no-op when nothing is held. */
  async releasePointer(): Promise<void> {
    if (!this.pointerHeld) return;
    this.pointerHeld = false;
    await this.page.mouse.up().catch(() => undefined);
  }

  async dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    await this.poll;
    await this.logReads;
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("requestfinished", this.onFinished);
    this.page.off("requestfailed", this.onFinished);
    this.page.off("console", this.onConsole);
    this.page.off("pageerror", this.onPageError);
    this.requests.clear();
    this.pending.clear();
    // After the listeners: the release is not part of any step's health.
    await this.releasePointer();
  }
}

export async function runAction(
  page: Page,
  step: WebStep,
  readinessTimeout = 10000,
) {
  const readiness = isReadinessStep(step);
  const timeout = readiness ? readinessTimeout : 10000;
  if (!readiness) return runActionWithTimeout(page, step, timeout);
  return withTimeoutDiagnostic("readiness", timeout, () =>
    runActionWithTimeout(page, step, timeout),
  );
}
/** A press step's key with its `modifiers` joined on: `Shift+ArrowUp`. */
export function pressKey(step: Extract<WebStep, { action: "press" }>): string {
  return [...(step.modifiers ?? []), step.key].join("+");
}

/**
 * Pointer down on the source's centre, move to the target's centre (or by
 * the offset) in fixed steps, and lift unless the step holds. A failure
 * after the button went down always lifts it again.
 */
async function runDrag(
  page: Page,
  step: Extract<WebStep, { action: "drag" }>,
  timeout: number,
): Promise<void> {
  const source = page.locator(step.selector).first();
  await source.scrollIntoViewIfNeeded({ timeout });
  const box = await source.boundingBox({ timeout });
  if (box === null) throw new Error(`drag source has no box: ${step.selector}`);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  try {
    let to: { x: number; y: number };
    if (step.offset !== undefined) {
      to = { x: from.x + step.offset.x, y: from.y + step.offset.y };
    } else {
      const target = page.locator(step.target as string).first();
      await target.waitFor({ state: "visible", timeout });
      const targetBox = await target.boundingBox({ timeout });
      if (targetBox === null)
        throw new Error(`drag target has no box: ${step.target}`);
      to = {
        x: targetBox.x + targetBox.width / 2,
        y: targetBox.y + targetBox.height / 2,
      };
    }
    await page.mouse.move(to.x, to.y, { steps: 10 });
    if (step.hold !== true) await page.mouse.up();
  } catch (error) {
    await page.mouse.up().catch(() => undefined);
    throw error;
  }
}

async function runActionWithTimeout(
  page: Page,
  step: WebStep,
  timeout: number,
) {
  switch (step.action) {
    case "click":
      return page.locator(step.selector).click({
        timeout,
        ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
      });
    case "dblclick":
      return page.locator(step.selector).dblclick({
        timeout,
        ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
      });
    case "hover":
      return page.locator(step.selector).hover({ timeout });
    case "drag":
      return runDrag(page, step, timeout);
    case "fill":
      return page.locator(step.selector).fill(step.value, { timeout });
    case "press": {
      const locator = page.locator(step.selector);
      const key = pressKey(step);
      for (let index = 0; index < (step.count ?? 1); index += 1)
        await locator.press(key, { timeout });
      return;
    }
    case "focus":
      return page.locator(step.selector).focus({ timeout });
    case "select":
      return page
        .locator(step.selector)
        .selectOption(
          step.value !== undefined
            ? { value: step.value }
            : { label: step.label as string },
          { timeout },
        );
    case "waitFor":
      return page
        .locator(step.selector)
        .waitFor({ state: step.state, timeout });
    case "expectUrl":
      return page.waitForURL(
        (url) =>
          step.path !== undefined
            ? url.pathname === step.path
            : new RegExp(step.pattern as string).test(url.href),
        { timeout },
      );
    case "expectVisible": {
      const deadline = performance.now() + timeout;
      let result: Awaited<ReturnType<typeof targetVisibility>>;
      do {
        try {
          result = await targetVisibility(page, step.selector, step.within);
        } catch (error) {
          if (
            page.isClosed() ||
            !/Execution context was destroyed|Cannot find context with specified id/.test(
              messageOf(error),
            )
          )
            throw error;
          result = {
            visible: false,
            reason: "document navigated during visibility measurement",
          };
        }
        if (result.visible) return;
        await page.waitForTimeout(50);
      } while (performance.now() < deadline);
      throw new errors.TimeoutError(
        `target not visible: ${step.selector}; ${result.reason ?? "no visible intersection"} (${result.boundary ?? step.within ?? "viewport"})`,
      );
    }
    case "expectText": {
      // innerText excludes hidden descendants, but does not pierce shadow roots.
      // Search each rendered element in the document and its open shadow trees.
      const match = await page.waitForFunction(
        (text) => {
          const roots: (Document | ShadowRoot)[] = [document];
          for (const root of roots) {
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot !== null) roots.push(element.shadowRoot);
              if (
                element instanceof HTMLElement &&
                element.getClientRects().length > 0 &&
                getComputedStyle(element).visibility === "visible" &&
                element.innerText.includes(text)
              )
                return true;
            }
            // A shadow root can render a message directly, without an element.
            if (
              root instanceof ShadowRoot &&
              getComputedStyle(root.host).visibility === "visible"
            ) {
              for (const node of root.childNodes) {
                if (
                  node.nodeType !== Node.TEXT_NODE ||
                  !node.textContent?.includes(text)
                )
                  continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                if (
                  [...range.getClientRects()].some(
                    (rect) => rect.width > 0 && rect.height > 0,
                  )
                )
                  return true;
              }
            }
          }
          return false;
        },
        step.text,
        { timeout },
      );
      await match.dispose();
      return;
    }
  }
}
