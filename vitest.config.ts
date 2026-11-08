import { availableParallelism } from "node:os";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import {
  heavyForks,
  suiteExclude,
  suiteInclude,
  suiteNames,
  unitFiles,
} from "./test/support/suite-groups.js";

// Vitest's 5s default per-test timeout fails sub-second unit tests when a
// shared verify host is saturated. Browser suites close Chromium in afterAll;
// under full-suite load that teardown has exceeded the 10s hook default
// without anything being wrong. Explicit deadline assertions are unchanged.
const timeouts = { testTimeout: 30_000, hookTimeout: 60_000 };

// Refuses SIGTERM/SIGINT from a test to the Vitest main process or its group
// and logs any that arrive from elsewhere (test/support/signal-guard-global.ts).
const signalGuard = ["./test/support/signal-guard-setup.ts"];

// One run, two pools. Reviewed pure unit files (test/support/suite-groups.ts)
// use Vitest's normal thread parallelism. Every other file, including any new
// one, starts Chromium, a built CLI, a fixture server or a child Idiom process
// and shares a bounded set of forks. Vitest 3 reads pool capacities from the
// root only, which is why the cap is here rather than on the heavy project.
// Both projects exclude autobuild's linked worktrees under .autobuild/, which
// carry their own copy of the suite.
export const suiteConfig = {
  test: {
    globalSetup: ["./test/support/signal-guard-global.ts"],
    poolOptions: {
      forks: { minForks: 1, maxForks: heavyForks(availableParallelism()) },
    },
    projects: [
      {
        test: {
          name: suiteNames.unit,
          pool: "threads",
          environment: "node",
          include: [...unitFiles],
          exclude: suiteExclude,
          setupFiles: signalGuard,
          ...timeouts,
        },
      },
      {
        test: {
          name: suiteNames.heavy,
          pool: "forks",
          environment: "node",
          include: suiteInclude,
          exclude: [...suiteExclude, ...unitFiles],
          setupFiles: signalGuard,
          ...timeouts,
        },
      },
    ],
  },
} satisfies ViteUserConfig;

export default defineConfig(suiteConfig);
