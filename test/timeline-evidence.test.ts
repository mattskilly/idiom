import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { summarizeFinding } from "../src/baseline/summary.js";
import { TIMELINE_LIMITS } from "../src/capture/timeline.js";
import type {
  ActionTimelineArtifact,
  CheckTuple,
  FindingCandidate,
} from "../src/checks/types.js";
import { EvidenceStore } from "../src/mcp/evidence.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { findingSchema } from "../src/schemas/finding.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const timelines: ActionTimelineArtifact = {
  version: 1,
  status: "ran",
  limits: { ...TIMELINE_LIMITS },
  truncated: { actions: 0 },
  actions: [
    {
      id: "probe-1",
      source: "probe-click",
      kind: "click",
      selector: "#go",
      name: "Go",
      url: "/",
      startedAt: 1,
      durationMs: 200,
      settled: true,
      status: "ran",
      truncated: [],
      shifts: [],
      frames: [],
      mutations: [],
      animations: [],
      requests: [],
      viewTransition: { used: false },
      effectRegion: { control: "#go", controls: [] },
    },
  ],
};

function tuple(withTimelines: boolean): CheckTuple {
  return {
    flow: "flow",
    state: "s",
    viewport: "desktop",
    width: 800,
    height: 600,
    metadataPath: "s/desktop/metadata.json",
    artifactPaths: [
      "s/desktop/metadata.json",
      ...(withTimelines ? ["s/desktop/timelines.json"] : []),
    ],
    commit: "fixture",
    createdAt: "2026-10-26T00:00:00.000Z",
    console: [],
    mismatches: [],
    ...(withTimelines ? { timelines } : {}),
  };
}

const candidate: FindingCandidate = {
  category: "motion",
  severity: "major",
  rule: "test-timeline",
  selectorHint: "#go",
  explanation: "Content moved after the click.",
  acceptance: ["Nothing moves."],
  verification: { check: "motion", params: { selector: "#go" } },
  timeline: "probe-1",
};

function draft(withTimelines: boolean, timeline = "probe-1") {
  const [built] = buildDeterministicDrafts({
    runId: "run",
    entries: [
      {
        tuple: tuple(withTimelines),
        candidate: { ...candidate, timeline },
        checkOrder: 0,
      },
    ],
  });
  if (!built) throw new Error("no draft");
  return built.finding;
}

test("a finding references its action timeline only when the tuple stored it", () => {
  const finding = draft(true);
  expect(finding.evidence.timeline).toEqual({
    artifact: "s/desktop/timelines.json",
    id: "probe-1",
  });
  expect(findingSchema.parse(finding)).toEqual(finding);
  expect(draft(false).evidence.timeline).toBeUndefined();
  expect(draft(true, "probe-9").evidence.timeline).toBeUndefined();
  expect(summarizeFinding(finding, { runDirectory: "/runs/r" }, "/")).toEqual(
    expect.objectContaining({
      timeline: { id: "probe-1", path: "runs/r/s/desktop/timelines.json" },
    }),
  );
});

test("idiom_issue resolves the referenced timeline, or asks for a recapture", async () => {
  const root = await mkdtemp(join(tmpdir(), "idiom-timeline-evidence-"));
  directories.push(root);
  const run = join(root, "idiom-quick-reports", "q1");
  await mkdir(join(run, "s/desktop"), { recursive: true });
  const finding = { ...draft(true), id: "f1" };
  await writeFile(join(run, "findings.json"), JSON.stringify([finding]));
  await writeFile(join(run, "mcp-detail.json"), JSON.stringify({ issues: [] }));
  await writeFile(
    join(run, "s/desktop/timelines.json"),
    JSON.stringify(timelines),
  );
  const store = new EvidenceStore(root);
  const detail = (await store.issue("quick:q1:f1")).structuredContent as {
    timeline: { id: string; path: string; status: string; record?: unknown };
  };
  expect(detail.timeline).toMatchObject({
    id: "probe-1",
    path: join(run, "s/desktop/timelines.json"),
    status: "available",
    record: { id: "probe-1", effectRegion: { control: "#go" } },
  });
  await rm(join(run, "s/desktop/timelines.json"));
  const missing = (await new EvidenceStore(root).issue("quick:q1:f1"))
    .structuredContent as { timeline: { status: string; record?: unknown } };
  expect(missing.timeline.status).toBe("unavailable: recapture");
  expect(missing.timeline.record).toBeUndefined();
});
