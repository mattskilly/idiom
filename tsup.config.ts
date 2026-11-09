import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
let buildCommit: string;
try {
  buildCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(buildCommit)) {
    throw new Error("Git returned an invalid full commit hash");
  }
} catch (cause) {
  throw new Error(
    "Cannot determine Idiom's build commit. Build from a Git checkout with a committed HEAD and Git on PATH.",
    { cause },
  );
}

export default defineConfig({
  // Development builds write the untracked build/; `bun run build:release` writes the tracked dist/ from this same config.
  // cli.js is the bin: a launcher that checks the Node version with no imports, then loads main.js.
  entry: { cli: "src/entry.ts", main: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  // Two self-contained files: releases commit only dist/cli.js and dist/main.js, so dynamic imports must not split into chunks.
  splitting: false,
  outDir: "build",
  clean: true,
  define: {
    __IDIOM_BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
});
