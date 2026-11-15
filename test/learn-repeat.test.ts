import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findRepeatedLearning } from "../src/learn/repeat.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const png = (marker: string) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(marker),
  ]);

function entry(id: number, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: `learned-${id}`,
    recordedAt: "2026-11-15T12:00:00.000Z",
    flow: "studio",
    state: "editor",
    observation: "the dots should be 8px",
    kind: "observation",
    target: { file: ".idiom/flows/studio.json" },
    entry: null,
    ...extra,
  };
}

async function project(entries: object[]) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-repeat-"));
  directories.push(directory);
  await mkdir(join(directory, ".idiom", "learned"), { recursive: true });
  await writeFile(
    join(directory, ".idiom", "learned.jsonl"),
    `${entries.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`,
  );
  return directory;
}

test("the same words and the same screenshot bytes find the stored record", async () => {
  const directory = await project([
    entry(1, { screenshot: ".idiom/learned/learned-1.png" }),
  ]);
  await writeFile(join(directory, ".idiom/learned/learned-1.png"), png("a"));
  await writeFile(join(directory, "a.png"), png("a"));
  await writeFile(join(directory, "b.png"), png("b"));
  const find = (
    screenshot: string | undefined,
    observation = "the dots should be 8px",
  ) =>
    findRepeatedLearning({
      projectDirectory: directory,
      observation,
      screenshot,
    });
  expect((await find(join(directory, "a.png")))?.id).toBe("learned-1");
  expect(
    (await find(join(directory, "a.png"), "  the dots\n should   be 8px "))?.id,
  ).toBe("learned-1");
  expect(await find(join(directory, "a.png"), "The dots should be 8px")).toBe(
    undefined,
  );
  expect(await find(join(directory, "b.png"))).toBe(undefined);
  expect(await find(undefined)).toBe(undefined);
  expect(await find(join(directory, "missing.png"))).toBe(undefined);
  await rm(join(directory, ".idiom/learned/learned-1.png"));
  expect(await find(join(directory, "a.png"))).toBe(undefined);
});

test("a stored record without a screenshot matches only a call without one", async () => {
  const directory = await project([entry(1)]);
  await writeFile(join(directory, "a.png"), png("a"));
  const base = {
    projectDirectory: directory,
    observation: "the dots should be 8px",
  };
  expect((await findRepeatedLearning(base))?.id).toBe("learned-1");
  expect(
    await findRepeatedLearning({
      ...base,
      screenshot: join(directory, "a.png"),
    }),
  ).toBe(undefined);
});

test("a named state or flow must match, and the newest match wins", async () => {
  const directory = await project([
    entry(1),
    entry(2, { state: "settings" }),
    entry(3),
  ]);
  const base = {
    projectDirectory: directory,
    observation: "the dots should be 8px",
  };
  expect((await findRepeatedLearning(base))?.id).toBe("learned-3");
  expect((await findRepeatedLearning({ ...base, state: "settings" }))?.id).toBe(
    "learned-2",
  );
  expect(await findRepeatedLearning({ ...base, state: "home" })).toBe(
    undefined,
  );
  expect(await findRepeatedLearning({ ...base, flow: "other" })).toBe(
    undefined,
  );
  expect(
    (await findRepeatedLearning({ ...base, flow: "studio", state: "editor" }))
      ?.id,
  ).toBe("learned-3");
});

test("no log means no repeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-repeat-"));
  directories.push(directory);
  expect(
    await findRepeatedLearning({
      projectDirectory: directory,
      observation: "x",
    }),
  ).toBe(undefined);
});
