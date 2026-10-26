import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { resolveDesignSource } from "../src/design/source.js";
import { createQuickConfiguration } from "../src/quick/config.js";
import { captureLiteralPages, writeReviewReports } from "../src/quick/run.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { attachCrops } from "../src/review/crops.js";
import {
  buildDeterministicDrafts,
  finalizeFindings,
} from "../src/review/findings.js";
import type { DesignDeclaration } from "../src/schemas/design.js";
import { FIGMA_URL, recordedFigma, throwingFigma } from "./figma-support.js";

const fixtures = join(import.meta.dirname, "fixtures/design-drift");
let directory: string;
let app: Awaited<ReturnType<typeof resolveDesignSource>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "idiom-figma-capture-"));
  app = await resolveDesignSource(join(fixtures, "app.html"), directory);
  await writeFile(
    join(directory, "design.html"),
    (await readFile(join(fixtures, "design.html"), "utf8")).replace(
      "</style>",
      "button{border-style:solid}</style>",
    ),
  );
});
afterAll(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

async function capture(
  design: DesignDeclaration,
  out: string,
  figma = recordedFigma(),
) {
  const configuration = createQuickConfiguration([app.url], {
    colorSchemes: ["light"],
  });
  // A 500px viewport the 500px Figma frame selects, and a mobile one it does not.
  configuration.project.viewports = [
    { name: "frame", width: 500, height: 700 },
    { name: "mobile", width: 390, height: 844 },
  ];
  configuration.flow.viewports = ["frame", "mobile"];
  for (const state of configuration.flow.states) state.design = design;
  const result = await captureLiteralPages({
    directory,
    finalDirectory: join(directory, out),
    configuration,
    checks: checksConfigFrom(),
    startedAt: new Date(),
    label: "test",
    dependencies: { browserLauncher: createBrowserLauncher(), figma },
  });
  const loaded = await loadCaptureRun({
    runDirectory: result.runDirectory,
    expectedFlow: configuration.flow.id,
  });
  return { result, loaded, configuration };
}
const at = (
  loaded: Awaited<ReturnType<typeof capture>>["loaded"],
  viewport: string,
) => loaded.tuples.find((t) => t.viewport === viewport);

test("a Figma reference captures at its viewport, is cached, and attaches findings with crops", async () => {
  const { result, loaded } = await capture(FIGMA_URL, "figma-run");
  const frame = at(loaded, "frame"),
    mobile = at(loaded, "mobile");
  expect(frame?.design?.unavailable).toBeUndefined();
  expect(frame?.design?.descriptor).toMatchObject({
    source: FIGMA_URL,
    resolved: {
      kind: "figma",
      final: "https://www.figma.com/design/AbCdEf123/?node-id=1-2",
    },
    figma: {
      fileKey: "AbCdEf123",
      nodeId: "1:2",
      version: "4711",
      variables: "resolved",
      cache: ".idiom/designs/figma/AbCdEf123/1-2/4711",
    },
    artifacts: { figma: "page-1/frame/design/figma.json" },
  });
  expect(frame?.design?.descriptor.artifacts.dom).toBeUndefined();
  expect(frame?.design?.descriptor.name).toBeUndefined();
  const shot = PNG.sync.read(
    await readFile(
      join(result.runDirectory, frame?.design?.screenshotPath ?? ""),
    ),
  );
  expect(shot.width).toBe(1000);
  expect(mobile?.design).toBeUndefined();
  expect(mobile?.designNotApplicable).toBe(
    "design reference figma applies at viewport frame",
  );
  const coverage = result.reviewed.coverage.filter(
    (e) => e.coverage.check === "design-drift",
  );
  expect(coverage.map((e) => [e.tuple.viewport, e.coverage.status])).toEqual([
    ["frame", "ran"],
    ["mobile", "skipped"],
  ]);
  expect(coverage[1]?.coverage.reason).toContain("applies at viewport frame");
  const candidates = result.reviewed.candidates.filter(
    (e) => e.candidate.category === "design-drift",
  );
  for (const property of [
    "borderTopLeftRadius",
    "gap.x",
    "fontWeight",
    "color",
    "missing",
    "extra",
    "text",
  ])
    expect(
      candidates.some((e) => e.candidate.designDrift?.property === property),
      property,
    ).toBe(true);
  const findings = await attachCrops(
    result.runDirectory,
    finalizeFindings({
      runId: "test",
      drafts: buildDeterministicDrafts({ runId: "test", entries: candidates }),
    }),
    loaded.tuples,
  );
  const radius = findings.find(
    (f) => f.evidence.designDrift?.property === "borderTopLeftRadius",
  );
  expect(radius?.evidence.designDrift?.crops?.map((c) => c.label)).toEqual([
    "Design",
    "App capture",
  ]);
  const reports = await writeReviewReports(result.runDirectory, {
    flow: "quick-review",
    commit: "test",
    outcome: { kind: "deterministic-only" },
    tuples: loaded.tuples,
    findings,
    coverage: result.reviewed.coverage,
    captureCoverage: [],
    suppressed: [],
  });
  const html = await readFile(reports.htmlReportPath, "utf8");
  expect(html).toContain("Figma file version 4711");
  expect(html).toContain("Checkout / main / Card");
  const markdown = await readFile(reports.reportPath, "utf8");
  expect(markdown).toContain(
    "Figma layer: [Checkout / main / Card](https://www.figma.com/design/AbCdEf123/?node-id=1-5) · variable radius/card",
  );
  await access(
    join(directory, ".idiom/designs/figma/AbCdEf123/1-2/current.json"),
  );

  // Replay from the pinned cache: no network, no token.
  const again = await capture(FIGMA_URL, "figma-cached", throwingFigma);
  expect(at(again.loaded, "frame")?.design?.unavailable).toBeUndefined();
}, 90000);

test("two references write design/<name>/ and reconcile; one keeps the original layout", async () => {
  const { result, loaded } = await capture(
    [
      { source: FIGMA_URL, name: "figma" },
      { source: join(directory, "design.html"), name: "prototype" },
    ],
    "two-run",
  );
  const frame = at(loaded, "frame"),
    mobile = at(loaded, "mobile");
  expect(frame?.designs?.map((d) => d.descriptor.name)).toEqual([
    "figma",
    "prototype",
  ]);
  expect(frame?.designs?.every((d) => d.matches && !d.unavailable)).toBe(true);
  expect(frame?.designs?.[0]?.descriptor.artifacts.observations).toBe(
    "page-1/frame/design/figma/observations.json",
  );
  expect(frame?.designs?.[1]?.descriptor.artifacts.observations).toBe(
    "page-1/frame/design/prototype/observations.json",
  );
  expect(mobile?.designs).toBeUndefined();
  expect(mobile?.design?.descriptor.artifacts.observations).toBe(
    "page-1/mobile/design/observations.json",
  );
  const frameCandidates = result.reviewed.candidates.filter(
    (e) =>
      e.tuple.viewport === "frame" && e.candidate.category === "design-drift",
  );
  // The references agree element for element, so nothing is a decision.
  expect(
    frameCandidates.some((e) => e.candidate.rule === "idiom:design-decision"),
  ).toBe(false);
  expect(
    frameCandidates.find((e) => e.candidate.designDrift?.property === "gap.x")
      ?.candidate.designDrift?.alsoReferences,
  ).toEqual(["prototype"]);
}, 90000);

test("a missing token with no cache is unavailable, never a pass", async () => {
  await rm(join(directory, ".idiom"), { recursive: true, force: true });
  const { result, loaded } = await capture(FIGMA_URL, "no-token", {
    ...recordedFigma(),
    env: {},
  });
  const frame = at(loaded, "frame");
  expect(frame?.design?.descriptor.status).toBe("failed");
  expect(frame?.design?.unavailable).toContain("FIGMA_TOKEN is not set");
  const coverage = result.reviewed.coverage.find(
    (e) => e.coverage.check === "design-drift" && e.tuple.viewport === "frame",
  );
  expect(coverage?.coverage.status).toBe("unavailable");
}, 90000);
