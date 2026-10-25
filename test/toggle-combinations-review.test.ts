import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { expectedCaptureTupleKeys } from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { runReview } from "../src/review/run.js";
import { flowSchema } from "../src/schemas/flow.js";
import { runVerify } from "../src/verify/run.js";
import { toggleProject } from "./toggle-support.js";

const rawFlow = {
  id: "evidence",
  title: "Independent evidence",
  intent: [],
  setup: [],
  states: [
    {
      id: "editor",
      description: "Editor",
      url: "/combination-evidence",
      probe: false,
      expect: { selectorPresent: ["#required"] },
    },
  ],
  toggles: {
    panel: { good: [], bad: [{ action: "click", selector: "#break" }] },
  },
  toggleRegions: ["#panel"],
};

test("equal layouts retain distinct expectations, axe and observation evidence for offline checks", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "idiom-combination-evidence-"),
  );
  const project = await toggleProject();
  project.viewports = project.viewports.slice(0, 1);
  const flow = flowSchema.parse(rawFlow);
  try {
    const result = await runCapture({
      projectDirectory: directory,
      project,
      flow,
      out: join(directory, ".idiom", "reports", "baseline"),
      dependencies: {
        snapshotSource: async () => ({ commit: "baseline", dirty: false }),
        inheritedEnvironment: { PATH: process.env.PATH },
      },
    });
    expect(result.counts).toEqual({ passed: 2, failed: 1, total: 3 });
    const loaded = await loadCaptureRun({
      runDirectory: result.runDirectory,
      expectedFlow: flow.id,
    });
    const bad = loaded.tuples.find(
      (tuple) => tuple.state === "editor.panel-bad",
    );
    expect(bad?.mismatches).toContainEqual({
      kind: "selector-present",
      expected: "#required",
    });
    expect(
      bad?.observations?.elements.some(
        (element) => element.selector === "#required",
      ),
    ).toBe(false);
    expect(bad?.axe).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ id: "label" }),
      ]),
    });
    const checked = runDeterministicChecks(
      loaded.tuples,
      expectedCaptureTupleKeys({
        project,
        flow,
        collapsed: loaded.collapsedTupleKeys,
      }),
      checksConfigFrom(project.checks),
    );
    expect(checked.candidates).toContainEqual(
      expect.objectContaining({
        tuple: expect.objectContaining({ combination: "panel=bad" }),
        candidate: expect.objectContaining({ category: "missing-state" }),
      }),
    );
    expect(checked.candidates).toContainEqual(
      expect.objectContaining({
        tuple: expect.objectContaining({ combination: "panel=bad" }),
        candidate: expect.objectContaining({ category: "a11y-label" }),
      }),
    );
    expect(loaded.collapsedCount).toBe(1);
    expect(bad?.screenshotPath).toBe(
      "editor.panel-good/desktop-1280/screenshot.png",
    );
    await expect(
      access(
        join(
          result.runDirectory,
          "editor.panel-bad",
          "desktop-1280",
          "screenshot.png",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(directory, ".idiom", "flows"), { recursive: true });
    await writeFile(
      join(directory, ".idiom", "project.json"),
      JSON.stringify(project),
    );
    await writeFile(
      join(directory, ".idiom", "flows", "evidence.json"),
      JSON.stringify(rawFlow),
    );
    const review = await runReview({
      project: directory,
      flow: flow.id,
      from: "baseline",
      deterministicOnly: true,
    });
    const findings = JSON.parse(await readFile(review.findingsPath, "utf8"));
    expect(findings).toContainEqual(
      expect.objectContaining({
        state: "editor.panel-bad",
        combination: "panel=bad",
        category: "missing-state",
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("runVerify retains attachments when distinct failing combinations become equal after repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-combination-verify-"));
  const project = await toggleProject();
  project.viewports = project.viewports.slice(0, 1);
  const raw = {
    ...rawFlow,
    states: [
      { ...rawFlow.states[0], url: "/combination-evidence?mode=verify" },
    ],
    toggles: {
      panel: {
        a: [{ action: "click", selector: "#panel-a" }],
        b: [{ action: "click", selector: "#panel-b" }],
      },
    },
    invariants: [{ name: "panel", selector: "#panel", height: 64 }],
  };
  const flow = flowSchema.parse(raw);
  const browserLauncher = createBrowserLauncher({
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  });
  try {
    await mkdir(join(directory, ".idiom", "flows"), { recursive: true });
    await writeFile(
      join(directory, ".idiom", "project.json"),
      JSON.stringify(project),
    );
    const baseline = await runCapture({
      projectDirectory: directory,
      project,
      flow,
      out: join(directory, ".idiom", "reports", "baseline"),
      dependencies: {
        browserLauncher,
        snapshotSource: async () => ({ commit: "before", dirty: false }),
        inheritedEnvironment: { PATH: process.env.PATH },
      },
    });
    const loaded = await loadCaptureRun({
      runDirectory: baseline.runDirectory,
      expectedFlow: flow.id,
    });
    const checked = runDeterministicChecks(
      loaded.tuples,
      expectedCaptureTupleKeys({ project, flow }),
      checksConfigFrom(project.checks),
    );
    const findings = buildDeterministicDrafts({
      runId: "baseline",
      entries: checked.candidates.filter(
        ({ tuple, candidate }) =>
          tuple.combination !== undefined &&
          candidate.category === "layout-invariants",
      ),
    }).map(({ finding }) => finding);
    expect(findings).toHaveLength(2);
    await writeFile(
      join(baseline.runDirectory, "findings.json"),
      JSON.stringify(findings),
    );
    const spec = join(directory, "repair.md");
    await writeFile(
      spec,
      findings
        .map(
          (finding) =>
            `\`\`\`idiom:finding\n${JSON.stringify(finding)}\n\`\`\``,
        )
        .join("\n\n"),
    );
    await writeFile(
      join(directory, ".idiom", "flows", "evidence.json"),
      JSON.stringify({
        ...raw,
        states: [
          {
            ...raw.states[0],
            url: "/combination-evidence?mode=verify&fixed=1",
          },
        ],
      }),
    );
    const result = await runVerify({
      project: directory,
      flow: flow.id,
      spec,
      against: baseline.runDirectory,
      out: join(directory, ".idiom", "reports", "verified"),
      dependencies: {
        gitTopology: async () => undefined,
        capture: {
          browserLauncher,
          snapshotSource: async () => ({ commit: "after", dirty: false }),
          inheritedEnvironment: { PATH: process.env.PATH },
        },
      },
    });
    expect(result).toMatchObject({
      passed: true,
      outcome: "fixed",
      findingCount: 2,
    });
    for (const state of ["editor.panel-a", "editor.panel-b"]) {
      await expect(
        access(
          join(
            result.outputDirectory,
            `before-after-${state}-desktop-1280.png`,
          ),
        ),
      ).resolves.toBeUndefined();
      for (const run of ["current-a", "current-b"])
        await expect(
          access(
            join(
              result.outputDirectory,
              run,
              state,
              "desktop-1280",
              "screenshot.png",
            ),
          ),
        ).resolves.toBeUndefined();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
