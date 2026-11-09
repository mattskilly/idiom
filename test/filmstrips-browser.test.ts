import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { decodeFrame, FilmstripCapture } from "../src/capture/filmstrips.js";
import { MotionCollector } from "../src/capture/motion.js";
import { probeControls } from "../src/capture/probe.js";
import { TimelineCollector, withTimelineIds } from "../src/capture/timeline.js";
import {
  FILMSTRIP_LIMITS,
  filmstripConfigSchema,
  filmstripManifestSchema,
} from "../src/checks/filmstrip-schema.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ActionTimelineArtifact,
  CheckTuple,
} from "../src/checks/types.js";
import { startLoadingServer } from "./loading-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function capture(
  fixture: string,
  explicit: boolean,
  nativeMs: number,
  disabledMs = 0,
  pageScale = 1,
) {
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
    reducedMotion: "no-preference",
  });
  const directory = await mkdtemp(join(tmpdir(), "idiom-filmstrip-test-"));
  const motion = new MotionCollector(page);
  const films = new FilmstripCapture(
    filmstripConfigSchema.parse({ actions: explicit ? ["#go"] : [] }),
    checksConfigFrom(),
    () => motion.evidence(),
  );
  try {
    await page.setContent(
      await readFile(join("test/fixtures/filmstrips", fixture), "utf8"),
    );
    if (pageScale !== 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: pageScale,
      });
      await cdp.detach();
    }
    if (disabledMs > 0)
      await page.evaluate((ms) => {
        const button = document.querySelector("#go") as HTMLButtonElement;
        button.disabled = true;
        setTimeout(() => {
          button.disabled = false;
        }, ms);
      }, disabledMs);
    const timeline = new TimelineCollector(page, { filmstrips: films });
    const recording = await timeline.start({
      source: "web-step",
      kind: "click",
      selector: "#go",
      name: "click",
      stepIndex: 1,
    });
    const window = await motion.start(
      { source: "web-step", selector: "#go", name: "click", stepIndex: 1 },
      recording.key,
    );
    await page.locator("#go").click();
    await page.waitForTimeout(nativeMs);
    await recording.finish();
    const frozenAction = structuredClone(timeline.evidence().actions[0]);
    await window.finish();
    await recording.finishVisual(motion.evidence());
    const tuple: CheckTuple = {
      flow: "f",
      state: "s",
      viewport: "v",
      width: 800,
      height: 600,
      metadataPath: "metadata.json",
      artifactPaths: [],
      commit: "test",
      createdAt: "",
      console: [],
      mismatches: [],
      timelines: withTimelineIds(timeline.evidence()),
      observations: {
        version: 2,
        elements: [],
        motion: motion.evidence(),
      } as unknown as CheckTuple["observations"],
    };
    await films.dispose();
    const manifest = await films.publish(directory, tuple);
    expect(
      filmstripManifestSchema.parse(JSON.parse(JSON.stringify(manifest))),
    ).toEqual(manifest);
    return {
      directory,
      manifest,
      frozenAction,
      publishedAction: tuple.timelines?.actions[0],
    };
  } finally {
    await films.dispose();
    await page.close();
  }
}

test("original 300ms transition has distinct intermediate pixels and preserves a short native boundary", async () => {
  const { directory, manifest, frozenAction, publishedAction } = await capture(
    "transition.html",
    true,
    120,
  );
  try {
    const action = manifest.actions[0];
    if (!action || !frozenAction || !publishedAction)
      throw new Error(`Missing action evidence: ${JSON.stringify(manifest)}`);
    expect(publishedAction.durationMs).toBe(frozenAction.durationMs);
    expect(action.settleMs).toBe(
      Math.max(
        0,
        frozenAction.startedAt + frozenAction.durationMs - (action.anchor ?? 0),
      ),
    );
    const positions: Array<{
      slot: number | "settle";
      time: number;
      x: number;
    }> = [];
    for (const frame of action.frames) {
      if (!frame.path) continue;
      const png = decodeFrame(await readFile(join(directory, frame.path)));
      if (!frame.geometry || frame.timestamp === undefined)
        throw new Error(
          `Missing frame geometry/time: ${JSON.stringify(frame)}`,
        );
      const scale = frame.geometry.scale;
      const y = Math.round((120 - action.region.y) * scale);
      let redX: number | undefined;
      for (let x = 0; x < png.width; x++) {
        const p = (y * png.width + x) * 4;
        if ((png.data[p] ?? 0) > 240 && (png.data[p + 1] ?? 255) < 10) {
          redX = x;
          break;
        }
      }
      expect(
        redX,
        `Red subject absent: ${JSON.stringify({ frame, manifest, positions })}`,
      ).toBeDefined();
      positions.push({
        slot: frame.slot,
        time: frame.timestamp,
        x: (redX as number) / scale + action.region.x,
      });
    }
    positions.sort((a, b) => a.time - b.time);
    const diagnostic = JSON.stringify({ manifest, positions });
    expect(positions.find((p) => p.slot === 0)?.x, diagnostic).toBe(0);
    // Host load can start the transition late or withhold late paints, so the
    // resting pixels are tied to when the page itself reached rest, not to a
    // nominal slot. A slot without pixels must name why and never counts.
    const restAt = action.visualFrames?.find((f) =>
      f.elements.some(
        (e) => e.selector === "#panel" && Math.round(e.rect.x) === 300,
      ),
    )?.time;
    for (const frame of action.frames)
      if (frame.path === undefined) {
        expect(frame.reason, diagnostic).toBeTruthy();
        expect(action.status, diagnostic).toBe("partial");
      } else if (
        restAt !== undefined &&
        frame.actualMs !== undefined &&
        frame.actualMs >= restAt + FILMSTRIP_LIMITS.toleranceMs
      )
        expect(
          positions.find((p) => p.slot === frame.slot)?.x,
          diagnostic,
        ).toBe(300);
    const intermediates = new Set(
      positions.filter((p) => p.x > 0 && p.x < 300).map((p) => p.x),
    );
    expect(intermediates.size, diagnostic).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < positions.length; i++)
      expect(positions[i]?.x, diagnostic).toBeGreaterThanOrEqual(
        positions[i - 1]?.x ?? 0,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("600ms insert is absent at 400 and present at 800 and native settle", async () => {
  const { directory, manifest } = await capture("late-insert.html", true, 900);
  try {
    const action = manifest.actions[0];
    expect(action?.status).toBe("complete");
    for (const slot of [400, 800, "settle"] as const) {
      const frame = action?.frames.find((f) => f.slot === slot);
      const png = decodeFrame(
        await readFile(join(directory, frame?.path as string)),
      );
      const x = 125 - (action?.region.x ?? 0);
      const y = 120 - (action?.region.y ?? 0);
      const p = (y * png.width + x) * 4;
      expect(png.data[p + 1]).toBe(slot === 400 ? 0 : 255);
      expect(png.data[p + 2]).toBe(slot === 400 ? 255 : 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default retention uses the real motion check; quiet controls persist no pixels", async () => {
  const finding = await capture("transition.html", false, 350);
  const quiet = await capture("late-insert.html", false, 100);
  try {
    expect(finding.manifest.actions).toHaveLength(1);
    expect(finding.manifest.actions[0]?.identity.source).toBe("web-step");
    expect(
      finding.manifest.actions[0]?.frames.filter((f) => f.path).length,
      JSON.stringify(finding.manifest.actions[0]),
    ).toBeGreaterThanOrEqual(4);
    expect(quiet.manifest.actions).toEqual([]);
  } finally {
    await rm(finding.directory, { recursive: true, force: true });
    await rm(quiet.directory, { recursive: true, force: true });
  }
});

test("probe hover/click windows share one real-page stream across deadline wrappers", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const directory = await mkdtemp(join(tmpdir(), "idiom-filmstrip-probe-"));
  const html = '<button id="go">Go</button><button id="other">Other</button>';
  const films = new FilmstripCapture(
    filmstripConfigSchema.parse({
      actions: ["#go", "#other"],
      offsetsMs: [0, 50],
    }),
    checksConfigFrom(),
  );
  try {
    await page.setContent(html);
    let timelines: ActionTimelineArtifact | undefined;
    const probe = await probeControls({
      page,
      skip: [],
      maxControls: 2,
      waitMs: 50,
      restore: async (active) => {
        await active.setContent(html);
      },
      filmstrips: films,
      onTimelines: (recorded) => {
        timelines = recorded;
      },
    });
    await films.dispose();
    const tuple: CheckTuple = {
      flow: "f",
      state: "s",
      viewport: "v",
      width: 800,
      height: 600,
      metadataPath: "metadata.json",
      artifactPaths: [],
      commit: "test",
      createdAt: "",
      console: [],
      mismatches: [],
      timelines: withTimelineIds(timelines),
      observations: {
        version: 2,
        elements: [],
        motion: probe.motion,
      } as unknown as CheckTuple["observations"],
    };
    const manifest = await films.publish(directory, tuple);
    expect(
      manifest.actions.filter((a) => a.identity.source === "probe-hover"),
    ).toHaveLength(2);
    expect(
      manifest.actions.filter((a) => a.identity.source === "probe-click"),
    ).toHaveLength(2);
    expect(manifest.actions.every((a) => a.frames.some((f) => f.path))).toBe(
      true,
    );
  } finally {
    await films.dispose();
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("input zero excludes Playwright auto-wait time", async () => {
  const { directory, manifest } = await capture(
    "transition.html",
    true,
    120,
    400,
  );
  try {
    const action = manifest.actions[0];
    expect(
      (action?.anchor ?? 0) - (action?.timelineOrigin ?? 0),
    ).toBeGreaterThan(250);
    const frame = action?.frames.find((f) => f.slot === 100);
    const png = decodeFrame(
      await readFile(join(directory, frame?.path as string)),
    );
    const y = Math.round(120 - (action?.region.y ?? 0));
    // At 100ms after actual dispatch, the red panel is still in transit:
    // past its 0px start and short of its 300px end. A single fixed pixel
    // sits on an edge of the panel, which the transition's variable start
    // lag moves either way.
    let redX = -1;
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] === 255 && png.data[i + 1] === 0) {
        redX = x;
        break;
      }
    }
    expect(redX).toBeGreaterThanOrEqual(0);
    const left = redX + (action?.region.x ?? 0);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(300);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loading evidence retains the held original action, with its own replay identity", async () => {
  const server = await startLoadingServer();
  const page = await browser.newPage();
  const directory = await mkdtemp(join(tmpdir(), "idiom-filmstrip-held-"));
  const films = new FilmstripCapture(
    filmstripConfigSchema.parse({}),
    checksConfigFrom(),
  );
  try {
    const url = `${server.origin}/loading-state/before.html`;
    await page.goto(url);
    let timelines: ActionTimelineArtifact | undefined;
    const probe = await probeControls({
      page,
      skip: [],
      maxControls: 1,
      waitMs: 150,
      restore: async (active) => {
        await active.goto(url);
      },
      filmstrips: films,
      heldReplay: { delayMs: 1500, withinMs: 1000, steps: [] },
      onTimelines: (value) => {
        timelines = value;
      },
    });
    await films.dispose();
    const t: CheckTuple = {
      flow: "f",
      state: "s",
      viewport: "v",
      width: 1280,
      height: 720,
      metadataPath: "metadata.json",
      artifactPaths: [],
      commit: "test",
      createdAt: "",
      console: [],
      mismatches: [],
      timelines: withTimelineIds(timelines),
      observations: {
        version: 2,
        elements: [],
        probe,
        motion: probe.motion,
      } as unknown as CheckTuple["observations"],
    };
    const manifest = await films.publish(directory, t);
    expect(
      manifest.actions.some(
        (a) =>
          a.identity.source === "slow-replay" &&
          a.identity.heldOf === "probe-click",
      ),
    ).toBe(true);
    const replay = manifest.actions.find(
      (a) => a.identity.source === "slow-replay",
    );
    expect(replay?.id).toBe("slow-probe-1");
    expect(replay?.frames.some((f) => f.path)).toBe(true);
  } finally {
    await films.dispose();
    await page.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("page scale maps CSS crop coordinates to the actual compositor pixels", async () => {
  // Any frame after the 300ms transition shows the panel at rest. Under heavy
  // load the sampler honestly declines late paints ("misses a known visual
  // change") — sometimes both 400 and settle — so recapture until one carries
  // pixels; the decline itself is correct behavior, not what this test checks.
  const atRest = (
    frames: Awaited<
      ReturnType<typeof capture>
    >["manifest"]["actions"][number]["frames"],
  ) =>
    frames.find((f) => f.slot === 400 && f.path) ??
    frames.find((f) => f.slot === "settle" && f.path);
  let result = await capture("transition.html", true, 350, 0, 2);
  for (
    let attempt = 1;
    attempt < 3 && !atRest(result.manifest.actions[0]?.frames ?? []);
    attempt++
  ) {
    await rm(result.directory, { recursive: true, force: true });
    result = await capture("transition.html", true, 350, 0, 2);
  }
  const { directory, manifest } = result;
  try {
    const action = manifest.actions[0];
    const frame =
      atRest(action?.frames ?? []) ??
      action?.frames.find((f) => f.slot === "settle");
    expect(frame?.geometry?.pageScale, JSON.stringify(frame)).toBe(2);
    expect(frame?.geometry?.scale).toBe(2);
    const png = decodeFrame(
      await readFile(join(directory, frame?.path as string)),
    );
    const x = Math.round((310 - (action?.region.x ?? 0)) * 2);
    const y = Math.round((120 - (action?.region.y ?? 0)) * 2);
    const p = (y * png.width + x) * 4;
    expect([...png.data.subarray(p, p + 3)]).toEqual([255, 0, 0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicitly requested load retains its actual displayed baseline and later pixels", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const directory = await mkdtemp(join(tmpdir(), "idiom-filmstrip-load-"));
  const films = new FilmstripCapture(
    filmstripConfigSchema.parse({ actions: ["load"] }),
    checksConfigFrom(),
  );
  try {
    const timeline = new TimelineCollector(page, { filmstrips: films });
    await timeline.beginLoad({
      source: "load",
      kind: "navigation",
      name: "fixture",
    });
    const html = await readFile(
      "test/fixtures/filmstrips/late-insert.html",
      "utf8",
    );
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    await page.waitForTimeout(100);
    await timeline.finishLoad(undefined, true);
    await films.dispose();
    const t: CheckTuple = {
      flow: "f",
      state: "s",
      viewport: "v",
      width: 800,
      height: 600,
      metadataPath: "metadata.json",
      artifactPaths: [],
      commit: "test",
      createdAt: "",
      console: [],
      mismatches: [],
      timelines: withTimelineIds(timeline.evidence()),
    };
    const manifest = await films.publish(directory, t);
    const load = manifest.actions[0];
    expect(load?.id).toBe("load");
    expect(
      load?.frames.find((f) => f.slot === 0)?.path,
      JSON.stringify(load),
    ).toBeDefined();
    const frame = load?.frames.find((f) => f.slot === 800);
    expect(frame?.path).toBeDefined();
    const png = decodeFrame(
      await readFile(join(directory, frame?.path as string)),
    );
    expect(png.width).toBeGreaterThan(0);
  } finally {
    await films.dispose();
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
});
