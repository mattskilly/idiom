import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { blankReason, sampleBlankMedia } from "../src/capture/visual-blank.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { visualBlankCheck } from "../src/checks/visual-blank.js";
import { buildRuleContract } from "../src/findings/contract.js";
import { capturePredicateIdentity } from "../src/findings/settings.js";
import { flowSchema } from "../src/schemas/flow.js";
import { checksConfigSchema, projectSchema } from "../src/schemas/project.js";
import { evaluateRuleAcceptance } from "../src/verify/acceptance.js";
import {
  blankEvidence,
  evidenceTuple,
  mediaRecord,
} from "./blank-media-support.js";

function png(content = 0, width = 204, height = 104) {
  const image = new PNG({ width, height });
  image.data.fill(255);
  let painted = 0;
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      if (painted++ < content) {
        const i = (y * width + x) * 4;
        image.data[i] = 0;
      }
    }
  return image;
}
const config = checksConfigFrom();
function sampled(content = 0) {
  return sampleBlankMedia(blankEvidence(), () => png(content), 204);
}
function check(evidence = sampled()) {
  return visualBlankCheck.run({
    tuple: evidenceTuple({ visualBlank: evidence }),
    config,
    tuples: [],
    narrowViewport: false,
  });
}

test("exact 99.5% boundary and two-colour near miss use every pixel", () => {
  expect(sampled(100).records[0]?.pixels).toMatchObject({
    count: 20000,
    distinct: 2,
    dominantShare: 0.995,
  });
  expect(check(sampled(100)).candidates).toHaveLength(1);
  expect(check(sampled(101)).candidates).toHaveLength(0);
  expect(check(sampled(10000)).candidates).toHaveLength(0);
  expect(check().candidates[0]).toMatchObject({
    severity: "minor",
    targetSelectors: ["#media"],
  });
});
test("within-bucket quantization noise stays blank", () => {
  const image = png();
  for (let i = 0; i < image.data.length; i += 4) image.data[i] = 240 + (i % 16);
  expect(
    sampleBlankMedia(blankEvidence(), () => image, 204).records[0]?.pixels
      ?.distinct,
  ).toBe(1);
});
test("alpha boundaries, video and opaque cover have concrete precedence", () => {
  const r = sampled(10000).records[0];
  if (!r) throw Error("record");
  expect(blankReason({ ...r, opacity: 0.01 })).toContain("opacity");
  expect(blankReason({ ...r, opacity: 0.01001 })).toBeUndefined();
  expect(
    blankReason({ ...r, overlay: { alpha: 0.98, coverage: 0.995 } }),
  ).toContain("overlay");
  expect(
    blankReason({ ...r, overlay: { alpha: 0.9799, coverage: 1 } }),
  ).toBeUndefined();
  expect(
    blankReason({ ...r, overlay: { alpha: 1, coverage: 0.9949 } }),
  ).toBeUndefined();
  expect(
    blankReason({ ...r, video: { poster: false, frame: false } }),
  ).toContain("video");
  expect(
    blankReason({ ...r, video: { poster: true, frame: false } }),
  ).toBeUndefined();
  expect(
    blankReason({ ...r, video: { poster: false, frame: true } }),
  ).toBeUndefined();
});
test("masks, exemptions, absent evidence, disabled checks and decode failure disclose coverage", () => {
  for (const r of [
    mediaRecord({ masked: true }),
    mediaRecord({ exempt: "swatch" }),
  ])
    expect(
      check(sampleBlankMedia(blankEvidence([r]), () => png(), 204)).candidates,
    ).toEqual([]);
  expect(check(blankEvidence([])).coverage.status).toBe("ran");
  expect(
    visualBlankCheck.run({
      tuple: evidenceTuple(),
      config,
      tuples: [],
      narrowViewport: false,
    }).coverage.status,
  ).toBe("unavailable");
  expect(
    visualBlankCheck.run({
      tuple: evidenceTuple(),
      config: {
        ...config,
        visualBlank: { enabled: false, swatchSelectors: [] },
      },
      tuples: [],
      narrowViewport: false,
    }).coverage.status,
  ).toBe("skipped");
  const failed = sampleBlankMedia(
    blankEvidence(),
    () => {
      throw Error("decode");
    },
    204,
  );
  expect(failed.status).toBe("unavailable");
  expect(check(failed).coverage.status).toBe("unavailable");
});
test("DPR, horizontal scroll, viewport, tiled, clipping and refreshed drift rects map crops", () => {
  const r = mediaRecord({
    rect: { x: -10, y: -20, width: 204, height: 104 },
    interior: { x: -10, y: -20, width: 204, height: 104 },
    visible: { x: -10, y: -20, width: 204, height: 104 },
    scroll: { x: 10, y: 20 },
  });
  for (const strategy of ["full-page", "tiled"] as const) {
    const e = sampleBlankMedia(
      blankEvidence([r]),
      () => png(0, 408, 208),
      204,
      { strategy, scale: 2, width: 204, height: 104 },
    );
    expect(e.records[0]?.pixels?.crop).toEqual({
      x: 4,
      y: 4,
      width: 400,
      height: 200,
    });
  }
  const e = sampleBlankMedia(blankEvidence([r]), () => png(), 204, {
    strategy: "viewport",
    scale: 1,
    width: 204,
    height: 104,
  });
  expect(e.records[0]?.pixels?.crop).toEqual({
    x: 0,
    y: 0,
    width: 192,
    height: 82,
  });
  const drift = {
    observed: { width: 204, height: 104 },
    captured: { width: 408, height: 208 },
  };
  const g = {
    strategy: "full-page" as const,
    scale: 1,
    width: 408,
    height: 208,
    drift,
  };
  expect(
    sampleBlankMedia(blankEvidence(), () => png(), 204, g).records[0]
      ?.unavailable,
  ).toContain("refreshed");
  expect(
    sampleBlankMedia(blankEvidence(), () => png(0, 408, 208), 204, {
      ...g,
      rects: { "#media": { x: 20.5, y: 30.5, width: 204, height: 104 } },
    }).records[0]?.pixels?.crop,
  ).toEqual({ x: 23, y: 33, width: 199, height: 99 });
  expect(
    sampleBlankMedia(
      blankEvidence([mediaRecord({ scroll: { x: 0, y: 1000 } })]),
      () => png(),
      204,
    ).records[0]?.unavailable,
  ).toContain("outside");
});
test("strict additive evidence round-trips; historical V2 remains readable", () => {
  const tuple = evidenceTuple({ visualBlank: sampled() });
  expect(observationArtifactSchema.parse(tuple.observations)).toEqual(
    tuple.observations,
  );
  expect(
    observationArtifactSchema.safeParse(evidenceTuple().observations).success,
  ).toBe(true);
  expect(
    observationArtifactSchema.safeParse({
      ...tuple.observations,
      visualBlank: { ...sampled(), extra: 1 },
    }).success,
  ).toBe(false);
});
test("new configuration defaults, strictness, array copies and state predicate identity", () => {
  expect(checksConfigSchema.parse({})).toMatchObject({
    visualBlank: { enabled: true, swatchSelectors: [] },
    loadingStuck: { enabled: true },
  });
  expect(
    checksConfigSchema.safeParse({ visualBlank: { swatchSelectors: [" "] } })
      .success,
  ).toBe(false);
  expect(
    checksConfigSchema.safeParse({ loadingStuck: { extra: true } }).success,
  ).toBe(false);
  const settings = checksConfigSchema.parse({
    visualBlank: { swatchSelectors: [".swatch"] },
  });
  const copied = checksConfigFrom(settings);
  copied.visualBlank?.swatchSelectors.push("#other");
  expect(settings.visualBlank.swatchSelectors).toEqual([".swatch"]);
  const flowInput = {
    id: "test",
    title: "Test",
    intent: [],
    setup: [],
    states: [{ id: "one", description: "One", url: "/", expect: {} }],
  };
  const flow = flowSchema.parse(flowInput),
    project = projectSchema.parse({
      version: 1,
      app: { name: "Test", framework: "other" },
      design: {},
      capture: {},
      server: {
        env: {},
        build: "true",
        start: "true",
        port: 3000,
        readyUrl: "http://localhost:3000",
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      model: { provider: "anthropic", model: "test" },
    });
  for (const declaration of [{ loading: true }, { loadingSettleMs: 100 }])
    expect(
      capturePredicateIdentity(
        project,
        flowSchema.parse({
          ...flowInput,
          states: [{ ...flowInput.states[0], ...declaration }],
        }),
      ),
    ).not.toBe(capturePredicateIdentity(project, flow));
  for (const loadingSettleMs of [0, -1, 1.5, Infinity])
    expect(
      flowSchema.safeParse({
        ...flowInput,
        states: [{ ...flowInput.states[0], loadingSettleMs }],
      }).success,
    ).toBe(false);
});
test("acceptance requires original target's usable pixels and unchanged settings", () => {
  const before = evidenceTuple({ visualBlank: sampled() });
  const candidate = check().candidates[0];
  if (!candidate) throw Error("candidate");
  const contract = buildRuleContract(before, candidate, config).acceptance;
  const result = (evidence = sampled(10000)) =>
    evaluateRuleAcceptance({
      contract,
      currentA: [evidenceTuple({ visualBlank: evidence })],
      currentB: [evidenceTuple({ visualBlank: evidence })],
      config,
    }).status;
  expect(result()).toBe("passed");
  expect(result(sampled())).toBe("failed");
  for (const patch of [
    { masked: true },
    { exempt: "swatch" },
    { unavailable: "crop" },
    { pixels: undefined },
  ]) {
    const good = sampled(10000);
    good.records = good.records.map((r) => ({ ...r, ...patch }));
    expect(result(good)).toBe("not-recheckable");
  }
  expect(result(blankEvidence([]))).toBe("not-recheckable");
  expect(result({ ...sampled(10000), swatchSelectors: [".new"] })).toBe(
    "not-recheckable",
  );
});

test("legacy helpers use screenshotScale for horizontal-overflow full-page captures", () => {
  const e = sampleBlankMedia(
    blankEvidence(),
    () => png(0, 408, 300),
    { width: 204, height: 104 },
    undefined,
    408,
  );
  expect(e.records[0]?.pixels?.crop).toEqual({
    x: 2,
    y: 2,
    width: 200,
    height: 100,
  });
});
