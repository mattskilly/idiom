import { access, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { removeTempDirectory } from "./support/temp-directory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "idiom-temp-directory-"));
  roots.push(root);
  return root;
}

function codedError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  error.code = code;
  return error;
}

const noSleep = async () => {};

test("a late write during removal is cleaned up on retry", async () => {
  const root = await tempRoot();
  let calls = 0;
  const remove = async (path: string) => {
    calls += 1;
    if (calls === 1) {
      // An abandoned capture writes a report while the removal runs.
      await mkdir(join(path, "late"), { recursive: true });
      await writeFile(join(path, "late", "report.json"), "{}");
      await rmdir(path);
      return;
    }
    await rm(path, { recursive: true, force: true });
  };

  await expect(
    removeTempDirectory(root, { remove, sleep: noSleep }),
  ).resolves.toBeUndefined();
  await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(calls).toBe(2);
});

test("a removal that keeps failing reports the path and the error after bounded attempts", async () => {
  const path = join(tmpdir(), "idiom-temp-directory-stuck");
  let calls = 0;
  const waits: number[] = [];
  const remove = async () => {
    calls += 1;
    throw codedError("ENOTEMPTY");
  };
  const sleep = async (ms: number) => {
    waits.push(ms);
  };

  const result = removeTempDirectory(path, {
    attempts: 3,
    delayMs: 5,
    remove,
    sleep,
  });
  await expect(result).rejects.toThrow(path);
  await expect(result).rejects.toThrow("ENOTEMPTY");
  expect(calls).toBe(3);
  expect(waits).toEqual([5, 10]);
});

test("a non-retryable error fails at once", async () => {
  const path = join(tmpdir(), "idiom-temp-directory-denied");
  let calls = 0;
  const remove = async () => {
    calls += 1;
    throw codedError("EACCES");
  };

  const result = removeTempDirectory(path, { remove, sleep: noSleep });
  await expect(result).rejects.toThrow(path);
  await expect(result).rejects.toThrow("EACCES");
  expect(calls).toBe(1);
});

test("removing a missing directory is a no-op", async () => {
  const root = await tempRoot();
  await expect(
    removeTempDirectory(join(root, "missing")),
  ).resolves.toBeUndefined();
});
