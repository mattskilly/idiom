import { cpus, loadavg } from "node:os";

export type HostSample = {
  load: [number, number, number] | null;
  coreCount: number;
};
export type HostRecord = {
  loadStart: HostSample["load"];
  loadEnd: HostSample["load"];
  coreCount: number;
  threshold: number;
  readyStartMs: number | null;
  readyEndMs: number | null;
  pressureReasons: Array<"load" | "ready-url-slowdown">;
};
export function readHost(): HostSample {
  return {
    load:
      process.platform === "win32"
        ? null
        : (loadavg() as [number, number, number]),
    coreCount: Math.max(1, cpus().length),
  };
}
export function pressureReasons(
  host: Omit<HostRecord, "pressureReasons">,
): HostRecord["pressureReasons"] {
  const reasons: HostRecord["pressureReasons"] = [];
  if (
    [host.loadStart, host.loadEnd].some(
      (load) => load !== null && load[0] / host.coreCount > host.threshold,
    )
  )
    reasons.push("load");
  if (
    host.readyStartMs !== null &&
    host.readyEndMs !== null &&
    host.readyEndMs > host.readyStartMs * 10
  )
    reasons.push("ready-url-slowdown");
  return reasons;
}
export async function measureReadyUrl(
  url: string,
  options: {
    signal: AbortSignal;
    fetch?: typeof globalThis.fetch | undefined;
    monotonicNow?: (() => number) | undefined;
  },
): Promise<number | null> {
  const clock = options.monotonicNow ?? (() => performance.now());
  const started = clock();
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(2000)]),
    });
    await response.body?.cancel();
    options.signal.throwIfAborted();
    return response.status === 200
      ? Math.max(Number.EPSILON, clock() - started)
      : null;
  } catch (error) {
    if (options.signal.aborted) throw error;
    return null;
  }
}
