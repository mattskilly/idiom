import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { withFileLock } from "../src/baseline/lock.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "idiom-lock-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const fast = { waitMs: 5_000, staleMs: 60_000, pollMs: 5 };

test("two holders of one lock never overlap", async () => {
  const path = join(directory, "a.lock");
  const events: string[] = [];
  const hold = (name: string) =>
    withFileLock(path, fast, async () => {
      events.push(`enter ${name}`);
      await new Promise((done) => setTimeout(done, 30));
      events.push(`exit ${name}`);
    });
  await Promise.all([hold("one"), hold("two")]);
  expect(events).toHaveLength(4);
  for (let index = 0; index < 4; index += 2) {
    const name = events[index]?.split(" ")[1];
    expect(events[index + 1]).toBe(`exit ${name}`);
  }
  await expect(readFile(path)).rejects.toThrow();
});

test("a lock held by a dead process on this host is taken over", async () => {
  const path = join(directory, "a.lock");
  await writeFile(
    path,
    JSON.stringify({
      token: "dead",
      pid: 999_999,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    }),
  );
  const result = await withFileLock(
    path,
    { ...fast, waitMs: 0, isAlive: () => false },
    async () => "ran",
  );
  expect(result).toBe("ran");
});

test("a live holder past the wait fails loudly, naming it", async () => {
  const path = join(directory, "advance.lock");
  await writeFile(
    path,
    JSON.stringify({
      token: "live",
      pid: 4242,
      hostname: "build-host",
      startedAt: new Date().toISOString(),
      description: "target refs/remotes/origin/main",
    }),
  );
  await expect(
    withFileLock(
      path,
      {
        ...fast,
        waitMs: 20,
        holderLabel: "another baseline advance",
      },
      async () => "ran",
    ),
  ).rejects.toThrow(
    /another baseline advance holds .*advance\.lock \(pid 4242 on build-host, target refs\/remotes\/origin\/main, since .*\); waited 20 ms/,
  );
});

test("a holder older than the stale limit is taken over even when alive", async () => {
  const path = join(directory, "a.lock");
  await writeFile(
    path,
    JSON.stringify({
      token: "old",
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date(Date.now() - 10_000).toISOString(),
    }),
  );
  expect(
    await withFileLock(
      path,
      { ...fast, waitMs: 0, staleMs: 1_000 },
      async () => "ran",
    ),
  ).toBe("ran");
});

test("release leaves a lock whose token changed (it was taken over)", async () => {
  const path = join(directory, "a.lock");
  const other = JSON.stringify({
    token: "someone-else",
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  });
  await withFileLock(path, fast, async () => {
    await writeFile(path, other);
  });
  expect(await readFile(path, "utf8")).toBe(other);
});
