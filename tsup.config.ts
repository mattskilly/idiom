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

// Set only by scripts/idiom-local.mjs (this repository's self-gate build): a
// fingerprint of the capture and check source that keys shared base records.
// Releases and development builds never set it; never export it in a release shell.
const engineIdentity = process.env.IDIOM_ENGINE_IDENTITY ?? "";
if (engineIdentity !== "" && !/^source:[0-9a-f]{20}$/.test(engineIdentity)) {
  throw new Error(
    `IDIOM_ENGINE_IDENTITY must be empty or source:<20 hex>, got ${JSON.stringify(engineIdentity)}`,
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
    __IDIOM_ENGINE_IDENTITY__: JSON.stringify(engineIdentity),
  },
});
