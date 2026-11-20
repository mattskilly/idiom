#!/usr/bin/env node
// Synthetic CPU load for measuring Idiom on a busy machine.
//
//   node scripts/measure-load.mjs [--workers N] [--duty 0.0-1.0] [--seconds S]
//
// Spawns N worker threads (default: 2 × available parallelism) that busy-loop
// for `duty` of every 100 ms slice (default 0.9), until killed or S seconds
// pass. Prints its PID, the worker count and the 1-minute load average every
// 10 s. Stops its own workers on SIGINT/SIGTERM; it never touches any other
// process.
import { availableParallelism, loadavg } from "node:os";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

if (!isMainThread) {
  const { duty } = workerData;
  const slice = 100;
  const spin = () => {
    const end = performance.now() + slice * duty;
    let x = 0;
    while (performance.now() < end) x = (x * 1103515245 + 12345) % 2147483648;
    setTimeout(spin, slice * (1 - duty));
    return x;
  };
  spin();
  parentPort?.on("message", (message) => {
    if (message === "stop") process.exit(0);
  });
} else {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : Number(process.argv[index + 1]);
  };
  const workers = Math.max(1, argument("workers", availableParallelism() * 2));
  const duty = Math.min(1, Math.max(0.05, argument("duty", 0.9)));
  const seconds = argument("seconds", 0);
  const threads = Array.from(
    { length: workers },
    () => new Worker(new URL(import.meta.url), { workerData: { duty } }),
  );
  const report = () =>
    console.log(
      `load: pid ${process.pid}, ${workers} workers at duty ${duty}, loadavg(1m) ${loadavg()[0].toFixed(2)} on ${availableParallelism()} cores`,
    );
  report();
  const timer = setInterval(report, 10_000);
  const stop = async () => {
    clearInterval(timer);
    await Promise.all(threads.map((thread) => thread.terminate()));
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (seconds > 0) setTimeout(stop, seconds * 1000);
}
