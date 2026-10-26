import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { addDesignCommand } from "../src/commands/design.js";
import { initProject } from "../src/commands/init.js";
import {
  designReferences,
  selectDesignViewport,
} from "../src/design/references.js";
import { designDeclarationSchema } from "../src/schemas/design.js";
import { flowSchema } from "../src/schemas/flow.js";
import { validateProject } from "../src/validation.js";
import { FIGMA_URL } from "./figma-support.js";

const viewports = [
  { name: "desktop", width: 1440 },
  { name: "tablet", width: 800 },
  { name: "wide-tablet", width: 840 },
  { name: "mobile", width: 390 },
];

test("declaration forms parse and resolve to named references", () => {
  for (const ok of [
    "design.html",
    FIGMA_URL,
    {
      source: FIGMA_URL,
      name: "figma",
      viewport: "mobile",
      colorScheme: "dark",
    },
    ["a.html", { source: FIGMA_URL }],
  ])
    expect(designDeclarationSchema.safeParse(ok).success).toBe(true);
  for (const bad of [
    [],
    { source: "a.html", name: "Bad Name" },
    { source: "a.html", extra: 1 },
    [
      { source: "a.html", name: "same" },
      { source: "b.html", name: "same" },
    ],
  ])
    expect(designDeclarationSchema.safeParse(bad).success).toBe(false);
  expect(designReferences({ design: "a.html" })).toEqual([
    { name: "design", source: "a.html", figma: false },
  ]);
  expect(
    designReferences({
      design: [
        "a.html",
        "b.html",
        FIGMA_URL,
        { source: FIGMA_URL, viewport: "mobile" },
        { source: "c.html", name: "design-2" },
      ],
    }).map((r) => r.name),
  ).toEqual(["design", "design-3", "figma", "figma-2", "design-2"]);
  expect(designReferences({})).toEqual([]);
  const flow = flowSchema.safeParse({
    id: "x",
    title: "x",
    intent: [],
    setup: [],
    states: [
      {
        id: "a",
        description: "a",
        url: "/",
        expect: {},
        design: [
          { source: "a.html", name: "one" },
          { source: "b.html", name: "one" },
        ],
      },
    ],
  });
  expect(flow.success).toBe(false);
  expect(JSON.stringify(flow.error?.issues)).toContain(
    "duplicate design reference name one",
  );
});

test("site references join declarations and default to the site name", () => {
  const design = designDeclarationSchema.parse([
    { site: "https://example.test/pricing" },
    { site: "https://example.test/", name: "home", colorScheme: "dark" },
    "design.png",
    { site: "https://example.test/other" },
  ]);
  expect(designReferences({ design })).toEqual([
    {
      name: "site",
      source: { site: "https://example.test/pricing" },
      figma: false,
    },
    {
      name: "home",
      source: { site: "https://example.test/" },
      figma: false,
      colorScheme: "dark",
    },
    { name: "design", source: "design.png", figma: false },
    {
      name: "site-2",
      source: { site: "https://example.test/other" },
      figma: false,
    },
  ]);
});

test("viewport selection: nearest width, earlier on ties, explicit override", () => {
  expect(selectDesignViewport({}, 375, viewports)).toBe("mobile");
  expect(selectDesignViewport({}, 1280, viewports)).toBe("desktop");
  expect(selectDesignViewport({}, 820, viewports)).toBe("tablet");
  expect(selectDesignViewport({ viewport: "desktop" }, 375, viewports)).toBe(
    "desktop",
  );
});

test("validate rejects an unknown design viewport; design add upserts named references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-refs-"));
  try {
    await initProject({ project: directory, yes: true });
    const file = join(directory, ".idiom", "flows", "example.json");
    const raw = {
      id: "example",
      title: "Example",
      intent: [],
      setup: [],
      states: [{ id: "home", description: "Home", url: "/", expect: {} }],
    };
    await writeFile(
      file,
      JSON.stringify({
        ...raw,
        states: [
          { ...raw.states[0], design: { source: "a.html", viewport: "watch" } },
        ],
      }),
    );
    await expect(validateProject({ project: directory })).rejects.toThrow(
      /design\.viewport: unknown project viewport "watch"/,
    );
    await writeFile(
      file,
      JSON.stringify({
        ...raw,
        states: [{ ...raw.states[0], design: "a.html" }],
      }),
    );
    await addDesignCommand({
      project: directory,
      cwd: directory,
      state: "home",
      source: FIGMA_URL,
      name: "figma",
      viewport: "mobile",
    });
    const design = () =>
      readFile(file, "utf8").then((t) => JSON.parse(t).states[0].design);
    expect(await design()).toEqual([
      { source: "a.html" },
      { source: FIGMA_URL, name: "figma", viewport: "mobile" },
    ]);
    await addDesignCommand({
      project: directory,
      cwd: directory,
      state: "home",
      source: "b.html",
      name: "figma",
    });
    expect(await design()).toEqual([
      { source: "a.html" },
      { source: "b.html", name: "figma" },
    ]);
    await expect(
      addDesignCommand({
        project: directory,
        cwd: directory,
        state: "home",
        source: "b.html",
        viewport: "watch",
      }),
    ).rejects.toThrow("Unknown project viewport");
    await addDesignCommand({
      project: directory,
      cwd: directory,
      state: "home",
      source: "c.html",
    });
    expect(await design()).toBe("c.html");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
