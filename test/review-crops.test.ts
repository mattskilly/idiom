import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import type { CheckTuple } from "../src/checks/types.js";
import { attachCrops, paramsRect } from "../src/review/crops.js";
import type { Finding } from "../src/schemas/finding.js";

const elementRect = { x: 600, y: 400, width: 100, height: 50 };
const textRect = { x: 40, y: 60, width: 200, height: 80 };

function finding(params: Record<string, unknown>): Finding {
  return {
    id: "f1",
    fingerprint: "0123456789abcdef0123",
    createdAt: "2026-10-26T00:00:00.000Z",
    commit: "fixture",
    flow: "f",
    state: "s",
    viewport: "desktop",
    layer: "deterministic",
    category: "orphan-word",
    severity: "minor",
    confidence: 1,
    evidence: { screenshots: [] },
    explanation: "x",
    acceptance: [],
    verification: { kind: "deterministic-check", check: "orphan-word", params },
    status: "open",
  } as Finding;
}

async function crop(params: Record<string, unknown>, documentWidth = 800) {
  const runDirectory = await mkdtemp(join(tmpdir(), "idiom-crops-"));
  await mkdir(join(runDirectory, "s"), { recursive: true });
  await writeFile(
    join(runDirectory, "s/screenshot.png"),
    PNG.sync.write(new PNG({ width: documentWidth * 2, height: 1200 })),
  );
  const tuple = {
    state: "s",
    viewport: "desktop",
    width: 800,
    metadataPath: "s/metadata.json",
    screenshotPath: "s/screenshot.png",
    observations: {
      viewport: { width: 800, height: 600 },
      document: { scrollWidth: documentWidth, scrollHeight: 600 },
      elements: [{ selector: "h1", visible: true, rect: elementRect }],
    },
  } as unknown as CheckTuple;
  const [result] = await attachCrops(runDirectory, [finding(params)], [tuple]);
  const path = result?.evidence.screenshots.at(-1);
  if (path === undefined) throw new Error("no crop written");
  const png = PNG.sync.read(await readFile(join(runDirectory, path)));
  return { width: png.width, height: png.height };
}

test("a measured params.rect is the crop subject, not the selector's element", async () => {
  // 24px padding each side, at the screenshot's 2x scale.
  expect(await crop({ selector: "h1", rect: textRect })).toEqual({
    width: (200 + 48) * 2,
    height: (80 + 48) * 2,
  });
});

test("an invalid params.rect falls back to the selector", async () => {
  for (const rect of [
    { x: 40, y: 60, width: 0, height: 80 },
    { x: Number.NaN, y: 60, width: 200, height: 80 },
    "40,60,200,80",
    null,
  ]) {
    expect(paramsRect(finding({ rect }))).toBeUndefined();
    expect(await crop({ selector: "h1", rect })).toEqual({
      width: (100 + 48) * 2,
      height: (50 + 48) * 2,
    });
  }
});

test("a full-page screenshot wider than the viewport keeps the device scale", async () => {
  // A 1000px-wide document at 2x is 2000 image px, not 2.5x the 800px viewport.
  expect(await crop({ selector: "h1", rect: textRect }, 1000)).toEqual({
    width: (200 + 48) * 2,
    height: (80 + 48) * 2,
  });
});
