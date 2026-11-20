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
//
// Engine: the out-of-tree CLI is keyed (IDIOM_ENGINE_IDENTITY, baked by
// tsup.config.ts) by a fingerprint of the code that produces a base record —
// capture, checks and record building — not by version + commit. Shared
// base-cache records therefore cross builds whose check and capture code is
// identical, and never cross builds where it differs.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// The record-producing entry points: base capture (→ review → capture and
// every check) and record building.
export const ENGINE_ENTRIES = [
  "src/baseline/base.ts",
  "src/baseline/record.ts",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (path) =>
  existsSync(path) ? sha256(readFileSync(path)) : "absent";
const stableJson = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(stableJson).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
          .join(",")}}`;

/**
 * `source:<20 hex>`: a hash of every source file in the entries' import
 * closure, plus the lockfile, the package's dependencies and the build config
 * (third-party code is external to the closure).
 */
export async function engineFingerprint({
  root = repositoryRoot,
  entries = ENGINE_ENTRIES,
} = {}) {
  const { build } = await import("esbuild");
  const result = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    metafile: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outdir: join(tmpdir(), "idiom-engine-fingerprint"),
    logLevel: "silent",
    define: {
      __IDIOM_BUILD_COMMIT__: '""',
      __IDIOM_ENGINE_IDENTITY__: '""',
    },
  });
  const inputs = Object.keys(result.metafile.inputs)
    .filter((key) => !key.includes(":"))
    .map((key) => key.split("\\").join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const input of inputs)
    hash.update(`${input}\0${fileHash(join(root, input))}\n`);
  const manifestPath = join(root, "package.json");
  const dependencies = existsSync(manifestPath)
    ? stableJson(
        JSON.parse(readFileSync(manifestPath, "utf8")).dependencies ?? {},
      )
    : "absent";
  hash.update(`package.json#dependencies\0${dependencies}\n`);
  for (const file of ["bun.lock", "tsup.config.ts"])
    hash.update(`${file}\0${fileHash(join(root, file))}\n`);
  return `source:${hash.digest("hex").slice(0, 20)}`;
}

export async function buildLocalCli({ root = repositoryRoot } = {}) {
  const engine = await engineFingerprint({ root });
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
        env: { ...process.env, IDIOM_ENGINE_IDENTITY: engine },
      });
      if (result.status !== 0)
        throw Object.assign(
          new Error(`${command} exited with ${result.status ?? result.signal}`),
          { status: result.status },
        );
    }
    return { cli: join(pkg, "dist", "cli.js"), cleanup, engine };
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
