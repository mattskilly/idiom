import type { Project } from "../schemas/project.js";
import type { CaptureOwnership } from "./ownership.js";

/**
 * `capture.concurrency`, unless `IDIOM_CAPTURE_CONCURRENCY` is set (a
 * diagnostic for comparing against a sequential run).
 */
export function captureConcurrency(
  project: Pick<Project, "capture">,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(environment.IDIOM_CAPTURE_CONCURRENCY);
  if (
    environment.IDIOM_CAPTURE_CONCURRENCY !== undefined &&
    Number.isInteger(override) &&
    override >= 1
  )
    return Math.min(8, override);
  return project.capture.concurrency ?? 4;
}

type LaneTuple = {
  state: { id: string };
  viewport: { name: string };
  colorScheme: string;
};

/**
 * Capture tuples in lanes: one lane per key (viewport and colour scheme), in
 * order of first appearance, each lane sequential in input order, and up to
 * `concurrency` lanes at once. The lane holding a `first` tuple (the probed
 * one, the longest) starts first. The first failure stops every lane before
 * its next tuple; it is rethrown only after every in-flight tuple settled.
 */
export async function runCaptureLanes<T extends LaneTuple>(options: {
  tuples: readonly T[];
  lane: (tuple: T) => string;
  first?: ((tuple: T) => boolean) | undefined;
  concurrency: number;
  owner?: Pick<CaptureOwnership, "begin"> | undefined;
  work: (tuple: T, index: number) => Promise<void>;
}): Promise<void> {
  const lanes = new Map<string, number[]>();
  for (const [index, tuple] of options.tuples.entries()) {
    const key = options.lane(tuple);
    const lane = lanes.get(key);
    if (lane) lane.push(index);
    else lanes.set(key, [index]);
  }
  const ordered = [...lanes.values()];
  const priority = ordered.findIndex((lane) =>
    lane.some((index) => {
      const tuple = options.tuples[index];
      return tuple !== undefined && options.first?.(tuple) === true;
    }),
  );
  if (priority > 0) ordered.unshift(...ordered.splice(priority, 1));
  let stopped = false;
  let failure: { error: unknown } | undefined;
  let next = 0;
  const worker = async () => {
    while (!stopped && next < ordered.length) {
      const lane = ordered[next] ?? [];
      next += 1;
      for (const index of lane) {
        if (stopped) return;
        const tuple = options.tuples[index];
        if (tuple === undefined) continue;
        const release = options.owner?.begin(tuple);
        try {
          await options.work(tuple, index);
        } catch (error) {
          if (!stopped) failure = { error };
          stopped = true;
          return;
        } finally {
          release?.();
        }
      }
    }
  };
  const workers = Math.max(
    1,
    Math.min(Math.floor(options.concurrency), ordered.length),
  );
  await Promise.allSettled(Array.from({ length: workers }, () => worker()));
  if (failure) throw failure.error;
}
