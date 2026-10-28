import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectChanges } from "../src/changed/git.js";
import { changedFixture } from "./changed-support.js";

test("unions committed, index-only, unstaged, untracked, deleted and renamed paths losslessly", async () => {
  const f = await changedFixture({
    "deleted.ts": "",
    "renamed.ts": "",
    "index-only.ts": "before",
    "sp ace\nfile.ts": "before",
  });
  try {
    const base = (await f.git("rev-parse", "HEAD")).trim();
    await f.write("committed.ts", "committed");
    await f.commit();
    await f.write("index-only.ts", "staged");
    await f.git("add", "index-only.ts");
    await f.write("index-only.ts", "before");
    await f.write("sp ace\nfile.ts", "after");
    await f.git("rm", "deleted.ts");
    await f.git("mv", "renamed.ts", "new.ts");
    await f.write("untracked.ts", "new");
    await f.write("ignored", "ignored");
    const changes = await collectChanges(f.directory, base);
    expect(changes.files.map((file) => file.path)).toEqual([
      "committed.ts",
      "deleted.ts",
      "index-only.ts",
      "new.ts",
      "renamed.ts",
      "sp ace\nfile.ts",
      "untracked.ts",
    ]);
    await mkdir(join(f.directory, "nested"));
    expect(await collectChanges(join(f.directory, "nested"), base)).toEqual(
      changes,
    );
    await expect(collectChanges(f.directory, "missing-ref")).rejects.toThrow(
      "invalid --changed base",
    );
    await expect(collectChanges(f.directory, "--all")).rejects.toThrow(
      "invalid --changed base",
    );
  } finally {
    await f.cleanup();
  }
});

test("default merge base prefers the remote default ref then local main/master and discloses HEAD fallback", async () => {
  const f = await changedFixture();
  try {
    const original = (await f.git("rev-parse", "HEAD")).trim();
    await f.git("checkout", "-qb", "feature");
    await f.write("feature.ts", "");
    await f.commit();
    expect((await collectChanges(f.directory)).resolvedBase).toBe(original);
    await f.git("update-ref", "refs/remotes/origin/trunk", original);
    await f.git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    expect((await collectChanges(f.directory)).baseReason).toContain(
      "origin/trunk",
    );
    await f.git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    await f.git("branch", "-m", "main", "master");
    expect((await collectChanges(f.directory)).baseReason).toContain("master");
    await f.git("branch", "-D", "master");
    expect((await collectChanges(f.directory)).fallbackReason).toContain(
      "using HEAD",
    );
    await f.git("checkout", "--orphan", "main");
    await f.git("rm", "-rf", ".");
    await f.commit("unrelated");
    await f.git("checkout", "feature");
    expect((await collectChanges(f.directory)).fallbackReason).toContain(
      "no merge base",
    );
  } finally {
    await f.cleanup();
  }
});

test("missing repositories and unborn HEAD are actionable errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-no-git-"));
  const f = await changedFixture();
  try {
    await expect(collectChanges(directory)).rejects.toThrow("committed HEAD");
    await f.git("checkout", "--orphan", "unborn");
    await expect(collectChanges(f.directory)).rejects.toThrow("committed HEAD");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await f.cleanup();
  }
});
