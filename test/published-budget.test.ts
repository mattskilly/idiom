import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { publishedBudgetCheck } from "../src/checks/published-budget.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { CheckTuple, ObservationArtifactV2 } from "../src/checks/types.js";

const observations = (
  extra: Partial<ObservationArtifactV2> = {},
): ObservationArtifactV2 => ({
  version: 2,
  viewport: { width: 1280, height: 800 },
  document: {
    scrollWidth: 1280,
    scrollHeight: 800,
    clientWidth: 1280,
    clientHeight: 800,
  },
  elements: [],
  headings: [],
  tokens: { status: "not-configured" },
  maskMembership: [],
  images: [],
  failedImageRequests: [],
  ...extra,
});

const tuple = (overrides: Partial<CheckTuple> = {}): CheckTuple => ({
  flow: "site",
  state: "page-root",
  viewport: "1280",
  width: 1280,
  height: 800,
  metadataPath: "page-root/1280/metadata.json",
  artifactPaths: [],
  commit: "abc",
  createdAt: "2026-10-23T00:00:00.000Z",
  observations: observations(),
  axe: { violations: [] },
  console: [],
  mismatches: [],
  published: {},
  ...overrides,
});

const runCheck = (value: CheckTuple) =>
  publishedBudgetCheck.run({
    tuple: value,
    narrowViewport: false,
    config: checksConfigFrom(),
  });

test("a tuple that is not published is skipped", () => {
  expect(runCheck(tuple({ published: undefined }))).toEqual({
    coverage: {
      check: "published-budget",
      status: "skipped",
      reason: "flow is not published",
    },
    candidates: [],
  });
});

test("a clean published tuple runs and reports nothing", () => {
  expect(runCheck(tuple())).toEqual({
    coverage: { check: "published-budget", status: "ran" },
    candidates: [],
  });
});

test("serious and critical axe violations fail once per rule; moderate and minor do not", () => {
  const node = (target: string) => ({ target: [target], html: `<${target}>` });
  const result = runCheck(
    tuple({
      axe: {
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            nodes: [node("p"), node("a")],
          },
          { id: "image-alt", impact: "critical", nodes: [node("img")] },
          { id: "region", impact: "moderate", nodes: [node("div")] },
          { id: "landmark-one-main", impact: "minor", nodes: [node("body")] },
        ],
      },
    }),
  );
  expect(
    result.candidates.map(({ rule, severity, selectorHint }) => ({
      rule,
      severity,
      selectorHint,
    })),
  ).toEqual([
    {
      rule: "published:axe:color-contrast",
      severity: "blocker",
      selectorHint: "p",
    },
    {
      rule: "published:axe:image-alt",
      severity: "blocker",
      selectorHint: "img",
    },
  ]);
  expect(result.candidates[0]?.axeNodes).toHaveLength(2);
});

test("a failed image request names its URL and reason, without double-reporting a broken <img>", () => {
  const result = runCheck(
    tuple({
      observations: observations({
        images: [
          {
            selector: "img.hero",
            src: "/hero.png",
            currentSrc: "http://site.test/hero.png",
            complete: true,
            naturalWidth: 0,
            naturalHeight: 0,
            visible: true,
          },
          {
            selector: "img.lazy",
            src: "/lazy.png",
            currentSrc: "",
            complete: false,
            naturalWidth: 0,
            naturalHeight: 0,
            visible: true,
          },
        ],
        failedImageRequests: [
          { url: "http://site.test/hero.png", reason: "HTTP 404" },
          {
            url: "http://site.test/logo.svg",
            reason: "net::ERR_CONNECTION_REFUSED",
          },
        ],
      }),
    }),
  );
  expect(
    result.candidates.map(({ explanation, selectorHint }) => ({
      explanation,
      selectorHint,
    })),
  ).toEqual([
    {
      explanation:
        "Image http://site.test/hero.png did not load (naturalWidth 0).",
      selectorHint: "img.hero",
    },
    {
      explanation:
        "Image request http://site.test/logo.svg failed: net::ERR_CONNECTION_REFUSED.",
      selectorHint: "document",
    },
  ]);
});

test("pixel drift over budget fails with both percentages; at budget and without a baseline it passes", () => {
  const measured = (ratio: number) =>
    tuple({
      published: {
        maxDiffRatio: 0.01,
        pixel: {
          status: "measured",
          ratio,
          differentPixels: ratio * 1000,
          totalPixels: 1000,
          baseline: "/b.png",
        },
      },
    });
  const over = runCheck(measured(0.05));
  expect(over.candidates).toHaveLength(1);
  expect(over.candidates[0]?.rule).toBe("published:pixel-budget");
  expect(over.candidates[0]?.explanation).toBe(
    "5.00% of pixels differ from the recorded baseline (budget 1.00%).",
  );
  expect(runCheck(measured(0.01)).candidates).toEqual([]);
  expect(
    runCheck(
      tuple({
        published: { maxDiffRatio: 0.01, pixel: { status: "no-baseline" } },
      }),
    ),
  ).toEqual({
    coverage: { check: "published-budget", status: "ran" },
    candidates: [],
  });
  const unavailable = runCheck(
    tuple({
      published: {
        maxDiffRatio: 0.01,
        pixel: { status: "unavailable", reason: "cannot decode before PNG" },
      },
    }),
  );
  expect(unavailable.coverage.status).toBe("unavailable");
  expect(unavailable.coverage.reason).toContain("cannot decode before PNG");
});

test("a published tuple without the image signal says so instead of passing silently", () => {
  const {
    images: _images,
    failedImageRequests: _failed,
    ...older
  } = observations({
    document: {
      scrollWidth: 1352,
      scrollHeight: 800,
      clientWidth: 1280,
      clientHeight: 800,
    },
  });
  const result = runCheck(tuple({ observations: older }));
  expect(result.coverage).toEqual({
    check: "published-budget",
    status: "unavailable",
    reason: "could not measure: image signal (recapture)",
  });
  expect(result.candidates.map(({ rule }) => rule)).toEqual([
    "published:document-overflow",
  ]);
  expect(result.candidates[0]?.explanation).toBe(
    "The page is 1352px wide at the 1280px viewport (1280px client width).",
  );
});

test("observation artifacts load with and without the image fields", () => {
  const {
    images: _images,
    failedImageRequests: _failed,
    ...older
  } = observations();
  expect(observationArtifactSchema.safeParse(older).success).toBe(true);
  expect(
    observationArtifactSchema.safeParse(
      observations({
        images: [
          {
            selector: "img",
            src: "a.png",
            currentSrc: "http://x/a.png",
            complete: true,
            naturalWidth: 10,
            naturalHeight: 10,
            visible: true,
          },
        ],
        failedImageRequests: [{ url: "http://x/b.png", reason: "HTTP 500" }],
      }),
    ).success,
  ).toBe(true);
});
