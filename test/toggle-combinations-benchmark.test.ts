import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { expectedCaptureTupleKeys } from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { buildReviewCoverage } from "../src/report/coverage.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { runReview } from "../src/review/run.js";
import { reviewFixture } from "./benchmark-support.js";
import { toggleFlow, toggleProject } from "./toggle-support.js";

// Same before/after fixture, with ?fixed=1 selecting the repaired toolbar.
test.each([false, true])(
  "capture panel cross product, fixed=%s",
  async (fixed) => {
    const directory = await mkdtemp(join(tmpdir(), "idiom-toggle-benchmark-"));
    const project = await toggleProject();
    const flow = toggleFlow(fixed);
    try {
      const result = await runCapture({
        projectDirectory: directory,
        project,
        flow,
        out: join(directory, ".idiom", "reports", "run"),
        dependencies: {
          browserLauncher: createBrowserLauncher({
            createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
          }),
          snapshotSource: async () => ({ commit: "fixture", dirty: false }),
          inheritedEnvironment: { PATH: process.env.PATH },
        },
      });
      expect(result.counts).toEqual({ passed: 20, failed: 0, total: 20 });
      const collapsed = JSON.parse(
        await readFile(join(result.runDirectory, "combinations.json"), "utf8"),
      );
      expect(collapsed.collapsed).toHaveLength(6);
      for (const entry of collapsed.collapsed) {
        expect(entry.combination).toContain("inspector=hidden");
        expect(entry.sameAs.combination).toContain("inspector=closed");
      }
      for (const entry of collapsed.collapsed) {
        const names = await readdir(
          join(result.runDirectory, entry.state, entry.viewport),
        );
        expect(names).toContain("observations.json");
        expect(names).not.toContain("screenshot.png");
      }
      expect(await readFile(result.reportPath, "utf8")).toContain(
        "6 collapsed",
      );
      const loaded = await loadCaptureRun({
        runDirectory: result.runDirectory,
        expectedFlow: flow.id,
      });
      expect(loaded.collapsedCount).toBe(6);
      const checked = runDeterministicChecks(
        loaded.tuples,
        expectedCaptureTupleKeys({
          project,
          flow,
          collapsed: loaded.collapsedTupleKeys,
        }),
        checksConfigFrom(project.checks),
      );
      const invariants = checked.candidates.filter(
        ({ candidate }) => candidate.category === "layout-invariants",
      );
      expect(
        invariants
          .map(({ tuple }) => [tuple.viewport, tuple.combination])
          .sort(),
      ).toEqual(
        fixed
          ? []
          : [
              ["desktop-1280", "drawer=360, inspector=open"],
              ["desktop-1280", "drawer=480, inspector=open"],
            ],
      );
      for (const { candidate } of invariants) {
        expect(candidate.explanation).toMatch(/^controls height/);
        expect(candidate.explanation).toContain("expected 64");
      }
      expect(
        checked.candidates.filter(
          ({ candidate }) => candidate.category === "missing-state",
        ),
      ).toEqual([]);
      if (!fixed) {
        const drafts = buildDeterministicDrafts({
          runId: loaded.runId,
          entries: invariants,
        });
        expect(drafts.map(({ finding }) => finding.combination)).toContain(
          "drawer=480, inspector=open",
        );
      }
      const coverage = buildReviewCoverage({
        project,
        flow,
        tuples: loaded.tuples,
        commit: loaded.commit,
        collapsedTupleKeys: loaded.collapsedTupleKeys,
      });
      // The server has stopped: replay the stored run through the public review path.
      await mkdir(join(directory, ".idiom", "flows"), { recursive: true });
      await writeFile(
        join(directory, ".idiom", "project.json"),
        JSON.stringify(project),
      );
      await writeFile(
        join(directory, ".idiom", "flows", "panels.json"),
        JSON.stringify({
          ...flow,
          states: flow.states.filter(
            (state) => state.combination === undefined,
          ),
        }),
      );
      const replay = await runReview({
        project: directory,
        flow: flow.id,
        from: "run",
        deterministicOnly: true,
        dependencies: {
          capture: {
            browserLauncher: async () => {
              throw Error("offline replay must not launch a browser");
            },
          },
          createCritiqueAdapter: () => {
            throw Error("offline replay must not call a model");
          },
        },
      });
      expect(replay.outcome).toEqual({ kind: "deterministic-only" });
      const replayReport = await readFile(replay.reportPath, "utf8");
      expect(replayReport).toContain(
        "6 combination layout screenshots were collapsed",
      );
      if (!fixed)
        expect(replayReport).toContain("[drawer=480, inspector=open]");
      expect(coverage.selectedTuples).toBe(20);
      expect(coverage.limitations.join(" ")).toContain(
        "6 combination layout screenshots were collapsed",
      );
      expect(coverage.limitations.join(" ")).not.toContain(
        "not successfully captured",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

test("fixture pair exposes and repairs the controls invariant through reviewFixture", async () => {
  const browser = await chromium.launch();
  const html = await readFile(
    join(import.meta.dirname, "fixtures/web-flow-steps/toggles.html"),
    "utf8",
  );
  const bothOpen = html.replace(
    'data-drawer="closed" data-inspector="closed"',
    'data-drawer="480" data-inspector="open"',
  );
  // setContent has no HTTP URL; choose the repaired state in the markup.
  const before = bothOpen.replace(/<script>[\s\S]*?<\/script>/, "");
  const after = before.replace("<body ", "<body data-fixed ");
  try {
    const options = {
      viewport: { width: 1280, height: 800 },
      invariants: [{ name: "controls", selector: ".ed-controls", height: 64 }],
    };
    expect(
      (await reviewFixture(browser, before, options)).filter(
        ({ candidate }) => candidate.category === "layout-invariants",
      ),
    ).toHaveLength(1);
    expect(
      (await reviewFixture(browser, after, options)).filter(
        ({ candidate }) => candidate.category === "layout-invariants",
      ),
    ).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("layout measurement shares context pins and releases pages on failure", async () => {
  const browser = await chromium.launch();
  const session = await createBrowserLauncher({
    launch: async () => browser,
  })();
  const project = await toggleProject();
  project.capture.colorSchemeAttribute = "data-theme";
  const flow = toggleFlow();
  const state = flow.states[0];
  const viewport = project.viewports[0];
  if (!state || !viewport || !session.measure)
    throw Error("missing tuple inputs");
  const html = `<style>.region{width:100px;height:64px}html[data-theme=dark] .region{width:200px} @media(prefers-color-scheme:dark){.region{height:80px}}</style><div class="region"></div>`;
  const tuple = {
    project,
    state,
    viewport,
    colorScheme: "dark" as const,
    navigationUrl: `data:text/html,${encodeURIComponent(html)}`,
  };
  try {
    const signature = await session.measure(tuple, [".region"]);
    expect(signature).toBe(JSON.stringify([["8,8,200,80"]]));
    expect(browser.contexts()).toHaveLength(0);
    const focused = {
      ...tuple,
      state: { ...state, focus: ".region" },
      navigationUrl: `data:text/html,${encodeURIComponent(html.replace('<div class="region">', '<style>html[data-theme] .region:focus{width:300px}</style><div class="region" tabindex="0">'))}`,
    };
    expect(await session.measure(focused, [".region"])).toBe(
      JSON.stringify([["8,8,300,80"]]),
    );
    expect(browser.contexts()).toHaveLength(0);
    expect(await session.measure(tuple, ["["])).toBeUndefined();
    expect(browser.contexts()).toHaveLength(0);
    expect(
      await session.measure(
        {
          ...tuple,
          state: {
            ...state,
            steps: [{ action: "click", selector: "[" }],
          },
        },
        [".region"],
      ),
    ).toBeUndefined();
    expect(browser.contexts()).toHaveLength(0);
  } finally {
    await session.close();
  }
}, 30_000);
