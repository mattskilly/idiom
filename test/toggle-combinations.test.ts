import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  expectedCaptureTupleKeys,
  selectCaptureTuples,
} from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import type {
  BrowserSession,
  BrowserTuple,
  TupleResult,
} from "../src/capture/types.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import {
  buildReviewCoverage,
  buildVerificationCoverage,
} from "../src/report/coverage.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { renderReviewHtmlReport } from "../src/review/html-report.js";
import { renderReport } from "../src/review/report.js";
import {
  combinationLabel,
  combinationStateId,
  expandToggleCombinations,
  flowSchema,
  isWebFlow,
} from "../src/schemas/flow.js";
import { toggleFlow, toggleProject } from "./toggle-support.js";

const base = {
  id: "flow",
  title: "Flow",
  intent: [],
  setup: [],
  states: [{ id: "editor", description: "Editor", url: "/editor", expect: {} }],
};
const toggles = {
  drawer: {
    closed: [],
    large: [{ action: "click" as const, selector: "#drawer" }],
  },
  inspector: { closed: [], open: [] },
};

describe("toggle flow schema", () => {
  test("cross product order, defaulting and path-safe labels", () => {
    expect(expandToggleCombinations(toggles).combos).toEqual([
      { drawer: "closed", inspector: "closed" },
      { drawer: "closed", inspector: "open" },
      { drawer: "large", inspector: "closed" },
      { drawer: "large", inspector: "open" },
    ]);
    expect(
      expandToggleCombinations(toggles, [{ inspector: "open" }]).combos,
    ).toEqual([{ drawer: "closed", inspector: "open" }]);
    expect(combinationLabel({ drawer: "large", inspector: "open" })).toBe(
      "drawer=large, inspector=open",
    );
    expect(
      combinationStateId("editor", { drawer: "large", inspector: "open" }),
    ).toBe("editor.drawer-large.inspector-open");
  });
  test("all caps at three toggles, explicit lists can use four", () => {
    const four = {
      a: { off: [], on: [] },
      b: { off: [], on: [] },
      c: { off: [], on: [] },
      d: { off: [], on: [] },
    };
    const expanded = expandToggleCombinations(four);
    expect(expanded.combos).toHaveLength(8);
    expect(expanded.combos.every((combo) => combo.d === "off")).toBe(true);
    expect(expanded.cap).toEqual({ combined: ["a", "b", "c"], held: ["d"] });
    expect(expandToggleCombinations(four, [{ d: "on" }])).toEqual({
      combos: [{ a: "off", b: "off", c: "off", d: "on" }],
    });
    const flow = flowSchema.parse({ ...base, toggles: four });
    expect(isWebFlow(flow) && flow.toggleCap).toEqual(expanded.cap);
  });
  test("prototype-named toggles still default only to their own declared options", () => {
    const flow = flowSchema.parse({
      ...base,
      toggles: { toString: { off: [], on: [] } },
      combinations: [{}],
    });
    expect(flow.states[1]?.id).toBe("editor.toString-off");
  });
  test("generated states inherit base configuration and append ordered steps", () => {
    const baseSteps = [{ action: "click", selector: "#base" }];
    const flow = flowSchema.parse({
      ...base,
      toggles,
      states: [
        {
          ...base.states[0],
          steps: baseSteps,
          focus: "#focus",
          fresh: true,
          settleMs: 20,
          viewports: ["desktop"],
          mask: [".secret"],
          invariants: [{ selector: ".controls", height: 64 }],
        },
      ],
      routes: ["/home"],
    });
    if (!isWebFlow(flow)) throw Error("web flow");
    expect(flow.states).toHaveLength(6);
    expect(flow.states[1]?.id).toBe("route-home");
    const generated = flow.states.find(
      (state) => state.id === "editor.drawer-large.inspector-open",
    );
    expect(generated).toMatchObject({
      description: "Editor (drawer=large, inspector=open)",
      steps: [...baseSteps, ...toggles.drawer.large],
      probe: false,
      url: "/editor",
      focus: "#focus",
      fresh: true,
      settleMs: 20,
      viewports: ["desktop"],
      mask: [".secret"],
      invariants: [{ selector: ".controls", height: 64 }],
      combination: {
        base: "editor",
        label: "drawer=large, inspector=open",
        options: { drawer: "large", inspector: "open" },
      },
    });
    const probe = flowSchema.parse({
      ...base,
      toggles,
      states: [{ ...base.states[0], probe: true }],
    });
    expect(probe.states.slice(1).every((state) => state.probe === true)).toBe(
      true,
    );
  });
  test("toggleStates expands declared states only and never routes", () => {
    const flow = flowSchema.parse({
      ...base,
      toggles,
      states: [...base.states, { ...base.states[0], id: "other" }],
      routes: ["/home"],
      toggleStates: ["other"],
    });
    expect(flow.states.map(({ id }) => id)).toEqual([
      "editor",
      "other",
      "route-home",
      "other.drawer-closed.inspector-closed",
      "other.drawer-closed.inspector-open",
      "other.drawer-large.inspector-closed",
      "other.drawer-large.inspector-open",
    ]);
  });
  test.each([
    { toggles: {} },
    { toggles: { drawer: {} } },
    { toggles: { "bad.name": { off: [] } } },
    { toggles: { "-bad": { off: [] } } },
    { toggles: { drawer: { "bad.name": [] } } },
    { toggles, combinations: [{ unknown: "open" }] },
    { toggles, combinations: [{ constructor: "open" }] },
    { toggles, combinations: [{ drawer: "toString" }] },
    { toggles, combinations: [{ drawer: "unknown" }] },
    { toggles, combinations: [{}, { drawer: "closed", inspector: "closed" }] },
    { toggles, combinations: [] },
    { toggles, toggleStates: ["missing"] },
    { toggles, toggleStates: ["route-home"], routes: ["/home"] },
    { combinations: "all" },
    { toggleStates: ["editor"] },
    { toggleRegions: [".drawer"] },
    {
      toggles,
      target: { kind: "electron", launch: { command: "electron ." } },
    },
  ])("rejects invalid config %j", (fields) => {
    expect(flowSchema.safeParse({ ...base, ...fields }).success).toBe(false);
  });
  test("toggle configuration is rejected on an otherwise valid Electron flow", () => {
    const electron = {
      ...base,
      target: {
        kind: "electron",
        launch: { executablePath: "electron" },
        window: { title: "Editor" },
      },
      states: [{ id: "editor", description: "Editor", expect: {} }],
    };
    expect(flowSchema.safeParse(electron).success).toBe(true);
    expect(flowSchema.safeParse({ ...electron, toggles }).success).toBe(false);
  });
  test("flows without toggles retain the previous parsed shape", () => {
    const parsed = flowSchema.parse(base);
    expect(Object.keys(parsed).sort()).toEqual([
      "health",
      "id",
      "intent",
      "setup",
      "states",
      "target",
      "title",
    ]);
    expect(parsed.states).toHaveLength(1);
    expect(parsed.states[0]).toEqual({
      id: "editor",
      description: "Editor",
      url: "/editor",
      expect: {
        status: 200,
        textPresent: [],
        selectorPresent: [],
        selectorAbsent: [],
      },
      steps: [],
      health: { allow: { urls: [], console: [] } },
      mask: [],
    });
  });
  test("generated id collisions are rejected at tuple selection", async () => {
    const project = await toggleProject();
    const flow = flowSchema.parse({
      ...base,
      toggles,
      states: [
        ...base.states,
        { ...base.states[0], id: "editor.drawer-closed.inspector-closed" },
      ],
      toggleStates: ["editor"],
    });
    expect(() => selectCaptureTuples({ project, flow })).toThrow(
      "duplicate state id",
    );
  });
});

function success(tuple: BrowserTuple): TupleResult {
  const { width, height } = tuple.viewport;
  return {
    ok: true,
    status: 200,
    dom: "<html></html>",
    screenshot: Buffer.from("fake png"),
    console: [],
    axe: { violations: [] },
    mismatches: [],
    observations: {
      version: 1,
      viewport: { width, height },
      document: {
        scrollWidth: width,
        scrollHeight: height,
        clientWidth: width,
        clientHeight: height,
      },
      elements: [],
      headings: [],
      tokens: { status: "not-configured" },
    },
    startedAt: "2026-10-23T00:00:00.000Z",
    endedAt: "2026-10-23T00:00:01.000Z",
  };
}

test.each([
  "measure",
  "no-measure",
  "no-selectors",
  "undefined",
  "selection",
  "schemes",
  "bases",
  "cap",
  "required-coordinates",
])(
  "capture and reload: %s",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "idiom-toggle-unit-"));
    const project = await toggleProject();
    // One signature per viewport and scheme; repeated across them must not collapse across axes or base states.
    const flow = toggleFlow();
    if (mode === "no-selectors") {
      flow.toggleRegions = [];
      flow.invariants = [];
    }
    if (mode === "schemes") {
      project.colorSchemes = ["light", "dark"];
    }
    if (mode === "bases") {
      const more = flow.states.map((state) => ({
        ...state,
        id: `other${state.id}`,
        ...(state.combination === undefined
          ? {}
          : { combination: { ...state.combination, base: "other" } }),
      }));
      flow.states.push(...more);
    }
    if (mode === "cap") {
      flow.toggleCap = {
        combined: ["drawer", "inspector", "third"],
        held: ["fourth"],
      };
    }
    const measured: string[] = [];
    const captured: BrowserTuple[] = [];
    const browser: BrowserSession = {
      version: "fake",
      close: async () => {},
      capture: async (tuple) => {
        captured.push(tuple);
        return success(tuple);
      },
      ...(mode === "no-measure"
        ? {}
        : {
            measure: async (tuple: BrowserTuple, selectors: string[]) => {
              measured.push(tuple.state.id);
              expect(selectors).toEqual([
                ".drawer",
                ".inspector",
                ".ed-controls",
              ]);
              return mode === "undefined" ? undefined : "same layout";
            },
          }),
    };
    try {
      const result = await runCapture({
        projectDirectory: directory,
        project,
        flow,
        out: join(directory, "run"),
        ...(mode === "required-coordinates"
          ? { deduplicateCombinations: false }
          : {}),
        ...(mode === "selection"
          ? {
              tuples: [
                { state: "editor.drawer-480.inspector-open", viewport: "wide" },
              ],
            }
          : {}),
        dependencies: {
          browserLauncher: async () => browser,
          snapshotSource: async () => ({ commit: "fixture", dirty: false }),
          inheritedEnvironment: { PATH: process.env.PATH },
        },
      });
      const noDedup = [
        "no-measure",
        "no-selectors",
        "undefined",
        "required-coordinates",
      ].includes(mode);
      const multiplier = ["schemes", "bases"].includes(mode) ? 2 : 1;
      const count = mode === "selection" ? 1 : 20 * multiplier;
      expect(captured).toHaveLength(count);
      expect(result.counts.total).toBe(count);
      const reportPath = join(result.runDirectory, "combinations.json");
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      const collapsed = noDedup || mode === "selection" ? 0 : 16 * multiplier;
      expect(report.collapsed).toHaveLength(collapsed);
      if (["no-selectors", "no-measure"].includes(mode)) {
        expect(measured).toEqual([]);
        expect(report.notes.join(" ")).toContain("not deduplicated");
      }
      if (mode === "cap") {
        expect(report.cap.held).toEqual(["fourth"]);
        expect(await readFile(result.reportPath, "utf8")).toContain(
          "cap of three toggles",
        );
      }
      expect(await readFile(result.reportPath, "utf8")).toContain(
        `${collapsed} collapsed`,
      );
      const loaded = await loadCaptureRun({
        runDirectory: result.runDirectory,
        expectedFlow: flow.id,
      });
      expect(loaded.collapsedCount).toBe(collapsed);
      expect(loaded.collapsedTupleKeys).toEqual([]);
      expect(
        loaded.tuples.filter(
          (tuple) => tuple.layoutRepresentative !== undefined,
        ),
      ).toHaveLength(collapsed);
      expect(
        captured.filter((tuple) => tuple.reuseScreenshot === undefined),
      ).toHaveLength(count - collapsed);
      if (collapsed > 0) {
        const representative = captured.find(
          (tuple) =>
            "combination" in tuple.state &&
            tuple.state.combination !== undefined,
        );
        if (!representative) throw Error("no representative");
        const axis = mode === "schemes" ? "/light" : "";
        const meta = JSON.parse(
          await readFile(
            join(
              result.runDirectory,
              representative.state.id,
              representative.viewport.name + axis,
              "metadata.json",
            ),
            "utf8",
          ),
        );
        expect(meta.combination.equivalent).toHaveLength(8);
        expect(
          loaded.tuples.find((tuple) => tuple.state === representative.state.id)
            ?.combination,
        ).toBe(meta.combination.label);
      }
      const expected = expectedCaptureTupleKeys({
        project,
        flow,
        collapsed: loaded.collapsedTupleKeys,
      });
      const checked = runDeterministicChecks(loaded.tuples, expected);
      if (mode !== "selection") {
        expect(
          checked.candidates.filter(
            ({ candidate }) => candidate.category === "missing-state",
          ),
        ).toEqual([]);
        const coverage = buildReviewCoverage({
          project,
          flow,
          tuples: loaded.tuples,
          commit: loaded.commit,
          collapsedTupleKeys: loaded.collapsedTupleKeys,
        });
        expect(coverage.selectedTuples).toBe(count);
        expect(coverage.successfulTuples).toBe(count);
        if (collapsed)
          expect(coverage.limitations.join(" ")).toContain(
            `${collapsed} combination layout screenshots were collapsed`,
          );
        const verification = buildVerificationCoverage({
          project,
          flow,
          tuples: selectCaptureTuples({ project, flow }).map((tuple) => ({
            state: tuple.state.id,
            viewport: tuple.viewport.name,
            colorScheme: tuple.colorScheme,
          })),
          successfulTuples: count,
          collapsedTupleKeys: loaded.collapsedTupleKeys,
        });
        expect(verification.selectedTuples).toBe(count);
        expect(verification.purpose).toBe(
          "Full declared grid selected for finding verification",
        );
        expect(verification.limitations.join(" ")).not.toContain(
          "not successfully recaptured",
        );
        expect(
          buildVerificationCoverage({
            project,
            flow,
            tuples: loaded.tuples,
            successfulTuples: count,
            collapsedTupleKeys: loaded.collapsedTupleKeys,
          }).purpose,
        ).toBe("Full declared grid selected for finding verification");
      }
      if (mode === "measure") {
        await writeFile(reportPath, JSON.stringify({ ...report, version: 2 }));
        await expect(
          loadCaptureRun({
            runDirectory: result.runDirectory,
            expectedFlow: flow.id,
          }),
        ).rejects.toThrow("invalid combinations report");
        await writeFile(
          reportPath,
          JSON.stringify({
            ...report,
            collapsed: [
              {
                ...report.collapsed[0],
                sameAs: { state: "missing", combination: "missing" },
              },
            ],
          }),
        );
        await expect(
          loadCaptureRun({
            runDirectory: result.runDirectory,
            expectedFlow: flow.id,
          }),
        ).rejects.toThrow("representative");
        await writeFile(reportPath, JSON.stringify(report));
        const first = report.collapsed[0];
        const collapsedDirectory = join(
          result.runDirectory,
          first.state,
          first.viewport,
        );
        const evidencePath = join(collapsedDirectory, "observations.json");
        const evidenceBytes = await readFile(evidencePath);
        await unlink(evidencePath);
        await expect(
          loadCaptureRun({
            runDirectory: result.runDirectory,
            expectedFlow: flow.id,
          }),
        ).rejects.toThrow("missing observations.json");
        await writeFile(evidencePath, evidenceBytes);
        const metadataPath = join(collapsedDirectory, "metadata.json");
        const originalMetadata = await readFile(metadataPath, "utf8");
        const metadata = JSON.parse(originalMetadata);
        for (const layoutRepresentative of [first.state, "../outside"]) {
          await writeFile(
            metadataPath,
            JSON.stringify({ ...metadata, layoutRepresentative }),
          );
          await expect(
            loadCaptureRun({
              runDirectory: result.runDirectory,
              expectedFlow: flow.id,
            }),
          ).rejects.toThrow(/invalid (layout representative|metadata)/);
        }
        await writeFile(metadataPath, originalMetadata);
        // Legacy reports predate independent evidence for collapsed tuples.
        for (const entry of report.collapsed)
          await rm(
            join(
              result.runDirectory,
              entry.state,
              entry.viewport,
              ...(entry.colorSchemeAxis ? [entry.colorScheme] : []),
            ),
            { recursive: true, force: true },
          );
        const { evidence, ...legacyReport } = report;
        await writeFile(reportPath, JSON.stringify(legacyReport));
        const legacyCollapsed = await loadCaptureRun({
          runDirectory: result.runDirectory,
          expectedFlow: flow.id,
        });
        expect(legacyCollapsed.collapsedTupleKeys).toHaveLength(collapsed);
        expect(legacyCollapsed.tuples).toHaveLength(count - collapsed);
        expect(
          buildReviewCoverage({
            project,
            flow,
            tuples: legacyCollapsed.tuples,
            commit: legacyCollapsed.commit,
            collapsedTupleKeys: legacyCollapsed.collapsedTupleKeys,
          }).limitations.join(" "),
        ).toContain("their deterministic checks are unavailable");
        await unlink(reportPath);
        const legacy = await loadCaptureRun({
          runDirectory: result.runDirectory,
          expectedFlow: flow.id,
        });
        expect(legacy.collapsedTupleKeys).toEqual([]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test("combination findings retain labels in markdown and HTML", async () => {
  const project = await toggleProject();
  const flow = toggleFlow();
  const tuple = {
    flow: "panels",
    state: "editor.drawer-480.inspector-open",
    combination: "drawer=480, inspector=open",
    viewport: "desktop-1280",
    width: 1280,
    height: 800,
    metadataPath: "metadata.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-10-23T00:00:00.000Z",
    console: [],
    mismatches: [],
  };
  const drafts = buildDeterministicDrafts({
    runId: "fixture",
    entries: [
      {
        tuple,
        checkOrder: 0,
        candidate: {
          category: "layout-invariants",
          severity: "major",
          rule: "idiom:layout-invariants:height",
          selectorHint: ".ed-controls",
          explanation: "controls height 128; expected 64",
          acceptance: ["Keep controls height 64"],
          verification: { check: "layout-invariants", params: {} },
        },
      },
    ],
  });
  const finding = drafts[0]?.finding;
  expect(finding?.combination).toBe(tuple.combination);
  if (!finding) throw Error("finding missing");
  const reportOptions = {
    runId: "fixture",
    flow: flow.id,
    commit: "fixture",
    findings: [finding],
    tuples: [tuple],
    coverage: [],
    outcome: { kind: "deterministic-only" as const },
    reportCoverage: buildReviewCoverage({
      project,
      flow,
      tuples: [tuple],
      commit: "fixture",
    }),
  };
  expect(renderReport(reportOptions)).toContain("[drawer=480, inspector=open]");
  expect(
    renderReviewHtmlReport({ ...reportOptions, screenshots: new Map() }),
  ).toContain("[drawer=480, inspector=open]");
});
