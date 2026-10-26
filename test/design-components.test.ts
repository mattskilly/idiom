import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  inferDesignComponents,
  loadDesignComponents,
  mergeInferredComponents,
} from "../src/checks/design-components.js";
import { projectSchema } from "../src/schemas/project.js";

const infer = (markdown: string) =>
  inferDesignComponents(markdown, "DESIGN.md");

test("size statements next to a name become inferred components with their line", () => {
  expect(
    infer(
      [
        "# Chrome",
        "",
        "Override dots mark a per-breakpoint override; they are about 8px, never larger than the type x-height.",
        "Chips 24px high hold one filter each.",
        "Cards are 320×200px.",
        "The side panel is 280px wide.",
        "Status indicator: 6px.",
      ].join("\n"),
    ),
  ).toEqual([
    {
      name: "override dot",
      words: ["override", "dot"],
      width: 8,
      height: 8,
      source: "DESIGN.md:3",
    },
    { name: "chip", words: ["chip"], height: 24, source: "DESIGN.md:4" },
    {
      name: "card",
      words: ["card"],
      width: 320,
      height: 200,
      source: "DESIGN.md:5",
    },
    {
      name: "side panel",
      words: ["side", "panel"],
      width: 280,
      source: "DESIGN.md:6",
    },
    {
      name: "status indicator",
      words: ["status", "indicator"],
      width: 6,
      height: 6,
      source: "DESIGN.md:7",
    },
  ]);
  expect(infer("Override dots are about 8px.")).toMatchObject([
    { name: "override dot", width: 8, height: 8 },
  ]);
  expect(infer("- **Override dots** … about 8px")).toMatchObject([
    { name: "override dot", width: 8, height: 8 },
  ]);
});

test("a size in a filler-only parenthetical names the sentence's subject", () => {
  expect(infer("Status dots are small (about 8px).")).toEqual([
    {
      name: "status dot",
      words: ["status", "dot"],
      width: 8,
      height: 8,
      source: "DESIGN.md:1",
    },
  ]);
  // The shape real design files use: a bold lead-in, then the subject.
  expect(
    infer(
      "- **Indicators are quiet.** Override dots and status marks are small (about 8px) and sized to the type.",
    ),
  ).toMatchObject([{ name: "override dot", width: 8, height: 8 }]);
  // Tables and fenced code still infer nothing.
  expect(infer("| Dot | (about 8px) |")).toEqual([]);
  expect(infer("```\nStatus dots are small (about 8px).\n```")).toEqual([]);
  // A named parenthetical keeps its own name.
  expect(infer("Rows (chips 24px high) stack.")).toMatchObject([
    { name: "chip", height: 24 },
  ]);
});

test("ambiguous sizes, token tables, fenced code and repeats are not components", () => {
  expect(infer("Buttons 32px.")).toEqual([]);
  expect(infer("Spacing steps are 4px and 8px.")).toEqual([]);
  expect(infer("Body text is 16px; line height 24px high.")).toEqual([]);
  expect(infer("Use a 4px radius on everything.")).toEqual([]);
  expect(infer("```css\n.chips { height: 24px high }\n```")).toEqual([]);
  expect(infer("```idiom-ruling\nchips 24px high\n```\nNothing else.")).toEqual(
    [],
  );
  expect(
    infer("Chips 24px high.\nChips 28px high.").map((c) => c.height),
  ).toEqual([24]);
  expect(infer("--space-8px tokens; ab 8px high")).toEqual([]);
  // Shapes seen in real design files.
  expect(infer("- **Sizing:** 20px tall, 8px horizontal padding.")).toEqual([]);
  expect(
    infer("The button has a transparent hit area of at least 44×44px."),
  ).toEqual([]);
  expect(infer("Phosphor Quotes icon at 32px in blue.")).toMatchObject([
    { name: "phosphor quote icon", width: 32, height: 32 },
  ]);
});

test("explicit components with the same name win; a missing design file infers nothing", async () => {
  const inferred = infer("Override dots are about 8px. Chips 24px high.");
  expect(
    mergeInferredComponents(
      [
        {
          name: "Override dots",
          selector: ".dot",
          width: 8,
          height: 8,
          tolerance: { ratio: 0.15, px: 1, mode: "tighter" },
        },
      ],
      inferred,
    ).map((c) => c.name),
  ).toEqual(["chip"]);
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-components-"));
  const project = projectSchema.parse({
    version: 1,
    app: { name: "Design", framework: "other" },
    server: {
      build: "true",
      start: "true",
      port: 3000,
      readyUrl: "http://localhost:3000",
      env: {},
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
    viewports: [{ name: "desktop", width: 1440, height: 900 }],
  });
  expect(await loadDesignComponents(directory, project)).toEqual([]);
  await writeFile(join(directory, "DESIGN.md"), "Chips 24px high.\n");
  expect(await loadDesignComponents(directory, project)).toEqual([
    { name: "chip", words: ["chip"], height: 24, source: "DESIGN.md:1" },
  ]);
});
