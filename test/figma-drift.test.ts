import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import { matchElements } from "../src/design/match.js";
import { measureDrift } from "../src/design/measure.js";
import { figmaFixtureObservation } from "./figma-support.js";

const fixtures = join(import.meta.dirname, "fixtures/design-drift");
let browser: Browser;
let design: ObservationArtifactV2,
  app: ObservationArtifactV2,
  figma: ObservationArtifactV2;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
  const observe = async (html: string) => {
    await page.setContent(html);
    return (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { designComparison: true },
    )) as ObservationArtifactV2;
  };
  // Figma has no `outset` stroke; the reference keeps every other UA style.
  design = await observe(
    (await readFile(join(fixtures, "design.html"), "utf8")).replace(
      "</style>",
      "button{border-style:solid}</style>",
    ),
  );
  app = await observe(await readFile(join(fixtures, "app.html"), "utf8"));
  figma = await figmaFixtureObservation();
  await page.close();
});
afterAll(async () => {
  await browser?.close();
});

const summary = (candidates: ReturnType<typeof measureDrift>) =>
  candidates.map((c) => ({
    property: c.designDrift?.property,
    app: c.designDrift?.appSelector,
    severity: c.severity,
  }));

test("the Figma frame reproduces the HTML reference with no findings", () => {
  expect(summary(measureDrift(figma, design, checksConfigFrom()))).toEqual([]);
});

test("the Figma frame finds the seven planted departures, cited to Figma layers", () => {
  const html = measureDrift(design, app, checksConfigFrom());
  const candidates = measureDrift(figma, app, checksConfigFrom());
  // Element for element, Figma reports exactly what the HTML reference does.
  expect(summary(candidates)).toEqual(summary(html));
  const properties = candidates.map((c) => c.designDrift?.property);
  for (const property of [
    "borderTopLeftRadius",
    "gap.x",
    "fontWeight",
    "color",
    "missing",
    "extra",
    "text",
  ])
    expect(properties).toContain(property);
  expect(
    candidates.find((c) => c.designDrift?.property === "missing")?.severity,
  ).toBe("major");
  const roots = app.elements
    .filter((e) => e.tag === "html" || e.tag === "body")
    .map((e) => e.selector);
  expect(
    candidates.filter((c) => roots.includes(c.designDrift?.appSelector ?? "")),
  ).toEqual([]);
  const matches = matchElements(figma, app);
  const root = matches.pairs.filter((p) => p.method === "root");
  expect(root.map((p) => p.design)).toEqual(["figma:root", "figma:1:2"]);
  expect(
    root.map((p) => app.elements.find((e) => e.selector === p.app)?.tag),
  ).toEqual(["html", "body"]);
  for (const candidate of candidates.filter(
    (c) => c.designDrift?.property !== "extra",
  )) {
    expect(candidate.designDrift?.designLayerPath).toMatch(/^Checkout \/ main/);
    expect(candidate.designDrift?.designLink).toMatch(
      /^https:\/\/www\.figma\.com\/design\/AbCdEf123\/\?node-id=1-\d+$/,
    );
    expect(candidate.explanation).toContain("Figma");
  }
  const radius = candidates.find(
    (c) => c.designDrift?.property === "borderTopLeftRadius",
  );
  expect(radius?.designDrift).toMatchObject({
    designLayerPath: "Checkout / main / Card",
    designLink: "https://www.figma.com/design/AbCdEf123/?node-id=1-5",
    designVariable: "radius/card",
    designValue: "8px",
    appValue: "12px",
  });
  expect(radius?.explanation).toContain(
    'Figma "Checkout / main / Card" (radius/card) "8px"',
  );
  expect(
    candidates.find((c) => c.designDrift?.property === "gap.x")?.designDrift,
  ).toMatchObject({
    designVariable: "space/row",
    designValue: 16,
    appValue: 24,
  });
  expect(
    candidates.find((c) => c.designDrift?.property === "missing")?.designDrift
      ?.designLayerPath,
  ).toBe("Checkout / main / Button");
});

test("app elements labelled with their own data-node-id still pair with Figma layers", () => {
  const matches = matchElements(figma, app);
  for (const label of [
    "main",
    "card",
    "row",
    "first",
    "second",
    "weight",
    "colour",
  ]) {
    const element = app.elements.find((e) => e.signals?.nodeId === label);
    expect(element, label).toBeDefined();
    const pair = matches.pairs.find((p) => p.app === element?.selector);
    expect(pair?.design, label).toMatch(/^figma:/);
  }
  expect(matchElements(figma, app)).toEqual(matches);
  // Pair ids derive from Figma node ids, so they are stable.
  const card = matches.pairs.find((p) => p.design === "figma:1:5");
  expect(card?.id).toBeDefined();
  expect(
    matchElements(figma, design).pairs.find((p) => p.design === "figma:1:5")
      ?.id,
  ).toBe(card?.id);
});
