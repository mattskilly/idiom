import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test, vi } from "vitest";
import { runCapture } from "../src/capture/run.js";
import type {
  BrowserLauncher,
  ElectronLauncher,
  TupleResult,
} from "../src/capture/types.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifact,
  ObservedElementV2,
} from "../src/checks/types.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { buildVerificationCoverage } from "../src/report/coverage.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import {
  compositeArtifactName,
  createAttachmentManifest,
  validateAttachmentManifest,
  writeAttachmentManifest,
} from "../src/verify/attachments.js";
import { resolveBaseline } from "../src/verify/baseline.js";
import { writeBeforeAfterComposite } from "../src/verify/compare.js";
import { evaluateVerification } from "../src/verify/evaluate.js";
import { renderVerificationHtmlReport } from "../src/verify/html-report.js";
import {
  compareFindingLocus,
  deriveVerificationLocus,
} from "../src/verify/locus.js";
import {
  assertMaskAgreement,
  bareTemporalComponent,
  buildSemanticProfile,
  type SemanticProfile,
} from "../src/verify/profile.js";
import { renderVerificationReport } from "../src/verify/report.js";
import { runVerify } from "../src/verify/run.js";
import { parseFindingBlocks, selectFindingTuples } from "../src/verify/spec.js";
import { fixtureCommand } from "./support/fixture-server.js";
import {
  artifactV2,
  freePort,
  legacyElement,
  png,
  v2Element,
} from "./verify-support.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function browserWithText(text: string, onLaunch?: () => void): BrowserLauncher {
  return async () => {
    onLaunch?.();
    return {
      version: "Mock Chromium",
      async capture(): Promise<TupleResult> {
        return {
          ok: true,
          status: 200,
          dom: `<html><body><main>${text}</main></body></html>`,
          screenshot: png(),
          console: [],
          axe: { violations: [] },
          observations: artifactV2(text),
          mismatches: [],
          startedAt: "2026-08-15T12:00:00.000Z",
          endedAt: "2026-08-15T12:00:01.000Z",
        };
      },
      async close() {},
    };
  };
}

function electronWithText(
  text: string,
  onSession?: () => void,
): ElectronLauncher {
  return async () => {
    onSession?.();
    return {
      effectiveEnvironment: {},
      async capture() {
        return {
          version: "Electron mock / Chromium mock",
          result: {
            ok: true as const,
            status: null,
            dom: `<html><body><main>${text}</main></body></html>`,
            screenshot: png(),
            console: [],
            axe: { violations: [] },
            observations: artifactV2(text),
            mismatches: [],
            startedAt: "2026-08-15T12:00:00.000Z",
            endedAt: "2026-08-15T12:00:01.000Z",
          },
        };
      },
      async close() {},
    };
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return findingSchema.parse({
    id: "IDM-run-0001",
    fingerprint: "fingerprint",
    createdAt: "2026-08-15T12:00:00.000Z",
    commit: "abc123",
    flow: "booking",
    state: "confirmed",
    viewport: "desktop",
    layer: "model",
    category: "hierarchy",
    severity: "major",
    confidence: 0.8,
    rule: "Hierarchy is clear",
    evidence: { screenshots: ["confirmed/desktop/screenshot.png"] },
    explanation: "The hierarchy is flat.",
    acceptance: ["The primary content is clear."],
    verification: { kind: "recapture-visual" },
    status: "open",
    ...overrides,
  });
}

function spacingArtifact(clearances: number[]): ObservationArtifact {
  const sections: ObservedElementV2[] = [];
  clearances.forEach((clearance, index) => {
    const y = 40 + index * 80;
    const path = `html[0]/body[0]/main[0]/section[${index}]`;
    const section = v2Element({
      selector: `section.action-${index + 1}`,
      tag: "section",
      path,
      y,
    });
    section.rect = { x: 20, y, width: 300, height: 30 + clearance };
    section.relativeRect = section.rect;
    const button = v2Element({
      selector: `button.action-${index + 1}`,
      tag: "button",
      path: `${path}/button[0]`,
      text: `Action ${index + 1}`,
      y: y + 10,
    });
    button.interactive = true;
    button.rect = { x: 30, y: y + 10, width: 120, height: 20 };
    button.relativeRect = button.rect;
    sections.push(section, button);
  });
  return artifactV2("Settings", sections);
}

function tuple(observations: ObservationArtifact): CheckTuple {
  return {
    flow: "booking",
    state: "confirmed",
    viewport: "desktop",
    width: 800,
    height: 600,
    metadataPath: "confirmed/desktop/metadata.json",
    screenshotPath: "confirmed/desktop/screenshot.png",
    artifactPaths: [],
    commit: "abc123",
    createdAt: "2026-08-15T12:00:00.000Z",
    observations,
    axe: { violations: [] },
    console: [],
    consoleAvailable: true,
    mismatches: [],
    platform: {
      platform: process.platform,
      architecture: process.arch,
      release: "test-release",
      browserVersion: "Chromium test",
    },
  };
}

test("finding fences honor opening length and validate every record", () => {
  const first = finding({
    explanation: "Contains a ``` marker safely in JSON.",
  });
  const second = finding({
    id: "IDM-run-0002",
    state: "taken",
    viewport: "mobile",
  });
  const source = [
    "````idiom:finding",
    JSON.stringify(first),
    "````",
    "text",
    "```idiom:finding",
    JSON.stringify(second),
    "```",
  ].join("\n");
  expect(parseFindingBlocks(source).map(({ id }) => id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(() => parseFindingBlocks("```idiom:finding\n{}\n```")).toThrow(
    "invalid idiom:finding",
  );
  expect(() => parseFindingBlocks("````idiom:finding\n{}\n```")).toThrow(
    "unterminated",
  );
  const canonical = findingSchema.parse({
    ...first,
    id: "finding-1",
    idAliases: [first.id],
  });
  expect(
    parseFindingBlocks(
      [
        "```idiom:finding",
        JSON.stringify(first),
        "```",
        "```idiom:finding",
        JSON.stringify(canonical),
        "```",
      ].join("\n"),
    ),
  ).toHaveLength(1);
  expect(() =>
    parseFindingBlocks(
      [
        "```idiom:finding",
        JSON.stringify(first),
        "```",
        "```idiom:finding",
        JSON.stringify({ ...canonical, state: "taken" }),
        "```",
      ].join("\n"),
    ),
  ).toThrow("incompatible embedded finding identity");
});

test("finding tuples are validated, deduplicated, and ordered by the manifest", () => {
  const project = projectSchema.parse({
    version: 1,
    app: { name: "x", framework: "other" },
    server: {
      build: "x",
      start: "x",
      readyUrl: "http://127.0.0.1:1",
      port: 1,
      env: {},
    },
    viewports: [
      { name: "desktop", width: 800, height: 600 },
      { name: "mobile", width: 390, height: 844 },
    ],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "booking",
    title: "Booking",
    intent: [],
    setup: [],
    states: [
      {
        id: "confirmed",
        description: "Confirmed",
        url: "/confirmed",
        expect: {},
      },
      { id: "taken", description: "Taken", url: "/taken", expect: {} },
    ],
  });
  expect(
    selectFindingTuples({
      findings: [
        finding({ state: "taken", viewport: "mobile" }),
        finding(),
        finding(),
      ],
      flow,
      project,
    }),
  ).toEqual([
    { state: "confirmed", viewport: "desktop" },
    { state: "taken", viewport: "mobile" },
  ]);
  expect(() =>
    selectFindingTuples({
      findings: [finding({ state: "missing" })],
      flow,
      project,
    }),
  ).toThrow("unknown state");

  const axisProject = projectSchema.parse({
    ...project,
    colorSchemes: ["light", "dark"],
  });
  expect(
    selectFindingTuples({
      findings: [
        finding({
          colorScheme: "dark",
          rule: "idiom:missing-color-scheme",
          verification: {
            kind: "deterministic-check",
            check: "missing-state",
            params: { fullFlow: true },
          },
        }),
      ],
      flow,
      project: axisProject,
    }),
  ).toEqual(
    flow.states.flatMap((state) =>
      axisProject.viewports.flatMap((viewport) =>
        axisProject.colorSchemes.map((colorScheme) => ({
          state: state.id,
          viewport: viewport.name,
          colorScheme,
        })),
      ),
    ),
  );
  expect(
    selectFindingTuples({
      findings: [
        finding({
          category: "spacing-rhythm",
          rule: "idiom:spacing-rhythm-outlier",
          verification: {
            kind: "deterministic-check",
            check: "spacing-rhythm",
            params: {
              placement: {
                structuralPath: "html[0]/body[0]/main[0]/section[0]/button[0]",
                kind: "button",
                side: "boundary-below",
              },
              fullFlow: true,
            },
          },
        }),
      ],
      flow,
      project: axisProject,
    }),
  ).toEqual(
    flow.states.flatMap((state) =>
      axisProject.viewports.flatMap((viewport) =>
        axisProject.colorSchemes.map((colorScheme) => ({
          state: state.id,
          viewport: viewport.name,
          colorScheme,
        })),
      ),
    ),
  );
});

test("verification coverage distinguishes finding scope from a full selected grid", () => {
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "build",
      start: "start",
      readyUrl: "http://127.0.0.1:1",
      port: 1,
      env: {},
    },
    viewports: [
      { name: "desktop", width: 800, height: 600 },
      { name: "mobile", width: 390, height: 844 },
    ],
    colorSchemes: ["light", "dark"],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "booking",
    title: "Booking",
    intent: [],
    setup: [],
    states: [
      { id: "confirmed", description: "Confirmed", url: "/", expect: {} },
      { id: "taken", description: "Taken", url: "/taken", expect: {} },
    ],
  });
  const sparseTuples = [
    { state: "confirmed", viewport: "desktop", colorScheme: "dark" as const },
  ];
  const sparse = buildVerificationCoverage({
    flow,
    project,
    tuples: sparseTuples,
    successfulTuples: 1,
    baselineCommit: "abc123",
    currentCommit: "def456",
  });
  const manifest = createAttachmentManifest(sparseTuples);
  const markdown = renderVerificationReport({
    flow: "booking",
    baselineRunId: "baseline",
    currentRunA: "current-a",
    currentRunB: "current-b",
    manifest,
    diagnostic: "fixture diagnostic",
    reportCoverage: sparse,
  });
  const html = renderVerificationHtmlReport({
    flow: "booking",
    baselineRunId: "baseline",
    currentRunA: "current-a",
    currentRunB: "current-b",
    manifest,
    diagnostic: "fixture diagnostic",
    reportCoverage: sparse,
  });
  for (const output of [markdown, html]) {
    expect(output).toContain("Finding-scoped verification coverage");
    expect(output).toContain("1 of 2 declared");
    expect(output).toContain("desktop (800×600)");
    expect(output).toContain("dark");
    expect(output).toContain("abc123");
    expect(output).toContain("def456");
    expect(output).toContain("not a fresh whole-flow review");
    expect(output.indexOf("Coverage and limits")).toBeLessThan(
      output.indexOf("fixture diagnostic"),
    );
  }

  const fullTuples = flow.states.flatMap((state) =>
    project.viewports.flatMap((viewport) =>
      project.colorSchemes.map((colorScheme) => ({
        state: state.id,
        viewport: viewport.name,
        colorScheme,
      })),
    ),
  );
  const full = buildVerificationCoverage({
    flow,
    project,
    tuples: fullTuples,
    successfulTuples: fullTuples.length,
    baselineCommit: "abc123",
    currentCommit: "def456",
  });
  expect(full.purpose).toBe(
    "Full declared grid selected for finding verification",
  );
  expect(full.selectedTuples).toBe(8);
  expect(full.limitations.join(" ")).toContain("not a fresh whole-flow review");
});

test("v2 profiles ignore non-rendered and non-allow-listed payload drift but detect rendered changes", () => {
  const hiddenA = v2Element({
    selector: "script",
    tag: "script",
    path: "html[0]/body[0]/script[0]",
    text: "self.__next_f.push('private-a')",
    visible: false,
  });
  const hiddenB = { ...hiddenA, directText: "private-b", text: "private-b" };
  const first = buildSemanticProfile({
    artifact: artifactV2("Stable", [hiddenA]),
    kind: "v2-full",
  });
  const second = buildSemanticProfile({
    artifact: artifactV2("Stable", [hiddenB]),
    kind: "v2-full",
  });
  expect(first.signature).toBe(second.signature);
  expect(first.reductions.excludedNonRendered).toBe(1);
  const changed = buildSemanticProfile({
    artifact: artifactV2("Visible change", [hiddenB]),
    kind: "v2-full",
  });
  expect(changed.signature).not.toBe(first.signature);
});

test("v2 verification suppresses masked temporal content-derived fields", () => {
  const datedArtifact = (
    dateText: string,
    ariaLabel: string,
    gridTemplateColumns: string,
    transform: string,
  ): ObservationArtifact => {
    const card = v2Element({
      selector: "section.card",
      tag: "section",
      path: "html[0]/body[0]/main[0]/section[0]",
      attributes: { class: "card" },
    });
    card.ancestorSelectors = ["main"];
    card.styles.gridTemplateColumns = gridTemplateColumns;
    card.styles.transform = transform;
    const when = v2Element({
      selector: "p.when",
      tag: "p",
      path: "html[0]/body[0]/main[0]/section[0]/p[0]",
      text: dateText,
      attributes: { class: "when", "aria-label": ariaLabel },
    });
    when.ancestorSelectors = ["section.card", "main"];
    when.temporal = true;
    const offender = v2Element({
      selector: "p.bad",
      tag: "p",
      path: "html[0]/body[0]/main[0]/section[0]/p[1]",
      text: "Cramped supporting copy",
      attributes: { class: "bad" },
    });
    offender.ancestorSelectors = ["section.card", "main"];
    const artifact = artifactV2("Surface", [card, when, offender]);
    if (artifact.version !== 2) throw new Error("fixture");
    const whenPath = when.legacyRenderedPath;
    if (whenPath === undefined) throw new Error("fixture");
    artifact.maskMembership = [{ selector: ".when", paths: [whenPath] }];
    return artifact;
  };
  const baselineArtifact = datedArtifact(
    "Wed Aug 12, 2:00 PM",
    "Wednesday, August 12 at 2:00 PM",
    "145.672px 254.328px",
    "matrix(1, 0, 0, 1, 145.672, 0)",
  );
  const current = datedArtifact(
    "Thu Sep 3, 11:15 AM",
    "Thursday, September 3 at 11:15 AM",
    "62.6719px 337.328px",
    "matrix(1, 0, 0, 1, 62.6719, 0)",
  );
  const baselineProfile = buildSemanticProfile({
    artifact: baselineArtifact,
    kind: "v2-full",
  });
  const dateRecord = baselineProfile.records.find(
    ({ selector }) => selector === "p.when",
  );
  expect(dateRecord).toMatchObject({
    path: "html[0]/body[0]/main[0]/section[0]/p[0]",
  });
  expect(dateRecord).not.toHaveProperty("text");
  expect(dateRecord).not.toHaveProperty("geometry");
  expect(dateRecord).not.toHaveProperty("attributes");
  const cardRecord = baselineProfile.records.find(
    ({ selector }) => selector === "section.card",
  );
  expect(cardRecord?.styles).not.toHaveProperty("gridTemplateColumns");
  expect(cardRecord?.styles).not.toHaveProperty("transform");
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".card");
  if (locus === undefined) throw new Error("expected locus");
  const result = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(current)],
    currentB: [tuple(structuredClone(current))],
  });
  expect(result).toMatchObject({
    passed: false,
    calibrations: [{ negotiated: "v2-full" }],
    findings: [{ status: "reproduced", locus: { changed: false } }],
  });
});

type TemporalNode = {
  selector: string;
  path: string;
  text?: string;
  attributes?: Record<string, string>;
  island?: string;
  visible?: boolean;
};

function temporalTree(nodes: TemporalNode[]): ObservationArtifact {
  const root = "html[0]/body[0]/main[0]";
  const elements = nodes.map((node, index) => {
    const tag = (node.path.split("/").at(-1) ?? "").replace(/\[\d+\]$/, "");
    const element = v2Element({
      selector: node.selector,
      tag,
      path: `${root}/${node.path}`,
      y: index * 20,
      ...(node.text === undefined ? {} : { text: node.text }),
      ...(node.attributes === undefined ? {} : { attributes: node.attributes }),
      ...(node.visible === undefined ? {} : { visible: node.visible }),
    });
    element.ancestorSelectors = [
      ...nodes
        .filter((other) => node.path.startsWith(`${other.path}/`))
        .map(({ selector }) => selector)
        .reverse(),
      "main",
    ];
    if (node.island !== undefined)
      element.stableIslandPath = `${root}/${node.island}`;
    return element;
  });
  return artifactV2("", elements);
}

function temporalRecord(artifact: ObservationArtifact, selector: string) {
  return buildSemanticProfile({ artifact, kind: "v2-full" }).records.find(
    (record) => record.selector === selector,
  );
}

function temporalVerdict(
  baselineArtifact: ObservationArtifact,
  current: ObservationArtifact,
  selector: string,
) {
  const locus = deriveVerificationLocus(tuple(baselineArtifact), selector);
  if (locus === undefined) throw new Error("expected locus");
  return evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(current)],
    currentB: [tuple(structuredClone(current))],
  });
}

test("bare temporal components are days of month or plausible years", () => {
  for (const value of ["1", "12", "31", "12th", " 3 ", "1999", "2026"])
    expect(bareTemporalComponent(value)).toBe(true);
  for (const value of [
    "0",
    "32",
    "42",
    "123",
    "1800",
    "3 guests",
    "",
    "123456789",
  ])
    expect(bareTemporalComponent(value)).toBe(false);
});

test("v2 verification recognizes a date past the old inner-text sample", () => {
  const lateDateArtifact = (
    dateText: string,
    gridTemplateColumns: string,
    transform: string,
    height: number,
  ): ObservationArtifact => {
    const filler = Array.from({ length: 20 }, (_, index) => ({
      selector: `p.filler-${index}`,
      path: `section[0]/p[${index}]`,
      text: `Supporting paragraph ${index} with enough copy to push later text well past any sample window.`,
    }));
    const artifact = temporalTree([
      { selector: "section.card", path: "section[0]" },
      ...filler,
      { selector: "p.when", path: "section[0]/p[20]", text: dateText },
    ]);
    if (artifact.version !== 2) throw new Error("fixture");
    const card = artifact.elements.find(
      ({ selector }) => selector === "section.card",
    );
    if (card === undefined) throw new Error("fixture");
    card.styles.gridTemplateColumns = gridTemplateColumns;
    card.styles.transform = transform;
    card.rect.height = height;
    card.relativeRect.height = height;
    return artifact;
  };
  const baselineArtifact = lateDateArtifact(
    "Wed Aug 12, 2:00 PM",
    "145.672px 254.328px",
    "matrix(1, 0, 0, 1, 145.672, 0)",
    480,
  );
  const current = lateDateArtifact(
    "Thu Sep 3, 11:15 AM",
    "62.6719px 337.328px",
    "matrix(1, 0, 0, 1, 62.6719, 0)",
    520,
  );
  if (baselineArtifact.version !== 2) throw new Error("fixture");
  expect(
    baselineArtifact.elements.every(({ temporal }) => temporal === false),
  ).toBe(true);
  expect(
    baselineArtifact.elements
      .filter(({ selector }) => selector.startsWith("p."))
      .reduce((total, { directText }) => total + directText.length, 0),
  ).toBeGreaterThan(1000);
  const profile = buildSemanticProfile({
    artifact: baselineArtifact,
    kind: "v2-full",
  });
  const cardRecord = profile.records.find(
    ({ selector }) => selector === "section.card",
  );
  expect(cardRecord?.styles).not.toHaveProperty("gridTemplateColumns");
  expect(cardRecord?.styles).not.toHaveProperty("transform");
  expect(cardRecord).not.toHaveProperty("geometry");
  expect(
    profile.records.find(({ selector }) => selector === "p.when"),
  ).not.toHaveProperty("text");
  expect(
    profile.records.find(({ selector }) => selector === "p.filler-3")?.text,
  ).toContain("Supporting paragraph 3");
  // main, section.card and p.when; body and html are excluded upstream.
  expect(profile.reductions.textSuppressedTemporal).toBeGreaterThanOrEqual(3);
  expect(temporalVerdict(baselineArtifact, current, "p.when")).toMatchObject({
    passed: false,
    calibrations: [{ negotiated: "v2-full" }],
    findings: [{ status: "reproduced", locus: { changed: false } }],
  });
});

test("v2 verification treats a calendar day as temporal through the grid label", () => {
  const calendar = (day: string) =>
    temporalTree([
      {
        selector: "table.calendar",
        path: "table[0]",
        attributes: { role: "grid", "aria-label": "October 2026" },
      },
      {
        selector: "tbody.weeks",
        path: "table[0]/tbody[0]",
        island: "table[0]",
      },
      {
        selector: "tr.week",
        path: "table[0]/tbody[0]/tr[0]",
        island: "table[0]",
      },
      {
        selector: "td.cell",
        path: "table[0]/tbody[0]/tr[0]/td[0]",
        attributes: { role: "gridcell" },
        island: "table[0]/tbody[0]/tr[0]/td[0]",
      },
      {
        selector: "button.day",
        path: "table[0]/tbody[0]/tr[0]/td[0]/button[0]",
        text: day,
        island: "table[0]/tbody[0]/tr[0]/td[0]",
      },
    ]);
  const baselineArtifact = calendar("12");
  const dayRecord = temporalRecord(baselineArtifact, "button.day");
  expect(dayRecord).not.toHaveProperty("text");
  expect(dayRecord).not.toHaveProperty("geometry");
  expect(
    temporalVerdict(baselineArtifact, calendar("3"), "button.day"),
  ).toMatchObject({
    passed: false,
    findings: [{ status: "reproduced", locus: { changed: false } }],
  });
});

test("v2 verification takes bare day or year context from own attributes or a parent's own text", () => {
  const labelled = temporalTree([
    {
      selector: "button.day",
      path: "button[0]",
      text: "12",
      attributes: { "aria-label": "Monday, October 12" },
    },
  ]);
  expect(temporalRecord(labelled, "button.day")).not.toHaveProperty("text");

  const renewal = (year: string) =>
    temporalTree([
      { selector: "p.renewal", path: "p[0]", text: "Renewal on Oct 30," },
      { selector: "span.year", path: "p[0]/span[0]", text: year },
    ]);
  expect(temporalRecord(renewal("2026"), "span.year")).not.toHaveProperty(
    "text",
  );
  expect(
    buildSemanticProfile({ artifact: renewal("2026"), kind: "v2-full" })
      .signature,
  ).toBe(
    buildSemanticProfile({ artifact: renewal("2027"), kind: "v2-full" })
      .signature,
  );

  // A hidden wrapper takes one step of the walk but does not end it.
  const wrapped = temporalTree([
    { selector: "p.renewal", path: "p[0]", text: "Renewal on Oct 30," },
    { selector: "span.wrap", path: "p[0]/span[0]", visible: false },
    { selector: "span.year", path: "p[0]/span[0]/span[0]", text: "2026" },
  ]);
  expect(temporalRecord(wrapped, "span.year")).not.toHaveProperty("text");
});

test("v2 verification keeps a bare count beside a date in a shared island", () => {
  const booking = (count: string) =>
    temporalTree([
      {
        selector: "form.booking",
        path: "form[0]",
        attributes: { role: "form" },
      },
      { selector: "div.when", path: "form[0]/div[0]", island: "form[0]" },
      {
        selector: "p.when",
        path: "form[0]/div[0]/p[0]",
        text: "Oct 12",
        island: "form[0]",
      },
      { selector: "div.stepper", path: "form[0]/div[1]", island: "form[0]" },
      {
        selector: "span.count",
        path: "form[0]/div[1]/span[0]",
        text: count,
        island: "form[0]",
      },
    ]);
  const baselineArtifact = booking("3");
  const profile = buildSemanticProfile({
    artifact: baselineArtifact,
    kind: "v2-full",
  });
  expect(
    profile.records.find(({ selector }) => selector === "span.count"),
  ).toMatchObject({ text: "3" });
  for (const selector of ["form.booking", "div.when", "p.when"])
    expect(
      profile.records.find((record) => record.selector === selector),
    ).not.toHaveProperty("geometry");
  expect(
    profile.records.find(({ selector }) => selector === "form.booking")
      ?.attributes,
  ).toBeUndefined();
  expect(
    temporalVerdict(baselineArtifact, booking("4"), "span.count"),
  ).toMatchObject({
    passed: true,
    findings: [{ status: "fixed", locus: { changed: true } }],
  });
});

test("v2 verification leaves out-of-range, mixed and distant bare numbers rendered", () => {
  const overRange = temporalTree([
    { selector: "p.renewal", path: "p[0]", text: "Renewal on Oct 30," },
    { selector: "span.count", path: "p[0]/span[0]", text: "42" },
    { selector: "span.step", path: "p[0]/span[1]", text: "Step 2 of 4" },
  ]);
  expect(temporalRecord(overRange, "span.count")).toMatchObject({
    text: "42",
  });
  expect(temporalRecord(overRange, "span.step")).toMatchObject({
    text: "Step 2 of 4",
  });

  const distant = temporalTree([
    { selector: "section.dated", path: "section[0]", text: "Oct 2026" },
    { selector: "div.a", path: "section[0]/div[0]" },
    { selector: "div.b", path: "section[0]/div[0]/div[0]" },
    { selector: "div.c", path: "section[0]/div[0]/div[0]/div[0]" },
    { selector: "div.d", path: "section[0]/div[0]/div[0]/div[0]/div[0]" },
    {
      selector: "span.day",
      path: "section[0]/div[0]/div[0]/div[0]/div[0]/span[0]",
      text: "12",
    },
  ]);
  expect(temporalRecord(distant, "span.day")).toMatchObject({ text: "12" });

  const bodyDated = temporalTree([
    { selector: "span.day", path: "span[0]", text: "12" },
  ]);
  if (bodyDated.version !== 2) throw new Error("fixture");
  const body = bodyDated.elements.find(({ tag }) => tag === "body");
  if (body === undefined) throw new Error("fixture");
  body.directText = "October 2026";
  body.attributes = { "aria-label": "October 2026" };
  expect(temporalRecord(bodyDated, "span.day")).toMatchObject({ text: "12" });
});

function contextualLegacy(
  elements: Array<{
    selector: string;
    tag: string;
    text: string;
    ancestors: string[];
  }>,
): ObservationArtifact {
  return {
    version: 1,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [
      legacyElement({ selector: "html", tag: "html" }),
      legacyElement({ selector: "body", tag: "body" }),
      legacyElement({ selector: "main", tag: "main" }),
      ...elements.map((element, index) =>
        legacyElement({ ...element, y: index * 20 }),
      ),
    ],
    headings: [],
    tokens: { status: "not-configured" },
  };
}

test("v1 projection treats a bare day as temporal only through a parent's residual text", () => {
  const dated = buildSemanticProfile({
    artifact: contextualLegacy([
      { selector: "p.when", tag: "p", text: "October 12", ancestors: ["main"] },
      {
        selector: "span.day",
        tag: "span",
        text: "12",
        ancestors: ["p.when", "main"],
      },
    ]),
    kind: "v1-compatible",
  });
  for (const selector of ["p.when", "span.day"]) {
    const record = dated.records.find((entry) => entry.selector === selector);
    expect(record).not.toHaveProperty("text");
    expect(record).not.toHaveProperty("geometry");
  }

  const shared = buildSemanticProfile({
    artifact: contextualLegacy([
      { selector: "form", tag: "form", text: "Oct 12 3", ancestors: ["main"] },
      {
        selector: "p.when",
        tag: "p",
        text: "Oct 12",
        ancestors: ["form", "main"],
      },
      {
        selector: "div.count",
        tag: "div",
        text: "3",
        ancestors: ["form", "main"],
      },
    ]),
    kind: "v1-compatible",
  });
  expect(
    shared.records.find(({ selector }) => selector === "div.count"),
  ).toMatchObject({ text: "3" });
  expect(
    shared.records.find(({ selector }) => selector === "p.when"),
  ).not.toHaveProperty("text");
});

test("v2 verification excludes temporal attribute values without hiding real changes", () => {
  const rebookArtifact = (
    ariaLabel: string,
    text: string,
  ): ObservationArtifact => {
    const card = v2Element({
      selector: "section.card",
      tag: "section",
      path: "html[0]/body[0]/main[0]/section[0]",
      attributes: { class: "card" },
    });
    card.ancestorSelectors = ["main"];
    const button = v2Element({
      selector: "button.rebook",
      tag: "button",
      path: "html[0]/body[0]/main[0]/section[0]/button[0]",
      text,
      attributes: { class: "rebook", "aria-label": ariaLabel },
    });
    button.ancestorSelectors = ["section.card", "main"];
    return artifactV2("Surface", [card, button]);
  };
  const baselineArtifact = rebookArtifact(
    "Reschedule Wednesday, August 12 at 2:00 PM",
    "Reschedule",
  );
  const current = rebookArtifact(
    "Reschedule Thursday, September 3 at 11:15 AM",
    "Reschedule",
  );
  const baselineProfile = buildSemanticProfile({
    artifact: baselineArtifact,
    kind: "v2-full",
  });
  expect(
    baselineProfile.records.find(({ selector }) => selector === "button.rebook")
      ?.attributes,
  ).toEqual({ class: "rebook" });
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".card");
  if (locus === undefined) throw new Error("expected locus");
  const reproduced = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(current)],
    currentB: [tuple(structuredClone(current))],
  });
  expect(reproduced).toMatchObject({
    passed: false,
    calibrations: [{ negotiated: "v2-full" }],
    findings: [{ status: "reproduced", locus: { changed: false } }],
  });

  const changed = rebookArtifact(
    "Reschedule Thursday, September 3 at 11:15 AM",
    "Choose another appointment",
  );
  const fixed = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(changed)],
    currentB: [tuple(structuredClone(changed))],
  });
  expect(fixed).toMatchObject({
    passed: true,
    findings: [{ status: "fixed", locus: { changed: true } }],
  });
});

test("distinct rendered paths keep changes outside a declared target locus excluded", () => {
  const wrappedArtifact = (secondText: string): ObservationArtifact => {
    const firstWrapper = v2Element({
      selector: "div.wrapper-a",
      tag: "div",
      path: "html[0]/body[0]/main[0]/div[0]",
      visible: false,
    });
    firstWrapper.ancestorSelectors = ["main"];
    const first = v2Element({
      selector: "p.wrapped-a",
      tag: "p",
      path: "html[0]/body[0]/main[0]/p[0]",
      text: "Alpha",
      attributes: { class: "wrapped-a" },
    });
    first.structuralPath = "html[0]/body[0]/main[0]/div[0]/p[0]";
    first.ancestorSelectors = ["div.wrapper-a", "main"];
    const secondWrapper = v2Element({
      selector: "div.wrapper-b",
      tag: "div",
      path: "html[0]/body[0]/main[0]/div[1]",
      visible: false,
    });
    secondWrapper.ancestorSelectors = ["main"];
    const second = v2Element({
      selector: "p.wrapped-b",
      tag: "p",
      path: "html[0]/body[0]/main[0]/p[1]",
      text: secondText,
      attributes: { class: "wrapped-b" },
    });
    second.structuralPath = "html[0]/body[0]/main[0]/div[1]/p[0]";
    second.ancestorSelectors = ["div.wrapper-b", "main"];
    return artifactV2("Surface", [firstWrapper, first, secondWrapper, second]);
  };
  const baselineArtifact = wrappedArtifact("Beta");
  const locus = deriveVerificationLocus(tuple(baselineArtifact), "p.wrapped-a");
  if (locus === undefined) throw new Error("expected locus");
  const current = wrappedArtifact("Changed outside the target");
  const result = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(current)],
    currentB: [tuple(structuredClone(current))],
  });
  expect(result).toMatchObject({
    passed: false,
    findings: [
      {
        status: "reproduced",
        locus: { source: "declared-locus", changed: false },
      },
    ],
  });
});

test("locus signatures ignore shifted ancestors but retain target changes", () => {
  const shiftedArtifact = (options: {
    banner: boolean;
    targetText: string;
  }): ObservationArtifact => {
    const sections: ObservedElementV2[] = [];
    if (options.banner)
      sections.push(
        v2Element({
          selector: "section.banner",
          tag: "section",
          path: "html[0]/body[0]/section[0]",
          text: "Unrelated banner",
          attributes: { class: "banner" },
        }),
      );
    const offset = options.banner ? 1 : 0;
    sections.push(
      v2Element({
        selector: "section.promo",
        tag: "section",
        path: `html[0]/body[0]/section[${offset}]`,
        text: "Promotion",
        attributes: { class: "promo" },
      }),
    );
    const checkout = v2Element({
      selector: "section.checkout",
      tag: "section",
      path: `html[0]/body[0]/section[${offset + 1}]`,
      attributes: { class: "checkout" },
    });
    const target = v2Element({
      selector: "p.bad",
      tag: "p",
      path: `${checkout.structuralPath}/p[0]`,
      text: options.targetText,
      attributes: { class: "bad" },
    });
    target.ancestorSelectors = ["section.checkout"];
    sections.push(checkout, target);
    return artifactV2("Surface", sections);
  };
  const baselineArtifact = shiftedArtifact({
    banner: false,
    targetText: "Still cramped",
  });
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".bad");
  if (locus === undefined) throw new Error("expected locus");
  const shifted = shiftedArtifact({
    banner: true,
    targetText: "Still cramped",
  });
  const reproduced = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(shifted)],
    currentB: [tuple(structuredClone(shifted))],
  });
  expect(reproduced).toMatchObject({
    passed: false,
    findings: [{ status: "reproduced", locus: { changed: false } }],
  });

  // A stray selector in verification.params is a deterministic-check concern
  // and never anchors a visual comparison: without a locus, the whole tuple is
  // compared, so the unrelated banner counts as a change.
  const strayParams = evaluateVerification({
    findings: [
      finding({
        verification: {
          kind: "recapture-visual",
          params: { selector: "p.bad" },
        },
      }),
    ],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(shifted)],
    currentB: [tuple(structuredClone(shifted))],
  });
  expect(strayParams).toMatchObject({
    passed: true,
    findings: [
      {
        status: "fixed",
        locus: { source: "legacy-whole-tuple", changed: true },
      },
    ],
  });

  const fixedArtifact = shiftedArtifact({
    banner: true,
    targetText: "Comfortable supporting copy",
  });
  const fixed = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(fixedArtifact)],
    currentB: [tuple(structuredClone(fixedArtifact))],
  });
  expect(fixed).toMatchObject({
    passed: true,
    findings: [{ status: "fixed", locus: { changed: true } }],
  });
});

test("locus-less visual findings compare the whole tuple end to end", () => {
  const baseline = tuple(artifactV2("Before"));
  const reproduced = evaluateVerification({
    findings: [finding()],
    baseline: [baseline],
    currentA: [tuple(artifactV2("Before"))],
    currentB: [tuple(artifactV2("Before"))],
  });
  expect(reproduced).toMatchObject({
    passed: false,
    findings: [
      {
        status: "reproduced",
        locus: { source: "legacy-whole-tuple", changed: false },
      },
    ],
  });
  const fixed = evaluateVerification({
    findings: [finding()],
    baseline: [baseline],
    currentA: [tuple(artifactV2("After"))],
    currentB: [tuple(artifactV2("After"))],
  });
  expect(fixed).toMatchObject({
    passed: true,
    findings: [
      {
        status: "fixed",
        locus: { source: "legacy-whole-tuple", changed: true },
      },
    ],
  });
});

test("locus geometry ignores outside displacement but detects target resizing", () => {
  const layoutArtifact = (options: {
    bannerHeight: number;
    targetHeight: number;
  }): ObservationArtifact => {
    const islandPath = "html[0]/body[0]/main[0]";
    const banner = v2Element({
      selector: "div.banner",
      tag: "div",
      path: `${islandPath}/div[0]`,
      text: "Promotion",
      attributes: { class: "banner" },
      y: 0,
    });
    banner.ancestorSelectors = ["main"];
    banner.rect.height = options.bannerHeight;
    banner.relativeRect.height = options.bannerHeight;
    banner.stableIslandPath = islandPath;
    const card = v2Element({
      selector: "div.card",
      tag: "div",
      path: `${islandPath}/div[1]`,
      attributes: { class: "card" },
      y: options.bannerHeight,
    });
    card.ancestorSelectors = ["main"];
    card.stableIslandPath = islandPath;
    const target = v2Element({
      selector: "p.bad",
      tag: "p",
      path: `${islandPath}/div[1]/p[0]`,
      text: "Cramped supporting copy",
      attributes: { class: "bad" },
      y: options.bannerHeight + 10,
    });
    target.ancestorSelectors = ["div.card", "main"];
    target.rect.height = options.targetHeight;
    target.relativeRect.height = options.targetHeight;
    target.stableIslandPath = islandPath;
    return artifactV2("Surface", [banner, card, target]);
  };
  const baselineArtifact = layoutArtifact({
    bannerHeight: 40,
    targetHeight: 20,
  });
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".bad");
  if (locus === undefined) throw new Error("expected locus");
  const displaced = layoutArtifact({
    bannerHeight: 120,
    targetHeight: 20,
  });
  const reproduced = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(displaced)],
    currentB: [tuple(structuredClone(displaced))],
  });
  expect(reproduced).toMatchObject({
    passed: false,
    calibrations: [{ negotiated: "v2-full" }],
    findings: [{ status: "reproduced", locus: { changed: false } }],
  });

  const resized = layoutArtifact({ bannerHeight: 40, targetHeight: 64 });
  const fixed = evaluateVerification({
    findings: [finding({ verification: { kind: "recapture-visual", locus } })],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(resized)],
    currentB: [tuple(structuredClone(resized))],
  });
  expect(fixed).toMatchObject({
    passed: true,
    findings: [{ status: "fixed", locus: { changed: true } }],
  });
});

test("v1 projection filters hidden payloads and suppresses capped and temporal ancestors", () => {
  const baseline: ObservationArtifact = {
    version: 1,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [
      legacyElement({ selector: "html", tag: "html", text: "x".repeat(500) }),
      legacyElement({
        selector: "body",
        tag: "body",
        text: "Monday August 15",
      }),
      legacyElement({ selector: "div", tag: "div", text: "Stable" }),
      legacyElement({ selector: "p", tag: "p", text: "Monday August 15" }),
      legacyElement({
        selector: "script",
        tag: "script",
        text: "private-a",
        visible: false,
      }),
    ],
    headings: [],
    tokens: { status: "not-configured" },
  };
  const profile = buildSemanticProfile({
    artifact: baseline,
    kind: "v1-compatible",
    maskMembership: [
      { selector: ".divide-y.divide-rule", paths: ["html[0]/body[0]/div[0]"] },
    ],
  });
  expect(profile.reductions.excludedNonRendered).toBe(1);
  expect(profile.reductions.textSuppressedBoundary).toBe(1);
  expect(profile.reductions.textSuppressedTemporal).toBeGreaterThan(0);
  expect(profile.reductions.textSuppressedMask).toBeGreaterThan(0);
  expect(JSON.stringify(profile.records)).not.toContain("private-a");

  const reduced = buildSemanticProfile({
    artifact: baseline,
    kind: "v1-compatible",
    maskMembership: [
      {
        selector: ".nested-mask",
        paths: ["html[0]/body[0]/div[0]/span[0]"],
      },
      { selector: ".valid-but-empty", paths: [] },
    ],
  });
  expect(reduced.reductions.maskStatus).toEqual([
    {
      selector: ".nested-mask",
      status: "widened",
      paths: ["html[0]/body[0]/div[0]"],
    },
    {
      selector: ".valid-but-empty",
      status: "temporal-mask-fallback",
      paths: [],
    },
  ]);
});

test("v1 temporal suppression retains non-temporal sibling text and geometry", () => {
  const legacyArtifact = (options: {
    offenderText: string;
    dateText: string;
    offenderHeight: number;
  }): ObservationArtifact => {
    const aggregate = `${options.offenderText} ${options.dateText}`;
    return {
      version: 1,
      viewport: { width: 800, height: 600 },
      document: {
        scrollWidth: 800,
        scrollHeight: 600,
        clientWidth: 800,
        clientHeight: 600,
      },
      elements: [
        legacyElement({ selector: "html", tag: "html", text: aggregate }),
        legacyElement({ selector: "body", tag: "body", text: aggregate }),
        legacyElement({ selector: "main", tag: "main", text: aggregate }),
        legacyElement({
          selector: "p.offender",
          tag: "p",
          text: options.offenderText,
          ancestors: ["main"],
          y: 0,
          height: options.offenderHeight,
        }),
        legacyElement({
          selector: "p.when",
          tag: "p",
          text: options.dateText,
          ancestors: ["main"],
          y: 100,
        }),
      ],
      headings: [],
      tokens: { status: "not-configured" },
    };
  };
  const currentArtifact = (options: {
    offenderText: string;
    dateText: string;
    offenderHeight: number;
  }): ObservationArtifact => {
    const offender = v2Element({
      selector: "p.offender",
      tag: "p",
      path: "html[0]/body[0]/main[0]/p[0]",
      text: options.offenderText,
      y: 0,
    });
    offender.ancestorSelectors = ["main"];
    offender.rect.height = options.offenderHeight;
    offender.relativeRect.height = options.offenderHeight;
    const when = v2Element({
      selector: "p.when",
      tag: "p",
      path: "html[0]/body[0]/main[0]/p[1]",
      text: options.dateText,
      y: 100,
    });
    when.ancestorSelectors = ["main"];
    when.temporal = true;
    const artifact = artifactV2("", [offender, when]);
    if (artifact.version !== 2) throw new Error("fixture");
    const aggregate = `${options.offenderText} ${options.dateText}`;
    for (const selector of ["html", "body", "main"]) {
      const ancestor = artifact.elements.find(
        (element) => element.selector === selector,
      );
      if (ancestor === undefined) throw new Error("fixture");
      ancestor.text = aggregate;
    }
    return artifact;
  };
  const baselineArtifact = legacyArtifact({
    offenderText: "Cramped supporting copy",
    dateText: "Wed Aug 12",
    offenderHeight: 20,
  });
  const baselineProfile = buildSemanticProfile({
    artifact: baselineArtifact,
    kind: "v1-compatible",
  });
  expect(
    baselineProfile.records.find(({ selector }) => selector === "p.offender"),
  ).toMatchObject({
    text: "Cramped supporting copy",
    geometry: { x: 0, y: 0, width: 100, height: 20 },
  });
  expect(baselineProfile.reductions.textSuppressedTemporal).toBe(4);

  const dateOnly = currentArtifact({
    offenderText: "Cramped supporting copy",
    dateText: "Thu Aug 13",
    offenderHeight: 20,
  });
  const dateOnlyProfile = buildSemanticProfile({
    artifact: dateOnly,
    kind: "v1-compatible",
  });
  expect(dateOnlyProfile.signature).toBe(baselineProfile.signature);
  const reproduced = evaluateVerification({
    findings: [finding()],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(dateOnly)],
    currentB: [tuple(structuredClone(dateOnly))],
  });
  expect(reproduced).toMatchObject({
    passed: false,
    findings: [{ status: "reproduced" }],
  });

  const changed = currentArtifact({
    offenderText: "Cramped supporting copy",
    dateText: "Thu Aug 13",
    offenderHeight: 64,
  });
  const changedProfile = buildSemanticProfile({
    artifact: changed,
    kind: "v1-compatible",
  });
  expect(changedProfile.signature).not.toBe(baselineProfile.signature);
  const fixed = evaluateVerification({
    findings: [finding()],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(changed)],
    currentB: [tuple(structuredClone(changed))],
  });
  expect(fixed).toMatchObject({
    passed: true,
    findings: [{ status: "fixed" }],
  });
});

type BoundaryBlock = {
  selector: string;
  tag: string;
  text: string;
  ancestors: string[];
  path: string;
  height?: number;
};

function boundaryPage(options: {
  leading?: BoundaryBlock[];
  targetText?: string | undefined;
  detailText?: string;
  noteText?: string;
  detailHeight?: number;
  regionPath?: string;
}): BoundaryBlock[] {
  const region = options.regionPath ?? "html[0]/body[0]/main[0]/div[0]";
  return [
    ...(options.leading ?? []),
    {
      selector: "div.region",
      tag: "div",
      text: "region",
      ancestors: ["main"],
      path: region,
    },
    ...(options.targetText === undefined
      ? []
      : [
          {
            selector: "p.target",
            tag: "p",
            text: options.targetText,
            ancestors: ["div.region", "main"],
            path: `${region}/p[0]`,
          },
          {
            selector: "span.detail",
            tag: "span",
            text: options.detailText ?? "detail",
            ancestors: ["p.target", "div.region", "main"],
            path: `${region}/p[0]/span[0]`,
            ...(options.detailHeight === undefined
              ? {}
              : { height: options.detailHeight }),
          },
        ]),
    {
      selector: "ul.note",
      tag: "ul",
      text: options.noteText ?? "note",
      ancestors: ["div.region", "main"],
      path: `${region}/ul[0]`,
    },
  ];
}

function boundaryV1(blocks: BoundaryBlock[]): ObservationArtifact {
  return {
    version: 1,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [
      legacyElement({ selector: "html", tag: "html", text: "shell" }),
      legacyElement({ selector: "body", tag: "body", text: "shell" }),
      legacyElement({ selector: "main", tag: "main", text: "shell" }),
      ...blocks.map((block) =>
        legacyElement({
          selector: block.selector,
          tag: block.tag,
          text: block.text,
          ancestors: block.ancestors,
          ...(block.height === undefined ? {} : { height: block.height }),
        }),
      ),
    ],
    headings: [],
    tokens: { status: "not-configured" },
  };
}

function boundaryV2(blocks: BoundaryBlock[]): ObservationArtifact {
  const artifact = artifactV2(
    "",
    blocks.map((block) => {
      const element = v2Element({
        selector: block.selector,
        tag: block.tag,
        path: block.path,
        text: block.text,
        attributes: { class: block.selector.split(".")[1] ?? "" },
      });
      element.ancestorSelectors = block.ancestors;
      if (block.height !== undefined) {
        element.rect.height = block.height;
        element.relativeRect.height = block.height;
      }
      return element;
    }),
  );
  for (const element of artifact.elements)
    if (["html", "body", "main"].includes(element.selector))
      element.text = "shell";
  return artifact;
}

function v1Profile(blocks: BoundaryBlock[]): SemanticProfile {
  return buildSemanticProfile({
    artifact: boundaryV1(blocks),
    kind: "v1-compatible",
  });
}

function boundaryLocusFinding(): Finding {
  const signature = (tag: string, selector: string) =>
    createHash("sha256").update(`${tag}\0${selector}`).digest("hex");
  return finding({
    verification: {
      kind: "recapture-visual",
      locus: {
        version: 1,
        target: { selector: "p.target", signature: signature("p", "p.target") },
        region: {
          selector: "div.region",
          signature: signature("div", "div.region"),
        },
        relativePath: "p[0]",
      },
    },
  });
}

function compareBoundary(
  subject: Finding,
  baseline: BoundaryBlock[],
  current: BoundaryBlock[],
) {
  return compareFindingLocus({
    finding: subject,
    baseline: v1Profile(baseline),
    currentA: v1Profile(current),
    currentB: v1Profile(current),
  });
}

const filler = (length: number, char = "x") => char.repeat(length);

test("v1 profiles record which paths reached the text boundary", () => {
  const profile = v1Profile(
    boundaryPage({ targetText: filler(500), detailText: filler(499) }),
  );
  expect(profile.reductions.boundaryPaths).toEqual([
    "html[0]/body[0]/main[0]/div[0]/p[0]",
  ]);
  expect(
    profile.records.find(({ selector }) => selector === "span.detail")?.text,
  ).toBe(filler(499));
  const v2 = buildSemanticProfile({
    artifact: boundaryV2(boundaryPage({ targetText: filler(500) })),
    kind: "v2-full",
  });
  expect(v2.reductions.boundaryPaths).toEqual([]);
});

test("pair-level text suppression unions the boundary across compared sides", () => {
  for (const subject of [boundaryLocusFinding()]) {
    // Below the boundary on both sides: unchanged, nothing suppressed.
    const same = compareBoundary(
      subject,
      boundaryPage({ targetText: filler(120) }),
      boundaryPage({ targetText: filler(120) }),
    );
    expect(same).toMatchObject({
      changed: false,
      pairTextSuppression: {
        paths: [],
        historicalRecords: 0,
        currentRecords: 0,
      },
    });
    // A genuine below-threshold text change is still compared.
    expect(
      compareBoundary(
        subject,
        boundaryPage({ targetText: filler(120) }),
        boundaryPage({ targetText: filler(130) }),
      ),
    ).toMatchObject({ changed: true, pairTextSuppression: { paths: [] } });

    // At the boundary on both sides: each side already suppressed its own.
    expect(
      compareBoundary(
        subject,
        boundaryPage({ targetText: filler(500, "a") }),
        boundaryPage({ targetText: filler(500, "b") }),
      ),
    ).toMatchObject({
      changed: false,
      pairTextSuppression: {
        paths: ["."],
        historicalRecords: 0,
        currentRecords: 0,
      },
    });

    // Crossing in either direction never decides the verdict on text alone.
    expect(
      compareBoundary(
        subject,
        boundaryPage({ targetText: filler(500, "a"), detailText: "d" }),
        boundaryPage({ targetText: filler(499, "b"), detailText: "d" }),
      ),
    ).toMatchObject({
      changed: false,
      pairTextSuppression: {
        paths: ["."],
        historicalRecords: 0,
        currentRecords: 1,
      },
    });
    expect(
      compareBoundary(
        subject,
        boundaryPage({ targetText: "t", detailText: filler(499, "a") }),
        boundaryPage({ targetText: "t", detailText: filler(500, "b") }),
      ),
    ).toMatchObject({
      changed: false,
      pairTextSuppression: {
        paths: ["span[0]"],
        historicalRecords: 1,
        currentRecords: 0,
      },
    });

    // Only text is removed: a real non-text change still counts.
    expect(
      compareBoundary(
        subject,
        boundaryPage({ targetText: "t", detailText: filler(500) }),
        boundaryPage({
          targetText: "t",
          detailText: filler(499),
          detailHeight: 64,
        }),
      ),
    ).toMatchObject({
      changed: true,
      pairTextSuppression: { paths: ["span[0]"] },
    });
  }
});

test("pair-level text suppression follows comparison roots, not absolute paths", () => {
  const subject = boundaryLocusFinding();
  const old: BoundaryBlock = {
    selector: "div.old",
    tag: "div",
    text: filler(500),
    ancestors: ["main"],
    path: "html[0]/body[0]/main[0]/div[0]",
  };
  const inserted: BoundaryBlock = {
    selector: "div.new",
    tag: "div",
    text: "inserted",
    ancestors: ["main"],
    path: "html[0]/body[0]/main[0]/div[0]",
  };
  const shiftedOld = { ...old, path: "html[0]/body[0]/main[0]/div[1]" };
  const baseline = (detailText: string) =>
    boundaryPage({
      leading: [old],
      targetText: "t",
      detailText,
      regionPath: "html[0]/body[0]/main[0]/div[1]",
    });
  const current = (detailText: string) =>
    boundaryPage({
      leading: [inserted, shiftedOld],
      targetText: "t",
      detailText,
      regionPath: "html[0]/body[0]/main[0]/div[2]",
    });
  expect(
    compareBoundary(subject, baseline(filler(120)), current(filler(120))),
  ).toMatchObject({ changed: false, pairTextSuppression: { paths: [] } });
  expect(
    compareBoundary(subject, baseline(filler(500)), current(filler(499))),
  ).toMatchObject({
    changed: false,
    pairTextSuppression: { paths: ["span[0]"], currentRecords: 1 },
  });

  // Target absent: the union is taken over the region roots.
  const absent = compareBoundary(
    subject,
    boundaryPage({ targetText: "t", noteText: filler(500) }),
    boundaryPage({ targetText: undefined, noteText: filler(499) }),
  );
  expect(absent).toMatchObject({
    target: "target-absent",
    pairTextSuppression: {
      paths: ["ul[0]"],
      historicalRecords: 0,
      currentRecords: 1,
    },
  });

  // Whole-tuple fallback keys the union by absolute path.
  const below = compareBoundary(
    finding(),
    boundaryPage({ targetText: "t" }),
    boundaryPage({ targetText: "t" }),
  );
  expect(below.beforeSignature).toBe(
    v1Profile(boundaryPage({ targetText: "t" })).signature,
  );
  expect(
    compareBoundary(
      finding(),
      boundaryPage({ targetText: "t", detailText: filler(500) }),
      boundaryPage({ targetText: "t", detailText: filler(499) }),
    ),
  ).toMatchObject({
    source: "legacy-whole-tuple",
    changed: false,
    pairTextSuppression: {
      paths: ["html[0]/body[0]/main[0]/div[0]/p[0]/span[0]"],
      historicalRecords: 0,
      currentRecords: 1,
    },
  });
});

test("a v1 baseline crossing the text boundary reproduces and reports pair suppression", () => {
  const subject = boundaryLocusFinding();
  const evaluate = (current: BoundaryBlock[]) =>
    evaluateVerification({
      findings: [subject],
      baseline: [
        tuple(
          boundaryV1(
            boundaryPage({ targetText: "t", detailText: filler(500) }),
          ),
        ),
      ],
      currentA: [tuple(boundaryV2(current))],
      currentB: [tuple(boundaryV2(current))],
    });
  const crossing = evaluate(
    boundaryPage({ targetText: "t", detailText: filler(499) }),
  );
  expect(crossing.calibrations[0]?.negotiated).toBe("v1-compatible");
  expect(crossing.findings[0]).toMatchObject({
    status: "reproduced",
    locus: { pairTextSuppression: { paths: ["span[0]"] } },
  });
  expect(crossing.findings[0]?.reason).toContain(
    "pair-level text suppression on 1 path(s)",
  );
  const render = (evaluation: typeof crossing) => [
    renderVerificationReport({
      flow: "booking",
      baselineRunId: "baseline",
      currentRunA: "A",
      currentRunB: "B",
      manifest: createAttachmentManifest([]),
      evaluation,
    }),
    renderVerificationHtmlReport({
      flow: "booking",
      baselineRunId: "baseline",
      currentRunA: "A",
      currentRunB: "B",
      manifest: createAttachmentManifest([]),
      evaluation,
    }),
  ];
  const [markdown, html] = render(crossing);
  expect(markdown).toContain("### Pair-level text suppression");
  expect(markdown).toContain(
    "- `IDM-run-0001` (declared-locus): text omitted on all compared sides for `span[0]` (500-character boundary reached on at least one side); historical records affected: 0, current: 1.",
  );
  expect(html).toContain(
    "Pair-level text suppression: text omitted on all compared sides for span[0]",
  );

  const genuine = evaluateVerification({
    findings: [subject],
    baseline: [tuple(boundaryV1(boundaryPage({ targetText: filler(120) })))],
    currentA: [tuple(boundaryV2(boundaryPage({ targetText: filler(130) })))],
    currentB: [tuple(boundaryV2(boundaryPage({ targetText: filler(130) })))],
  });
  expect(genuine.findings[0]).toMatchObject({
    status: "fixed",
    locus: { pairTextSuppression: { paths: [] } },
  });
  for (const output of render(genuine))
    expect(output).not.toContain("Pair-level text suppression");
});

test("mask calibration rejects current membership drift", () => {
  const first = artifactV2("Stable");
  const second = artifactV2("Stable");
  if (first.version !== 2 || second.version !== 2) throw new Error("fixture");
  first.maskMembership = [
    { selector: ".date", paths: ["html[0]/body[0]/main[0]"] },
  ];
  second.maskMembership = [{ selector: ".date", paths: [] }];
  expect(() => assertMaskAgreement(first, second)).toThrow("mask membership");
});

test("visual evaluation reproduces unchanged evidence and accepts a stable semantic change", () => {
  const embedded = finding();
  const baseline = tuple(artifactV2("Before"));
  const unchanged = evaluateVerification({
    findings: [embedded],
    baseline: [baseline],
    currentA: [tuple(artifactV2("Before"))],
    currentB: [tuple(artifactV2("Before"))],
  });
  expect(unchanged.passed).toBe(false);
  expect(unchanged.findings[0]?.status).toBe("reproduced");
  const fixed = evaluateVerification({
    findings: [embedded],
    baseline: [baseline],
    currentA: [tuple(artifactV2("After"))],
    currentB: [tuple(artifactV2("After"))],
  });
  expect(fixed.passed).toBe(true);
  expect(fixed.findings[0]?.status).toBe("fixed");
});

test("spacing-rhythm deterministic verification reproduces and fixes through the shared registry", () => {
  const baseline = tuple(spacingArtifact([16, 16, 16, 0]));
  const checked = runDeterministicChecks([baseline]);
  const spacingEntries = checked.candidates.filter(
    ({ candidate }) => candidate.category === "spacing-rhythm",
  );
  expect(spacingEntries).toHaveLength(1);
  const embedded = buildDeterministicDrafts({
    runId: "baseline",
    entries: spacingEntries,
  })[0]?.finding;
  if (embedded === undefined) throw new Error("missing spacing finding");
  expect(embedded.verification.params?.fullFlow).toBe(true);

  const reproducedArtifact = spacingArtifact([16, 16, 16, 0]);
  const reproduced = evaluateVerification({
    findings: [embedded],
    baseline: [baseline],
    currentA: [tuple(reproducedArtifact)],
    currentB: [tuple(structuredClone(reproducedArtifact))],
  });
  expect(reproduced.findings).toMatchObject([{ status: "reproduced" }]);
  expect(reproduced.passed).toBe(false);

  const fixedArtifact = spacingArtifact([16, 16, 16, 16]);
  const fixed = evaluateVerification({
    findings: [embedded],
    baseline: [baseline],
    currentA: [tuple(fixedArtifact)],
    currentB: [tuple(structuredClone(fixedArtifact))],
  });
  expect(fixed.findings).toMatchObject([{ status: "fixed" }]);
  expect(fixed.passed).toBe(true);
});

test("v1 baseline negotiation compares only shared fields against v2 captures", () => {
  const baselineArtifact: ObservationArtifact = {
    version: 1,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [
      legacyElement({ selector: "html", tag: "html" }),
      legacyElement({ selector: "body", tag: "body" }),
      legacyElement({ selector: "main", tag: "main" }),
      legacyElement({
        selector: "div.wrapper",
        tag: "div",
        visible: false,
        ancestors: ["main"],
      }),
      legacyElement({
        selector: "p.wrapped",
        tag: "p",
        text: "Before",
        ancestors: ["div.wrapper", "main"],
      }),
    ],
    headings: [],
    tokens: { status: "not-configured" },
  };
  const currentWithV2OnlyDrift = () => {
    const wrapper = v2Element({
      selector: "div.wrapper",
      tag: "div",
      path: "html[0]/body[0]/main[0]/div[0]",
      visible: false,
    });
    wrapper.ancestorSelectors = ["main"];
    const wrapped = v2Element({
      selector: "p.wrapped",
      tag: "p",
      path: "html[0]/body[0]/main[0]/p[0]",
      text: "Before",
    });
    wrapped.structuralPath = "html[0]/body[0]/main[0]/div[0]/p[0]";
    wrapped.ancestorSelectors = ["div.wrapper", "main"];
    const artifact = artifactV2("", [wrapper, wrapped]);
    if (artifact.version !== 2) throw new Error("fixture");
    wrapped.directText = "Changed direct text that v1 never recorded";
    wrapped.attributes = { class: "changed-v2-only", role: "region" };
    wrapped.styles.display = "flex";
    wrapped.styles.fontFamily = "A v2-only font";
    return artifact;
  };
  const reproduced = evaluateVerification({
    findings: [finding()],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(currentWithV2OnlyDrift())],
    currentB: [tuple(currentWithV2OnlyDrift())],
  });
  expect(reproduced.calibrations[0]).toMatchObject({
    fullV2: "equal",
    negotiated: "v1-compatible",
    negotiatedResult: "equal",
  });
  for (const profile of [
    reproduced.calibrations[0]?.baselineProfile,
    reproduced.calibrations[0]?.currentProfileA,
    reproduced.calibrations[0]?.currentProfileB,
  ])
    expect(
      profile?.records.find(({ selector }) => selector === "p.wrapped")?.path,
    ).toBe("html[0]/body[0]/main[0]/p[0]");
  expect(reproduced.findings[0]?.status).toBe("reproduced");
  expect(reproduced.passed).toBe(false);

  const changedSharedStyle = () => {
    const artifact = currentWithV2OnlyDrift();
    const wrapped = artifact.elements.find(
      ({ selector }) => selector === "p.wrapped",
    );
    if (wrapped === undefined) throw new Error("fixture");
    wrapped.styles.borderTopWidth = "1px";
    return artifact;
  };
  const fixed = evaluateVerification({
    findings: [finding()],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(changedSharedStyle())],
    currentB: [tuple(changedSharedStyle())],
  });
  expect(fixed.findings[0]?.status).toBe("fixed");
  expect(fixed.passed).toBe(true);
});

test("a new deterministic blocker fails even when the original visual finding is fixed", () => {
  const baseline = tuple(artifactV2("Before"));
  const currentA = tuple(artifactV2("After"));
  const currentB = tuple(artifactV2("After"));
  currentA.mismatches = [{ kind: "text-present", expected: "Required state" }];
  currentB.mismatches = [{ kind: "text-present", expected: "Required state" }];
  const result = evaluateVerification({
    findings: [finding()],
    baseline: [baseline],
    currentA: [currentA],
    currentB: [currentB],
  });
  expect(result.findings[0]?.status).toBe("fixed");
  expect(result.newBlockers.length).toBeGreaterThan(0);
  expect(result.passed).toBe(false);
});

test("only unique CSS hints persist a target plus durable region locus", () => {
  const target = v2Element({
    selector: "button.cta",
    tag: "button",
    path: "html[0]/body[0]/main[0]/button[0]",
    text: "Continue",
    attributes: { class: "cta" },
  });
  target.ancestorSelectors = ["main"];
  const source = artifactV2("Surface", [target]);
  const sourceTuple = tuple(source);
  expect(deriveVerificationLocus(sourceTuple, ".cta")).toMatchObject({
    version: 1,
    target: { selector: "button.cta" },
    region: { selector: "main" },
  });
  expect(
    deriveVerificationLocus(sourceTuple, "the continue button"),
  ).toBeUndefined();
  const duplicate = v2Element({
    selector: "button.cta:nth-of-type(2)",
    tag: "button",
    path: "html[0]/body[0]/main[0]/button[1]",
    attributes: { class: "cta" },
  });
  duplicate.ancestorSelectors = ["main"];
  expect(
    deriveVerificationLocus(
      tuple(artifactV2("Surface", [target, duplicate])),
      ".cta",
    ),
  ).toBeUndefined();
});

function anchoredArtifact(options: {
  regionTag: string;
  regionClass: string;
  regionAttributes?: Record<string, string>;
  regionSelector?: string;
  wrapperClass: string;
  targetText: string;
  extras?: ObservedElementV2[];
}): ObservationArtifact {
  const regionPath = `html[0]/body[0]/main[0]/${options.regionTag}[0]`;
  const regionSelector =
    options.regionSelector ??
    `${options.regionTag}${options.regionClass
      .split(" ")
      .sort()
      .map((name) => `.${name}`)
      .join("")}`;
  const region = v2Element({
    selector: regionSelector,
    tag: options.regionTag,
    path: regionPath,
    attributes: { ...options.regionAttributes, class: options.regionClass },
  });
  region.ancestorSelectors = ["main"];
  const wrapperSelector = `div.${options.wrapperClass}`;
  const wrapper = v2Element({
    selector: wrapperSelector,
    tag: "div",
    path: `${regionPath}/div[0]`,
    attributes: { class: options.wrapperClass },
  });
  wrapper.ancestorSelectors = [regionSelector, "main"];
  const target = v2Element({
    selector: "p.bad",
    tag: "p",
    path: `${regionPath}/div[0]/p[0]`,
    text: options.targetText,
    attributes: { class: "bad" },
  });
  target.ancestorSelectors = [wrapperSelector, regionSelector, "main"];
  return artifactV2("Surface", [
    region,
    wrapper,
    target,
    ...(options.extras ?? []),
  ]);
}

function decoySection(index: number): ObservedElementV2 {
  const section = v2Element({
    selector: `section.decoy-${index}`,
    tag: "section",
    path: `html[0]/body[0]/main[0]/section[${index}]`,
    text: `Decoy ${index}`,
    attributes: { class: `decoy-${index}` },
  });
  section.ancestorSelectors = ["main"];
  return section;
}

test("a test-id ancestor anchors the region and survives a nearer class repair", () => {
  const build = (wrapperClass: string, targetText: string) =>
    anchoredArtifact({
      regionTag: "section",
      regionClass: "card",
      regionAttributes: { "data-testid": "booking" },
      regionSelector: 'section[data-testid="booking"]',
      wrapperClass,
      targetText,
      extras: [decoySection(1), decoySection(2)],
    });
  const baselineArtifact = build("p-4", "Cramped supporting copy");
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".bad");
  expect(locus?.region.selector).toBe('section[data-testid="booking"]');
  if (locus === undefined) throw new Error("expected locus");
  const embedded = finding({
    verification: { kind: "recapture-visual", locus },
  });
  const restyled = build("p-6", "Cramped supporting copy");
  expect(
    evaluateVerification({
      findings: [embedded],
      baseline: [tuple(baselineArtifact)],
      currentA: [tuple(restyled)],
      currentB: [tuple(structuredClone(restyled))],
    }),
  ).toMatchObject({
    passed: false,
    findings: [{ status: "reproduced", locus: { source: "declared-locus" } }],
  });
  // A repair that removes the target compares the durable region instead.
  const repaired = build("p-6", "Cramped supporting copy");
  repaired.elements = repaired.elements.filter(
    (element) => element.selector !== "p.bad",
  );
  expect(
    evaluateVerification({
      findings: [embedded],
      baseline: [tuple(baselineArtifact)],
      currentA: [tuple(repaired)],
      currentB: [tuple(structuredClone(repaired))],
    }),
  ).toMatchObject({
    passed: true,
    findings: [
      {
        status: "fixed",
        locus: { source: "declared-locus", target: "target-absent" },
      },
    ],
  });
});

test("a unique landmark anchors the region by tag across class changes on itself", () => {
  const build = (regionClass: string) =>
    anchoredArtifact({
      regionTag: "form",
      regionClass,
      wrapperClass: "p-4",
      targetText: "Cramped supporting copy",
      extras: [decoySection(1)],
    });
  const baselineArtifact = build("grid gap-2");
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".bad");
  expect(locus?.region.selector).toBe("form");
  if (locus === undefined) throw new Error("expected locus");
  const restyled = build("grid gap-4");
  restyled.elements = restyled.elements.filter(
    (element) => element.selector !== "p.bad",
  );
  const profile = (artifact: ObservationArtifact) =>
    buildSemanticProfile({ artifact, kind: "v2-full" });
  expect(
    compareFindingLocus({
      finding: finding({ verification: { kind: "recapture-visual", locus } }),
      baseline: profile(baselineArtifact),
      currentA: profile(restyled),
      currentB: profile(structuredClone(restyled)),
    }),
  ).toMatchObject({ source: "declared-locus", target: "target-absent" });

  // A second visible form makes the landmark ambiguous: fail closed.
  const secondForm = v2Element({
    selector: "form.other",
    tag: "form",
    path: "html[0]/body[0]/main[0]/form[1]",
    attributes: { class: "other" },
  });
  const ambiguous = build("grid gap-4");
  ambiguous.elements.push(secondForm);
  expect(() =>
    compareFindingLocus({
      finding: finding({ verification: { kind: "recapture-visual", locus } }),
      baseline: profile(baselineArtifact),
      currentA: profile(ambiguous),
      currentB: profile(structuredClone(ambiguous)),
    }),
  ).toThrow("verification locus selector is ambiguous: form");
});

test("without a durable anchor the class-derived region still fails closed", () => {
  const secondMain = v2Element({
    selector: "main.aside",
    tag: "main",
    path: "html[0]/body[0]/main[1]",
    text: "Second main",
    attributes: { class: "aside" },
  });
  const build = (wrapperClass: string) =>
    anchoredArtifact({
      regionTag: "section",
      regionClass: "shell",
      wrapperClass,
      targetText: "Cramped supporting copy",
      extras: [decoySection(1), secondMain],
    });
  const baselineArtifact = build("p-4");
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".bad");
  // Neither section nor main is unique by tag, so no landmark anchors it.
  expect(locus?.region.selector).toBe("div.p-4");
  if (locus === undefined) throw new Error("expected locus");
  const restyled = build("p-6");
  expect(() =>
    evaluateVerification({
      findings: [
        finding({ verification: { kind: "recapture-visual", locus } }),
      ],
      baseline: [tuple(baselineArtifact)],
      currentA: [tuple(restyled)],
      currentB: [tuple(structuredClone(restyled))],
    }),
  ).toThrow("current verification region is missing: div.p-4");
});

test("locus comparison accepts consistent target disappearance and ignores unrelated changes", () => {
  const target = v2Element({
    selector: "button.cta",
    tag: "button",
    path: "html[0]/body[0]/main[0]/button[0]",
    text: "Continue",
    attributes: { class: "cta" },
  });
  target.ancestorSelectors = ["main"];
  const baselineArtifact = artifactV2("Surface", [target]);
  const locus = deriveVerificationLocus(tuple(baselineArtifact), ".cta");
  if (locus === undefined) throw new Error("expected locus");
  const embedded = finding({
    verification: { kind: "recapture-visual", locus },
  });
  const removed = evaluateVerification({
    findings: [embedded],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(artifactV2("Surface"))],
    currentB: [tuple(artifactV2("Surface"))],
  });
  expect(removed).toMatchObject({
    passed: true,
    findings: [{ status: "fixed", locus: { target: "target-absent" } }],
  });

  const unrelatedA = v2Element({
    selector: "footer",
    tag: "footer",
    path: "html[0]/body[0]/footer[0]",
    text: "new build token",
  });
  const currentWithUnrelated = artifactV2("Surface", [target, unrelatedA]);
  const unrelated = evaluateVerification({
    findings: [embedded],
    baseline: [tuple(baselineArtifact)],
    currentA: [tuple(currentWithUnrelated)],
    currentB: [tuple(currentWithUnrelated)],
  });
  expect(unrelated.passed).toBe(false);
  expect(unrelated.findings[0]?.status).toBe("reproduced");
});

test("baseline discovery searches an injected primary checkout and rejects ambiguity", async () => {
  const current = await mkdtemp(join(tmpdir(), "idiom-baseline-current-"));
  const primary = await mkdtemp(join(tmpdir(), "idiom-baseline-primary-"));
  directories.push(current, primary);
  const run = join(primary, ".idiom", "reports", "source-run");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "findings.json"), JSON.stringify([finding()]));
  await expect(
    resolveBaseline({
      projectDirectory: current,
      findings: [finding()],
      gitTopology: async () => primary,
    }),
  ).resolves.toMatchObject({ runDirectory: run });
  const duplicate = join(current, ".idiom", "reports", "duplicate");
  await mkdir(duplicate, { recursive: true });
  await writeFile(
    join(duplicate, "findings.json"),
    JSON.stringify([finding()]),
  );
  await expect(
    resolveBaseline({
      projectDirectory: current,
      findings: [finding()],
      gitTopology: async () => primary,
    }),
  ).rejects.toThrow("found 2 baseline captures");
});

test("a canonical ticket identity resolves an untouched legacy baseline by alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-baseline-alias-"));
  directories.push(directory);
  const run = join(directory, ".idiom", "reports", "legacy-run");
  await mkdir(run, { recursive: true });
  const legacy = finding();
  await writeFile(join(run, "findings.json"), JSON.stringify([legacy]));
  const canonical = finding({
    id: "finding-1",
    idAliases: [legacy.id],
  });
  await expect(
    resolveBaseline({
      projectDirectory: directory,
      findings: [canonical],
      gitTopology: async () => undefined,
    }),
  ).resolves.toMatchObject({ runDirectory: run });
  await expect(
    resolveBaseline({
      projectDirectory: directory,
      findings: [{ ...canonical, fingerprint: "wrong" }],
      gitTopology: async () => undefined,
    }),
  ).rejects.toThrow("found 0 baseline captures");
});

test("attachment manifests enforce unique canonical ordinals and report mapping", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-attachments-"));
  directories.push(directory);
  const manifest = createAttachmentManifest([
    { state: "confirmed", viewport: "desktop" },
    { state: "taken", viewport: "mobile" },
  ]);
  for (const composite of manifest.composites)
    await writeFile(join(directory, composite.path), "png");
  await writeFile(
    join(directory, "before-after.md"),
    manifest.composites.map(({ kind, path }) => `${kind} ${path}`).join("\n"),
  );
  await writeAttachmentManifest(directory, manifest);
  await expect(
    validateAttachmentManifest({ outputDirectory: directory, manifest }),
  ).resolves.toEqual(manifest);
  const invalid = structuredClone(manifest);
  if (invalid.composites[1] !== undefined)
    invalid.composites[1].kind = "idiom-before-after-001";
  await expect(
    validateAttachmentManifest({
      outputDirectory: directory,
      manifest: invalid,
      requireFiles: false,
    }),
  ).rejects.toThrow("not canonical");
});

test("composite artifact names keep ordinary ids and encode unsafe ones", () => {
  expect(
    compositeArtifactName({ state: "confirmed", viewport: "desktop" }),
  ).toBe("before-after-confirmed-desktop.png");
  expect(
    compositeArtifactName({
      state: "confirmed",
      viewport: "desktop",
      colorScheme: "dark",
    }),
  ).toBe("before-after-confirmed-desktop-dark.png");
  expect(
    compositeArtifactName({ state: "s", viewport: "v", combination: "a=b" }),
  ).toBe("before-after-s-v-a-b.png");
  const nested = compositeArtifactName({
    state: "checkout/payment",
    viewport: "desktop",
  });
  expect(nested).toMatch(
    /^before-after-checkout-payment-[0-9a-f]{8}-desktop\.png$/,
  );
  for (const state of ["a\\b", "..", "../escape", "", "a b", "v1..2"]) {
    const name = compositeArtifactName({ state, viewport: "desktop" });
    expect(name).not.toMatch(/[/\\]/);
    expect(name).not.toContain("..");
    expect(basename(name)).toBe(name);
  }
  expect(compositeArtifactName({ state: "desktop", viewport: "a/b" })).not.toBe(
    compositeArtifactName({ state: "desktop", viewport: "a-b" }),
  );
  expect(compositeArtifactName({ state: "a/b", viewport: "desktop" })).not.toBe(
    compositeArtifactName({ state: "a-b", viewport: "desktop" }),
  );
  expect(compositeArtifactName({ state: "a/b", viewport: "desktop" })).toBe(
    compositeArtifactName({ state: "a/b", viewport: "desktop" }),
  );
});

test("attachment manifests write a state id containing a path separator as one file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-attachments-"));
  directories.push(directory);
  const manifest = createAttachmentManifest([
    { state: "checkout/payment", viewport: "desktop" },
    { state: "confirmed", viewport: "desktop" },
  ]);
  expect(manifest.composites.map(({ state }) => state)).toEqual([
    "checkout/payment",
    "confirmed",
  ]);
  expect(manifest.composites[1]?.path).toBe(
    "before-after-confirmed-desktop.png",
  );
  for (const composite of manifest.composites)
    await writeFile(join(directory, composite.path), "png");
  await writeFile(
    join(directory, "before-after.md"),
    manifest.composites.map(({ kind, path }) => `${kind} ${path}`).join("\n"),
  );
  await writeAttachmentManifest(directory, manifest);
  await expect(
    validateAttachmentManifest({ outputDirectory: directory, manifest }),
  ).resolves.toEqual(manifest);
});

test("unequal PNG dimensions produce padded evidence without deciding the verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-images-"));
  directories.push(directory);
  const before = new PNG({ width: 2, height: 3 });
  const after = new PNG({ width: 4, height: 2 });
  before.data.fill(255);
  after.data.fill(0);
  const beforePath = join(directory, "before.png");
  const afterPath = join(directory, "after.png");
  const outputPath = join(directory, "composite.png");
  await writeFile(beforePath, PNG.sync.write(before));
  await writeFile(afterPath, PNG.sync.write(after));
  const comparison = await writeBeforeAfterComposite({
    beforePath,
    afterPath,
    outputPath,
  });
  expect(comparison.padded).toEqual({ width: 4, height: 3 });
  expect(comparison.differentPixels).toBeGreaterThan(0);
  await expect(access(outputPath)).resolves.toBeUndefined();
});

async function verifyRunFixture(): Promise<{
  projectDirectory: string;
  baselineDirectory: string;
  spec: string;
  embedded: Finding;
}> {
  const projectDirectory = await mkdtemp(join(tmpdir(), "idiom-verify-run-"));
  directories.push(projectDirectory);
  await initProject({ project: projectDirectory, yes: true });
  const port = await freePort();
  const serverScript = join(
    import.meta.dirname,
    "fixtures",
    "capture",
    "server.mjs",
  );
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: fixtureCommand(serverScript),
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: { PORT: String(port) },
      startupTimeoutMs: 5_000,
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "booking",
    title: "Booking",
    intent: [],
    setup: [],
    states: [
      { id: "confirmed", description: "Confirmed", url: "/", expect: {} },
    ],
  });
  await writeFile(
    join(projectDirectory, ".idiom", "project.json"),
    JSON.stringify(project),
  );
  await writeFile(
    join(projectDirectory, ".idiom", "flows", "booking.json"),
    JSON.stringify(flow),
  );
  const baselineDirectory = join(
    projectDirectory,
    ".idiom",
    "reports",
    "source-run",
  );
  await runCapture({
    projectDirectory,
    project,
    flow,
    out: baselineDirectory,
    dependencies: {
      browserLauncher: browserWithText("Before"),
      inheritedEnvironment: { PATH: process.env.PATH },
      snapshotSource: async () => ({ commit: "abc123", dirty: false }),
    },
  });
  const embedded = finding();
  await writeFile(
    join(baselineDirectory, "findings.json"),
    JSON.stringify([embedded]),
  );
  const spec = join(projectDirectory, "spec.md");
  await writeFile(
    spec,
    `# Fix\n\n\`\`\`idiom:finding\n${JSON.stringify(embedded)}\n\`\`\`\n`,
  );
  return { projectDirectory, baselineDirectory, spec, embedded };
}

test("finding verification owns two independent capture lifecycles and publishes paired evidence", async () => {
  const { projectDirectory, baselineDirectory, spec, embedded } =
    await verifyRunFixture();
  let launches = 0;
  const localFetch = globalThis.fetch;
  const fetch = vi.fn(() => {
    throw new Error("verify must not call fetch or a provider");
  });
  vi.stubGlobal("fetch", fetch);
  const output = join(projectDirectory, ".idiom", "reports", "verified");
  const result = await runVerify({
    flow: "booking",
    spec,
    project: projectDirectory,
    against: baselineDirectory,
    out: output,
    dependencies: {
      gitTopology: async () => undefined,
      capture: {
        browserLauncher: browserWithText("After", () => {
          launches += 1;
        }),
        inheritedEnvironment: { PATH: process.env.PATH },
        process: { fetch: localFetch },
        snapshotSource: async () => ({ commit: "def456", dirty: false }),
      },
    },
  });
  expect(launches).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(result).toMatchObject({ outcome: "fixed", passed: true, causes: [] });
  expect(
    result.verdicts?.every((v) => v.acceptance.status === "not-recheckable"),
  ).toBe(true);
  expect(result.verdicts).toEqual([
    expect.objectContaining({ finding: embedded, status: "fixed" }),
  ]);
  expect(result.htmlReportPath).toBe(join(output, "report.html"));
  const htmlReport = await readFile(result.htmlReportPath, "utf8");
  expect(htmlReport).toContain("data:image/png;base64,");
  expect(htmlReport).toContain('data-slider type="range"');
  expect(htmlReport).toContain("Before: confirmed at desktop");
  expect(htmlReport).toContain("Coverage and limits");
  expect(htmlReport).toContain("Historical baseline commit");
  expect(htmlReport).toContain("abc123");
  expect(htmlReport).toContain("Current recapture commit");
  expect(htmlReport).toContain("def456");
  const markdownReport = await readFile(
    join(output, "before-after.md"),
    "utf8",
  );
  expect(markdownReport).toContain("idiom-before-after-001");
  expect(markdownReport).toContain("Historical baseline commit");
  expect(markdownReport).toContain("Current recapture commit");
  await expect(
    access(join(output, "before-after-confirmed-desktop.png")),
  ).resolves.toBeUndefined();
  await expect(
    access(
      join(output, "current-a", "confirmed", "desktop", "observations.json"),
    ),
  ).resolves.toBeUndefined();
  await expect(
    access(
      join(output, "current-b", "confirmed", "desktop", "observations.json"),
    ),
  ).resolves.toBeUndefined();
});

test("a nonzero verification still publishes validated paired evidence for the failing tuple", async () => {
  const { projectDirectory, baselineDirectory, spec } =
    await verifyRunFixture();
  const output = join(projectDirectory, ".idiom", "reports", "regressed");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "verify",
      "booking",
      "--project",
      projectDirectory,
      "--spec",
      spec,
      "--against",
      baselineDirectory,
      "--out",
      output,
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      verify: {
        gitTopology: async () => undefined,
        capture: {
          browserLauncher: browserWithText("Before"),
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "def456", dirty: false }),
        },
      },
    },
  );
  expect(code).not.toBe(0);
  expect(stdout.join("")).toContain("Verified booking: failed");
  expect(stderr.join("")).toContain("verification failed");
  const manifest = JSON.parse(
    await readFile(join(output, "attachments.json"), "utf8"),
  );
  await expect(
    validateAttachmentManifest({ outputDirectory: output, manifest }),
  ).resolves.toEqual(manifest);
  expect(manifest.composites).toEqual([
    {
      ordinal: 1,
      kind: "idiom-before-after-001",
      state: "confirmed",
      viewport: "desktop",
      path: "before-after-confirmed-desktop.png",
    },
  ]);
  await expect(
    access(join(output, "before-after-confirmed-desktop.png")),
  ).resolves.toBeUndefined();
  const markdownReport = await readFile(
    join(output, "before-after.md"),
    "utf8",
  );
  for (const identity of [
    "idiom-before-after-001",
    "confirmed",
    "desktop",
    "before-after-confirmed-desktop.png",
  ])
    expect(markdownReport).toContain(identity);
});

test("a verification failure before any composite exists publishes no paired evidence", async () => {
  const { projectDirectory, baselineDirectory, spec } =
    await verifyRunFixture();
  const output = join(projectDirectory, ".idiom", "reports", "no-evidence");
  await expect(
    runVerify({
      flow: "booking",
      spec,
      project: projectDirectory,
      against: baselineDirectory,
      out: output,
      dependencies: {
        gitTopology: async () => undefined,
        capture: {
          browserLauncher: async () => {
            throw new Error("browser unavailable");
          },
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "def456", dirty: false }),
        },
      },
    }),
  ).rejects.toThrow(
    "capture failed to start: browser launch — browser unavailable",
  );
  await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
});

test("Electron finding verification uses two independent ordinary capture lifecycles", async () => {
  const projectDirectory = await mkdtemp(
    join(tmpdir(), "idiom-electron-verify-"),
  );
  directories.push(projectDirectory);
  await initProject({ project: projectDirectory, yes: true });
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "must-not-run",
      start: "must-not-run",
      readyUrl: "http://127.0.0.1:9/",
      port: 9,
      env: {},
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "booking",
    title: "Booking desktop",
    intent: [],
    setup: [],
    target: {
      kind: "electron",
      launch: { executablePath: "fixture-electron" },
      window: { title: "Capture" },
    },
    states: [{ id: "confirmed", description: "Confirmed", expect: {} }],
  });
  await writeFile(
    join(projectDirectory, ".idiom", "project.json"),
    JSON.stringify(project),
  );
  await writeFile(
    join(projectDirectory, ".idiom", "flows", "booking.json"),
    JSON.stringify(flow),
  );
  const baselineDirectory = join(
    projectDirectory,
    ".idiom",
    "reports",
    "source-electron",
  );
  await runCapture({
    projectDirectory,
    project,
    flow,
    out: baselineDirectory,
    dependencies: {
      electronLauncher: electronWithText("Before"),
      inheritedEnvironment: { PATH: process.env.PATH },
      snapshotSource: async () => ({ commit: "abc123", dirty: false }),
    },
  });
  const embedded = finding();
  await writeFile(
    join(baselineDirectory, "findings.json"),
    JSON.stringify([embedded]),
  );
  const spec = join(projectDirectory, "spec-electron.md");
  await writeFile(
    spec,
    `# Fix\n\n\`\`\`idiom:finding\n${JSON.stringify(embedded)}\n\`\`\`\n`,
  );
  let sessions = 0;
  const result = await runVerify({
    flow: "booking",
    spec,
    project: projectDirectory,
    against: baselineDirectory,
    out: join(projectDirectory, ".idiom", "reports", "verified-electron"),
    dependencies: {
      gitTopology: async () => undefined,
      capture: {
        electronLauncher: electronWithText("After", () => {
          sessions += 1;
        }),
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "def456", dirty: false }),
      },
    },
  });
  expect(sessions).toBe(2);
  expect(result).toMatchObject({ outcome: "fixed", passed: true, causes: [] });
  expect(
    result.verdicts?.every((v) => v.acceptance.status === "not-recheckable"),
  ).toBe(true);
});

test("the verify source graph has no critique adapter or provider SDK dependency", async () => {
  const root = join(import.meta.dirname, "..", "src");
  const queue = [join(root, "commands", "verify.ts")];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(
      /(?:src\/critique|\.\.\/critique|@anthropic-ai)/,
    );
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const candidate = resolve(
        dirname(file),
        specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : specifier,
      );
      if (candidate.startsWith(root)) queue.push(candidate);
    }
  }
  expect(visited.size).toBeGreaterThan(10);
});

test("no-finding verification publishes not-applicable output without capture or APIs", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-no-findings-"));
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: [],
      setup: [],
      states: [
        { id: "confirmed", description: "Confirmed", url: "/", expect: {} },
      ],
    }),
  );
  const spec = join(project, "spec.md");
  await writeFile(spec, "# No embedded findings\n");
  const browserLauncher = vi.fn(async () => {
    throw new Error("browser must not run");
  });
  const fetch = vi.fn(() => {
    throw new Error("fetch must not run");
  });
  vi.stubGlobal("fetch", fetch);
  const output = join(project, ".idiom", "reports", "no-findings");
  const result = await runVerify({
    flow: "booking",
    spec,
    project,
    out: output,
    dependencies: { capture: { browserLauncher } },
  });
  expect(result).toMatchObject({
    outcome: "no-findings",
    passed: true,
    verdicts: [],
  });
  expect(browserLauncher).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  const markdown = await readFile(join(output, "before-after.md"), "utf8");
  const html = await readFile(join(output, "report.html"), "utf8");
  expect(markdown).toContain("not applicable — no embedded findings");
  for (const output of [markdown, html]) {
    expect(output).toContain("No finding verification coverage");
    expect(output).toContain("0 of 1 declared");
    expect(output).toContain("0 of 0 selected");
    expect(output).toContain("no commit identity was captured");
  }
  expect(html).toContain("No embedded findings");
  expect(html).toContain("Print or save as PDF");
  expect(
    JSON.parse(await readFile(join(output, "attachments.json"), "utf8")),
  ).toMatchObject({
    version: 1,
    composites: [],
  });
  await writeFile(join(output, "stale-from-prior-attempt.txt"), "stale");
  await expect(
    runVerify({
      flow: "booking",
      spec,
      project,
      out: output,
      dependencies: { capture: { browserLauncher } },
    }),
  ).resolves.toMatchObject({ outcome: "no-findings" });
  await expect(
    access(join(output, "stale-from-prior-attempt.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("Autobuild templates separate the gate from the configured verifier and retain distinct attachment kinds", async () => {
  const root = join(import.meta.dirname, "..");
  const skill = await readFile(
    join(root, "templates", "idiom-verify", "SKILL.md"),
    "utf8",
  );
  const config = await readFile(
    join(root, "templates", "autobuild.idiom.toml"),
    "utf8",
  );
  const command = "idiom verify <flow> --spec .ab/spec.md --out .ab/idiom";
  expect(
    skill.match(
      new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    ),
  ).toHaveLength(1);
  expect(config).toContain(
    'idiom-check = "idiom check --gate --fail-on major --deferred warn"',
  );
  expect(skill).toContain(
    "Read and parse the repository’s actual".replace("’", "'"),
  );
  expect(skill).toContain("autobuild.toml");
  expect(skill).toContain(
    "idiom-before-after-$" + '{ordinal.toString().padStart(3, "0")}',
  );
  expect(skill).toContain("idiom-verify-report");
});

test("the Autobuild verifier clears stale output and attaches paired evidence on failure", async () => {
  const skill = await readFile(
    join(import.meta.dirname, "..", "templates", "idiom-verify", "SKILL.md"),
    "utf8",
  );
  const command = "idiom verify <flow> --spec .ab/spec.md --out .ab/idiom";
  const clear = skill.indexOf("rm -rf .ab/idiom`");
  expect(clear).toBeGreaterThan(-1);
  expect(clear).toBeLessThan(skill.indexOf(command));
  expect(skill).not.toMatch(/attach(es)? nothing/);
  const nonzero = skill.slice(skill.indexOf("exited nonzero"));
  const deposit = skill.indexOf(
    "ab artifact put <kind> .ab/idiom/<path> --attach",
  );
  const report = skill.indexOf(
    "ab artifact put idiom-verify-report .ab/idiom/before-after.md --attach",
  );
  expect(deposit).toBeGreaterThan(skill.indexOf(command));
  expect(report).toBeGreaterThan(deposit);
  expect(skill.indexOf("exited nonzero")).toBeGreaterThan(report);
  expect(nonzero).toContain(
    "ab verdict fail --report .ab/idiom/before-after.md",
  );
  expect(nonzero).toContain(
    "Attaching the composites on failure is deliberate",
  );
  expect(nonzero).toContain("no paired visual evidence");
  expect(nonzero).toContain("earlier verify cycle");
});

test("full-flow evaluation adds all-severity regressions without changing the standalone gate", () => {
  const before = tuple(artifactV2("Before"));
  const small = v2Element({
    selector: "button.small",
    tag: "button",
    path: "html[0]/body[0]/main[0]/button[0]",
    text: "Tiny",
  });
  small.interactive = true;
  small.enabled = true;
  small.rect.width = 10;
  small.rect.height = 10;
  const neighbor = structuredClone(small);
  neighbor.selector = "button.neighbor";
  neighbor.structuralPath = "html[0]/body[0]/main[0]/button[1]";
  neighbor.rect.x += 12;
  const after = tuple(artifactV2("After", [small, neighbor]));
  const standalone = evaluateVerification({
    findings: [finding()],
    baseline: [before],
    currentA: [after],
    currentB: [structuredClone(after)],
  });
  const full = evaluateVerification({
    findings: [finding()],
    baseline: [before],
    currentA: [after],
    currentB: [structuredClone(after)],
    fullFlow: true,
  });
  expect(standalone.newFindings).toBeUndefined();
  expect(full.findings).toEqual(standalone.findings);
  expect(full.passed).toBe(standalone.passed);
  expect(
    full.newFindings?.some(
      (item) => item.category === "target-size" && item.severity === "minor",
    ),
  ).toBe(true);
  expect(
    renderVerificationReport({
      flow: "studio",
      baselineRunId: "baseline",
      currentRunA: "A",
      currentRunB: "B",
      manifest: createAttachmentManifest([]),
      evaluation: full,
    }),
  ).toContain("New deterministic findings (all severities)");
  expect(
    renderVerificationHtmlReport({
      flow: "studio",
      baselineRunId: "baseline",
      currentRunA: "A",
      currentRunB: "B",
      manifest: createAttachmentManifest([]),
      evaluation: full,
    }),
  ).toContain("New deterministic findings (all severities)");
});

test("manual judged acceptance retains visual-locus verdicts and overall pass", () => {
  const baseline = tuple(artifactV2("Before"));
  for (const legacy of [false, true]) {
    const item = legacy
      ? finding()
      : finding({
          basis: "judged",
          basisDetails: {
            kind: "judged",
            summary: "Model critique",
            confidence: 0.8,
          },
          acceptance: {
            version: 1,
            kind: "manual",
            doneWhen: ["The primary content is clear."],
          },
        });
    for (const changed of [false, true]) {
      const current = tuple(artifactV2(changed ? "After" : "Before"));
      const result = evaluateVerification({
        findings: [item],
        baseline: [baseline],
        currentA: [current],
        currentB: [current],
      });
      expect(result.findings[0]?.acceptance.status).toBe("not-recheckable");
      expect(result.findings[0]?.status).toBe(changed ? "fixed" : "reproduced");
      expect(result.passed).toBe(changed);
    }
  }
});

test("new executable acceptance reuses real rules and refuses missing targets or changed settings", async () => {
  const { buildRuleContract } = await import("../src/findings/contract.js");
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  const { evaluateRuleAcceptance } = await import(
    "../src/verify/acceptance.js"
  );
  const bad = tuple(artifactV2("Before"));
  if (!bad.observations) throw new Error("missing fixture observations");
  bad.observations.document.scrollWidth = 900;
  const candidate = runDeterministicChecks([bad]).candidates.find(
    (c) => c.candidate.category === "overflow-clip",
  );
  if (!candidate) throw new Error("missing fixture candidate");
  expect(candidate).toBeDefined();
  const contract = buildRuleContract(bad, candidate.candidate).acceptance;
  const good = tuple(artifactV2("After"));
  const evaluate = (a: CheckTuple, b = a, config = checksConfigFrom()) =>
    evaluateRuleAcceptance({ contract, currentA: [a], currentB: [b], config });
  expect(evaluate(bad).status).toBe("failed");
  expect(evaluate(good).status).toBe("passed");
  expect(evaluate(good, bad).status).toBe("not-recheckable");
  expect(
    evaluate(good, good, { ...checksConfigFrom(), minGap: 999 }).reason,
  ).toContain("settings changed");
  const unknown = evaluateRuleAcceptance({
    contract: { ...contract, check: "unknown" },
    currentA: [good],
    currentB: [good],
  });
  expect(unknown.status).toBe("not-recheckable");
  const item = buildDeterministicDrafts({
    runId: "new",
    entries: [candidate],
  })[0]?.finding;
  if (!item) throw new Error("missing fixture finding");
  const unverifiable = {
    ...item,
    verification: { ...item.verification, check: "unknown" },
    acceptance: { ...contract, check: "unknown" },
  };
  const result = evaluateVerification({
    findings: [unverifiable],
    baseline: [bad],
    currentA: [good],
    currentB: [good],
  });
  expect(result.findings[0]?.status).toBe("unverifiable");
  expect(result.passed).toBe(false);
});

test("legacy deterministic acceptance keeps coordinate fingerprint verification", () => {
  const baseline = tuple(artifactV2("Before"));
  if (!baseline.observations) throw new Error("missing fixture observations");
  baseline.observations.document.scrollWidth = 900;
  const item = buildDeterministicDrafts({
    runId: "legacy",
    entries: runDeterministicChecks([baseline]).candidates,
  })[0]?.finding;
  if (!item) throw new Error("missing fixture finding");
  const legacy = findingSchema.parse({
    ...item,
    basis: undefined,
    basisDetails: undefined,
    acceptance: item.acceptance.doneWhen,
  });
  const sidecar = parseFindingBlocks(
    `\`\`\`idiom:finding\n${JSON.stringify({ ...legacy, acceptance: legacy.acceptance.doneWhen, basis: undefined, basisDetails: undefined })}\n\`\`\``,
  )[0];
  if (!sidecar) throw new Error("missing fixture sidecar");
  for (const fixed of [false, true]) {
    const current = fixed ? tuple(artifactV2("After")) : baseline;
    const result = evaluateVerification({
      findings: [sidecar],
      baseline: [baseline],
      currentA: [current],
      currentB: [current],
    });
    expect(result.findings[0]?.acceptance.status).toBe("not-recheckable");
    expect(result.findings[0]?.status).toBe(fixed ? "fixed" : "reproduced");
    expect(result.findings[0]?.reason).toContain(
      "legacy fingerprint evaluation",
    );
    expect(result.passed).toBe(fixed);
  }
});

test("deterministic findings with a params selector never enter locus comparison", () => {
  const baseline = tuple(artifactV2("Before"));
  if (!baseline.observations) throw new Error("missing fixture observations");
  baseline.observations.document.scrollWidth = 900;
  const item = buildDeterministicDrafts({
    runId: "guard",
    entries: runDeterministicChecks([baseline]).candidates,
  })[0]?.finding;
  if (!item) throw new Error("missing fixture finding");
  const legacy = findingSchema.parse({
    ...item,
    basis: undefined,
    basisDetails: undefined,
    acceptance: item.acceptance.doneWhen,
    verification: {
      ...item.verification,
      params: { ...item.verification.params, selector: "html" },
    },
  });
  const result = evaluateVerification({
    findings: [legacy],
    baseline: [baseline],
    currentA: [baseline],
    currentB: [baseline],
  });
  expect(result.findings[0]?.locus).toBeUndefined();
  expect(result.findings[0]?.reason).toMatch(/^legacy fingerprint evaluation/);
});

test("fixed mixed contracts pass without imposing executable proof on legacy or judged findings", () => {
  const baseline = tuple(artifactV2("Before"));
  if (!baseline.observations) throw new Error("missing fixture observations");
  baseline.observations.document.scrollWidth = 900;
  const executable = buildDeterministicDrafts({
    runId: "mixed",
    entries: runDeterministicChecks([baseline]).candidates,
  })[0]?.finding;
  if (!executable) throw new Error("missing fixture finding");
  const legacy = findingSchema.parse({
    ...executable,
    id: "legacy-mixed",
    basis: undefined,
    basisDetails: undefined,
    acceptance: executable.acceptance.doneWhen,
  });
  const judged = finding({
    basis: "judged",
    basisDetails: { kind: "judged", summary: "Model critique" },
    acceptance: { version: 1, kind: "manual", doneWhen: ["Clear hierarchy."] },
  });
  const current = tuple(artifactV2("After"));
  const result = evaluateVerification({
    findings: [executable, legacy, judged],
    baseline: [baseline],
    currentA: [current],
    currentB: [current],
  });
  expect(result.findings.map((v) => v.status)).toEqual([
    "fixed",
    "fixed",
    "fixed",
  ]);
  expect(result.findings.map((v) => v.acceptance.status)).toEqual([
    "passed",
    "not-recheckable",
    "not-recheckable",
  ]);
  expect(result.passed).toBe(true);
});

test("static acceptance cannot pass because an unmeasured selector disappeared", async () => {
  const { buildRuleContract } = await import("../src/findings/contract.js");
  const { evaluateRuleAcceptance } = await import(
    "../src/verify/acceptance.js"
  );
  const target = v2Element({
    selector: "#small",
    tag: "button",
    path: "html[0]/body[0]/button[0]",
  });
  target.interactive = true;
  target.rect = { x: 0, y: 0, width: 10, height: 10 };
  const { checksConfigFrom } = await import("../src/checks/registry.js");
  const config = {
    ...checksConfigFrom(),
    targetSize: { fine: 30, coarse: 44, narrowBelow: 768 },
  };
  const before = tuple(artifactV2("Before", [target]));
  const candidate = runDeterministicChecks(
    [before],
    undefined,
    config,
  ).candidates.find((e) => e.candidate.category === "target-size");
  if (!candidate) throw new Error("missing fixture candidate");
  expect(candidate).toBeDefined();
  const contract = buildRuleContract(
    before,
    candidate.candidate,
    config,
  ).acceptance;
  expect(contract.target).toEqual({ kind: "selectors", selectors: ["#small"] });
  const absent = tuple(artifactV2("After"));
  const missing = evaluateRuleAcceptance({
    contract,
    currentA: [absent],
    currentB: [absent],
    config,
  });
  expect(missing.status).toBe("not-recheckable");
  expect(missing.reason).toContain("missing");
  const fixed = tuple(
    artifactV2("After", [
      { ...target, rect: { x: 0, y: 0, width: 50, height: 50 } },
    ]),
  );
  expect(
    evaluateRuleAcceptance({
      contract,
      currentA: [fixed],
      currentB: [fixed],
      config,
    }).status,
  ).toBe("passed");
});

test("a pinned brief mismatch fails verification even when the embedded finding is fixed", async () => {
  const { projectDirectory, baselineDirectory, spec } =
    await verifyRunFixture();
  const asset = join(
    projectDirectory,
    ".ab",
    "assets",
    "design",
    "card-height",
  );
  await mkdir(asset, { recursive: true });
  await writeFile(
    join(asset, "criteria.json"),
    JSON.stringify({
      format: "idiom-design-asset",
      version: 1,
      brief: {
        slug: "card-height",
        title: "Card height",
        decision: "Keep height",
        chosenOption: "keep",
        chosenTitle: "Keep",
        decidedBy: "requester",
      },
      criteria: [
        {
          index: 0,
          kind: "geometry",
          statement: "Card is 56px tall",
          assertions: [
            {
              flow: "booking",
              state: "confirmed",
              selector: "main",
              height: 56,
            },
          ],
          rules: [],
        },
      ],
      screenshots: [],
    }),
  );
  const launcher = browserWithText("After");
  const result = await runVerify({
    project: projectDirectory,
    flow: "booking",
    spec,
    against: baselineDirectory,
    out: join(projectDirectory, ".idiom", "reports", "asset-verified"),
    dependencies: {
      gitTopology: async () => undefined,
      capture: {
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "def456", dirty: false }),
        browserLauncher: async (...args) => {
          const browser = await launcher(...args);
          return {
            ...browser,
            async capture(tuple) {
              const result = await browser.capture(tuple);
              if (result.observations?.version === 2)
                result.observations.selectorMarks = [
                  { purpose: "brief", selector: "main", matches: ["main"] },
                ];
              return result;
            },
          };
        },
      },
    },
  });
  expect(result.verdicts?.every((verdict) => verdict.status === "fixed")).toBe(
    true,
  );
  expect(result).toMatchObject({
    outcome: "failed",
    passed: false,
    designAssets: {
      passed: false,
      briefs: [{ slug: "card-height", mismatched: 1 }],
    },
  });
  expect(result.causes.join(" ")).toContain(
    'Brief "Card height" (card-height, design asset card-height), criterion',
  );
});
