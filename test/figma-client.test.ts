import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchFigmaFrame } from "../src/design/figma/cache.js";
import { figmaToken } from "../src/design/figma/client.js";
import { parseFigmaUrl } from "../src/design/figma/url.js";
import {
  FIGMA_URL,
  figmaFixture,
  pngSize,
  recordedFigma,
  throwingFigma,
} from "./figma-support.js";

let projectDirectory: string;
beforeEach(async () => {
  projectDirectory = await mkdtemp(join(tmpdir(), "idiom-figma-"));
});
afterEach(async () => {
  await rm(projectDirectory, { recursive: true, force: true });
});
const ref = () => {
  const parsed = parseFigmaUrl(FIGMA_URL);
  if (!parsed) throw new Error("fixture URL");
  return parsed;
};
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

test("a missing or blank token explains how to create one", () => {
  for (const env of [{}, { FIGMA_TOKEN: "  " }])
    expect(() => figmaToken({ env })).toThrow(
      /Personal access tokens.*file_content:read.*export FIGMA_TOKEN/s,
    );
});

test("rejected, missing, rate-limited and unrenderable frames fail distinctly without leaking the token", async () => {
  const cases: Array<[Parameters<typeof recordedFigma>[0], RegExp]> = [
    [
      {
        "/v1/files/AbCdEf123?depth=1": {
          status: 403,
          body: { err: "Invalid token figd_secret-token-value" },
        },
      },
      /rejected FIGMA_TOKEN.*Personal access tokens/s,
    ],
    [
      {
        "/v1/files/AbCdEf123?depth=1": {
          status: 404,
          body: { err: "Not found" },
        },
      },
      /not found \(404\).*shared/,
    ],
    [
      { "/nodes?": { status: 429, body: { err: "Rate limit" } } },
      /rate limited.*429/,
    ],
    [
      { "/v1/images/": { body: { err: null, images: { "1:2": null } } } },
      /could not render node 1:2/,
    ],
    [
      { "/nodes?": { body: { nodes: { "1:2": null } } } },
      /node 1:2 was not found/,
    ],
    [
      { "/v1/files/AbCdEf123?depth=1": { status: 500, body: { err: "boom" } } },
      /answered 500: boom/,
    ],
  ];
  for (const [routes, message] of cases) {
    const error = await fetchFigmaFrame(ref(), {
      projectDirectory,
      deps: recordedFigma(routes),
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain("figd_secret-token-value");
  }
});

test("first fetch writes a pinned version cache; later runs need no network or token; refresh repoints", async () => {
  const calls: string[] = [];
  const frame = await fetchFigmaFrame(ref(), {
    projectDirectory,
    deps: recordedFigma({}, calls),
    now: () => new Date("2026-10-25T12:00:00Z"),
  });
  expect(frame.meta).toMatchObject({
    fileKey: "AbCdEf123",
    nodeId: "1:2",
    version: "4711",
    variables: "resolved",
    link: "https://www.figma.com/design/AbCdEf123/?node-id=1-2",
    scale: 2,
  });
  expect(pngSize(frame.png)).toEqual({ width: 1000, height: 1200 });
  expect(calls.some((u) => u.includes("version=4711"))).toBe(true);
  expect(calls.find((u) => u.endsWith(".png"))).toBeDefined();
  const root = join(projectDirectory, ".idiom/designs/figma/AbCdEf123/1-2");
  expect(
    JSON.parse(await readFile(join(root, "current.json"), "utf8")),
  ).toEqual({ version: "4711" });
  const files = await filesUnder(root);
  expect(files.map((f) => f.slice(root.length + 1)).sort()).toEqual([
    "4711/frame.png",
    "4711/meta.json",
    "4711/nodes.json",
    "4711/variables.json",
    "current.json",
  ]);
  for (const file of files)
    expect((await readFile(file)).toString("latin1")).not.toContain(
      "figd_secret",
    );

  const cached = await fetchFigmaFrame(ref(), {
    projectDirectory,
    deps: throwingFigma,
  });
  expect(cached.meta).toEqual(frame.meta);
  expect(cached.document).toEqual(frame.document);

  const file = (await figmaFixture("file.json")) as Record<string, unknown>;
  const refreshed = await fetchFigmaFrame(ref(), {
    projectDirectory,
    refresh: true,
    deps: recordedFigma({
      "/v1/files/AbCdEf123?depth=1": { body: { ...file, version: "4800" } },
    }),
  });
  expect(refreshed.meta.version).toBe("4800");
  expect(
    JSON.parse(await readFile(join(root, "current.json"), "utf8")),
  ).toEqual({ version: "4800" });
  expect((await readdir(root)).sort()).toEqual([
    "4711",
    "4800",
    "current.json",
  ]);
});

test("variables are best effort: a 403 is recorded, not thrown", async () => {
  const frame = await fetchFigmaFrame(ref(), {
    projectDirectory,
    deps: recordedFigma({
      "/variables/local": { status: 403, body: { err: "Forbidden" } },
    }),
  });
  expect(frame.variables).toBeUndefined();
  expect(frame.meta.variables).toMatch(/^unavailable: .*Enterprise/);
});
