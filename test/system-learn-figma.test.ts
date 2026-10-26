import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import type { FigmaVariables } from "../src/design/figma/types.js";
import { parseFigmaUrl } from "../src/design/figma/url.js";
import { figmaVariableTokens } from "../src/system/learn/figma.js";
import { runSystemLearning } from "../src/system/learn/run.js";
import { runSystem } from "../src/system/run.js";
import {
  FIGMA_FILE_URL,
  figmaFixture,
  recordedFigma,
  throwingFigma,
} from "./figma-support.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), "idiom-learn-figma-"));
  roots.push(root);
  await initProject({ project: root, yes: true, write: () => {} });
  return root;
}
const ref = () => {
  const parsed = parseFigmaUrl(FIGMA_FILE_URL);
  if (!parsed) throw new Error("url");
  return parsed;
};

test("variables become colour, radius, spacing and other tokens with themes and aliases", async () => {
  const variables = (await figmaFixture("variables.json")) as FigmaVariables;
  const { tokens } = figmaVariableTokens(variables, "cache.json");
  const by = (key: string, theme?: string) =>
    tokens.find((t) => t.source.key === key && t.theme === theme);
  expect(by("Colors/color/surface")).toMatchObject({
    kind: "color",
    value: "#f0f0f0",
    name: "color/surface",
  });
  expect(by("Colors/color/surface", "dark")?.value).toBe("#1e1e1e");
  expect(by("Colors/color/accent")?.value).toBe("#143c78");
  expect(by("Colors/color/accent", "dark")?.value).toBe("#78a0dc");
  expect(by("Colors/color/scrim")?.value).toBe("#00000080");
  expect(by("Colors/color/scrim", "dark")?.value).toBe("#000000cc");
  expect(by("Layout/radius/card")).toMatchObject({
    kind: "radius",
    value: "8px",
  });
  expect(by("Layout/space/row")).toMatchObject({
    kind: "spacing",
    value: "16px",
  });
  expect(by("Layout/size/icon")).toMatchObject({
    kind: "other",
    value: "20px",
  });
  // Single-mode collections carry no theme; booleans and remote variables are skipped.
  expect(
    tokens.some((t) => t.source.key.startsWith("Layout/") && t.theme),
  ).toBe(false);
  expect(
    tokens.some((t) => t.name === "flag/beta" || t.name === "remote/thing"),
  ).toBe(false);
});

test("system --learn <figma-file-url> previews and applies through the confirmed diff", async () => {
  const root = await project();
  const output: string[] = [];
  const preview = await runSystemLearning(root, {
    dependencies: {
      isTTY: false,
      write: (s) => output.push(s),
      figma: recordedFigma(),
    },
    source: { figma: ref() },
  });
  expect(preview.outcome).toBe("preview");
  expect(output.join("")).toContain(
    'Figma variables from "Design comparison" (AbCdEf123) version 4711',
  );
  expect(preview.draft.diff).toContain("color/surface");
  expect(preview.draft.diff).toContain('"theme": "dark"');
  const applied = await runSystemLearning(root, {
    yes: true,
    dependencies: { write: () => {}, figma: throwingFigma },
    source: { figma: ref() },
  });
  expect(applied.outcome).toBe("applied");
  const config = JSON.parse(
    await readFile(join(root, ".idiom", "project.json"), "utf8"),
  );
  const tokens = config.design.tokens as Array<{
    name: string;
    source: { path: string };
  }>;
  expect(tokens.find((t) => t.name === "radius/card")?.source.path).toBe(
    ".idiom/designs/figma/AbCdEf123/variables/4711.json",
  );
}, 60000);

test("a 403 explains the Enterprise requirement; non-Figma sources are rejected", async () => {
  const root = await project();
  await expect(
    runSystemLearning(root, {
      dependencies: {
        write: () => {},
        figma: recordedFigma({
          "/variables/local": { status: 403, body: { err: "Forbidden" } },
        }),
      },
      source: { figma: ref() },
    }),
  ).rejects.toThrow(/Enterprise plan.*file_variables:read/);
  await expect(
    runSystem({ project: root, learn: true, learnSource: "tokens.json" }),
  ).rejects.toThrow("--learn takes a Figma file URL");
});
