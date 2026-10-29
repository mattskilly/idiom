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
    return { directory, manifest };
  } finally {
    await films.dispose();
    await page.close();
  }
}

test("original 300ms transition has distinct intermediate pixels and preserves a short native boundary", async () => {
  const { directory, manifest } = await capture("transition.html", true, 120);
  try {
    const action = manifest.actions[0];
    expect(action?.status).toBe("complete");
    expect(action?.settleMs).toBeLessThan(400);
    const positions = new Map<number | "settle", number>();
    for (const frame of action?.frames ?? []) {
      expect(frame.path, JSON.stringify(frame)).toBeDefined();
      const png = decodeFrame(
        await readFile(join(directory, frame.path as string)),
      );
      const y = Math.round(
        (120 - (action?.region.y ?? 0)) * (frame.geometry?.scale ?? 1),
      );
      const xs: number[] = [];
      for (let x = 0; x < png.width; x++) {
        const p = (y * png.width + x) * 4;
        if ((png.data[p] ?? 0) > 240 && (png.data[p + 1] ?? 255) < 10)
          xs.push(x);
      }
      positions.set(frame.slot, xs[0] ?? -1);
    }
    expect(positions.get(0)).toBe(0);
    expect(positions.get(100)).toBeGreaterThan(25);
    expect(positions.get(100)).toBeLessThan(145);
    expect(positions.get(200)).toBeGreaterThan(140);
    expect(positions.get(200)).toBeLessThan(245);
    expect(positions.get(400)).toBe(300);
    expect(positions.get(800)).toBe(300);
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
  const { directory, manifest } = await capture(
    "transition.html",
    true,
    350,
    0,
    2,
  );
  try {
    const action = manifest.actions[0];
    const frame = action?.frames.find((f) => f.slot === 400);
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
