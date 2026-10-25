import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { observePage } from "../src/checks/observe.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { checkMarks, checksConfigSchema } from "../src/schemas/project.js";
import { fixture, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const checks = {
  mirrored: [
    {
      name: "panel collapse",
      a: "#drawer-collapse",
      b: "#inspector-collapse",
      axis: "vertical",
    },
  ],
};
const reported = async (
  name: string,
  options: Parameters<typeof reviewFixture>[2] = { checks },
) =>
  (await reviewFixture(browser, await fixture(name), options))
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "mirrored-control");

test("drawer icon and inspector glyph report their measured differences (#24)", async () => {
  const before = await reported("mirrored-before.html");
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({
    rule: "idiom:mirrored-asymmetry",
    selectorHint: "#inspector-collapse",
    verification: {
      check: "mirrored-control",
      params: {
        differences: ["size", "kind", "placement"],
        panels: ["#drawer", "#inspector"],
      },
    },
  });
  expect(before[0]?.explanation).toContain("28×28px vs");
  expect(before[0]?.explanation).toContain("icon vs text glyph");
  expect(before[0]?.explanation).toMatch(
    /17px from its panel's canvas-facing edge vs [\d.]+px/,
  );
});

test.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])(
  "repaired mirrored controls stay quiet at $width px (#24)",
  async (viewport) => {
    expect(await reported("mirrored-after.html", { checks, viewport })).toEqual(
      [],
    );
  },
);

test("unconfigured controls are not compared (#24)", async () => {
  expect(await reported("mirrored-before.html", {})).toEqual([]);
});

const icon =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4 8 8 4 12" fill="none" stroke="currentColor"/></svg>';
const symmetricControls = (
  a: string,
  b: string,
) => `<!doctype html><html><head><style>
body { margin: 0; }
button { position: absolute; top: 30px; width: 28px; height: 28px; padding: 0; border: 0; font: 14px/20px Arial; }
svg { width: 16px; height: 16px; }
#a { left: 200px; } #b { left: 772px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; font-size: 30px; font-weight: 700; }
</style></head><body><button id="a" aria-label="Previous">${a}</button><button id="b" aria-label="Next">${b}</button></body></html>`;
const mirrored = { mirrored: [{ name: "navigation", a: "#a", b: "#b" }] };

test.each([
  [
    "screen-reader-only label beside an SVG",
    `${icon}<span class="sr-only">Previous</span>`,
    icon,
  ],
  ["display:none SVG beside a glyph", '«<svg style="display:none"></svg>', "»"],
  [
    "screen-reader-only label before visible text",
    '<span class="sr-only">Previous</span><span>«</span>',
    "<span>»</span>",
  ],
  [
    "graphic inside a clipped label",
    '«<span class="sr-only"><svg></svg>Previous</span>',
    "»",
  ],
])("symmetric controls ignore %s (#24)", async (_name, a, b) => {
  const results = await reviewFixture(browser, symmetricControls(a, b), {
    viewport: { width: 1000, height: 200 },
    checks: mirrored,
  });
  expect(
    results.filter(
      ({ candidate }) => candidate.category === "mirrored-control",
    ),
  ).toEqual([]);
});

const reviewTextControls = async (
  a: string,
  b: string,
  css = "",
  options: { checks?: unknown; extraHtml?: string } = {},
) => {
  const context = await browser.newContext({
    viewport: { width: 1000, height: 200 },
  });
  try {
    const page = await context.newPage();
    await page.setContent(
      symmetricControls(a, b)
        .replace("</style>", `${css}</style>`)
        .replace("</body>", `${options.extraHtml ?? ""}</body>`),
    );
    const settings = checksConfigSchema.parse(options.checks ?? mirrored);
    const observations = await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { marks: checkMarks(settings) },
    );
    // Real capture evidence, including generated/boxless owner fonts, survives
    // the stored-artifact schema before review consumes it.
    expect(observationArtifactSchema.parse(observations)).toEqual(observations);
    const reviewed = runDeterministicChecks(
      [
        {
          flow: "navigation",
          state: "ready",
          viewport: "desktop",
          width: 1000,
          height: 200,
          metadataPath: "ready/desktop/metadata.json",
          artifactPaths: [],
          commit: "fixture",
          createdAt: "2026-10-23T00:00:00.000Z",
          observations,
          console: [],
          mismatches: [],
        },
      ],
      undefined,
      checksConfigFrom(settings),
    );
    return {
      coverage: reviewed.coverage.find(
        ({ coverage }) => coverage.check === "mirrored-control",
      )?.coverage,
      candidates: reviewed.candidates.filter(
        ({ candidate }) => candidate.category === "mirrored-control",
      ),
    };
  } finally {
    await context.close();
  }
};
const textControls = async (a: string, b: string, css = "") => {
  const reviewed = await reviewTextControls(a, b, css);
  expect(reviewed.coverage?.status).toBe("ran");
  return reviewed.candidates;
};

test("display:contents text matches a direct glyph (#24)", async () => {
  expect(
    await textControls('<span style="display:contents">«</span>', "»"),
  ).toEqual([]);
});

test("display:contents owners retain their glyph fonts (#24)", async () => {
  const findings = await textControls(
    '<span style="display:contents; font-size:24px; font-weight:700">«</span>',
    '<span style="display:contents; font-size:12px; font-weight:400">»</span>',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.candidate.verification.params?.differences).toEqual([
    "font",
  ]);
  expect(findings[0]?.candidate.explanation).toContain("24px/700 vs 12px/400");
});

test.each(["before", "after"])(
  "generated ::%s text matches a direct glyph (#24)",
  async (pseudo) => {
    expect(
      await textControls(
        '<span class="pseudo"></span>',
        "»",
        `.pseudo::${pseudo} { content: '«'; }`,
      ),
    ).toEqual([]);
  },
);

test("generated glyphs retain their own pseudo-element fonts (#24)", async () => {
  const findings = await textControls(
    '<span class="pseudo"></span>',
    '<span class="pseudo"></span>',
    '.pseudo::before { content: "«"; } #a .pseudo::before { font:700 24px Arial; } #b .pseudo::before { font:400 12px Arial; }',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.candidate.verification.params?.differences).toEqual([
    "font",
  ]);
  expect(findings[0]?.candidate.explanation).toContain("24px/700 vs 12px/400");
});

test("unsupported generated content is unavailable rather than silently empty (#24)", async () => {
  const result = await reviewTextControls(
    '<span class="pseudo"></span>',
    '<span class="pseudo"></span>',
    ".pseudo::before { content: counter(step); }",
  );
  expect(result.candidates).toEqual([]);
  expect(result.coverage).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("unsupported generated content"),
  });
});

test("hidden generated text and text in display:none wrappers do not change kind (#24)", async () => {
  expect(
    await textControls(
      '«<span style="display:contents"><span style="display:none">Hidden</span></span><span class="pseudo"></span>',
      "»",
      '.pseudo::before { content: "Hidden"; display:none; font:700 24px Arial; }',
    ),
  ).toEqual([]);
});

test.each([false, true])(
  "unavailable pairs preserve supported findings (unavailable first: %s)",
  async (unavailableFirst) => {
    const collapse = { name: "collapse", a: "#a", b: "#b" };
    const numbered = { name: "numbered navigation", a: "#c", b: "#d" };
    const css =
      "#a { width: 40px; } #c { left:200px; top:90px; } #d { left:772px; top:90px; } .numbered::after { content:counter(item); }";
    const extraHtml =
      '<button id="c" class="numbered" aria-label="Previous item"></button><button id="d" class="numbered" aria-label="Next item"></button>';
    const alone = await reviewTextControls("«", "»", css, {
      extraHtml,
      checks: { mirrored: [collapse] },
    });
    expect(alone.coverage?.status).toBe("ran");
    expect(alone.candidates).toHaveLength(1);
    expect(
      alone.candidates[0]?.candidate.verification.params?.differences,
    ).toEqual(["size", "placement"]);
    const mixed = await reviewTextControls("«", "»", css, {
      extraHtml,
      checks: {
        mirrored: unavailableFirst
          ? [numbered, collapse]
          : [collapse, numbered],
      },
    });
    expect(mixed.candidates.map(({ candidate }) => candidate)).toEqual(
      alone.candidates.map(({ candidate }) => candidate),
    );
    expect(mixed.coverage).toMatchObject({
      status: "ran",
      reason: expect.stringContaining('unavailable: "numbered navigation":'),
    });
    expect(mixed.coverage?.reason).toContain("unsupported generated content");
  },
);
