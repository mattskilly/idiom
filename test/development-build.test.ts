import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "..");

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return (await execFileAsync(command, args, { cwd })).stdout;
}

/** Copies this checkout's working-tree files (tracked and unignored) into a fresh repository. */
async function committedCopy(destination: string): Promise<void> {
  const listing = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    repositoryRoot,
  );
  for (const path of new Set(listing.split("\0").filter(Boolean))) {
    const source = join(repositoryRoot, path);
    const stats = await lstat(source).catch(() => undefined);
    if (stats === undefined || stats.isDirectory()) continue;
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    if (stats.isSymbolicLink()) await symlink(await readlink(source), target);
    else await copyFile(source, target);
  }
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(destination, "node_modules"),
  );
  await run("git", ["init", "-q"], destination);
  await run("git", ["add", "-A"], destination);
  await run(
    "git",
    ["add", "-f", "--", "dist/cli.js", "dist/main.js"],
    destination,
  );
  await run(
    "git",
    [
      "-c",
      "user.name=Idiom Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "checkout",
    ],
    destination,
  );
}

// Runs in a copy: an in-tree build would clean the build/ that sibling tests execute.
test("bun run build leaves tracked files alone; build:release writes the same bytes to dist/", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-development-build-"));
  try {
    await committedCopy(directory);
    const status = () => run("git", ["status", "--porcelain"], directory);

    await run("bun", ["run", "build"], directory);
    expect(await status()).toBe("");
    await lstat(join(directory, "build", "cli.js"));
    await lstat(join(directory, "build", "main.js"));

    await run("bun", ["run", "build:release"], directory);
    // The launcher embeds no commit, so only the program is sure to change.
    const changed = (await status()).split("\n").filter(Boolean);
    expect(changed).toContain(" M dist/main.js");
    expect(
      changed.every((line) => /^ M dist\/(?:cli|main)\.js$/.test(line)),
    ).toBe(true);
    for (const name of ["cli.js", "main.js"]) {
      const development = await readFile(join(directory, "build", name));
      const release = await readFile(join(directory, "dist", name));
      expect(development.equals(release)).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
