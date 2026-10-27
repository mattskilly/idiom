import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { collectPageEvidence } from "../src/capture/page.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { orphanWordCheck } from "../src/checks/orphan-word.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  Rect,
} from "../src/checks/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const html = `<!doctype html><html lang="en"><style>
  body { margin: 0; font: 32px/40px sans-serif; color: #111; background: #fff; }
  h2 { margin: 0 0 40px; font: inherit; width: 600px; }
</style><body>
  <h2 id="visible">Build something great<br>today</h2>
  <h2 id="faded">Build something great<br><span style="opacity:0">today</span></h2>
  <h2 id="hidden">Build something great<br><span style="visibility:hidden">today</span></h2>
  <h2 id="masked">Build something great<br><span style="display:inline-block;overflow:hidden;vertical-align:top"><span style="display:inline-block;transform:translateY(110%)">today</span></span></h2>
  <div style="overflow:hidden;height:30px;margin-bottom:40px"><h2 id="clipped">Build something great<br>today</h2></div>
  <p id="running"><span id="sentence" role="button" tabindex="0">Track your great<br>flights.</span> <span role="button" tabindex="0">Convert anything.</span></p>
  <div><h3 id="inline-heading" style="display:inline;font:inherit">Build something great<br>today</h3> <a href="#edit">edit</a></div>
  <h2 id="transparent" style="color:transparent">Build something great<br>today</h2>
</body></html>`;

let browser: Browser;
let observations: ObservationArtifactV2;

beforeAll(async () => {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const state = flowSchema.parse({
    id: "f",
    title: "f",
    intent: [],
    setup: [],
    states: [{ id: "s", description: "s", url: "/", expect: {} }],
  }).states[0];
  if (state === undefined) throw new Error("Missing state");
  const result = await collectPageEvidence({
    page,
    state,
    settleMs: 0,
    reachStage: "state",
    reach: async () => {
      await page.setContent(html);
      return 200;
    },
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
    collectConsole: async () => [],
    tokens: { status: "not-configured" },
    screenshotOptions: { fullPage: true, animations: "disabled" },
    observe: { orphanWord: true },
    now: () => new Date(),
  });
  if (!result.ok || result.observations?.version !== 2)
    throw new Error("capture failed");
  observations = result.observations;
  await page.close();
});
afterAll(async () => {
  await browser.close();
});

const records = () => observations.orphanWords?.records ?? [];
const record = (selector: string) =>
  records().find((entry) => entry.selector === selector);
const inside = (inner: Rect | undefined, outer: Rect | undefined) =>
  inner !== undefined &&
  outer !== undefined &&
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

test("a visible heading's stranded word carries its text geometry and ink", () => {
  const visible = record("#visible");
  expect(visible?.word).toBe("today");
  const box = observations.elements.find((e) => e.selector === "#visible");
  expect(inside(visible?.rect, box?.rect)).toBe(true);
  expect(inside(visible?.lastLine, visible?.rect)).toBe(true);
  expect(visible?.lastLine?.y).toBeGreaterThan(visible?.rect?.y ?? 0);
  expect(visible?.ink?.status).toBe("measured");
  if (visible?.ink?.status === "measured")
    expect(visible.ink.share).toBeGreaterThan(0.02);
});

test("words hidden by opacity, visibility, a reveal mask or an ancestor clip form no line", () => {
  expect(record("#faded")).toBeUndefined();
  expect(record("#masked")).toBeUndefined();
  expect(record("#hidden")).toBeUndefined();
  expect(record("#clipped")).toBeUndefined();
});

test("an inline button's last line is shared with the copy that follows it; an inline heading's is not", () => {
  expect(record("#sentence")).toBeUndefined();
  expect(record("#inline-heading")?.word).toBe("today");
});

test("a word the screenshot does not show is measured blank and skipped", () => {
  const transparent = record("#transparent");
  expect(transparent?.ink).toEqual({ status: "measured", share: 0 });
  const tuple: CheckTuple = {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 800,
    height: 600,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-10-26T00:00:00Z",
    console: [],
    mismatches: [],
    observations,
  };
  const result = orphanWordCheck.run({
    tuple,
    narrowViewport: false,
    config: checksConfigFrom(checksConfigSchema.parse({})),
  });
  expect(result.candidates.map((c) => c.selectorHint)).toEqual([
    "#visible",
    "#inline-heading",
  ]);
  expect(result.candidates[0]?.verification.params?.rect).toEqual(
    record("#visible")?.rect,
  );
  expect(result.coverage.inkSkipped).toEqual({ "idiom:orphan-word": 1 });
});

test("the new orphan fields round-trip through the artifact schema", () => {
  const stored = JSON.parse(JSON.stringify(observations));
  expect(observationArtifactSchema.parse(stored)).toEqual(stored);
  const scan = stored.orphanWords;
  scan.records[0].ink = { status: "measured", share: -0.1 };
  expect(observationArtifactSchema.safeParse(stored).success).toBe(false);
});
