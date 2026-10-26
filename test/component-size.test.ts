import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import { reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

test("default component tolerance reports 12px dots and allows 8.5px dots declared at 8px", async () => {
  const html = await readFile(
    join(import.meta.dirname, "fixtures/component-size/dots.html"),
    "utf8",
  );
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "dots", html }],
    {
      checks: {
        components: [
          { name: "oversize dot", selector: ".oversize", width: 8, height: 8 },
          { name: "subpixel dot", selector: ".subpixel", width: 8, height: 8 },
        ],
      },
    },
  );
  const observations = tuples[0]?.observations;
  if (observations?.version !== 2) throw new Error("expected v2 capture");
  expect(
    observations.components?.map(({ rects }) =>
      rects.map(({ width, height }) => [width, height]),
    ),
  ).toEqual([
    [
      [12, 12],
      [12, 12],
    ],
    [[8.5, 8.5]],
  ]);
  const reported = findings.filter(
    ({ candidate }) => candidate.category === "component-size",
  );
  expect(reported).toHaveLength(1);
  expect(reported[0]?.candidate.explanation).toContain(
    '2 of 2 "oversize dot" elements render at 12×12px',
  );
  expect(reported[0]?.candidate.explanation).toContain("(±1×1px)");
  expect(observations.components?.map(({ tolerance }) => tolerance)).toEqual([
    { ratio: 0.15, px: 1, mode: "tighter" },
    { ratio: 0.15, px: 1, mode: "tighter" },
  ]);
  const persisted = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(observations)),
  );
  const offline = runDeterministicChecks(
    tuples.map((tuple) => ({ ...tuple, observations: persisted })),
  );
  expect(
    offline.candidates
      .filter(({ candidate }) => candidate.category === "component-size")
      .map(({ candidate }) => candidate),
  ).toEqual(reported.map(({ candidate }) => candidate));

  // A historical artifact retains max semantics with its recorded numbers.
  const legacy = observationArtifactSchema.parse({
    ...persisted,
    components: observations.components?.map((component) => ({
      ...component,
      tolerance: { ratio: 0.25, px: 4 },
    })),
  });
  expect(
    runDeterministicChecks(
      tuples.map((tuple) => ({ ...tuple, observations: legacy })),
    ).candidates.filter(
      ({ candidate }) => candidate.category === "component-size",
    ),
  ).toEqual([]);
});

test.each([
  { tolerance: {}, applied: { ratio: 0.25, px: 4, mode: "looser" }, count: 0 },
  {
    tolerance: { ratio: 0.25, px: 4 },
    applied: { ratio: 0.25, px: 4, mode: "looser" },
    count: 0,
  },
  {
    tolerance: { ratio: 0.25, px: 4, mode: "tighter" },
    applied: { ratio: 0.25, px: 4, mode: "tighter" },
    count: 1,
  },
])(
  "explicit tolerance $tolerance survives capture and offline review",
  async ({ tolerance, applied, count }) => {
    const html = await readFile(
      join(import.meta.dirname, "fixtures/component-size/dots.html"),
      "utf8",
    );
    const { findings, tuples } = await reviewStates(
      browser,
      [{ state: "dots", html }],
      {
        checks: {
          components: [
            {
              name: "override dot",
              selector: ".oversize",
              width: 8,
              height: 8,
              tolerance,
            },
          ],
        },
      },
    );
    const reported = findings.filter(
      ({ candidate }) => candidate.category === "component-size",
    );
    expect(reported).toHaveLength(count);
    if (count > 0)
      expect(reported[0]?.candidate.explanation).toContain("(±2×2px)");
    const savedTuples = tuples.map((tuple) => {
      const observations = observationArtifactSchema.parse(
        JSON.parse(JSON.stringify(tuple.observations)),
      );
      if (observations.version !== 2) throw new Error("expected v2 capture");
      expect(observations.components?.[0]?.tolerance).toEqual(applied);
      expect(observations.components?.[0]?.rects).toHaveLength(2);
      return { ...tuple, observations };
    });
    expect(
      runDeterministicChecks(savedTuples)
        .candidates.filter(
          ({ candidate }) => candidate.category === "component-size",
        )
        .map(({ candidate }) => candidate),
    ).toEqual(reported.map(({ candidate }) => candidate));
  },
);

const inferredComponents = (
  tuples: Awaited<ReturnType<typeof reviewStates>>["tuples"],
) => {
  const observations = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(tuples[0]?.observations)),
  );
  if (observations.version !== 2) throw new Error("expected v2 capture");
  return observations.components ?? [];
};
const sizeFindings = (
  findings: Awaited<ReturnType<typeof reviewStates>>["findings"],
) =>
  findings
    .filter(({ candidate }) => candidate.category === "component-size")
    .map(({ candidate }) => candidate);

test("a size stated in DESIGN.md resolves its selector from class words and is judged", async () => {
  const html = await readFile(
    join(import.meta.dirname, "fixtures/component-size/dots.html"),
    "utf8",
  );
  const design = "# Layers\n\nOverride dots are about 8px.\n";
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "dots", html }],
    { design },
  );
  expect(
    inferredComponents(tuples).map(
      ({ name, selector, width, height, rects, inferred }) => ({
        name,
        selector,
        width,
        height,
        rects: rects.length,
        inferred,
      }),
    ),
  ).toEqual([
    {
      name: "override dot",
      selector: ".bp-override-dot",
      width: 8,
      height: 8,
      rects: 3,
      inferred: { source: "DESIGN.md:3", words: ["override", "dot"] },
    },
  ]);
  expect(sizeFindings(findings)).toMatchObject([
    {
      explanation:
        '2 of 3 "override dot" elements render at 12×12px; the design specifies 8×8px (±1×1px) (inferred from DESIGN.md:3).',
    },
  ]);
  // Explicit config wins by name, and by selector.
  for (const component of [
    { name: "Override dots", selector: ".subpixel", width: 8, height: 8 },
    { name: "big dot", selector: ".bp-override-dot", width: 12, height: 12 },
  ]) {
    const explicit = await reviewStates(browser, [{ state: "dots", html }], {
      design,
      checks: { components: [component] },
    });
    expect(
      inferredComponents(explicit.tuples).map(({ name, inferred }) => ({
        name,
        inferred,
      })),
    ).toEqual([{ name: component.name, inferred: undefined }]);
  }
}, 60_000);

test("inferred selectors prefer the most-used token, fall back to aria-label, and stay unresolved otherwise", async () => {
  const html = `<!doctype html><style>span{display:inline-block;width:8px;height:8px}
    .chip{display:inline-block;width:60px;height:30px}</style><main>
    <span class="x-override-dot"></span><span class="x-override-dot"></span>
    <span class="x-override-dot-tooltip"></span>
    <span aria-label="Status indicator" style="width:10px;height:10px"></span>
    <span class="chip">A</span></main>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "mixed", html }],
    {
      design: [
        "Override dots are 8px.",
        "Status indicators are 6px.",
        "Chips 24px high.",
        "Toggle avatars are 32px.",
      ].join("\n"),
    },
  );
  expect(
    inferredComponents(tuples).map(
      ({ name, selector, rects, inferred, unresolved }) => ({
        name,
        selector,
        rects: rects.length,
        axis: inferred?.axis,
        unresolved,
      }),
    ),
  ).toEqual([
    {
      name: "override dot",
      selector: ".x-override-dot",
      rects: 2,
      axis: undefined,
      unresolved: undefined,
    },
    {
      name: "status indicator",
      selector: '[aria-label="Status indicator"]',
      rects: 1,
      axis: undefined,
      unresolved: undefined,
    },
    {
      name: "chip",
      selector: ".chip",
      rects: 1,
      axis: "height",
      unresolved: undefined,
    },
    {
      name: "toggle avatar",
      selector: "",
      rects: 0,
      axis: undefined,
      unresolved: true,
    },
  ]);
  expect(sizeFindings(findings).map(({ explanation }) => explanation)).toEqual([
    '1 of 1 "status indicator" elements render at 10×10px; the design specifies 6×6px (±0.9×0.9px) (inferred from DESIGN.md:2).',
    '1 of 1 "chip" elements render at 60×30px; the design specifies 24px high (±1px) (inferred from DESIGN.md:3).',
  ]);
  // A one-axis spec ignores the other axis.
  const fine = await reviewStates(
    browser,
    [{ state: "chip", html: html.replace("height:30px", "height:24px") }],
    { design: "Chips 24px high." },
  );
  expect(sizeFindings(fine.findings)).toEqual([]);
}, 60_000);

test("a shape name matched only by its modifier resolves textless elements, never textful controls", async () => {
  const html = `<!doctype html><style>.layer-override{display:inline-block;width:12px;height:12px;border-radius:50%;background:#36c}
    .layer-override-menu{width:80px;height:24px}</style><main>
    <span class="layer-override" role="img" aria-label="Has tablet overrides"></span>
    <span class="layer-override" role="img" aria-label="Has mobile overrides"></span>
    <button class="layer-override-menu">Overrides</button></main>`;
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "dots", html }],
    { design: "Override dots are small (about 8px).\n" },
  );
  expect(
    inferredComponents(tuples).map(({ name, selector, rects, inferred }) => ({
      name,
      selector,
      rects: rects.map((rect) => [rect.width, rect.height]),
      inferred,
    })),
  ).toEqual([
    {
      name: "override dot",
      selector: ".layer-override",
      rects: [
        [12, 12],
        [12, 12],
      ],
      inferred: {
        source: "DESIGN.md:1",
        words: ["override", "dot"],
        matchedBy: "modifier",
      },
    },
  ]);
  expect(sizeFindings(findings).map(({ explanation }) => explanation)).toEqual([
    '2 of 2 "override dot" elements render at 12×12px; the design specifies 8×8px (±1×1px) (inferred from DESIGN.md:1).',
  ]);
  // Only a textful control carries the modifier: nothing is selected.
  const textful = await reviewStates(
    browser,
    [
      {
        state: "menu",
        html: html.replace(/<span class="layer-override"[^>]*><\/span>/g, ""),
      },
    ],
    { design: "Override dots are small (about 8px).\n" },
  );
  expect(inferredComponents(textful.tuples)).toMatchObject([
    { name: "override dot", selector: "", rects: [], unresolved: true },
  ]);
}, 60_000);
