import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { withCaptureOwnership } from "../src/capture/ownership.js";
import { RunLifecycle } from "../src/capture/run-lifecycle.js";
import { type RunRecord, runRecordSchema } from "../src/capture/run-record.js";
import { renderSlowTuples, slowTupleSteps } from "../src/capture/timings.js";
import { capturePredicateIdentity } from "../src/findings/settings.js";
import { projectSchema } from "../src/schemas/project.js";
import { toggleFlow, toggleProject } from "./toggle-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const tuple = (state: string) => ({
  state,
  viewport: "desktop",
  colorScheme: "light" as const,
});
function running(selected = [tuple("a"), tuple("b")]): RunRecord {
  return runRecordSchema.parse({
    version: 1,
    status: "running",
    runId: "run",
    owner: { pid: process.pid },
    startedAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    completedTuples: [],
    flow: "home",
    source: { commit: "c".repeat(40), dirty: false },
    declared: selected,
    selected,
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    probe: {
      policy: "once-per-state",
      fallback: false,
      intended: [],
      executed: [],
    },
    timings: {
      build: { status: "skipped", ms: 0 },
      start: { status: "skipped", ms: 0 },
      tuples: selected.map((t) => ({
        ...t,
        total: { status: "unavailable", ms: 0 },
        probe: { status: "unavailable", ms: 0 },
      })),
      probe: { status: "skipped", ms: 0 },
      checks: { status: "skipped", ms: 0 },
    },
  });
}
async function stored(directory: string) {
  return runRecordSchema.parse(
    JSON.parse(await readFile(join(directory, "run.json"), "utf8")),
  );
}

test("only a tuple's last checkpoint makes it final, and completion makes all final", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-lifecycle-"));
  directories.push(directory);
  const record = running();
  const lifecycle = new RunLifecycle(directory, record);
  const noop = async () => undefined;
  await lifecycle.checkpoint(tuple("b"), undefined, noop);
  await lifecycle.checkpoint(tuple("a"), undefined, noop);
  expect(await stored(directory)).toMatchObject({
    completedTuples: [tuple("a"), tuple("b")],
  });
  expect((await stored(directory)).finalTuples).toBeUndefined();
  await lifecycle.checkpoint(
    tuple("b"),
    () => ({
      ...tuple("b"),
      total: { status: "measured", ms: 5 },
      probe: { status: "skipped", ms: 0 },
      steps: { artifacts: 2, secretScan: 1 },
    }),
    noop,
    { final: true },
  );
  const afterFinal = await stored(directory);
  expect(afterFinal.finalTuples).toEqual([tuple("b")]);
  expect(afterFinal.timings.tuples[1]?.steps).toEqual({
    artifacts: 2,
    secretScan: 1,
  });
  // A run-root summary is kept as soon as it is known.
  await lifecycle.writeRunFile("build.json", { kind: "production", id: "b1" });
  expect(
    JSON.parse(await readFile(join(directory, "build.json"), "utf8")),
  ).toEqual({ kind: "production", id: "b1" });
  const complete = await lifecycle.complete(
    { ...record, status: undefined } as RunRecord,
    noop,
  );
  expect(complete.finalTuples).toEqual(record.selected);
  // Sealed: later writes are ignored.
  await lifecycle.writeRunFile("build.json", { kind: "production", id: "b2" });
  expect(
    JSON.parse(await readFile(join(directory, "build.json"), "utf8")).id,
  ).toBe("b1");
});

test("an interrupt with a budget report round-trips through the record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-lifecycle-"));
  directories.push(directory);
  const lifecycle = new RunLifecycle(directory, running());
  const budget = {
    limit: "capture.maxMinutes" as const,
    step: "artifacts",
    activity: "state b, viewport desktop, scheme light, step artifacts",
    slowest: [{ ...tuple("a"), step: "probe", ms: 192_000 }],
  };
  await lifecycle.interrupt(
    { reason: "capture-failed", budget },
    () => undefined,
  );
  expect((await stored(directory)).interruption).toEqual({
    reason: "capture-failed",
    budget,
  });
});

test("a capture.maxMinutes expiry names the running step and the slowest steps so far", async () => {
  let report: unknown;
  const failure = await withCaptureOwnership(
    0.001,
    undefined,
    async (owner) => {
      owner.coordinate(
        {
          state: { id: "b" },
          viewport: { name: "desktop" },
          colorScheme: "light",
        },
        "secret scan",
      );
      owner.recordStep(tuple("a"), "probe", 192_000);
      owner.recordStep(tuple("a"), "probe", 1_000);
      owner.recordStep(tuple("b"), "capture", 61_000);
      owner.recordStep(tuple("a"), "capture", 5_000);
      owner.recordStep(tuple("b"), "secret scan", 1_000);
      await new Promise<void>((resolve) =>
        owner.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      report = owner.budgetReport();
      owner.check();
      return "unreachable";
    },
  ).then(
    () => undefined,
    (error: unknown) => (error as Error).message,
  );
  expect(failure).toBe(
    "Capture exceeded capture.maxMinutes=0.001: state b, viewport desktop, scheme light, step secret scan; slowest steps so far: a/desktop/light probe 3m13s, b/desktop/light capture 1m01s, a/desktop/light capture 5.0s",
  );
  expect(report).toMatchObject({
    limit: "capture.maxMinutes",
    step: "secret scan",
    slowest: [
      { ...tuple("a"), step: "probe", ms: 193_000 },
      { ...tuple("b"), step: "capture", ms: 61_000 },
      { ...tuple("a"), step: "capture", ms: 5_000 },
      { ...tuple("b"), step: "secret scan", ms: 1_000 },
    ],
  });
});

test("slow tuples rank by their summed steps, checks included", () => {
  const timing = (state: string, steps: Record<string, number>) => ({
    ...tuple(state),
    total: { status: "measured" as const, ms: 0 },
    probe: { status: "skipped" as const, ms: 0 },
    steps,
  });
  const slow = slowTupleSteps(
    {
      tuples: [
        timing("a", { capture: 1_000, secretScan: 500 }),
        timing("b", { capture: 3_000, probe: 9_000, artifacts: 200 }),
        timing("c", { capture: 100 }),
      ],
    },
    new Map([["a\0desktop\0light", 4_000]]),
    2,
  );
  expect(slow.map((entry) => [entry.state, entry.ms])).toEqual([
    ["b", 12_200],
    ["a", 5_500],
  ]);
  expect(renderSlowTuples(slow)).toBe(
    [
      "Slowest tuples:",
      "  b/desktop/light 12s (capture 3.0s, probe 9.0s, artifacts 0.2s)",
      "  a/desktop/light 5.5s (capture 1.0s, secret scan 0.5s, checks 4.0s)",
    ].join("\n"),
  );
});

test("capture.stateMaxMinutes is scheduling: it never changes the capture settings identity", async () => {
  const without = await toggleProject();
  const withBudget = projectSchema.parse({
    ...without,
    capture: { ...without.capture, stateMaxMinutes: 2 },
  });
  const flow = toggleFlow();
  expect(withBudget.capture.stateMaxMinutes).toBe(2);
  expect(capturePredicateIdentity(withBudget, flow)).toBe(
    capturePredicateIdentity(without, flow),
  );
});
