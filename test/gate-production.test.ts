import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { runCapture } from "../src/capture/run.js";
import { workingTreeIdentity } from "../src/changed/git.js";
import { productionFixture } from "./production-support.js";

const exec = promisify(execFile);

test("working-tree identity follows content: dirty edits and untracked files change it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-identity-"));
  const git = (...args: string[]) => exec("git", args, { cwd: directory });
  try {
    await git("init", "--quiet");
    await writeFile(join(directory, "a.txt"), "one\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "a",
    );
    const clean = await workingTreeIdentity(directory);
    expect(await workingTreeIdentity(directory)).toBe(clean);
    await writeFile(join(directory, "a.txt"), "two\n");
    const dirty = await workingTreeIdentity(directory);
    expect(dirty).not.toBe(clean);
    await writeFile(join(directory, "b.txt"), "new\n");
    const untracked = await workingTreeIdentity(directory);
    expect(untracked).not.toBe(dirty);
    await writeFile(join(directory, "b.txt"), "newer\n");
    expect(await workingTreeIdentity(directory)).not.toBe(untracked);
    await writeFile(join(directory, "b.txt"), "new\n");
    expect(await workingTreeIdentity(directory)).toBe(untracked);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an input identity reuses the production build on a dirty tree", async () => {
  const f = await productionFixture({}, false);
  try {
    // Dirty: an untracked file the commit does not have.
    await writeFile(join(f.directory, "dirty.txt"), "edit\n");
    const options = {
      projectDirectory: f.directory,
      project: f.project,
      flow: f.flow,
      prod: true,
      inputIdentity: "sha256:inputs",
    };
    const first = await runCapture(options);
    const second = await runCapture(options);
    expect(first.counts).toEqual({ passed: 1, failed: 0, total: 1 });
    expect(second.counts).toEqual(first.counts);
    expect(first.timings?.build.status).toBe("measured");
    expect(second.timings?.build.status).toBe("reused");
    const changed = await runCapture({
      ...options,
      inputIdentity: "sha256:other",
    });
    expect(changed.timings?.build.status).toBe("measured");
    // Without an identity a dirty tree never reuses (unchanged behaviour).
    const plain = await runCapture({ ...options, inputIdentity: undefined });
    expect(plain.timings?.build.status).toBe("measured");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}, 60_000);
