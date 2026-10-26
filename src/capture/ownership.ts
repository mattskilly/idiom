import { IdiomError } from "../errors.js";
import { Deadline, DeadlineExpired } from "./deadline.js";
import type { CaptureActivity } from "./types.js";

export type CaptureLifetime = {
  signal?: AbortSignal | undefined;
  onActivity?: ((activity: CaptureActivity) => void) | undefined;
};

/** Fixed maximum grace after deadline expiry, including all resource teardown. */
const CLEANUP_GRACE_MS = 5000;
export class CaptureOwnership {
  private resources = new Map<object, () => Promise<unknown>>();
  private started = new Map<object, Promise<unknown>>();
  activity: CaptureActivity = {
    state: "pending",
    viewport: "pending",
    colorScheme: "pending",
    step: "initialization",
  };
  controller = new AbortController();
  deadline: Deadline;
  /** Coordinates captured concurrently, named when the deadline expires. */
  private inFlight = new Map<object, string>();
  constructor(
    maxMinutes: number,
    private onActivity?: (activity: CaptureActivity) => void,
  ) {
    this.deadline = new Deadline(
      "capture",
      Math.min(Number.MAX_SAFE_INTEGER, maxMinutes * 60000),
      () => {
        const a = this.activity;
        const current = `state ${a.state}, viewport ${a.viewport}, scheme ${a.colorScheme}, step ${a.step}`;
        return this.inFlight.size > 1
          ? `${current}; in flight: ${[...this.inFlight.values()].join(", ")}`
          : current;
      },
      { signal: this.controller.signal },
    );
  }
  get signal() {
    return this.deadline.signal;
  }
  check = () => this.deadline.check();
  stage = (step: string) => {
    this.check();
    this.activity.step = step;
    this.onActivity?.({ ...this.activity });
  };
  coordinate(
    selected: {
      state: { id: string };
      viewport: { name: string };
      colorScheme: string;
    },
    step: string,
  ) {
    this.check();
    this.activity = {
      state: selected.state.id,
      viewport: selected.viewport.name,
      colorScheme: selected.colorScheme,
      step,
    };
    this.onActivity?.({ ...this.activity });
  }
  /** Mark a coordinate in flight; the returned function ends it. */
  begin(selected: {
    state: { id: string };
    viewport: { name: string };
    colorScheme: string;
  }): () => void {
    const token = {};
    this.inFlight.set(
      token,
      `${selected.state.id}/${selected.viewport.name}/${selected.colorScheme}`,
    );
    return () => {
      this.inFlight.delete(token);
    };
  }
  own<T extends object>(value: T, close: (value: T) => Promise<unknown>): T {
    if (!this.resources.has(value))
      this.resources.set(value, () => close(value));
    if (this.signal.aborted) void this.close(value).catch(() => undefined);
    return value;
  }
  async acquire<T extends object>(
    pending: Promise<T>,
    close: (value: T) => Promise<unknown>,
  ): Promise<T> {
    // A launcher/workspace adapter may resolve after the caller has failed.
    const registered = pending.then((value) => this.own(value, close));
    return this.deadline.run(() => registered);
  }
  close(value: object): Promise<unknown> {
    let pending = this.started.get(value);
    if (!pending) {
      pending = Promise.resolve().then(() => this.resources.get(value)?.());
      this.started.set(value, pending);
      void pending.catch(() => undefined);
    }
    return pending;
  }
  async cleanup() {
    await Promise.all(
      [...this.resources.keys()].map((value) => this.close(value)),
    );
  }
}

export async function withCaptureOwnership<T>(
  maxMinutes: number,
  dependencies: CaptureLifetime | undefined,
  work: (owner: CaptureOwnership) => Promise<T>,
): Promise<T> {
  const owner = new CaptureOwnership(maxMinutes, dependencies?.onActivity);
  const parentAbort = () =>
    owner.controller.abort(dependencies?.signal?.reason);
  dependencies?.signal?.addEventListener("abort", parentAbort, { once: true });
  if (dependencies?.signal?.aborted) parentAbort();
  const sigint = () =>
    owner.controller.abort(new IdiomError("capture interrupted by SIGINT"));
  const sigterm = () =>
    owner.controller.abort(new IdiomError("capture interrupted by SIGTERM"));
  // A stray rejection from abandoned browser work must end this capture
  // through the normal path, so the application server is always stopped.
  const unhandled = (reason: unknown) =>
    owner.controller.abort(
      new IdiomError(
        `capture failed on an unhandled browser error: ${String(reason).split("\n")[0]}`,
      ),
    );
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  process.on("unhandledRejection", unhandled);
  let failure: unknown;
  let result: T | undefined;
  // Start cleanup at expiry, independently of the losing operation's finally.
  const abort = () => {
    void owner.cleanup().catch(() => undefined);
  };
  owner.signal.addEventListener("abort", abort, { once: true });
  try {
    result = await owner.deadline.run(() => work(owner));
  } catch (error) {
    failure =
      error instanceof DeadlineExpired && error.scope === "capture"
        ? new IdiomError(
            `Capture exceeded capture.maxMinutes=${maxMinutes}: ${error.activity}`,
          )
        : error;
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owner.cleanup(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLEANUP_GRACE_MS);
        }),
      ]);
    } catch (error) {
      failure ??= error;
    } finally {
      clearTimeout(timer);
      owner.signal.removeEventListener("abort", abort);
      owner.deadline.dispose();
      dependencies?.signal?.removeEventListener("abort", parentAbort);
      process.off("SIGINT", sigint);
      process.off("SIGTERM", sigterm);
      process.off("unhandledRejection", unhandled);
    }
  }
  if (failure !== undefined) throw failure;
  if (!result) throw new IdiomError("capture ended without a result");
  return result;
}
