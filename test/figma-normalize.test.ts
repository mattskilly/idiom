import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { figmaObservation } from "../src/design/figma/normalize.js";
import type { FigmaNode } from "../src/design/figma/types.js";
import {
  figmaFixtureObservation,
  figmaFrameDocument,
} from "./figma-support.js";

const solid = (r: number, g: number, b: number, extra = {}) => ({
  type: "SOLID",
  color: { r: r / 255, g: g / 255, b: b / 255, a: 1 },
  ...extra,
});
const frame = (children: FigmaNode[], width = 375): FigmaNode => ({
  id: "9:1",
  name: "Mobile",
  type: "FRAME",
  absoluteBoundingBox: { x: 50, y: 60, width, height: 812 },
  fills: [solid(250, 250, 250)],
  children,
});
const at = (x: number, y: number, width: number, height: number) => ({
  absoluteBoundingBox: { x: 50 + x, y: 60 + y, width, height },
});
const observe = (node: FigmaNode, width = 390) =>
  figmaObservation(node, {
    viewport: { width, height: 844 },
    fileKey: "Key1",
  });
const byId = (obs: ReturnType<typeof observe>, id: string) =>
  obs.elements.find((e) => e.selector === `figma:${id}`);

test("root shape: a synthetic transparent html and the frame as body", async () => {
  const obs = observe(
    frame([
      { id: "9:2", name: "Card", type: "RECTANGLE", ...at(10, 20, 100, 40) },
    ]),
  );
  const [html, body, card] = obs.elements;
  expect(obs.elements.filter((e) => e.tag === "html")).toHaveLength(1);
  expect(html).toMatchObject({
    selector: "figma:root",
    structuralPath: "figma",
    rect: { x: 0, y: 0, width: 390, height: 812 },
    attributes: { "data-idiom-source": "figma" },
  });
  expect(html?.styles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(html?.attributes["data-figma-id"]).toBeUndefined();
  expect(body).toMatchObject({
    selector: "figma:9:1",
    tag: "body",
    structuralPath: "figma/0",
    ancestorSelectors: ["figma:root"],
    rect: { x: 0, y: 0, width: 390, height: 812 },
  });
  expect(body?.styles.backgroundColor).toBe("rgb(250, 250, 250)");
  expect(body?.attributes).toMatchObject({
    "data-figma-id": "9:1",
    "data-figma-link": "https://www.figma.com/design/Key1/?node-id=9-1",
    "data-figma-frame-width": "375",
  });
  // A 375 frame at a 390 viewport: roots snap, children keep frame-relative bounds.
  expect(card).toMatchObject({
    structuralPath: "figma/0/0",
    ancestorSelectors: ["figma:9:1", "figma:root"],
    rect: { x: 10, y: 20, width: 100, height: 40 },
  });
  expect(observationArtifactSchema.parse(obs)).toEqual(obs);
  expect(obs.viewport).toEqual({ width: 390, height: 844 });
  expect(obs.document.scrollHeight).toBe(812);
});

test("styles: radii, strokes, fills, text and wrapper folding", () => {
  const obs = observe(
    frame([
      {
        id: "1:1",
        name: "Rounded",
        type: "RECTANGLE",
        ...at(0, 0, 10, 10),
        cornerRadius: 6,
      },
      {
        id: "1:2",
        name: "Corners",
        type: "RECTANGLE",
        ...at(0, 0, 10, 10),
        rectangleCornerRadii: [1, 2, 3, 4],
      },
      {
        id: "1:3",
        name: "Strokes",
        type: "FRAME",
        ...at(0, 0, 10, 10),
        strokes: [solid(255, 0, 0)],
        strokeWeight: 2,
        individualStrokeWeights: { top: 1, right: 0, bottom: 3, left: 2 },
      },
      {
        id: "1:4",
        name: "Alpha",
        type: "RECTANGLE",
        ...at(0, 0, 10, 10),
        fills: [solid(0, 0, 255, { opacity: 0.5 })],
      },
      {
        id: "1:5",
        name: "Gradient",
        type: "RECTANGLE",
        ...at(0, 0, 10, 10),
        fills: [{ type: "GRADIENT_LINEAR" }],
      },
      {
        id: "1:6",
        name: "Label",
        type: "TEXT",
        ...at(0, 0, 80, 40),
        characters: "Two  lines",
        fills: [solid(10, 20, 30)],
        style: {
          fontFamily: "Inter",
          fontWeight: 600,
          fontSize: 14,
          lineHeightPx: 20,
          letterSpacing: 0.5,
          textAlignHorizontal: "CENTER",
        },
      },
      {
        id: "1:7",
        name: "Intrinsic",
        type: "TEXT",
        ...at(0, 0, 10, 10),
        characters: "x",
        style: {
          fontSize: 12,
          lineHeightPx: 14,
          lineHeightUnit: "INTRINSIC_%",
        },
      },
      {
        id: "1:8",
        name: "Hidden",
        type: "RECTANGLE",
        visible: false,
        ...at(0, 0, 10, 10),
      },
      {
        id: "1:9",
        name: "Ghost",
        type: "RECTANGLE",
        opacity: 0,
        ...at(0, 0, 10, 10),
      },
      { id: "1:10", name: "Frame 3", type: "FRAME", ...at(0, 0, 0, 10) },
      {
        id: "1:11",
        name: "Primary CTA",
        type: "INSTANCE",
        ...at(0, 0, 120, 44),
        fills: [solid(0, 0, 0)],
        children: [
          {
            id: "I1:11;2:1",
            name: "Text",
            type: "TEXT",
            ...at(10, 10, 60, 20),
            characters: "Continue",
            fills: [solid(255, 255, 255)],
            style: { fontSize: 16, fontWeight: 700, lineHeightPx: 20 },
          },
        ],
      },
      {
        id: "1:12",
        name: "Icon",
        type: "VECTOR",
        ...at(0, 0, 16, 16),
        fills: [solid(1, 2, 3)],
        strokes: [solid(4, 5, 6)],
      },
      { id: "1:13", name: "Frame 12", type: "FRAME", ...at(0, 0, 10, 10) },
    ]),
  );
  expect(byId(obs, "1:1")?.styles.borderBottomLeftRadius).toBe("6px");
  expect(
    [
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomRightRadius",
      "borderBottomLeftRadius",
    ].map((k) => byId(obs, "1:2")?.styles[k as "borderTopLeftRadius"]),
  ).toEqual(["1px", "2px", "3px", "4px"]);
  expect(byId(obs, "1:3")?.styles).toMatchObject({
    borderTopWidth: "1px",
    borderRightWidth: "0px",
    borderRightStyle: "none",
    borderBottomWidth: "3px",
    borderLeftWidth: "2px",
    borderLeftStyle: "solid",
    borderLeftColor: "rgb(255, 0, 0)",
  });
  expect(byId(obs, "1:4")?.styles.backgroundColor).toBe("rgba(0, 0, 255, 0.5)");
  expect(byId(obs, "1:5")?.styles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(byId(obs, "1:6")).toMatchObject({
    tag: "span",
    directText: "Two lines",
    styles: {
      color: "rgb(10, 20, 30)",
      backgroundColor: "rgba(0, 0, 0, 0)",
      fontFamily: "Inter",
      fontSize: "14px",
      fontWeight: "600",
      lineHeight: "20px",
      letterSpacing: "0.5px",
      textAlign: "center",
    },
    signals: { lineCount: 2 },
  });
  expect(byId(obs, "1:7")?.styles.lineHeight).toBe("normal");
  for (const id of ["1:8", "1:9", "1:10"])
    expect(byId(obs, id)).toBeUndefined();
  const cta = byId(obs, "1:11");
  expect(cta).toMatchObject({
    directText: "Continue",
    interactive: true,
    signals: { role: "button", name: "Primary CTA" },
    styles: {
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(0, 0, 0)",
      fontWeight: "700",
    },
  });
  expect(byId(obs, "I1:11;2:1")).toBeUndefined();
  expect(byId(obs, "1:12")).toMatchObject({
    tag: "svg",
    styles: { fill: "rgb(1, 2, 3)", stroke: "rgb(4, 5, 6)" },
    signals: { hasGraphic: true },
  });
  expect(byId(obs, "1:13")?.attributes["data-figma-name"]).toBeUndefined();
  expect(byId(obs, "1:11")?.attributes).toMatchObject({
    "data-figma-name": "Primary CTA",
    "data-figma-path": "Mobile / Primary CTA",
  });
});

test("the fixture frame resolves variables, layer paths and names, and is byte-stable", async () => {
  const obs = await figmaFixtureObservation();
  const card = byId(obs, "1:5");
  expect(JSON.parse(card?.attributes["data-figma-variables"] ?? "{}")).toEqual({
    backgroundColor: "color/surface",
    borderTopLeftRadius: "radius/card",
  });
  expect(card?.attributes["data-figma-path"]).toBe("Checkout / main / Card");
  expect(
    JSON.parse(byId(obs, "1:6")?.attributes["data-figma-variables"] ?? "{}"),
  ).toEqual({ gap: "space/row" });
  expect(byId(obs, "1:6")?.styles).toMatchObject({
    display: "flex",
    flexDirection: "row",
    gap: "16px",
  });
  expect(byId(obs, "1:7")?.attributes["data-figma-name"]).toBeUndefined();
  expect(byId(obs, "1:7")?.attributes["data-figma-path"]).toBe(
    "Checkout / main / Row / Rectangle 1",
  );
  expect(byId(obs, "1:14")).toBeUndefined();
  expect(byId(obs, "1:16")).toBeUndefined();
  const without = await figmaFixtureObservation(undefined, false);
  expect(
    byId(without, "1:5")?.attributes["data-figma-variables"],
  ).toBeUndefined();
  expect(JSON.stringify(await figmaFixtureObservation())).toBe(
    JSON.stringify(obs),
  );
  expect(await figmaFrameDocument()).toBeDefined();
});
