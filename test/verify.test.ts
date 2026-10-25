import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  ObservedElement,
  ObservedElementV2,
  ObservedStyles,
} from "../src/checks/types.js";
import { initProject } from "../src/commands/init.js";
import { buildVerificationCoverage } from "../src/report/coverage.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import {
  createAttachmentManifest,
  validateAttachmentManifest,
  writeAttachmentManifest,
} from "../src/verify/attachments.js";
import { resolveBaseline } from "../src/verify/baseline.js";
import { writeBeforeAfterComposite } from "../src/verify/compare.js";
import { evaluateVerification } from "../src/verify/evaluate.js";
import { renderVerificationHtmlReport } from "../src/verify/html-report.js";
import { deriveVerificationLocus } from "../src/verify/locus.js";
import {
  assertMaskAgreement,
  buildSemanticProfile,
} from "../src/verify/profile.js";
import { renderVerificationReport } from "../src/verify/report.js";
import { runVerify } from "../src/verify/run.js";
import { parseFindingBlocks, selectFindingTuples } from "../src/verify/spec.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error === undefined ? accept() : reject(error))),
  );
  return address.port;
}

function png(width = 2, height = 2, value = 255): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(value);
  return PNG.sync.write(image);
}

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

const styles: ObservedStyles = {
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgb(255, 255, 255)",
  borderTopColor: "rgb(0, 0, 0)",
  borderRightColor: "rgb(0, 0, 0)",
  borderBottomColor: "rgb(0, 0, 0)",
  borderLeftColor: "rgb(0, 0, 0)",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  outlineStyle: "none",
  textOverflow: "clip",
  fill: "rgb(0, 0, 0)",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
};

function legacyElement(options: {
  selector: string;
  tag: string;
  text?: string;
  visible?: boolean;
  ancestors?: string[];
  y?: number;
  height?: number;
}): ObservedElement {
  return {
    selector: options.selector,
    tag: options.tag,
    text: options.text ?? "",
    visible: options.visible ?? true,
    interactive: false,
    enabled: true,
    rect: {
      x: 0,
      y: options.y ?? 0,
      width: 100,
      height: options.height ?? 20,
    },
    scrollWidth: 100,
    scrollHeight: 20,
    clientWidth: 100,
    clientHeight: 20,
    outOfFlow: false,
    ancestorSelectors: options.ancestors ?? [],
    authoredProperties: [],
    styles,
    hitTestWith: [],
  };
}

function expandedStyles(): ObservedElementV2["styles"] {
  return {
    ...styles,
    display: "block",
    visibility: "visible",
    opacity: "1",
    fontFamily: "system-ui",
    fontSize: "16px",
    fontWeight: "400",
    lineHeight: "24px",
    letterSpacing: "normal",
    textAlign: "start",
    textDecorationLine: "none",
    textTransform: "none",
    whiteSpace: "normal",
    wordBreak: "normal",
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
    marginTop: "0px",
    marginRight: "0px",
    marginBottom: "0px",
    marginLeft: "0px",
    gap: "normal",
    flexDirection: "row",
    justifyContent: "normal",
    alignItems: "normal",
    gridTemplateColumns: "none",
    boxShadow: "none",
    transform: "none",
    zIndex: "auto",
  };
}

function v2Element(options: {
  selector: string;
  tag: string;
  path: string;
  text?: string;
  visible?: boolean;
  attributes?: Record<string, string>;
  y?: number;
}): ObservedElementV2 {
  const base = legacyElement({
    selector: options.selector,
    tag: options.tag,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.visible === undefined ? {} : { visible: options.visible }),
    ...(options.y === undefined ? {} : { y: options.y }),
  });
  return {
    ...base,
    structuralPath: options.path,
    ...(base.visible ? { legacyRenderedPath: options.path } : {}),
    directText: options.text ?? "",
    attributes: options.attributes ?? {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: base.rect,
    styles: expandedStyles(),
  };
}

function artifactV2(
  text: string,
  extras: ObservedElementV2[] = [],
): ObservationArtifact {
  return {
    version: 2,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [
      v2Element({ selector: "html", tag: "html", path: "html[0]" }),
      v2Element({ selector: "body", tag: "body", path: "html[0]/body[0]" }),
      v2Element({
        selector: "main",
        tag: "main",
        path: "html[0]/body[0]/main[0]",
        text,
        attributes: { class: "surface" },
      }),
      ...extras,
    ],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
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

  const legacyAnchor = evaluateVerification({
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
  expect(legacyAnchor).toMatchObject({
    passed: false,
    findings: [
      {
        status: "reproduced",
        locus: { source: "legacy-evidence-anchor", changed: false },
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

test("finding verification owns two independent capture lifecycles and publishes paired evidence", async () => {
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
      start: `node ${JSON.stringify(serverScript)}`,
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
  expect(result).toMatchObject({ outcome: "fixed", passed: true });
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
  expect(result).toMatchObject({ outcome: "fixed", passed: true });
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

test("Autobuild templates keep the literal verify command byte-identical and distinct attachment kinds", async () => {
  const root = join(import.meta.dirname, "..");
  const skill = await readFile(
    join(root, "templates", "ab-verify-idiom", "SKILL.md"),
    "utf8",
  );
  const config = await readFile(
    join(root, "templates", "autobuild.idiom.toml"),
    "utf8",
  );
  const command = "idiom verify booking --spec .ab/spec.md --out .ab/idiom";
  expect(
    skill.match(
      new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    ),
  ).toHaveLength(1);
  expect(config).toContain(`idiom-verify = "${command}"`);
  expect(skill).toContain(
    "idiom-before-after-$" + '{ordinal.toString().padStart(3, "0")}',
  );
  expect(skill).toContain("idiom-verify-report");
});
