import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { observePage } from "../src/checks/observe.js";
import type {
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { figmaObservation } from "../src/design/figma/normalize.js";
import type { FigmaNode } from "../src/design/figma/types.js";
import { matchElements } from "../src/design/match.js";

const at = (x: number, y: number, width: number, height: number) => ({
  absoluteBoundingBox: { x, y, width, height },
});
const figma = (children: FigmaNode[]) =>
  figmaObservation(
    {
      id: "1:1",
      name: "Screen",
      type: "FRAME",
      ...at(0, 0, 400, 400),
      children,
    },
    { viewport: { width: 400, height: 400 }, fileKey: "K" },
  );
/** The same tree as an app capture: no Figma attributes, app selectors. */
function asApp(
  obs: ObservationArtifactV2,
  edit: (e: ObservedElementV2) => void = () => undefined,
): ObservationArtifactV2 {
  const copy = structuredClone(obs);
  const rename = (s: string) => s.replace(/^figma:/, "app:");
  for (const e of copy.elements) {
    e.selector = rename(e.selector);
    e.ancestorSelectors = e.ancestorSelectors.map(rename);
    e.structuralPath = e.structuralPath.replace(/^figma/, "html");
    e.stableIslandPath = e.structuralPath;
    e.attributes = {};
    if (e.signals) e.signals.nodeId = undefined;
    edit(e);
  }
  return copy;
}
const twoTexts = [
  {
    id: "12:34",
    name: "Price",
    type: "TEXT",
    ...at(10, 10, 100, 20),
    characters: "Alpha",
  },
  {
    id: "12:35",
    name: "Total",
    type: "TEXT",
    ...at(10, 50, 100, 20),
    characters: "Beta",
  },
] satisfies FigmaNode[];

test("an app data-node-id shaped like a Figma id pins the match", () => {
  const design = figma(twoTexts);
  // The app labels its "Beta" element as Figma 12:34 although its text says Beta.
  const app = asApp(design, (e) => {
    if (e.selector === "app:12:35" && e.signals) e.signals.nodeId = "12:34";
  });
  const matches = matchElements(design, app);
  expect(matches.pairs.find((p) => p.design === "figma:12:34")).toMatchObject({
    app: "app:12:35",
    method: "data-node-id",
  });
});

test("a different Figma-shaped app id blocks; an app-local label never does", () => {
  const design = figma(twoTexts);
  const blocked = matchElements(
    design,
    asApp(design, (e) => {
      if (e.selector === "app:12:34" && e.signals) e.signals.nodeId = "12:99";
    }),
  );
  expect(blocked.pairs.find((p) => p.design === "figma:12:34")).toBeUndefined();
  const labelled = matchElements(
    design,
    asApp(design, (e) => {
      if (e.selector === "app:12:34" && e.signals) e.signals.nodeId = "card";
      if (e.selector === "app:12:35" && e.signals) e.signals.nodeId = "total";
    }),
  );
  expect(labelled.pairs.find((p) => p.design === "figma:12:34")?.app).toBe(
    "app:12:34",
  );
  expect(labelled.pairs.find((p) => p.design === "figma:12:35")?.app).toBe(
    "app:12:35",
  );
  expect(labelled.unmatchedDesign).toEqual([]);
});

test("layer names match data-idiom-name and accessible names; ids are stable", async () => {
  const design = figma([
    { id: "2:1", name: "Summary card", type: "FRAME", ...at(10, 10, 200, 60) },
    { id: "2:2", name: "Search", type: "FRAME", ...at(10, 100, 200, 60) },
    {
      id: "2:3",
      name: "Rectangle 4",
      type: "RECTANGLE",
      ...at(10, 200, 200, 60),
    },
  ]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 400, height: 400 },
    });
    // Reversed order, so position alone would mispair the named layers.
    await page.setContent(
      '<style>body{margin:0}div,nav{height:60px;width:200px}</style><nav aria-label="Search"></nav><div data-idiom-name="Summary card"></div><div></div>',
    );
    const app = (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      {
        designComparison: true,
      },
    )) as ObservationArtifactV2;
    const matches = matchElements(design, app);
    const tag = (p: (typeof matches.pairs)[number] | undefined) =>
      app.elements.find((e) => e.selector === p?.app);
    const named = matches.pairs.find((p) => p.design === "figma:2:1");
    expect(named?.method).toBe("data-idiom-name");
    expect(tag(named)?.attributes["data-idiom-name"]).toBe("Summary card");
    const search = matches.pairs.find((p) => p.design === "figma:2:2");
    expect(search?.method).toBe("role-name");
    expect(tag(search)?.tag).toBe("nav");
    expect(matchElements(design, app)).toEqual(matches);
  } finally {
    await browser.close();
  }
});

test("kind leniency holds whichever side the Figma element is on, except for inferred controls", () => {
  const design = figma([
    {
      id: "3:1",
      name: "Wrapper",
      type: "FRAME",
      ...at(10, 10, 300, 100),
      children: [
        { id: "3:2", name: "Hero", type: "RECTANGLE", ...at(20, 20, 100, 50) },
        {
          id: "3:3",
          name: "Buy button",
          type: "FRAME",
          ...at(150, 20, 100, 50),
        },
      ],
    },
  ]);
  const app = asApp(design, (e) => {
    if (e.selector === "app:3:2") e.tag = "img";
    if (e.selector === "app:3:3") {
      e.interactive = false;
      if (e.signals) e.signals.role = "";
    }
  });
  const matches = matchElements(design, app);
  expect(matches.pairs.find((p) => p.design === "figma:3:2")?.app).toBe(
    "app:3:2",
  );
  // The inferred button needs an interactive counterpart.
  expect(matches.pairs.find((p) => p.design === "figma:3:3")).toBeUndefined();
  const reversed = matchElements(app, design);
  expect(reversed.pairs.find((p) => p.app === "figma:3:2")?.design).toBe(
    "app:3:2",
  );
});

test("HTML-vs-HTML matching is unchanged by the Figma rules", async () => {
  const fixtures = join(import.meta.dirname, "fixtures/design-drift");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 500, height: 700 },
    });
    const observe = async (file: string) => {
      await page.setContent(await readFile(join(fixtures, file), "utf8"));
      return (await observePage(
        page,
        { status: "not-configured" },
        undefined,
        [],
        {
          designComparison: true,
        },
      )) as ObservationArtifactV2;
    };
    const design = await observe("design.html"),
      app = await observe("app.html");
    const matches = matchElements(design, app);
    // Recorded before the Figma change: node-id pairs keep node: ids.
    const ids = matches.pairs.filter((p) => p.method === "data-node-id");
    expect(ids.length).toBeGreaterThan(4);
    const { createHash } = await import("node:crypto");
    const card = design.elements.find((e) => e.signals?.nodeId === "card");
    expect(matches.pairs.find((p) => p.design === card?.selector)?.id).toBe(
      createHash("sha256").update("node:card").digest("hex").slice(0, 24),
    );
    // Recorded with the matcher as it was before the Figma rules.
    expect(matches).toMatchSnapshot();
  } finally {
    await browser.close();
  }
});
