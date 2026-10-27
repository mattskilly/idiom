import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import { evidencePath } from "../src/artifact-path.js";
import { summarizeFinding } from "../src/baseline/summary.js";
import {
  decodeFrame,
  FilmstripBudget,
  FilmstripCapture,
  filmstripRegion,
} from "../src/capture/filmstrips.js";
import { TIMELINE_LIMITS, withTimelineIds } from "../src/capture/timeline.js";
import {
  FILMSTRIP_LIMITS,
  type FilmstripAction,
  filmstripConfigSchema,
  filmstripManifestSchema,
} from "../src/checks/filmstrip-schema.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import {
  actionIdentity,
  linkRecording,
  recordingKey,
  sameAction,
  temporalAction,
} from "../src/checks/temporal-evidence.js";
import type {
  ActionTimeline,
  CheckTuple,
  FindingCandidate,
} from "../src/checks/types.js";
import { EvidenceStore } from "../src/mcp/evidence.js";
import { composeFilmstrip, subjectRects } from "../src/review/filmstrips.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { findingSchema } from "../src/schemas/finding.js";
import {
  createAttachmentManifest,
  validateAttachmentManifest,
} from "../src/verify/attachments.js";
import {
  verificationFilmstripRequests,
  verificationFilmstrips,
} from "../src/verify/filmstrips.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function root() {
  const d = await mkdtemp(join(tmpdir(), "idiom-films-"));
  directories.push(d);
  return d;
}
const rect = (x: number, y = 10) => ({ x, y, width: 20, height: 20 });
function action(extra: Partial<ActionTimeline> = {}): ActionTimeline {
  return {
    id: "probe-1",
    source: "probe-click",
    kind: "click",
    selector: "#go",
    name: "Go",
    url: "/",
    startedAt: 1000,
    clockOrigin: 1000,
    durationMs: 100,
    settled: true,
    status: "ran",
    truncated: [],
    requests: [],
    shifts: [],
    mutations: [],
    animations: [],
    viewTransition: { used: false },
    effectRegion: { controls: [] },
    frames: [
      {
        time: 0,
        scroll: { x: 0, y: 0 },
        scrollers: [],
        elements: [
          { selector: "#panel", rect: rect(10), offset: { x: 0, y: 0 } },
        ],
      },
      {
        time: 100,
        scroll: { x: 0, y: 0 },
        scrollers: [],
        elements: [
          { selector: "#panel", rect: rect(70), offset: { x: 0, y: 0 } },
        ],
      },
    ],
    ...extra,
  };
}
function tuple(actions = [action()]): CheckTuple {
  return {
    flow: "f",
    state: "s",
    viewport: "v",
    width: 100,
    height: 60,
    metadataPath: "s/v/metadata.json",
    artifactPaths: ["s/v/timelines.json"],
    commit: "abc",
    createdAt: "2026-10-27T00:00:00.000Z",
    console: [],
    mismatches: [],
    timelines: {
      version: 1,
      status: "ran",
      limits: { ...TIMELINE_LIMITS },
      truncated: { actions: 0 },
      actions,
    },
  };
}
function visual(): FilmstripAction {
  return {
    id: "probe-1",
    identity: actionIdentity(action()),
    status: "complete",
    anchor: 1000,
    timelineOrigin: 1000,
    settleMs: 100,
    settled: true,
    region: { x: 0, y: 0, width: 100, height: 60 },
    frames: [0, 100, "settle"].map((slot) => ({
      slot: slot as number | "settle",
      requestedMs: slot === 0 ? 0 : 100,
      actualMs: slot === 0 ? 0 : 100,
      timestamp: slot === 0 ? 1000 : 1100,
      path: `filmstrips/probe-1/${slot}.png`,
      geometry: {
        width: 100,
        height: 60,
        scrollX: 0,
        scrollY: 0,
        scale: 1,
        pageScale: 1,
      },
    })),
  };
}
function finding(t = tuple()) {
  const candidate: FindingCandidate = {
    category: "motion",
    rule: "idiom:motion-no-transition",
    severity: "minor",
    selectorHint: "#panel",
    explanation: "Panel snaps",
    acceptance: ["Animate panel"],
    verification: { check: "motion", params: { surface: "#panel" } },
    timeline: "probe-1",
  };
  const built = buildDeterministicDrafts({
    runId: "r",
    entries: [{ tuple: t, candidate, checkOrder: 0 }],
  })[0];
  if (!built) throw Error("no finding");
  return { ...built.finding, id: "f1" };
}
async function pixels(directory: string, film = visual()) {
  for (const f of film.frames) {
    const p = new PNG({ width: 100, height: 60 });
    p.data.fill(255);
    const x = f.slot === 0 ? 10 : 70;
    for (let y = 10; y < 30; y++)
      for (let xx = x; xx < x + 20; xx++) {
        const i = (y * 100 + xx) * 4;
        p.data[i] = 0;
        p.data[i + 1] = 0;
      }
    const path = join(directory, "s/v", f.path as string);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, PNG.sync.write(p));
  }
}

test("configuration defaults and bounds reject unusable offset schedules", () => {
  expect(filmstripConfigSchema.parse({})).toEqual({
    enabled: true,
    offsetsMs: [0, 50, 100, 200, 400, 800],
    actions: [],
  });
  for (const offsetsMs of [
    [],
    [50],
    [0, 0],
    [0, 100, 50],
    [0, 0.5],
    [0, Infinity],
    [0, 5001],
    Array.from({ length: 17 }, (_, i) => i),
  ])
    expect(filmstripConfigSchema.safeParse({ offsetsMs }).success).toBe(false);
  expect(filmstripConfigSchema.safeParse({ actions: [""] }).success).toBe(
    false,
  );
  expect(
    filmstripConfigSchema.parse({
      enabled: false,
      offsetsMs: [0, 5000],
      actions: ["load", "#go"],
    }).enabled,
  ).toBe(false);
});
test("recording keys survive ordering and spread but never enter serialized evidence", () => {
  const a = linkRecording(action(), "a");
  const b = linkRecording(
    action({ source: "probe-hover", kind: "hover" }),
    "b",
  );
  const ids = withTimelineIds(tuple([b, a]).timelines)?.actions;
  expect(ids?.map((a) => a.id)).toEqual(["probe-1", "hover-1"]);
  expect(ids?.map((a) => recordingKey(a))).toEqual(["a", "b"]);
  expect(JSON.stringify(ids)).not.toContain('"a"');
});
test("generic action-linked rules resolve exact actions and ambiguous legacy motion stays unavailable", () => {
  const a = linkRecording(action(), "a");
  const b = linkRecording(action({ id: "probe-2" }), "b");
  const t = tuple([a, b]);
  expect(
    temporalAction(t, {
      category: "future-rule",
      timeline: "probe-2",
      verification: {},
    }),
  ).toBe(b);
  expect(
    temporalAction(
      t,
      linkRecording({ category: "motion", verification: {} }, "a"),
    ),
  ).toBe(a);
  expect(
    temporalAction(t, {
      category: "motion",
      verification: {
        params: { source: "probe-click", action: "Go", actionSelector: "#go" },
      },
    }),
  ).toBeUndefined();
  expect(sameAction(actionIdentity(a), actionIdentity(b))).toBe(true);
  expect(
    sameAction(
      actionIdentity(a),
      actionIdentity(action({ source: "probe-hover", kind: "hover" })),
    ),
  ).toBe(false);
});
test("fixed crop unions prior and current viewport rectangles with context", () => {
  expect(filmstripRegion(action(), 100, 60)).toEqual({
    x: 0,
    y: 0,
    width: 100,
    height: 54,
  });
  expect(filmstripRegion(action({ frames: [] }), 100, 60)).toEqual({
    x: 0,
    y: 0,
    width: 100,
    height: 60,
  });
});
test("outlines follow each recorded position and do not use the final box at zero", () => {
  expect(subjectRects(action(), visual(), 0, "#panel")).toEqual([rect(10)]);
  expect(subjectRects(action(), visual(), 100, "#panel")).toEqual([rect(70)]);
});
test("bounded sheets preserve every column and outline the moving subject in the right cells", async () => {
  const directory = await root();
  await pixels(directory);
  const t = tuple();
  const f = visual();
  const evidence = await composeFilmstrip({
    runDirectory: directory,
    tuple: t,
    action: f,
    timeline: action(),
    selector: "#panel",
    path: "s/v/crops/sheet.png",
  });
  expect(evidence).toMatchObject({
    status: "complete",
    limits: { width: 4096, height: 1536, bytes: 4194304 },
  });
  const png = decodeFrame(
    await readFile(join(directory, evidence.sheet as string)),
  );
  expect(png.width).toBe(360);
  expect(png.height).toBe(96);
  const red = (x: number, y: number) => [
    ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3),
  ];
  expect(red(12, 46)).toEqual([235, 45, 55]);
  expect(red(192, 46)).toEqual([235, 45, 55]);
  expect(red(132, 46)).not.toEqual([235, 45, 55]);
  const findingWithSheet = findingSchema.parse({
    ...finding(t),
    evidence: { ...finding(t).evidence, filmstrip: evidence },
  });
  expect(
    summarizeFinding(findingWithSheet, { runDirectory: directory }, directory)
      .filmstrip,
  ).toContain("sheet.png");
  expect(evidence.bytes).toBeLessThanOrEqual(FILMSTRIP_LIMITS.bytes);
});
test("MCP serves the temporal sheet before its unchanged static crop and rejects corrupt declared sheets", async () => {
  const directory = await root();
  const run = join(directory, "idiom-quick-reports/q1");
  await pixels(run);
  const t = tuple();
  const evidence = await composeFilmstrip({
    runDirectory: run,
    tuple: t,
    action: visual(),
    timeline: action(),
    selector: "#panel",
    path: "s/v/crops/sheet.png",
  });
  const f = {
    ...finding(t),
    evidence: {
      ...finding(t).evidence,
      filmstrip: evidence,
      screenshots: ["s/v/filmstrips/probe-1/0.png"],
    },
  };
  await writeFile(join(run, "findings.json"), JSON.stringify([f]));
  await writeFile(join(run, "mcp-detail.json"), JSON.stringify({ issues: [] }));
  await writeFile(join(run, "s/v/timelines.json"), JSON.stringify(t.timelines));
  const response = await new EvidenceStore(directory).issue("quick:q1:f1");
  expect(response.content.map((p) => p.type)).toEqual([
    "text",
    "image",
    "image",
  ]);
  const image = response.content[1];
  expect(image?.type).toBe("image");
  if (image?.type !== "image") throw Error("no image");
  expect(decodeFrame(Buffer.from(image.data, "base64")).width).toBe(360);
  await writeFile(join(run, evidence.sheet as string), "broken");
  await expect(
    new EvidenceStore(directory).issue("quick:q1:f1"),
  ).rejects.toThrow("regenerate");
});
test("artifact reads reject symlink escapes and oversized decoded PNG headers", async () => {
  const directory = await root();
  const outside = await root();
  await writeFile(join(outside, "x.png"), "x");
  await symlink(outside, join(directory, "link"));
  await expect(evidencePath(directory, "link/x.png")).rejects.toThrow(
    "escapes",
  );
  const p = new PNG({ width: 1, height: 1 });
  const bytes = PNG.sync.write(p);
  bytes.writeUInt32BE(100000, 16);
  bytes.writeUInt32BE(100000, 20);
  expect(() => decodeFrame(bytes)).toThrow("pixel limit");
  const manifest = {
    version: 1,
    offsetsMs: [0, 100],
    limits: { ...FILMSTRIP_LIMITS },
    actions: [visual()],
  };
  expect(filmstripManifestSchema.safeParse(manifest).success).toBe(true);
  const frame = manifest.actions[0]?.frames[0];
  if (!frame) throw new Error("no fixture frame");
  frame.path = "../escape.png";
  expect(filmstripManifestSchema.safeParse(manifest).success).toBe(false);
});
test("verification preserves historical pixels, requests the passing action and tolerates legacy evidence", async () => {
  const baseline = await root();
  const after = await root();
  const output = await root();
  await pixels(baseline);
  await pixels(after);
  const beforeTuple = {
    ...tuple(),
    filmstrips: {
      version: 1 as const,
      offsetsMs: [0, 100],
      limits: { ...FILMSTRIP_LIMITS },
      actions: [visual()],
    },
  };
  const afterAction = action({ id: "probe-9" });
  const afterFilm = { ...visual(), id: "probe-9" };
  const afterTuple = {
    ...tuple([afterAction]),
    filmstrips: { ...beforeTuple.filmstrips, actions: [afterFilm] },
  };
  const f = finding(beforeTuple);
  expect(
    verificationFilmstripRequests([f], [beforeTuple])[0]?.identity,
  ).toEqual(actionIdentity(action()));
  const manifest = createAttachmentManifest([]);
  const images = await verificationFilmstrips({
    findings: [f],
    baseline: { runDirectory: baseline, tuples: [beforeTuple] },
    after: { runDirectory: after, tuples: [afterTuple] },
    output,
    manifest,
  });
  expect(manifest.filmstrips?.[0]).toMatchObject({
    before: "filmstrips/001/before/sheet.png",
    after: "filmstrips/001/after/sheet.png",
  });
  expect(images.size).toBe(2);
  const links =
    manifest.filmstrips
      ?.flatMap((f) => [f.kind, f.before, f.after])
      .join(" ") ?? "";
  await writeFile(join(output, "before-after.md"), links);
  await validateAttachmentManifest({ outputDirectory: output, manifest });
  const legacy = createAttachmentManifest([]);
  await verificationFilmstrips({
    findings: [f],
    baseline: { runDirectory: baseline, tuples: [tuple()] },
    after: { runDirectory: after, tuples: [] },
    output,
    manifest: legacy,
  });
  expect(legacy.filmstrips?.[0]?.beforeUnavailable).toContain("unavailable");
});

test("compressed caps cover idle baselines and earlier tuples in a lane, acknowledge every frame and release all buffers", async () => {
  const budget = new FilmstripBudget();
  const captures: FilmstripCapture[] = [];
  const huge = "A".repeat(8 * 1024 * 1024); // 6MiB compressed, never decoded in the callback.
  let acks = 0;
  for (let index = 0; index < 6; index++) {
    const session = Object.assign(new EventEmitter(), {
      send: async (command: string) => {
        if (command === "Page.screencastFrameAck") acks++;
        if (command === "Page.startScreencast") emit("AA==", 0);
        return {};
      },
      detach: async () => {},
    });
    const emit = (data: string, ms: number) =>
      session.emit("Page.screencastFrame", {
        data,
        sessionId: 1,
        metadata: {
          timestamp: 1 + ms / 1000,
          deviceWidth: 1,
          deviceHeight: 1,
          pageScaleFactor: 1,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      });
    let mark:
      | ((_source: object, token: string, time: number) => void)
      | undefined;
    const page = Object.assign(new EventEmitter(), {
      context: () => ({ newCDPSession: async () => session }),
      viewportSize: () => ({ width: 1, height: 1 }),
      exposeBinding: async (_name: string, fn: typeof mark) => {
        mark = fn;
      },
      evaluate: async (
        _fn: unknown,
        arg?: { token?: string; requests?: string[] },
      ) => {
        if (arg?.requests) return false;
        if (arg?.token) mark?.({}, arg.token, 1000);
        return { time: 1200 };
      },
    }) as unknown as Page;
    const capture = new FilmstripCapture(
      filmstripConfigSchema.parse({
        actions: ["#go"],
        offsetsMs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      }),
      checksConfigFrom(),
      undefined,
      [],
      budget,
    );
    captures.push(capture);
    await capture.start(
      page,
      { source: "probe-click", kind: "click", selector: "#go" },
      `r${index}`,
    );
    emit(huge, 1);
    emit(huge, 2);
    emit(huge, 3);
    emit("A".repeat(24 * 1024 * 1024), 4);
    expect(capture.retainedBytes).toBeLessThanOrEqual(
      FILMSTRIP_LIMITS.actionBytes,
    );
    expect(budget.bytes).toBeLessThanOrEqual(FILMSTRIP_LIMITS.laneBytes);
    await capture.dispose();
    expect(session.listenerCount("Page.screencastFrame")).toBe(0);
  }
  expect(acks).toBe(30);
  expect(budget.bytes).toBeGreaterThan(0);
  for (const capture of captures) capture.clear();
  expect(budget.bytes).toBe(0);
});
