import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  loadRunRecord,
  type RunRecord,
  runRecordSchema,
} from "../src/capture/run-record.js";
import { skipped } from "../src/capture/timings.js";
import { findLatestCapture, loadCaptureRun } from "../src/review/artifacts.js";

function record(): RunRecord {
  const declared = ["a", "b"].map((state) => ({
    state,
    viewport: "wide",
    colorScheme: "light" as const,
  }));
  return {
    version: 1,
    flow: "flow",
    source: { commit: "commit", dirty: false },
    declared,
    selected: declared,
    viewports: [{ name: "wide", width: 800, height: 600 }],
    probe: {
      policy: "once-per-state",
      fallback: false,
      intended: [],
      executed: [],
    },
    timings: {
      build: skipped(),
      start: skipped(),
      probe: skipped(),
      checks: skipped(),
      tuples: declared.map((tuple) => ({
        ...tuple,
        total: skipped(),
        probe: skipped(),
      })),
    },
  };
}

test.each([
  "version",
  "unsafe-id",
  "duplicate",
  "outside-selection",
  "outside-probe",
  "outside-executed",
  "missing-timing",
  "duplicate-timing",
  "viewport",
  "negative-time",
  "unknown-field",
])("run records strictly reject %s", (kind) => {
  const value = record();
  const firstDeclared = value.declared[0];
  const firstSelected = value.selected[0];
  const firstTiming = value.timings.tuples[0];
  if (!firstDeclared || !firstSelected || !firstTiming)
    throw new Error("missing fixture coordinate");
  if (kind === "version") Object.assign(value, { version: 2 });
  if (kind === "unsafe-id") firstDeclared.state = "../a";
  if (kind === "duplicate") value.declared.push(firstDeclared);
  if (kind === "outside-selection")
    value.selected = [
      { state: "other", viewport: "wide", colorScheme: "light" },
    ];
  if (kind === "outside-probe")
    value.probe.intended = [
      { state: "other", viewport: "wide", colorScheme: "light" },
    ];
  if (kind === "outside-executed") value.probe.executed = [firstSelected];
  if (kind === "missing-timing") value.timings.tuples = [];
  if (kind === "duplicate-timing") value.timings.tuples[1] = firstTiming;
  if (kind === "viewport") value.viewports = [];
  if (kind === "negative-time") value.timings.build.ms = -1;
  if (kind === "unknown-field") Object.assign(value, { unknown: true });
  expect(runRecordSchema.safeParse(value).success).toBe(false);
});

test("latest skips a newer partial run and legacy missing records remain readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-record-"));
  try {
    for (const [date, partial] of [
      ["2026-10-01T00-00-00", false],
      ["2026-10-02T00-00-00", true],
    ] as const) {
      const path = join(directory, ".idiom/reports", date);
      await mkdir(path, { recursive: true });
      const value = record();
      if (partial) {
        value.selected = value.selected.slice(0, 1);
        value.timings.tuples = value.timings.tuples.slice(0, 1);
      }
      await writeFile(join(path, "run.json"), JSON.stringify(value));
      await writeFile(
        join(path, "baseline.md"),
        "Flow `flow`: 1 passed, 0 failed",
      );
      await mkdir(join(path, "a/wide"), { recursive: true });
      await writeFile(
        join(path, "a/wide/metadata.json"),
        JSON.stringify({ source: value.source }),
      );
    }
    expect(
      await findLatestCapture({
        projectDirectory: directory,
        flow: "flow",
        commit: "commit",
      }),
    ).toBe("2026-10-01T00-00-00");
    const path = join(directory, ".idiom/reports/2026-10-02T00-00-00");
    await writeFile(join(path, "run.json"), "{}");
    await expect(
      loadCaptureRun({ runDirectory: path, expectedFlow: "flow" }),
    ).rejects.toThrow(/invalid run.json/);
    await rm(join(path, "run.json"));
    expect(await loadRunRecord(path)).toBeUndefined();
    expect(await readFile(join(path, "baseline.md"), "utf8")).toContain(
      "0 failed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
