import { configDefaults, defineConfig } from "vitest/config";

// Autobuild's linked worktrees live under the gitignored .autobuild/ and carry
// their own full copy of the suite; running them from the primary checkout
// triples the run and fails on in-flight branches.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.autobuild/**"],
  },
});
