import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { FigmaDependencies } from "../src/design/figma/client.js";
import { figmaObservation } from "../src/design/figma/normalize.js";
import { type FigmaNode, figmaNodeSchema } from "../src/design/figma/types.js";

export const figmaFixtures = join(
  import.meta.dirname,
  "fixtures/design-drift/figma",
);
export const FIGMA_URL =
  "https://www.figma.com/design/AbCdEf123/Design-comparison?node-id=1-2&t=xyz";
export const FIGMA_FILE_URL =
  "https://www.figma.com/design/AbCdEf123/Design-comparison";

export async function figmaFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(figmaFixtures, name), "utf8"));
}
export async function figmaFrameDocument(): Promise<FigmaNode> {
  const nodes = (await figmaFixture("nodes.json")) as {
    nodes: Record<string, { document: unknown }>;
  };
  return figmaNodeSchema.parse(nodes.nodes["1:2"]?.document);
}
export async function figmaFixtureObservation(
  viewport = { width: 500, height: 700 },
  withVariables = true,
) {
  return figmaObservation(await figmaFrameDocument(), {
    viewport,
    fileKey: "AbCdEf123",
    ...(withVariables
      ? {
          variables: (await figmaFixture(
            "variables.json",
          )) as import("../src/design/figma/types.js").FigmaVariables,
        }
      : {}),
  });
}

type Route = { status?: number; body?: unknown; bytes?: Buffer };
/** A recorded Figma API: routes by path prefix; anything else throws. */
export function recordedFigma(
  overrides: Record<string, Route | ((url: string) => Route)> = {},
  calls: string[] = [],
): FigmaDependencies {
  return {
    env: { FIGMA_TOKEN: "figd_secret-token-value" },
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const pick = async (): Promise<Route> => {
        for (const [prefix, route] of Object.entries(overrides))
          if (url.includes(prefix))
            return typeof route === "function" ? route(url) : route;
        if (url.includes("/variables/local"))
          return { body: await figmaFixture("variables.json") };
        if (url.includes("/nodes?"))
          return { body: await figmaFixture("nodes.json") };
        if (url.includes("/v1/images/"))
          return { body: await figmaFixture("images.json") };
        if (url.includes("/v1/files/"))
          return { body: await figmaFixture("file.json") };
        if (url.endsWith("frame-1-2.png"))
          return { bytes: await readFile(join(figmaFixtures, "frame.png")) };
        throw new Error(`unexpected Figma request ${url}`);
      };
      const route = await pick();
      const status = route.status ?? 200;
      return new Response(
        route.bytes
          ? new Uint8Array(route.bytes)
          : JSON.stringify(route.body ?? { err: "error" }),
        { status },
      );
    }) as typeof fetch,
  };
}

export const throwingFigma: FigmaDependencies = {
  env: {},
  fetch: (async () => {
    throw new Error("network must not be touched");
  }) as unknown as typeof fetch,
};

export function pngSize(buffer: Buffer) {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height };
}
