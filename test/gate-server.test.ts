import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { planServerReuse, servedBuildId } from "../src/gate/server-reuse.js";
import { projectSchema } from "../src/schemas/project.js";

test("a build id is read from __NEXT_DATA__ or a static asset path", () => {
  expect(
    servedBuildId('<script>{"props":{},"buildId":"abc123"}</script>'),
  ).toBe("abc123");
  expect(
    servedBuildId('<script src="/_next/static/xyz789/_buildManifest.js">'),
  ).toBe("xyz789");
  expect(servedBuildId("<html></html>")).toBeUndefined();
});

test("reuse is verified against BUILD_ID, refused on mismatch or a stale build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-reuse-"));
  try {
    await mkdir(join(directory, ".next"));
    await writeFile(join(directory, ".next/BUILD_ID"), "abc123\n");
    const project = projectSchema.parse({
      version: 1,
      app: { name: "x", framework: "nextjs" },
      server: {
        build: "true",
        start: "true",
        readyUrl: "http://127.0.0.1:1/",
        port: 1,
        env: {},
        production: { build: "true", start: "true", distDir: ".next" },
      },
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "unused" },
    });
    const serving = (id: string) =>
      (async () =>
        new Response(`{"buildId":"${id}"}`, {
          status: 200,
        })) as unknown as typeof fetch;
    const base = {
      projectDirectory: directory,
      project,
      reuse: true,
      production: false,
      changedFiles: [] as string[],
    };
    expect(
      await planServerReuse({ ...base, fetch: serving("abc123") }),
    ).toEqual({
      mode: "reused",
      verified: true,
      reason: "build abc123",
    });
    expect(
      await planServerReuse({ ...base, fetch: serving("other") }),
    ).toMatchObject({
      mode: "fresh",
      reason: expect.stringContaining("is not"),
    });
    const edited = join(directory, "page.tsx");
    await writeFile(edited, "x");
    const past = new Date(Date.now() - 60_000);
    await utimes(join(directory, ".next/BUILD_ID"), past, past);
    expect(
      await planServerReuse({
        ...base,
        changedFiles: [edited],
        fetch: serving("abc123"),
      }),
    ).toMatchObject({
      mode: "fresh",
      reason: expect.stringContaining("stale build"),
    });
    const silent = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await planServerReuse({ ...base, fetch: silent })).toMatchObject({
      mode: "fresh",
      reason: expect.stringContaining("nothing answers"),
    });
    expect(
      await planServerReuse({
        ...base,
        reuse: false,
        fetch: serving("abc123"),
      }),
    ).toMatchObject({ mode: "fresh" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
