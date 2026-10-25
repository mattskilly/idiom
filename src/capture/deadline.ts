import type { Page } from "playwright";

export type DeadlineScope = "control" | "state" | "capture";

/** Activity is copied at expiry, so late continuations cannot rewrite diagnostics. */
export class DeadlineExpired extends Error {
  constructor(
    readonly scope: DeadlineScope,
    readonly activity: string,
  ) {
    super(`${scope} timed-out: ${activity}`);
    this.name = "DeadlineExpired";
  }
}

/** Host-side monotonic deadline. Does not depend on the page's event loop. */
export class Deadline {
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private end: number;
  private now: () => number;
  private parent: AbortSignal | undefined;
  readonly signal = this.controller.signal;

  constructor(
    readonly scope: DeadlineScope,
    ms: number,
    private activity: () => string,
    options: { signal?: AbortSignal | undefined; now?: () => number } = {},
  ) {
    if (!Number.isFinite(ms) || ms <= 0)
      throw new Error("deadline duration must be finite and positive");
    this.now = options.now ?? (() => performance.now());
    this.end = this.now() + ms;
    this.parent = options.signal;
    this.parent?.addEventListener("abort", this.onParent, { once: true });
    if (this.parent?.aborted) this.onParent();
    else this.arm();
  }

  private onParent = () => {
    this.controller.abort(this.parent?.reason);
    clearTimeout(this.timer);
  };
  private expire() {
    this.controller.abort(new DeadlineExpired(this.scope, this.activity()));
    clearTimeout(this.timer);
  }
  private arm() {
    // Node converts overflowing timers to 1ms. Re-arm long budgets instead.
    this.timer = setTimeout(
      () => {
        if (this.end <= this.now()) this.expire();
        else this.arm();
      },
      Math.max(1, Math.min(2_147_483_647, this.end - this.now())),
    );
  }
  check() {
    if (this.parent?.aborted) this.onParent();
    if (!this.signal.aborted && this.now() >= this.end) this.expire();
    this.signal.throwIfAborted();
  }
  remaining(limit = Number.MAX_SAFE_INTEGER): number {
    this.check();
    // Playwright interprets zero as unlimited.
    return Math.max(1, Math.min(limit, Math.ceil(this.end - this.now())));
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.signal.removeEventListener("abort", abort);
        reject(this.signal.reason);
      };
      this.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          this.check();
          return work();
        })
        .then(
          (value) => {
            this.check();
            resolve(value);
          },
          (error: unknown) => {
            this.check();
            reject(error);
          },
        )
        .catch(reject)
        .finally(() => this.signal.removeEventListener("abort", abort));
    });
  }

  /** Invalidate retired work even when the enclosing operation completed. */
  dispose() {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onParent);
    this.controller.abort(new Error("operation retired"));
  }
}

/**
 * Bind page/locator operations to an attempt. Checks each async boundary,
 * clips action waits, and forbids a retired continuation from starting work.
 * Values returned by evaluate stay ordinary data. Only Playwright handles
 * and its synchronous locator/input factories are wrapped.
 */
export function deadlinePage(
  page: Page,
  deadline: Deadline,
): { page: Page; dispose(): void } {
  const listeners: Array<{
    target: Page;
    event: string;
    listener: (...args: never[]) => void;
  }> = [];
  const cache = new WeakMap<object, object>();
  const factories = new Set([
    "locator",
    "getByRole",
    "getByText",
    "getByLabel",
    "getByTitle",
    "getByTestId",
    "getByPlaceholder",
    "getByAltText",
    "first",
    "last",
    "nth",
    "filter",
    "or",
    "and",
    "frameLocator",
    "frame",
    "mainFrame",
  ]);
  const timed = new Set([
    "click",
    "dblclick",
    "hover",
    "focus",
    "fill",
    "press",
    "selectOption",
    "check",
    "uncheck",
    "setInputFiles",
    "waitFor",
    "waitForURL",
    "goto",
    "reload",
    "innerText",
    "textContent",
    "getAttribute",
    "inputValue",
    "isVisible",
    "isEnabled",
    "isChecked",
    "screenshot",
  ]);
  const wrap = (target: object): object => {
    const existing = cache.get(target);
    if (existing) return existing;
    const proxy = new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key, object);
        if (["mouse", "keyboard", "touchscreen"].includes(String(key)))
          return wrap(value);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "off" || key === "removeListener")
            return value.apply(object, args);
          deadline.check();
          if (key === "on" || key === "once") {
            listeners.push({
              target: object as Page,
              event: args[0] as string,
              listener: args[1] as (...args: never[]) => void,
            });
            value.apply(object, args);
            return proxy;
          }
          if (key === "waitForTimeout")
            args[0] = Math.min(args[0] as number, deadline.remaining());
          if (
            timed.has(String(key)) &&
            typeof Reflect.get(object, "locator") === "function"
          ) {
            // Locator methods with a value/selector take options last; page
            // screenshot/reload and locator actions with no value take one.
            const index = [
              "goto",
              "fill",
              "press",
              "selectOption",
              "setInputFiles",
              "waitForURL",
              "getAttribute",
            ].includes(String(key))
              ? 1
              : 0;
            const options = (args[index] ?? {}) as { timeout?: number };
            args[index] = {
              ...options,
              timeout: deadline.remaining(
                options.timeout && options.timeout > 0
                  ? options.timeout
                  : 30_000,
              ),
            };
          }
          if (key === "waitForFunction")
            args[2] = {
              ...(args[2] as object),
              timeout: deadline.remaining(30_000),
            };
          const result = value.apply(object, args);
          if (factories.has(String(key)) && result) return wrap(result);
          if (result && typeof result.then === "function")
            return deadline.run(() => result);
          return result;
        };
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  const dispose = () => {
    for (const { target, event, listener } of listeners.splice(0))
      (
        target as unknown as {
          off(event: string, listener: (...args: never[]) => void): void;
        }
      ).off(event, listener);
    deadline.signal.removeEventListener("abort", dispose);
  };
  deadline.signal.addEventListener("abort", dispose, { once: true });
  return { page: wrap(page) as Page, dispose };
}
