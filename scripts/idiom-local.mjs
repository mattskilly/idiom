#!/usr/bin/env node
// Runs this checkout's own Idiom CLI, built out of tree.
//
//   node scripts/idiom-local.mjs <idiom args…>
//
// Why out of tree: the in-tree development build (build/, gitignored) is
// cleaned and rewritten by any concurrent `bun run build` or `bun run test`,
// which can delete the CLI while a review runs. Building into a temp package
// directory whose other package files link back here keeps this run
// independent of the checkout's build/ and of the tracked release dist/.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

// The package entries the bundle reads relative to its root (dist/..), other
// than dist itself: every top-level `files` entry, plus the manifest and deps.
export function packageLinks(manifest) {
  const entries = new Set(["package.json", "node_modules"]);
  for (const file of manifest.files ?? []) {
    const top = file.split("/").find(Boolean);
    if (top && top !== "dist") entries.add(top);
  }
  return [...entries].sort();
}

export async function buildLocalCli({ root = repositoryRoot } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "idiom-local-"));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const pkg = join(temporary, "pkg");
    await mkdir(pkg);
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    for (const entry of packageLinks(manifest)) {
      if (existsSync(join(root, entry)))
        await symlink(join(root, entry), join(pkg, entry));
    }
    const steps = [
      [process.execPath, [join(root, "scripts", "check-plugins.mjs")]],
      [
        join(root, "node_modules", ".bin", "tsup"),
        ["--config", "tsup.config.ts", "--out-dir", join(pkg, "dist")],
      ],
    ];
    for (const [command, args] of steps) {
      const result = spawnSync(command, args, {
        cwd: root,
        stdio: ["ignore", "ignore", "inherit"],
      });
      if (result.status !== 0)
        throw Object.assign(
          new Error(`${command} exited with ${result.status ?? result.signal}`),
          { status: result.status },
        );
    }
    return { cli: join(pkg, "dist", "cli.js"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  let built;
  try {
    built = await buildLocalCli();
  } catch (error) {
    console.error(`idiom-local: could not build the CLI (${error.message})`);
    process.exit(2);
  }
  let status = 1;
  try {
    status = await new Promise((done) => {
      const child = spawn(
        process.execPath,
        [built.cli, ...process.argv.slice(2)],
        { cwd: repositoryRoot, stdio: "inherit" },
      );
      child.on("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
      child.on("error", () => done(1));
    });
  } finally {
    await built.cleanup();
  }
  process.exit(status);
}
