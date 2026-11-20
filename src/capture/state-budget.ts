/** One state ran out of `capture.stateMaxMinutes`; only its work is aborted. */
export class StateBudgetExpired extends Error {
  constructor(
    readonly state: string,
    readonly limitMinutes: number,
    readonly step: string,
  ) {
    super(
      `state ${state} exceeded capture.stateMaxMinutes=${limitMinutes} during ${step}`,
    );
    this.name = "StateBudgetExpired";
  }
}

type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};
const realTimers: Timers = {
  set: (callback, ms) =>
    setTimeout(callback, Math.max(1, Math.min(2_147_483_647, ms))),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Entry = {
  inFlight: number;
  /** Time already spent with work in flight, before the current span. */
  spent: number;
  /** When the current span began (inFlight > 0). */
  since: number;
  step: string;
  controller: AbortController;
  timer?: unknown;
};

/**
 * Per-state time budgets. A state's clock runs only while some of its work
 * is in flight (the union of its spans across lanes and passes), so time
 * spent queued behind other states is not charged to it. With no limit
 * nothing is ever aborted.
 */
export class StateBudgets {
  private entries = new Map<string, Entry>();
  private readonly limitMs: number | undefined;
  constructor(
    readonly limitMinutes: number | undefined,
    private clock: () => number = () => performance.now(),
    private timers: Timers = realTimers,
  ) {
    this.limitMs =
      limitMinutes === undefined
        ? undefined
        : Math.min(Number.MAX_SAFE_INTEGER, limitMinutes * 60_000);
  }
  get enabled(): boolean {
    return this.limitMs !== undefined;
  }
  private entry(state: string): Entry {
    let entry = this.entries.get(state);
    if (entry === undefined) {
      entry = {
        inFlight: 0,
        spent: 0,
        since: 0,
        step: "capture",
        controller: new AbortController(),
      };
      this.entries.set(state, entry);
    }
    return entry;
  }
  private expire(state: string, entry: Entry) {
    if (entry.controller.signal.aborted || this.limitMinutes === undefined)
      return;
    entry.controller.abort(
      new StateBudgetExpired(state, this.limitMinutes, entry.step),
    );
  }
  /** Start a span of the state's work; the returned function ends it. */
  begin(state: string, step: string): () => void {
    const entry = this.entry(state);
    entry.step = step;
    if (this.limitMs === undefined) return () => undefined;
    if (entry.inFlight === 0) {
      entry.since = this.clock();
      const left = this.limitMs - entry.spent;
      if (left <= 0) this.expire(state, entry);
      else entry.timer = this.timers.set(() => this.expire(state, entry), left);
    }
    entry.inFlight += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      entry.inFlight -= 1;
      if (entry.inFlight > 0) return;
      entry.spent += Math.max(0, this.clock() - entry.since);
      if (entry.timer !== undefined) this.timers.clear(entry.timer);
      entry.timer = undefined;
    };
  }
  /** Name the step a state is in, for the expiry message. */
  step(state: string, step: string): void {
    this.entry(state).step = step;
  }
  /** Aborts when (and only when) this state's budget runs out. */
  signal(state: string): AbortSignal {
    return this.entry(state).controller.signal;
  }
  expired(state: string): StateBudgetExpired | undefined {
    const reason = this.entries.get(state)?.controller.signal.reason;
    return reason instanceof StateBudgetExpired ? reason : undefined;
  }
  /** Milliseconds the state has had work in flight so far. */
  spentMs(state: string): number {
    const entry = this.entries.get(state);
    if (entry === undefined) return 0;
    return (
      entry.spent +
      (entry.inFlight > 0 ? Math.max(0, this.clock() - entry.since) : 0)
    );
  }
  dispose(): void {
    for (const entry of this.entries.values())
      if (entry.timer !== undefined) this.timers.clear(entry.timer);
  }
}
