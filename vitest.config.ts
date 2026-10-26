import { configDefaults, defineConfig } from "vitest/config";

// Autobuild's linked worktrees live under the gitignored .autobuild/ and carry
// their own full copy of the suite; running them from the primary checkout
// triples the run and fails on in-flight branches.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.autobuild/**"],
    // Browser and built-CLI suites spawn their own Chromium/Node processes.
    // Bound file concurrency so shared hosts can still meet deadline assertions.
    maxWorkers: 2,
    // Vitest's 5s default per-test timeout fails sub-second unit tests when a
    // shared verify host is saturated. Explicit deadline assertions are unchanged.
    testTimeout: 30_000,
    // Browser suites close Chromium in afterAll; under full-suite load that
    // teardown has exceeded the 10s default without anything being wrong.
    hookTimeout: 60_000,
  },
});
