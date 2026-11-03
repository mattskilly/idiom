import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { writeBaselineReport } from "../src/capture/artifacts.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { decideCommand } from "../src/commands/decide.js";
import { initProject } from "../src/commands/init.js";
import type { CritiqueInput, CritiqueResult } from "../src/critique/types.js";
import {
  readDecisions,
  standingRuleRejections,
} from "../src/decisions/read.js";
import { IdiomError } from "../src/errors.js";
import { buildReviewCoverage } from "../src/report/coverage.js";
import { findLatestCapture, loadCaptureRun } from "../src/review/artifacts.js";
import {
  isCatalogDecisionTarget,
  type ReviewCatalog,
} from "../src/review/catalog.js";
import {
  buildDeterministicDrafts,
  buildModelDrafts,
  dedupeFindingDrafts,
  dedupeSuppressedFindings,
  type FindingDraft,
  finalizeFindingSelection,
  finalizeFindings,
  suppressFindingDrafts,
  writeFindings,
} from "../src/review/findings.js";
import { renderReviewHtmlReport } from "../src/review/html-report.js";
import { FindingNamingSession } from "../src/review/names.js";
import {
  degradedReasonSentence,
  renderReport,
  writeReport,
} from "../src/review/report.js";
import {
  hasReviewableScreenshot,
  NO_REVIEWABLE_SCREENSHOTS_REASON,
  noReviewableScreenshotsOutcome,
  runReview,
} from "../src/review/run.js";
import { findingSchema } from "../src/schemas/finding.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function metadata(failure: { stage: string; message: string } | null = null) {
  return {
    source: { commit: "abc123", dirty: false },
    flow: { id: "booking", title: "Booking" },
    state: { id: "ready", description: "Ready" },
    viewport: {
      name: "phone",
      width: 320,
      height: 600,
      deviceScaleFactor: 2,
    },
    url: {
      kind: "literal",
      origin: "http://127.0.0.1:3107",
      url: "http://127.0.0.1:3107/ready",
    },
    timestamps: {
      startedAt: "2026-08-14T12:00:00.000Z",
      endedAt: "2026-08-14T12:00:01.000Z",
    },
    status: 200,
    expectations: {
      passed: failure === null,
      mismatches: failure === null ? [] : [{ kind: "status", expected: 200 }],
    },
    failure,
  };
}

const observations = {
  version: 1,
  viewport: { width: 320, height: 600 },
  document: {
    scrollWidth: 340,
    scrollHeight: 600,
    clientWidth: 320,
    clientHeight: 600,
  },
  elements: [],
  headings: [{ selector: "h1", level: 1, text: "Ready" }],
  tokens: { status: "not-configured" },
};

const reviewV2Styles: ObservedElementV2["styles"] = {
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
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
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
  display: "block",
  visibility: "visible",
  opacity: "1",
  fontFamily: "system-ui",
  fontSize: "16px",
  fontWeight: "400",
  lineHeight: "normal",
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

function reviewV2Element(options: {
  selector: string;
  tag: string;
  path: string;
  rect: { x: number; y: number; width: number; height: number };
  interactive?: boolean;
  text?: string;
}): ObservedElementV2 {
  return {
    selector: options.selector,
    tag: options.tag,
    text: options.text ?? "",
    visible: true,
    interactive: options.interactive ?? false,
    enabled: true,
    rect: options.rect,
    scrollWidth: options.rect.width,
    scrollHeight: options.rect.height,
    clientWidth: options.rect.width,
    clientHeight: options.rect.height,
    outOfFlow: false,
    ancestorSelectors: [],
    authoredProperties: [],
    styles: reviewV2Styles,
    hitTestWith: [],
    structuralPath: options.path,
    legacyRenderedPath: options.path,
    directText: options.text ?? "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]/main[0]",
    relativeRect: options.rect,
  };
}

function reviewSpacingObservations(): ObservationArtifactV2 {
  const elements = [
    reviewV2Element({
      selector: "html",
      tag: "html",
      path: "html[0]",
      rect: { x: 0, y: 0, width: 390, height: 844 },
    }),
    reviewV2Element({
      selector: "body",
      tag: "body",
      path: "html[0]/body[0]",
      rect: { x: 0, y: 0, width: 390, height: 844 },
    }),
    reviewV2Element({
      selector: "main.settings",
      tag: "main",
      path: "html[0]/body[0]/main[0]",
      rect: { x: 20, y: 20, width: 350, height: 500 },
    }),
  ];
  [16, 16, 16, 0].forEach((clearance, index) => {
    const y = 40 + index * 90;
    const path = `html[0]/body[0]/main[0]/section[${index}]`;
    elements.push(
      reviewV2Element({
        selector: `section.action-${index + 1}`,
        tag: "section",
        path,
        rect: { x: 30, y, width: 330, height: 54 + clearance },
      }),
      reviewV2Element({
        selector: `button.action-${index + 1}`,
        tag: "button",
        path: `${path}/button[0]`,
        rect: { x: 40, y: y + 10, width: 120, height: 44 },
        interactive: true,
        text: `Action ${index + 1}`,
      }),
    );
  });
  return {
    version: 2,
    viewport: { width: 390, height: 844 },
    document: {
      scrollWidth: 390,
      scrollHeight: 844,
      clientWidth: 390,
      clientHeight: 844,
    },
    elements,
    headings: [{ selector: "h1", level: 1, text: "Settings" }],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
}

async function successfulRun(): Promise<string> {
  const run = await mkdtemp(join(tmpdir(), "idiom-review-"));
  directories.push(run);
  const tuple = join(run, "ready", "phone");
  await mkdir(tuple, { recursive: true });
  await Promise.all([
    writeFile(join(tuple, "metadata.json"), JSON.stringify(metadata())),
    writeFile(join(tuple, "screenshot.png"), "png"),
    writeFile(join(tuple, "dom.html"), "<h1>Ready</h1>"),
    writeFile(
      join(tuple, "console.jsonl"),
      `${JSON.stringify({ type: "pageerror", text: "Unexpected token `<` in JSON\nsecond line" })}\n`,
    ),
    writeFile(
      join(tuple, "axe.json"),
      JSON.stringify({
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            nodes: [{ target: ["p.copy"], html: "<p>copy</p>" }],
          },
        ],
      }),
    ),
    writeFile(join(tuple, "observations.json"), JSON.stringify(observations)),
  ]);
  return run;
}

test("loads literal and setup-derived document response context", async () => {
  const run = await successfulRun();
  const expectedStatusByState = new Map([["ready", 404]]);
  const metadataPath = join(run, "ready", "phone", "metadata.json");
  await writeFile(metadataPath, JSON.stringify({ ...metadata(), status: 404 }));
  const literal = await loadCaptureRun({
    runDirectory: run,
    expectedFlow: "booking",
    expectedStatusByState,
  });
  expect(literal.tuples[0]?.documentResponse).toEqual({
    url: "http://127.0.0.1:3107/ready",
    actualStatus: 404,
    expectedStatus: 404,
  });

  await writeFile(
    metadataPath,
    JSON.stringify({
      ...metadata(),
      status: 404,
      url: {
        kind: "setup-stdout",
        origin: "http://127.0.0.1:3107",
        source: "setup-stdout",
        pattern: "BOOKING_URL=(https?://\\\\S+)",
        append: "?tz=America/New_York",
        template:
          "http://127.0.0.1:3107/{setup-stdout:ready}?tz=America/New_York",
      },
    }),
  );
  const derived = await loadCaptureRun({
    runDirectory: run,
    expectedFlow: "booking",
    expectedStatusByState,
  });
  expect(derived.tuples[0]?.documentResponse?.url).toBe(
    "http://127.0.0.1:3107/{setup-stdout:ready}?tz=America/New_York",
  );
});

test("loads console request provenance and reports only the same-URL subresource", async () => {
  const run = await successfulRun();
  const tuple = join(run, "ready", "phone");
  const documentUrl = "http://127.0.0.1:3107/ready";
  const text =
    "Failed to load resource: the server responded with a status of 404 (Not Found)";
  const location = { url: documentUrl, lineNumber: 0, columnNumber: 0 };
  const records = [
    {
      type: "error",
      text,
      location,
      request: { resourceType: "document", mainFrame: true },
    },
    {
      type: "error",
      text,
      location,
      request: { resourceType: "script", mainFrame: true },
    },
  ];
  const consolePath = join(tuple, "console.jsonl");
  const metadataPath = join(tuple, "metadata.json");
  await writeFile(
    consolePath,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  await writeFile(
    metadataPath,
    JSON.stringify({ ...metadata(), status: 404, consoleProvenance: true }),
  );
  const load = () =>
    loadCaptureRun({
      runDirectory: run,
      expectedFlow: "booking",
      expectedStatusByState: new Map([["ready", 404]]),
    });
  const loaded = (await load()).tuples[0];
  expect(loaded?.consoleProvenance).toBe(true);
  expect(loaded?.console.map((record) => record.request)).toEqual(
    records.map((record) => record.request),
  );
  const reported = runDeterministicChecks(loaded ? [loaded] : [])
    .candidates.filter(
      ({ candidate }) => candidate.category === "console-error",
    )
    .map(({ candidate }) => candidate);
  expect(reported).toHaveLength(1);
  expect(reported[0]?.explanation).not.toContain("recorded");

  await writeFile(
    consolePath,
    `${JSON.stringify({ ...records[0], request: { resourceType: "document", mainFrame: "yes" } })}\n`,
  );
  await expect(load()).rejects.toThrow(
    "request must be { resourceType: string, mainFrame: boolean }",
  );
  await expect(load()).rejects.toBeInstanceOf(IdiomError);
  await writeFile(consolePath, "");
  await writeFile(
    metadataPath,
    JSON.stringify({ ...metadata(), consoleProvenance: "true" }),
  );
  await expect(load()).rejects.toThrow(`invalid metadata in ${metadataPath}`);
});

test.each([
  {
    kind: "literal",
    url: {
      kind: "literal",
      origin: "http://127.0.0.1:54321",
      url: "http://127.0.0.1:54321/not-found",
      canonicalOrigin: "http://127.0.0.1:3107",
    },
    location: "http://127.0.0.1:3107/not-found",
    suppressed: true,
  },
  {
    kind: "setup-stdout",
    url: {
      kind: "setup-stdout",
      origin: "http://127.0.0.1:54321",
      source: "setup-stdout",
      pattern: "URL (\\S+)",
      append: "",
      template: "http://127.0.0.1:54321/{setup-stdout:ready}",
      canonicalOrigin: "http://127.0.0.1:3107",
    },
    location: "http://127.0.0.1:3107/{setup-stdout:ready}",
    suppressed: true,
  },
  {
    kind: "literal without canonicalOrigin",
    url: {
      kind: "literal",
      origin: "http://127.0.0.1:54321",
      url: "http://127.0.0.1:54321/not-found",
    },
    location: "http://127.0.0.1:3107/not-found",
    suppressed: false,
  },
])(
  "a canonicalOrigin maps the $kind document URL onto canonical console locations",
  async ({ url, location, suppressed }) => {
    const run = await successfulRun();
    const tuple = join(run, "ready", "phone");
    await writeFile(
      join(tuple, "metadata.json"),
      JSON.stringify({ ...metadata(), status: 404, url }),
    );
    await writeFile(
      join(tuple, "console.jsonl"),
      `${JSON.stringify({
        type: "error",
        text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
        location: { url: location, lineNumber: 0, columnNumber: 0 },
      })}\n`,
    );
    const loaded = await loadCaptureRun({
      runDirectory: run,
      expectedFlow: "booking",
      expectedStatusByState: new Map([["ready", 404]]),
    });
    expect(loaded.tuples[0]?.documentResponse?.url).toBe(
      suppressed ? location : url.kind === "literal" ? url.url : undefined,
    );
    const consoleErrors = runDeterministicChecks(
      loaded.tuples,
    ).candidates.filter(
      ({ candidate }) => candidate.category === "console-error",
    );
    expect(consoleErrors).toHaveLength(suppressed ? 0 : 1);
  },
);

test("loads the recorded final document URL and rejects a non-string one", async () => {
  const run = await successfulRun();
  const expectedStatusByState = new Map([["ready", 404]]);
  const metadataPath = join(run, "ready", "phone", "metadata.json");
  const load = () =>
    loadCaptureRun({
      runDirectory: run,
      expectedFlow: "booking",
      expectedStatusByState,
    });
  await writeFile(metadataPath, JSON.stringify({ ...metadata(), status: 404 }));
  expect((await load()).tuples[0]?.documentResponse).not.toHaveProperty(
    "finalUrl",
  );

  await writeFile(
    metadataPath,
    JSON.stringify({
      ...metadata(),
      status: 404,
      documentUrl: "http://127.0.0.1:3107/gone",
    }),
  );
  expect((await load()).tuples[0]?.documentResponse).toEqual({
    url: "http://127.0.0.1:3107/ready",
    finalUrl: "http://127.0.0.1:3107/gone",
    actualStatus: 404,
    expectedStatus: 404,
  });

  await writeFile(
    metadataPath,
    JSON.stringify({ ...metadata(), status: 404, documentUrl: 3107 }),
  );
  await expect(load()).rejects.toThrow();
});

test("a non-string canonicalOrigin makes metadata invalid", async () => {
  const run = await successfulRun();
  await writeFile(
    join(run, "ready", "phone", "metadata.json"),
    JSON.stringify({
      ...metadata(),
      url: { ...metadata().url, canonicalOrigin: 3107 },
    }),
  );
  await expect(
    loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }),
  ).rejects.toThrow();
});

test("stored review ignores an expected 404 document error but keeps genuine errors", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-review-expected-404-"));
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: ["The not-found state is intentional."],
      setup: [],
      viewports: ["mobile"],
      states: [
        {
          id: "not-found",
          description: "Not found",
          url: "/not-found",
          expect: { status: 404 },
        },
      ],
    }),
  );
  const runId = "2026-08-15T23-13-53-099Z";
  const tupleDirectory = join(
    project,
    ".idiom",
    "reports",
    runId,
    "not-found",
    "mobile",
  );
  await mkdir(tupleDirectory, { recursive: true });
  const documentUrl = "http://127.0.0.1:3107/not-found";
  const resourceMessage =
    "Failed to load resource: the server responded with a status of 404";
  await Promise.all([
    writeFile(
      join(tupleDirectory, "metadata.json"),
      JSON.stringify({
        ...metadata(),
        state: { id: "not-found", description: "Not found" },
        viewport: {
          name: "mobile",
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
        },
        url: {
          kind: "literal",
          origin: "http://127.0.0.1:3107",
          url: documentUrl,
        },
        status: 404,
      }),
    ),
    writeFile(join(tupleDirectory, "screenshot.png"), "png"),
    writeFile(join(tupleDirectory, "dom.html"), "<h1>Not found</h1>"),
    writeFile(
      join(tupleDirectory, "console.jsonl"),
      `${[
        {
          type: "error",
          text: resourceMessage,
          location: { url: documentUrl, lineNumber: 0, columnNumber: 0 },
        },
        {
          type: "error",
          text: `${resourceMessage} (Not Found)`,
          location: {
            url: "http://127.0.0.1:3107/missing.css",
            lineNumber: 0,
            columnNumber: 0,
          },
        },
        { type: "pageerror", text: "Application crashed" },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    ),
    writeFile(
      join(tupleDirectory, "axe.json"),
      JSON.stringify({ violations: [] }),
    ),
    writeFile(
      join(tupleDirectory, "observations.json"),
      JSON.stringify({
        ...observations,
        viewport: { width: 390, height: 844 },
        document: {
          scrollWidth: 390,
          scrollHeight: 844,
          clientWidth: 390,
          clientHeight: 844,
        },
      }),
    ),
  ]);

  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    deterministicOnly: true,
  });
  expect(result).not.toHaveProperty("issueRankingContext");
  const findings = JSON.parse(
    await readFile(result.findingsPath, "utf8"),
  ) as Array<{
    category: string;
    evidence: { consoleExcerpt?: string };
  }>;
  expect(
    findings
      .filter(({ category }) => category === "console-error")
      .map(({ evidence }) => evidence.consoleExcerpt),
  ).toEqual(["Application crashed", `${resourceMessage} (Not Found)`]);
});

test("configured review keeps failed tuples while healthy v2 siblings emit spacing rhythm", async () => {
  const project = await mkdtemp(
    join(tmpdir(), "idiom-review-spacing-partial-"),
  );
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: ["Account settings retain consistent action spacing."],
      setup: [],
      viewports: ["mobile"],
      states: [
        {
          id: "settings",
          description: "Settings",
          url: "/settings",
          expect: { status: 200 },
        },
        {
          id: "broken",
          description: "Broken",
          url: "/broken",
          expect: { status: 200 },
        },
      ],
    }),
  );
  const runId = "2026-08-27T13-00-00-000Z";
  const run = join(project, ".idiom", "reports", runId);
  const settings = join(run, "settings", "mobile");
  const broken = join(run, "broken", "mobile");
  await Promise.all([
    mkdir(settings, { recursive: true }),
    mkdir(broken, { recursive: true }),
  ]);
  const viewport = {
    name: "mobile",
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
  };
  await Promise.all([
    writeFile(
      join(settings, "metadata.json"),
      JSON.stringify({
        ...metadata(),
        state: { id: "settings", description: "Settings" },
        viewport,
        url: {
          kind: "literal",
          origin: "http://127.0.0.1:3107",
          url: "http://127.0.0.1:3107/settings",
        },
      }),
    ),
    writeFile(join(settings, "screenshot.png"), "png"),
    writeFile(join(settings, "dom.html"), "<h1>Settings</h1>"),
    writeFile(join(settings, "console.jsonl"), ""),
    writeFile(join(settings, "axe.json"), JSON.stringify({ violations: [] })),
    writeFile(
      join(settings, "observations.json"),
      JSON.stringify(reviewSpacingObservations()),
    ),
    writeFile(
      join(broken, "metadata.json"),
      JSON.stringify({
        ...metadata({ stage: "navigation", message: "connection refused" }),
        state: { id: "broken", description: "Broken" },
        viewport,
        url: {
          kind: "literal",
          origin: "http://127.0.0.1:3107",
          url: "http://127.0.0.1:3107/broken",
        },
      }),
    ),
  ]);

  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    deterministicOnly: true,
  });
  const findings = JSON.parse(
    await readFile(result.findingsPath, "utf8"),
  ) as Array<{ category: string; state: string }>;
  expect(findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ category: "missing-state", state: "broken" }),
      expect.objectContaining({
        category: "spacing-rhythm",
        state: "settings",
      }),
    ]),
  );
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("| settings | mobile | spacing-rhythm | ran |");
  expect(report).toContain(
    "| broken | mobile | spacing-rhythm | unavailable | not evaluated: observations.json is unavailable |",
  );
});

async function reviewPass(run: string) {
  const loaded = await loadCaptureRun({
    runDirectory: run,
    expectedFlow: "booking",
  });
  const checked = runDeterministicChecks(loaded.tuples);
  const findings = finalizeFindings({
    runId: loaded.runId,
    drafts: buildDeterministicDrafts({
      runId: loaded.runId,
      entries: checked.candidates,
    }),
    maxFindings: 5,
  });
  expect(findings.length).toBeGreaterThan(0);
  for (const finding of findings) {
    expect(findingSchema.parse(finding).confidence).toBe(1);
    expect(finding.evidence.artifacts?.length).toBeGreaterThan(0);
  }
  const report = renderReport({
    flow: "booking",
    commit: loaded.commit,
    findings,
    tuples: loaded.tuples,
    coverage: checked.coverage,
    narrowWidth: checked.narrowWidth,
    outcome: { kind: "deterministic-only" },
  });
  expect(report).toContain("![ready at phone](ready/phone/screenshot.png)");
  expect(report.toLowerCase()).not.toContain("score");
  const firstFindings = await writeFindings(run, findings);
  const firstReport = await writeReport(run, report);
  return {
    findings,
    report,
    findingsSource: await readFile(firstFindings, "utf8"),
    reportSource: await readFile(firstReport, "utf8"),
  };
}

test("review output is schema-valid and byte-identical on full replay", async () => {
  const run = await successfulRun();
  const first = await reviewPass(run);
  expect(first.report).toContain("Basis: measured:");
  for (const finding of first.findings) {
    expect(finding.basis).toBe(
      finding.layer === "model" ? "judged" : "measured",
    );
    expect(finding.acceptance.kind).toBe(
      finding.layer === "model" ? "manual" : "rule",
    );
  }
  expect(first.report).toContain(
    "![ready at phone](ready/phone/screenshot.png)",
  );
  expect(first.report).toContain("```html\n<p>copy</p>\n```");
  expect(first.report).toContain(
    "```text\nUnexpected token `<` in JSON\nsecond line\n```",
  );
  expect(first.report).toContain(
    "Unexpected token \\`&lt;\\` in JSON<br>second line",
  );
  expect(first.report).not.toContain("&\\#96;");
  expect(first.report).not.toContain("&lt;p&gt;");
  expect(first.report).toContain("| spacing-rhythm | unavailable |");
  expect(first.report).toContain("| layout-invariants | unavailable |");
  expect(first.report).toContain("recapture to measure declared invariants");
  expect(first.report).toContain(
    "not evaluated: observations version 1 lacks structural geometry",
  );
  expect(first.report.toLowerCase()).not.toContain("score");

  const second = await reviewPass(run);
  expect(second.findingsSource).toBe(first.findingsSource);
  expect(second.reportSource).toBe(first.reportSource);
  expect(second.findings.map(({ fingerprint }) => fingerprint)).toEqual(
    first.findings.map(({ fingerprint }) => fingerprint),
  );
});

test("reports render full, intentional, and degraded model outcomes distinctly", () => {
  const base = {
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples: [],
    coverage: [],
  };
  const full = renderReport({ ...base, outcome: { kind: "full" } });
  expect(full).toContain("# Full review: booking");
  expect(full).toContain("Model layer: completed successfully.");

  const intentional = renderReport({
    ...base,
    outcome: { kind: "deterministic-only" },
  });
  expect(intentional).toContain("# Deterministic-only review: booking");
  expect(intentional).toContain("skipped by choice (`--deterministic-only`)");
  expect(intentional).not.toContain("Model layer did not run");

  const degraded = renderReport({
    ...base,
    outcome: {
      kind: "degraded",
      reason: "`network` *failed*\nretry unavailable",
    },
  });
  expect(degraded).toContain("# Degraded review: booking");
  expect(degraded).toContain("## Model layer did not run");
  expect(degraded).toContain("\\`network\\` \\*failed\\*<br>retry unavailable");
  expect(degraded).not.toContain("# Full review:");
});

test("degraded reports punctuate the reason before the deterministic-findings note", () => {
  const base = {
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples: [],
    coverage: [],
  };
  const render = (reason: string) => {
    const options = { ...base, outcome: { kind: "degraded" as const, reason } };
    return {
      markdown: renderReport(options),
      html: renderReviewHtmlReport({ ...options, screenshots: new Map() }),
    };
  };

  const unpunctuated = render("ANTHROPIC_API_KEY is not set");
  expect(unpunctuated.markdown).toContain(
    "ANTHROPIC\\_API\\_KEY is not set. Deterministic findings remain available.",
  );
  expect(unpunctuated.html).toContain(
    "Model layer did not run: ANTHROPIC_API_KEY is not set. Deterministic findings remain available.",
  );

  const punctuated = render("provider failed.");
  for (const report of [punctuated.markdown, punctuated.html]) {
    expect(report).toContain(
      "provider failed. Deterministic findings remain available.",
    );
    expect(report).not.toContain("failed..");
  }

  const truncated = render("provider response was cut…");
  for (const report of [truncated.markdown, truncated.html]) {
    expect(report).toContain("cut… Deterministic findings remain available.");
    expect(report).not.toContain("….");
  }

  expect(degradedReasonSentence("x")).toBe("x.");
  expect(degradedReasonSentence("x \n")).toBe("x.");
  for (const terminated of ["x.", "x!", "x?", "x…", "x.)", 'x."']) {
    expect(degradedReasonSentence(terminated)).toBe(terminated);
  }
  expect(degradedReasonSentence("")).toBe("");
});

test("reports list truncated text references only when the model layer was attempted", () => {
  const base = {
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples: [],
    coverage: [],
  };
  const truncatedReferences = [
    {
      label: "reference:brand.md",
      polarity: "reference" as const,
      totalChars: 40_213,
      includedChars: 12_000,
    },
  ];
  const sentence =
    "Text references truncated for the model (limit 12,000 characters each): reference:brand.md (40,213 characters, first 12,000 sent).";
  for (const outcome of [
    { kind: "full" as const },
    { kind: "degraded" as const, reason: "provider failed" },
  ]) {
    const options = { ...base, outcome, truncatedReferences };
    expect(renderReport(options), outcome.kind).toContain(sentence);
    expect(
      renderReviewHtmlReport({ ...options, screenshots: new Map() }),
      outcome.kind,
    ).toContain(sentence);
  }
  for (const options of [
    { ...base, outcome: { kind: "full" as const } },
    { ...base, outcome: { kind: "full" as const }, truncatedReferences: [] },
    {
      ...base,
      outcome: { kind: "deterministic-only" as const },
      truncatedReferences,
    },
  ]) {
    expect(renderReport(options)).not.toContain("Text references truncated");
    expect(
      renderReviewHtmlReport({ ...options, screenshots: new Map() }),
    ).not.toContain("Text references truncated");
  }
});

test("reports note when the deterministic findings context was bounded", () => {
  const base = {
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples: [],
    coverage: [],
  };
  const deterministicContextLimits = [
    { state: "checkout", totalFindings: 212, includedFindings: 50 },
  ];
  const sentence =
    "Deterministic findings context for the model was bounded (limit 50 findings or 20,000 characters per prompt): checkout 50 of 212 listed, the rest summarized by category and severity.";
  for (const outcome of [
    { kind: "full" as const },
    { kind: "degraded" as const, reason: "provider failed" },
  ]) {
    const options = { ...base, outcome, deterministicContextLimits };
    expect(renderReport(options), outcome.kind).toContain(sentence);
    expect(
      renderReviewHtmlReport({ ...options, screenshots: new Map() }),
      outcome.kind,
    ).toContain(sentence);
  }
  for (const options of [
    { ...base, outcome: { kind: "full" as const } },
    {
      ...base,
      outcome: { kind: "full" as const },
      deterministicContextLimits: [],
    },
    {
      ...base,
      outcome: { kind: "deterministic-only" as const },
      deterministicContextLimits,
    },
  ]) {
    expect(renderReport(options)).not.toContain("context for the model");
    expect(
      renderReviewHtmlReport({ ...options, screenshots: new Map() }),
    ).not.toContain("context for the model");
  }
  const advisory = {
    version: 1 as const,
    flow: "booking",
    outcome: { kind: "full" as const },
    patterns: [
      {
        id: "logo-marquee",
        intent: "A calm row of logos",
        state: "home",
        status: "ok" as const,
        screenshots: [],
        findings: [],
        deterministicContextLimit: { totalFindings: 61, includedFindings: 31 },
      },
    ],
  };
  const patternSentence =
    "Deterministic findings context for the model was bounded (limit 50 findings or 20,000 characters per prompt): 31 of 61 listed, the rest summarized by category and severity.";
  const options = { ...base, outcome: { kind: "full" as const }, advisory };
  expect(renderReport(options)).toContain(patternSentence);
  expect(
    renderReviewHtmlReport({ ...options, screenshots: new Map() }),
  ).toContain(patternSentence);
});

test("review coverage is ordered before findings and exposes narrowed and failed scope", () => {
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
      { name: "desktop", width: 1440, height: 900 },
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
    viewports: ["mobile"],
    colorSchemes: ["dark"],
    states: [
      { id: "ready", description: "Ready", url: "/", expect: {} },
      { id: "failed", description: "Failed", url: "/failed", expect: {} },
    ],
  });
  const tupleBase = {
    flow: "booking",
    viewport: "mobile",
    colorScheme: "dark" as const,
    colorSchemeAxis: true,
    width: 390,
    height: 844,
    artifactPaths: [],
    commit: "abc123",
    createdAt: "2026-08-20T12:00:00.000Z",
    console: [],
    mismatches: [],
  };
  const tuples = [
    {
      ...tupleBase,
      state: "ready",
      metadataPath: "ready/mobile/dark/metadata.json",
      screenshotPath: "ready/mobile/dark/screenshot.png",
    },
    {
      ...tupleBase,
      state: "failed",
      metadataPath: "failed/mobile/dark/metadata.json",
      failure: { stage: "navigation", message: "refused" },
    },
  ];
  const reportCoverage = buildReviewCoverage({
    flow,
    project,
    tuples,
    commit: "abc123",
  });
  const options = {
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples,
    coverage: [],
    outcome: { kind: "full" as const },
    reportCoverage,
  };
  const markdown = renderReport(options);
  const html = renderReviewHtmlReport({ ...options, screenshots: new Map() });
  for (const output of [markdown, html]) {
    expect(output).toContain("2 of 2 declared");
    expect(output).toContain("mobile (390×844)");
    expect(output).toContain("dark");
    expect(output).toContain("1 of 2 selected");
    expect(output).toContain("Captured commit");
    expect(output).toContain("abc123");
    expect(output).toContain("excludes project viewport");
    expect(output).toContain("excludes project colour scheme");
    expect(output).toContain("not successfully captured");
  }
  expect(markdown.indexOf("## Coverage and limits")).toBeLessThan(
    markdown.indexOf("## ready"),
  );
  expect(html.indexOf("Coverage and limits")).toBeLessThan(
    html.indexOf("<h2>ready</h2>"),
  );
});

test("declared surface coverage names judged, other-governed, and ungoverned groups including none", () => {
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
    surfaces: [
      { id: "booking", name: "Recipient booking" },
      { id: "composer", name: "Desktop composer" },
      { id: "feed", name: "Update feed" },
    ],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const current = flowSchema.parse({
    id: "booking",
    surface: "booking",
    title: "Booking",
    intent: [],
    setup: [],
    states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
  });
  const composer = flowSchema.parse({
    id: "composer",
    surface: "composer",
    title: "Composer",
    intent: [],
    setup: [],
    states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
  });
  const coverage = buildReviewCoverage({
    project,
    flow: current,
    allFlows: [current, composer],
    tuples: [],
    commit: "abc123",
  });
  const markdown = renderReport({
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples: [],
    coverage: [],
    outcome: { kind: "full" },
    reportCoverage: coverage,
  });
  expect(markdown).toContain("Recipient booking (booking) — flows: booking");
  expect(markdown).toContain("Desktop composer (composer) — flows: composer");
  expect(markdown).toContain("Update feed (feed) — flows: none");

  const complete = buildReviewCoverage({
    project: projectSchema.parse({
      ...project,
      surfaces: project.surfaces.slice(0, 1),
    }),
    flow: current,
    allFlows: [current],
    tuples: [],
    commit: "abc123",
  });
  expect(
    renderReport({
      flow: "booking",
      commit: "abc123",
      findings: [],
      tuples: [],
      coverage: [],
      outcome: { kind: "full" },
      reportCoverage: complete,
    }),
  ).toContain("Ungoverned (no flow captures this surface): none");
});

test("model reference citations persist in finding evidence and render by exact label", async () => {
  const run = await successfulRun();
  const loaded = await loadCaptureRun({
    runDirectory: run,
    expectedFlow: "booking",
  });
  const drafts = buildModelDrafts({
    runId: loaded.runId,
    candidates: [
      {
        category: "reference-mismatch",
        severity: "major",
        confidence: 0.85,
        rule: "Match the editorial reference density.",
        selectorHint: "main",
        state: "ready",
        viewport: "phone",
        screenshots: ["ready/phone"],
        references: ["reference:editorial-density"],
        explanation: "The surface is much more spacious than the reference.",
        suggestedArea: "main content",
        acceptance: ["The main content matches the reference density."],
      },
    ],
    screenshots: [
      {
        label: "ready/phone",
        path: "ready/phone/screenshot.png",
        readPath: join(run, "ready", "phone", "screenshot.png"),
        state: "ready",
        viewport: "phone",
      },
    ],
    tuples: loaded.tuples,
  });
  const finding = drafts[0]?.finding;
  if (finding === undefined) throw new Error("missing model finding");
  expect(finding.evidence.references).toEqual(["reference:editorial-density"]);
  expect(
    renderReport({
      flow: "booking",
      commit: loaded.commit,
      findings: [finding],
      tuples: loaded.tuples,
      coverage: [],
      outcome: { kind: "full" },
    }),
  ).toContain("References: reference:editorial-density");
});

test("metadata-explained failures remain reviewable and stale successes do not", async () => {
  const run = await mkdtemp(join(tmpdir(), "idiom-review-failed-"));
  directories.push(run);
  const tuple = join(run, "ready", "phone");
  await mkdir(tuple, { recursive: true });
  await writeFile(
    join(tuple, "metadata.json"),
    JSON.stringify(metadata({ stage: "navigation", message: "refused" })),
  );
  const loaded = await loadCaptureRun({
    runDirectory: run,
    expectedFlow: "booking",
  });
  const checked = runDeterministicChecks(loaded.tuples);
  expect(
    checked.candidates.some(
      ({ candidate }) => candidate.category === "missing-state",
    ),
  ).toBe(true);
  expect(
    checked.coverage.find(({ coverage }) => coverage.check === "contrast")
      ?.coverage.status,
  ).toBe("unavailable");
  expect(
    checked.coverage.find(({ coverage }) => coverage.check === "spacing-rhythm")
      ?.coverage,
  ).toEqual({
    check: "spacing-rhythm",
    status: "unavailable",
    reason: "not evaluated: observations.json is unavailable",
  });

  await writeFile(join(tuple, "metadata.json"), JSON.stringify(metadata()));
  await expect(
    loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }),
  ).rejects.toThrow("stale or corrupt");
});

test("corrupt observations fail with an actionable recapture error", async () => {
  const run = await successfulRun();
  await writeFile(join(run, "ready", "phone", "observations.json"), "{}");
  await expect(
    loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }),
  ).rejects.toThrow(/invalid observations.*recapture the flow/);
});

function draft(options: {
  fingerprint: string;
  layer: "deterministic" | "model";
  severity: "blocker" | "major" | "minor";
  stableOrder: number;
  confidence?: number;
}): FindingDraft {
  return {
    stableOrder: options.stableOrder,
    selectorHint: `surface-${options.fingerprint}`,
    finding: findingSchema.parse({
      id: "draft",
      fingerprint: options.fingerprint,
      createdAt: "2026-08-14T12:00:00.000Z",
      commit: "abc123",
      flow: "booking",
      state: "ready",
      viewport: "phone",
      layer: options.layer,
      category: options.layer === "model" ? "hierarchy" : "missing-state",
      severity: options.severity,
      confidence: options.confidence ?? (options.layer === "model" ? 0.8 : 1),
      rule: `rule-${options.fingerprint}`,
      evidence: { screenshots: ["ready/phone/screenshot.png"] },
      explanation: `Explanation ${options.fingerprint}`,
      acceptance: ["It is visibly resolved."],
      verification:
        options.layer === "model"
          ? { kind: "recapture-visual" }
          : { kind: "deterministic-check", check: "missing-state" },
      status: "open",
    }),
  };
}

test("mixed findings are severity-ranked with deterministic tie precedence and a global cap", () => {
  const findings = finalizeFindings({
    runId: "run",
    maxFindings: 3,
    drafts: [
      draft({
        fingerprint: "model-blocker",
        layer: "model",
        severity: "blocker",
        stableOrder: 0,
      }),
      draft({
        fingerprint: "det-blocker",
        layer: "deterministic",
        severity: "blocker",
        stableOrder: 5,
      }),
      draft({
        fingerprint: "det-major",
        layer: "deterministic",
        severity: "major",
        stableOrder: 1,
      }),
      draft({
        fingerprint: "model-major",
        layer: "model",
        severity: "major",
        stableOrder: 0,
      }),
    ],
  });
  expect(findings.map((finding) => finding.fingerprint)).toEqual([
    "det-blocker",
    "model-blocker",
    "det-major",
  ]);
  expect(findings.map((finding) => finding.id)).toEqual([
    "finding-1",
    "finding-2",
    "finding-3",
  ]);
  expect(
    findings.every((finding) => findingSchema.safeParse(finding).success),
  ).toBe(true);
});

test("deduplication happens before cap reservation", () => {
  const first = draft({
    fingerprint: "same",
    layer: "deterministic",
    severity: "major",
    stableOrder: 0,
  });
  const second = draft({
    fingerprint: "same",
    layer: "deterministic",
    severity: "major",
    stableOrder: 1,
  });
  const live = draft({
    fingerprint: "different",
    layer: "deterministic",
    severity: "minor",
    stableOrder: 2,
  });
  expect(
    dedupeFindingDrafts([first, second, live]).map(
      ({ finding }) => finding.fingerprint,
    ),
  ).toEqual(["same", "different"]);
});

test("combined selection is stable by severity, confidence, and fingerprint before partitioning", () => {
  const candidates = [
    draft({
      fingerprint: "z-low-confidence",
      layer: "model",
      severity: "major",
      confidence: 0.4,
      stableOrder: 0,
    }),
    draft({
      fingerprint: "z-high-confidence",
      layer: "model",
      severity: "major",
      confidence: 0.9,
      stableOrder: 9,
    }),
    draft({
      fingerprint: "a-high-confidence",
      layer: "model",
      severity: "major",
      confidence: 0.9,
      stableOrder: 20,
    }),
    draft({
      fingerprint: "minor-deterministic",
      layer: "deterministic",
      severity: "minor",
      stableOrder: 0,
    }),
  ];
  const first = finalizeFindingSelection({
    runId: "run",
    drafts: candidates,
    maxFindings: 2,
  });
  const replay = finalizeFindingSelection({
    runId: "run",
    drafts: [...candidates].reverse(),
    maxFindings: 2,
  });
  expect(first.material.map(({ fingerprint }) => fingerprint)).toEqual([
    "a-high-confidence",
    "z-high-confidence",
  ]);
  expect(first.deferred.map(({ fingerprint }) => fingerprint)).toEqual([
    "z-low-confidence",
    "minor-deterministic",
  ]);
  expect(replay.material).toEqual(first.material);
  expect(replay.deferred).toEqual(first.deferred);
});

test("full stored review evaluates the model after six deterministic findings and reports displaced findings", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-review-combined-cap-"));
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: ["The primary action is obvious."],
      setup: [],
      viewports: ["mobile"],
      states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
    }),
  );
  const runId = "2026-08-15T12-00-00-000Z";
  const tuple = join(project, ".idiom", "reports", runId, "ready", "mobile");
  await mkdir(tuple, { recursive: true });
  await Promise.all([
    writeFile(
      join(tuple, "metadata.json"),
      JSON.stringify({
        ...metadata(),
        viewport: {
          name: "mobile",
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
        },
      }),
    ),
    writeFile(join(tuple, "screenshot.png"), "png"),
    writeFile(join(tuple, "dom.html"), "<h1>Ready</h1>"),
    writeFile(join(tuple, "console.jsonl"), ""),
    writeFile(
      join(tuple, "axe.json"),
      JSON.stringify({
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            nodes: Array.from({ length: 6 }, (_, index) => ({
              target: [`p.copy-${index + 1}`],
              html: `<p class="copy-${index + 1}">copy</p>`,
            })),
          },
        ],
      }),
    ),
    writeFile(
      join(tuple, "observations.json"),
      JSON.stringify({
        ...observations,
        viewport: { width: 390, height: 844 },
        document: {
          scrollWidth: 390,
          scrollHeight: 844,
          clientWidth: 390,
          clientHeight: 844,
        },
      }),
    ),
  ]);
  const contexts: Array<{
    modelCandidateAllowance: number;
    deterministicFindings: Array<{ id: string; fingerprint: string }>;
  }> = [];
  const critique = {
    async critique(context: {
      modelCandidateAllowance: number;
      deterministicFindings: Array<{ id: string; fingerprint: string }>;
    }) {
      contexts.push(context);
      return [
        {
          category: "hierarchy" as const,
          severity: "blocker" as const,
          confidence: 0.9,
          rule: "DESIGN.md: keep the primary action dominant",
          selectorHint: "main form",
          state: "ready",
          viewport: "mobile",
          screenshots: ["ready/mobile"],
          references: [],
          explanation: "The primary action is not visually identifiable.",
          suggestedArea: "main form",
          acceptance: ["The primary action is visually dominant."],
        },
      ];
    },
  };

  const first = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: { critique },
  });
  const firstFindings = JSON.parse(
    await readFile(first.findingsPath, "utf8"),
  ) as Array<{ id: string; fingerprint: string; layer: string }>;
  const firstReport = await readFile(first.reportPath, "utf8");
  const firstHtmlReport = await readFile(first.htmlReportPath, "utf8");
  expect(contexts[0]?.modelCandidateAllowance).toBe(5);
  expect(contexts[0]?.deterministicFindings).toHaveLength(6);
  expect(
    contexts[0]?.deterministicFindings.every(({ id }) =>
      /^finding-[1-9]\d*$/.test(id),
    ),
  ).toBe(true);
  expect(first.outcome).toEqual({ kind: "full" });
  expect(firstFindings).toHaveLength(5);
  expect(firstFindings.filter(({ layer }) => layer === "model")).toHaveLength(
    1,
  );
  expect(
    firstFindings.filter(({ layer }) => layer === "deterministic"),
  ).toHaveLength(4);
  expect(firstReport).toContain("## Evaluated but not selected");
  expect(firstReport).toContain("Basis: judged:");
  expect(firstHtmlReport).toContain("judged:");
  expect(firstHtmlReport).toContain("stated confidence");
  for (const finding of contexts[0]?.deterministicFindings ?? [])
    expect(firstReport).toContain(finding.id);
  expect(firstReport).not.toContain("IDM-");
  expect(firstReport.match(/Layer: deterministic/g)).toHaveLength(6);
  expect(firstReport).not.toContain("cap of 5 was exhausted");
  // Both deferred ids are run-local; this run's own findings.json never makes
  // them decidable.
  expect(
    firstReport.match(/Report-only: not an `idiom decide --finding` target/g),
  ).toHaveLength(2);
  expect(firstReport).not.toContain("Decision target:");
  expect(firstHtmlReport).toContain("data:image/png;base64,");
  expect(firstHtmlReport).toContain("Evaluated but not selected");
  expect(firstHtmlReport).toContain("prefers-color-scheme: dark");
  expect(firstHtmlReport.toLowerCase()).not.toContain("design score");
  const registry = JSON.parse(
    await readFile(join(project, ".idiom", "finding-names.json"), "utf8"),
  ) as { next: number; entries: Array<{ name: string }> };
  expect(registry.entries).toHaveLength(7);
  expect(registry.next).toBe(8);

  const second = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: { critique },
  });
  const secondFindings = JSON.parse(
    await readFile(second.findingsPath, "utf8"),
  ) as Array<{ id: string; fingerprint: string }>;
  expect(secondFindings.map(({ fingerprint }) => fingerprint)).toEqual(
    firstFindings.map(({ fingerprint }) => fingerprint),
  );
  expect(secondFindings.map(({ id }) => id)).toEqual(
    firstFindings.map(({ id }) => id),
  );
  const secondReport = await readFile(second.reportPath, "utf8");
  expect(
    secondReport.match(/Report-only: not an `idiom decide --finding` target/g),
  ).toHaveLength(2);
  expect(secondReport).not.toContain("Decision target:");
  expect(first).not.toHaveProperty("critiqueEvidenceLimits");
  expect(firstReport).not.toContain("critique evidence was limited");
  expect(firstHtmlReport).not.toContain("critique evidence was limited");

  const evidenceLimits = {
    provider: "claude-code" as const,
    limits: { images: 20, imageBytes: 20 * 1024 * 1024, domChars: 60_000 },
    sessions: 2,
    omitted: [
      {
        label: "ready/mobile",
        kind: "dom-excerpt" as const,
        reason: "excerpt is 70,000 characters; session DOM budget is 60,000",
      },
    ],
  };
  const limited = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: {
      critique: {
        async critique() {
          return {
            findings: [],
            decisionObservations: [],
            discardedDecisionObservations: 0,
            evidenceLimits,
          };
        },
      },
    },
  });
  const sentence =
    "Claude Code critique evidence was limited (per session: 20 images, 20 MB of images, 60,000 DOM characters): split across 2 sessions; omitted ready/mobile (dom-excerpt: excerpt is 70,000 characters; session DOM budget is 60,000).";
  expect(limited.outcome).toEqual({ kind: "full" });
  expect(limited.critiqueEvidenceLimits).toEqual(evidenceLimits);
  expect(await readFile(limited.reportPath, "utf8")).toContain(sentence);
  expect(await readFile(limited.htmlReportPath, "utf8")).toContain(sentence);
});

test("isCatalogDecisionTarget mirrors decide --finding resolution outside the excluded run", () => {
  const lineage = (ids: string[], runDirectories: string[]) => ({
    ids,
    occurrences: runDirectories.map((runDirectory) => ({ runDirectory })),
  });
  const catalog = {
    lineages: [
      lineage(["finding-1"], ["/reports/a", "/reports/b"]),
      lineage(["finding-2"], ["/reports/b"]),
      lineage(["finding-3"], ["/reports/a"]),
      lineage(["finding-3"], ["/reports/b"]),
    ],
  } as unknown as ReviewCatalog;
  expect(isCatalogDecisionTarget(catalog, "finding-1")).toBe(true);
  expect(isCatalogDecisionTarget(catalog, "finding-1", "/reports/b")).toBe(
    true,
  );
  expect(isCatalogDecisionTarget(catalog, "finding-9")).toBe(false);
  expect(isCatalogDecisionTarget(catalog, "finding-3")).toBe(false);
  expect(isCatalogDecisionTarget(catalog, "finding-2")).toBe(true);
  expect(isCatalogDecisionTarget(catalog, "finding-2", "/reports/x/../b")).toBe(
    false,
  );
});

test("capped report marks catalog-backed deferred findings as decision targets and run-local ones as report-only", async () => {
  const project = await mkdtemp(
    join(tmpdir(), "idiom-review-deferred-targets-"),
  );
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: ["The primary action is obvious."],
      setup: [],
      viewports: ["mobile"],
      states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
    }),
  );
  const firstRunId = "2026-08-15T12-00-00-000Z";
  const secondRunId = "2026-08-16T12-00-00-000Z";
  const reports = join(project, ".idiom", "reports");
  const tuple = join(reports, firstRunId, "ready", "mobile");
  await mkdir(tuple, { recursive: true });
  await Promise.all([
    writeFile(
      join(tuple, "metadata.json"),
      JSON.stringify({
        ...metadata(),
        viewport: {
          name: "mobile",
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
        },
      }),
    ),
    writeFile(join(tuple, "screenshot.png"), "png"),
    writeFile(join(tuple, "dom.html"), "<h1>Ready</h1>"),
    writeFile(join(tuple, "console.jsonl"), ""),
    writeFile(
      join(tuple, "axe.json"),
      JSON.stringify({
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            nodes: Array.from({ length: 6 }, (_, index) => ({
              target: [`p.copy-${index + 1}`],
              html: `<p class="copy-${index + 1}">copy</p>`,
            })),
          },
        ],
      }),
    ),
    writeFile(
      join(tuple, "observations.json"),
      JSON.stringify({
        ...observations,
        viewport: { width: 390, height: 844 },
        document: {
          scrollWidth: 390,
          scrollHeight: 844,
          clientWidth: 390,
          clientHeight: 844,
        },
      }),
    ),
  ]);
  await cp(join(reports, firstRunId), join(reports, secondRunId), {
    recursive: true,
  });
  const blocker = {
    category: "hierarchy" as const,
    severity: "blocker" as const,
    confidence: 0.9,
    rule: "DESIGN.md: keep the primary action dominant",
    selectorHint: "main form",
    state: "ready",
    viewport: "mobile",
    screenshots: ["ready/mobile"],
    references: [],
    explanation: "The primary action is not visually identifiable.",
    suggestedArea: "main form",
    acceptance: ["The primary action is visually dominant."],
  };

  // Run 1: no model finding, so five deterministic findings are material and
  // one is deferred.
  const first = await runReview({
    project,
    flow: "booking",
    from: firstRunId,
    dependencies: { critique: { critique: async () => [] } },
  });
  const firstMaterial = JSON.parse(
    await readFile(first.findingsPath, "utf8"),
  ) as Array<{ id: string }>;
  expect(firstMaterial).toHaveLength(5);
  expect(first.deferredFindings).toHaveLength(1);

  // Run 2: the blocker takes a slot, displacing one finding run 1 recorded.
  const second = await runReview({
    project,
    flow: "booking",
    from: secondRunId,
    dependencies: { critique: { critique: async () => [blocker] } },
  });
  const secondMaterial = JSON.parse(
    await readFile(second.findingsPath, "utf8"),
  ) as Array<{ id: string }>;
  expect(secondMaterial).toHaveLength(5);
  expect(second.deferredFindings).toHaveLength(2);
  const firstIds = new Set(firstMaterial.map(({ id }) => id));
  const catalogued = second.deferredFindings.filter(({ id }) =>
    firstIds.has(id),
  );
  const runLocal = second.deferredFindings.filter(
    ({ id }) => !firstIds.has(id),
  );
  expect(catalogued).toHaveLength(1);
  expect(runLocal).toHaveLength(1);
  const cataloguedId = catalogued[0]?.id ?? "";
  const runLocalId = runLocal[0]?.id ?? "";

  const report = await readFile(second.reportPath, "utf8");
  const html = await readFile(second.htmlReportPath, "utf8");
  expect(report).toContain(
    `- ${cataloguedId} (major) — Decision target: \`idiom decide --finding ${cataloguedId}\``,
  );
  expect(report).toContain(
    `- ${runLocalId} (major) — Report-only: not an \`idiom decide --finding\` target`,
  );
  expect(report).toContain(
    "Each entry is marked: `decision target` ids already have a catalog lineage",
  );
  expect(report).toContain(
    "Actionable findings above are recorded in findings.json and can be passed to `idiom decide --finding <id>`.",
  );
  for (const { id } of secondMaterial) expect(report).toContain(id);
  expect(html).toContain(
    `<strong>${cataloguedId}</strong> <span class="badge badge-good">decision target</span> <code>idiom decide --finding ${cataloguedId}</code>`,
  );
  expect(html).toContain(
    `<strong>${runLocalId}</strong> <span class="badge badge-neutral">report-only</span>`,
  );

  // The labels match what decide actually accepts.
  await decideCommand({
    project,
    finding: cataloguedId,
    accept: true,
    write: () => {},
  });
  await expect(
    decideCommand({
      project,
      finding: runLocalId,
      accept: true,
      write: () => {},
    }),
  ).rejects.toThrow(/unknown finding id/);
});

test("full review revalidates and publishes recurring unruled decisions outside findings", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-review-rulings-"));
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: ["The primary action is obvious."],
      setup: [],
      viewports: ["mobile"],
      states: [
        { id: "ready", description: "Ready", url: "/", expect: {} },
        {
          id: "confirmed",
          description: "Confirmed",
          url: "/confirmed",
          expect: {},
        },
      ],
    }),
  );
  const runId = "2026-08-20T12-00-00-000Z";
  for (const state of ["ready", "confirmed"]) {
    const tuple = join(project, ".idiom", "reports", runId, state, "mobile");
    await mkdir(tuple, { recursive: true });
    await Promise.all([
      writeFile(
        join(tuple, "metadata.json"),
        JSON.stringify({
          ...metadata(),
          state: { id: state, description: state },
          viewport: {
            name: "mobile",
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
          },
          url: {
            kind: "literal",
            origin: "http://127.0.0.1:3107",
            url: `http://127.0.0.1:3107/${state}`,
          },
        }),
      ),
      writeFile(join(tuple, "screenshot.png"), "png"),
      writeFile(join(tuple, "dom.html"), `<h1>${state}</h1>`),
      writeFile(join(tuple, "console.jsonl"), ""),
      writeFile(join(tuple, "axe.json"), JSON.stringify({ violations: [] })),
      writeFile(
        join(tuple, "observations.json"),
        JSON.stringify({
          ...observations,
          viewport: { width: 390, height: 844 },
          document: {
            scrollWidth: 390,
            scrollHeight: 844,
            clientWidth: 390,
            clientHeight: 844,
          },
        }),
      ),
    ]);
  }
  const excerpt = "How should controls, feedback, and transitions behave?";
  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: {
      critique: {
        async critique() {
          return {
            findings: [],
            discardedDecisionObservations: 0,
            decisionObservations: ["ready", "confirmed"].map((state) => ({
              choiceKey: "chip-selection",
              question: "How should selected chips be shown?",
              state,
              viewport: "mobile",
              screenshot: `${state}/mobile`,
              nearestLawExcerpt: excerpt,
              candidates: [
                {
                  wording: "Selected chips use a filled treatment.",
                  precedent: { kind: "law" as const, excerpt },
                },
              ],
            })),
          };
        },
      },
    },
  });
  expect(result.findingCount).toBe(0);
  expect(result.unruledDecisionCount).toBe(1);
  expect(JSON.parse(await readFile(result.findingsPath, "utf8"))).toEqual([]);
  expect(
    JSON.parse(await readFile(result.unruledDecisionsPath, "utf8")),
  ).toMatchObject([
    {
      id: "ruling-1",
      choiceKey: "chip-selection",
      occurrences: [{ state: "confirmed" }, { state: "ready" }],
    },
  ]);
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("## Unruled decisions");
  expect(report).toContain("Selected chips use a filled treatment.");
});

test("suppressed decision provenance renders the canonical name in both formats", () => {
  const rejected = draft({
    fingerprint: "legacy-rejected-fingerprint",
    layer: "model",
    severity: "major",
    stableOrder: 0,
  });
  const state = {
    projectDirectory: "/project",
    path: "/project/.idiom/finding-names.json",
    registry: { version: 1 as const, next: 1, entries: [] },
    changed: false,
    malformedTickets: [],
  };
  const named = {
    ...rejected,
    finding: new FindingNamingSession(state).name(rejected.finding, [], {
      preserveIdAsAlias: false,
    }),
  };
  const [suppressed] = suppressFindingDrafts(
    [named],
    [
      {
        at: "2026-08-14T12:00:00.000Z",
        commit: "abc123",
        findingId: "IDM-historical-0001",
        fingerprint: "legacy-rejected-fingerprint",
        decision: "reject",
        scope: "rule",
        actor: "human",
      },
    ],
  ).suppressed;
  if (suppressed === undefined) throw new Error("missing suppression");
  const options = {
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples: [],
    coverage: [],
    suppressed: [suppressed],
    outcome: { kind: "full" as const },
  };
  const markdown = renderReport(options);
  const html = renderReviewHtmlReport({ ...options, screenshots: new Map() });
  for (const output of [markdown, html]) {
    expect(output).toContain("finding-1");
    expect(output).not.toContain("IDM-historical-0001");
  }
});

test("standing rule decisions suppress before counting and render in the appendix", () => {
  const rejected = draft({
    fingerprint: "rejected-fingerprint",
    layer: "model",
    severity: "major",
    stableOrder: 0,
  });
  const decision = {
    at: "2026-08-14T12:00:00.000Z",
    commit: "abc123",
    findingId: "old-id",
    fingerprint: "rejected-fingerprint",
    decision: "reject" as const,
    scope: "rule" as const,
    reason: "The quiet density is intentional.",
    actor: "human",
  };
  const partitioned = suppressFindingDrafts(
    [rejected, { ...rejected, stableOrder: 1 }],
    [decision],
  );
  expect(partitioned.kept).toEqual([]);
  expect(partitioned.suppressed).toHaveLength(2);
  const suppressed = dedupeSuppressedFindings(partitioned.suppressed);
  expect(suppressed).toHaveLength(1);
  const report = renderReport({
    flow: "booking",
    commit: "abc123",
    findings: [],
    tuples: [],
    coverage: [],
    suppressed,
    outcome: { kind: "full" },
  });
  expect(report).toContain("Suppressed by prior decision");
  expect(report).toContain("rejected-fingerprint");
  expect(report).toContain("quiet density is intentional");
  expect(report.toLowerCase()).not.toContain("score");
});

test("decision JSONL diagnostics identify the corrupt line", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-decisions-"));
  directories.push(project);
  await mkdir(join(project, ".idiom"), { recursive: true });
  await writeFile(
    join(project, ".idiom", "decisions.jsonl"),
    `${JSON.stringify({
      at: "2026-08-14T12:00:00.000Z",
      commit: "abc123",
      findingId: "old-id",
      fingerprint: "fingerprint",
      decision: "reject",
      scope: "rule",
    })}\nnot-json\n`,
  );
  await expect(readDecisions(project)).rejects.toThrow(
    /decisions\.jsonl:2: malformed JSON/,
  );
});

test("a later rule decision replaces the earlier standing judgment", () => {
  const shared = {
    at: "2026-08-14T12:00:00.000Z",
    commit: "abc123",
    findingId: "old-id",
    fingerprint: "fingerprint",
    scope: "rule" as const,
    actor: "human",
  };
  expect(
    standingRuleRejections([
      { ...shared, decision: "reject" },
      { ...shared, decision: "accept" },
    ]),
  ).toEqual([]);
});

test("project rules change review severity and audit deterministic and model suppressions", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-review-rules-"));
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: ["The action is obvious."],
      setup: [],
      viewports: ["mobile"],
      states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
    }),
  );
  await writeFile(
    join(project, ".idiom", "rules.json"),
    JSON.stringify({
      version: 1,
      overrides: [
        {
          id: "ignore-console",
          match: { category: "console-error", flow: "booking" },
          action: "suppress",
          reason: "Expected fixture noise",
        },
        {
          id: "contrast-minor",
          match: { category: "contrast", state: "ready" },
          action: "severity",
          severity: "minor",
          reason: "Low-impact fixture copy",
        },
        {
          id: "ignore-model-hierarchy",
          match: { category: "hierarchy", flow: "booking" },
          action: "suppress",
          reason: "Intentional hierarchy",
        },
      ],
    }),
  );
  const runId = "2026-08-14T12-00-00-000Z";
  const tuple = join(project, ".idiom", "reports", runId, "ready", "mobile");
  await mkdir(tuple, { recursive: true });
  await Promise.all([
    writeFile(
      join(tuple, "metadata.json"),
      JSON.stringify({
        ...metadata(),
        viewport: {
          name: "mobile",
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
        },
      }),
    ),
    writeFile(join(tuple, "screenshot.png"), "png"),
    writeFile(join(tuple, "dom.html"), "<h1>Ready</h1>"),
    writeFile(
      join(tuple, "console.jsonl"),
      `${JSON.stringify({ type: "error", text: "fixture noise" })}\n`,
    ),
    writeFile(
      join(tuple, "axe.json"),
      JSON.stringify({
        violations: [
          {
            id: "color-contrast",
            impact: "serious",
            nodes: [{ target: ["p.copy"], html: "<p>copy</p>" }],
          },
        ],
      }),
    ),
    writeFile(join(tuple, "observations.json"), JSON.stringify(observations)),
  ]);

  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: {
      critique: {
        async critique() {
          return [
            {
              category: "hierarchy",
              severity: "major",
              confidence: 0.8,
              rule: "design:hierarchy",
              selectorHint: "main",
              state: "ready",
              viewport: "mobile",
              screenshots: ["ready/mobile"],
              references: [],
              explanation: "The hierarchy is intentionally quiet.",
              suggestedArea: "main content",
              acceptance: ["The hierarchy is clear."],
            },
          ];
        },
      },
    },
  });
  const findings = JSON.parse(await readFile(result.findingsPath, "utf8"));
  expect(findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ category: "contrast", severity: "minor" }),
    ]),
  );
  expect(
    findings.some(
      (finding: { category: string }) => finding.category === "console-error",
    ),
  ).toBe(false);
  expect(
    findings.some(
      (finding: { category: string }) => finding.category === "hierarchy",
    ),
  ).toBe(false);
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain(
    "Severity override: major -> minor by rule contrast-minor (Low-impact fixture copy)",
  );
  expect(report).toContain("Rule: ignore-console — Expected fixture noise");
  expect(report).toContain(
    "Rule: ignore-model-hierarchy — Intentional hierarchy",
  );
});

test("legacy captures load without a build; production provenance validates and agrees across tuples", async () => {
  const run = await successfulRun();
  const path = join(run, "ready", "phone", "metadata.json");
  expect(
    (await loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }))
      .build,
  ).toBeUndefined();
  const build = { kind: "production", id: "fixture-production-id" };
  await writeFile(path, JSON.stringify({ ...metadata(), build }));
  expect(
    (await loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }))
      .build,
  ).toEqual(build);
  for (const invalid of [
    null,
    { kind: "dev", id: "x" },
    { kind: "production", id: "" },
    { kind: "production", id: 3 },
  ]) {
    await writeFile(path, JSON.stringify({ ...metadata(), build: invalid }));
    await expect(
      loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }),
    ).rejects.toThrow(/invalid metadata/);
  }
  await writeFile(path, JSON.stringify({ ...metadata(), build }));
  const second = join(run, "second", "phone");
  await mkdir(second, { recursive: true });
  const secondMetadata = {
    ...metadata({ stage: "navigation", message: "failed" }),
    state: { id: "second" },
  };
  for (const variant of [
    undefined,
    { kind: "production", id: "different-build" },
  ]) {
    await writeFile(
      join(second, "metadata.json"),
      JSON.stringify({ ...secondMetadata, build: variant }),
    );
    await expect(
      loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }),
    ).rejects.toThrow(/disagree on production build/);
  }
  await writeFile(
    join(second, "metadata.json"),
    JSON.stringify({
      ...secondMetadata,
      build: { id: build.id, kind: build.kind },
    }),
  );
  expect(
    (await loadCaptureRun({ runDirectory: run, expectedFlow: "booking" }))
      .build,
  ).toEqual(build);
});

test("review headers name production builds conditionally", () => {
  const base = {
    flow: "booking",
    commit: "abc",
    findings: [],
    tuples: [],
    coverage: [],
    outcome: { kind: "deterministic-only" as const },
  };
  expect(renderReport(base)).not.toContain("Production build");
  expect(
    renderReviewHtmlReport({ ...base, screenshots: new Map() }),
  ).not.toContain("Production build");
  const build = { kind: "production" as const, id: "fixture-production-id" };
  expect(renderReport({ ...base, build })).toContain(
    "Production build: `fixture-production-id`",
  );
  expect(
    renderReviewHtmlReport({ ...base, build, screenshots: new Map() }),
  ).toContain("Production build: fixture-production-id");
});

test("latest production lookup skips a newer dev capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-latest-production-"));
  directories.push(directory);
  for (const [runId, production] of [
    ["2026-10-20T00-00-00-000Z", true],
    ["2026-10-21T00-00-00-000Z", false],
  ] as const) {
    const run = join(directory, ".idiom", "reports", runId);
    const tuple = join(run, "ready", "phone");
    await mkdir(tuple, { recursive: true });
    await writeFile(
      join(tuple, "metadata.json"),
      JSON.stringify({
        ...metadata(),
        ...(production ? { build: { kind: "production", id: "prod" } } : {}),
      }),
    );
    await writeFile(
      join(run, "baseline.md"),
      "Flow `booking`: 1 passed, 0 failed, 1 total.\n",
    );
  }
  expect(
    await findLatestCapture({
      projectDirectory: directory,
      flow: "booking",
      commit: "abc123",
    }),
  ).toBe("2026-10-21T00-00-00-000Z");
  expect(
    await findLatestCapture({
      projectDirectory: directory,
      flow: "booking",
      commit: "abc123",
      production: true,
    }),
  ).toBe("2026-10-20T00-00-00-000Z");
});

test("empty production runs retain run-level build identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-empty-production-"));
  directories.push(directory);
  const build = { kind: "production" as const, id: "empty-build" };
  await writeBaselineReport({
    stagingDirectory: directory,
    flow: flowSchema.parse({
      id: "empty",
      title: "Empty",
      intent: [],
      setup: [],
      states: [],
    }),
    tuples: [],
    build,
  });
  expect(
    await loadCaptureRun({ runDirectory: directory, expectedFlow: "empty" }),
  ).toMatchObject({ tuples: [], build });
  await writeFile(
    join(directory, "build.json"),
    JSON.stringify({ kind: "production" }),
  );
  await expect(
    loadCaptureRun({ runDirectory: directory, expectedFlow: "empty" }),
  ).rejects.toThrow(/invalid production build/);
});

test("painted skip counts render beside partial coverage reasons with escaping", () => {
  const options = {
    flow: "booking",
    commit: "fixture",
    findings: [],
    tuples: [],
    outcome: { kind: "full" as const },
    coverage: [
      {
        tuple: {
          flow: "booking",
          state: "ready",
          viewport: "phone",
          width: 390,
          height: 844,
          metadataPath: "m.json",
          artifactPaths: [],
          commit: "fixture",
          createdAt: "2026-10-26T00:00:00Z",
          console: [],
          mismatches: [],
        },
        coverage: {
          check: "orphan-word" as const,
          status: "ran" as const,
          reason: "partial <scan>",
          paintedSkipped: { "idiom:orphan-word": 2, "idiom:<test>": 0 },
        },
      },
    ],
  };
  const markdown = renderReport(options);
  const html = renderReviewHtmlReport({ ...options, screenshots: new Map() });
  expect(markdown).toContain("idiom:orphan-word: 2 skipped as not painted");
  expect(html).toContain(
    "partial &lt;scan&gt;; idiom:orphan-word: 2 skipped as not painted",
  );
  expect(html).toContain("idiom:&lt;test&gt;: 0 skipped as not painted");
  expect(
    JSON.parse(JSON.stringify(options.coverage))[0].coverage.paintedSkipped,
  ).toEqual({ "idiom:orphan-word": 2, "idiom:<test>": 0 });
});

test("coverage shows responsive-break not applicable off the minimum width and names only the responsive check", () => {
  const at = (viewport: string, width: number) => ({
    flow: "booking",
    state: "ready",
    viewport,
    width,
    height: 844,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-10-26T00:00:00Z",
    console: [],
    mismatches: [],
  });
  const phone = at("phone", 390);
  const desktop = at("desktop", 1280);
  const options = {
    flow: "booking",
    commit: "fixture",
    findings: [],
    tuples: [phone, desktop],
    narrowWidth: 390,
    outcome: { kind: "full" as const },
    coverage: [
      {
        tuple: phone,
        coverage: {
          check: "responsive-break" as const,
          status: "ran" as const,
        },
      },
      {
        tuple: desktop,
        coverage: {
          check: "responsive-break" as const,
          status: "not-applicable" as const,
          reason: "evaluated only at the minimum captured CSS width",
        },
      },
      {
        tuple: desktop,
        coverage: { check: "target-size" as const, status: "ran" as const },
      },
    ],
  };
  const markdown = renderReport(options);
  const html = renderReviewHtmlReport({ ...options, screenshots: new Map() });
  expect(markdown).toContain(
    "| ready | desktop | responsive-break | not applicable | evaluated only at the minimum captured CSS width |",
  );
  expect(markdown).toContain("| ready | phone | responsive-break | ran |  |");
  expect(markdown).toContain("| ready | desktop | target-size | ran |  |");
  expect(markdown).toContain(
    "The responsive check (responsive-break) runs only at the minimum captured CSS width, 390px (phone); at other viewports it is reported as not applicable.",
  );
  expect(html).toContain(
    "<tr><td>ready</td><td>desktop</td><td>responsive-break</td><td>not applicable</td><td>evaluated only at the minimum captured CSS width</td></tr>",
  );
  expect(html).toContain(
    "<tr><td>ready</td><td>phone</td><td>responsive-break</td><td>ran</td><td></td></tr>",
  );
  expect(html).toContain(
    "<tr><td>ready</td><td>desktop</td><td>target-size</td><td>ran</td><td></td></tr>",
  );
  expect(html).toContain(
    "The responsive check (responsive-break) runs only at the minimum captured CSS width, 390px; at other viewports it is reported as not applicable.",
  );
  for (const output of [markdown, html]) {
    const sentence = output.slice(output.indexOf("The responsive check"));
    expect(sentence.slice(0, sentence.indexOf("not applicable."))).not.toMatch(
      /target/,
    );
  }

  const empty = {
    ...options,
    tuples: [],
    coverage: [],
    narrowWidth: undefined,
  };
  for (const output of [
    renderReport(empty),
    renderReviewHtmlReport({ ...empty, screenshots: new Map() }),
  ]) {
    expect(output).toContain(
      "The responsive check was unavailable because the capture has no viewport tuples.",
    );
    expect(output).not.toContain("Responsive and target");
  }
});

async function reviewFixture(screenshotStates: readonly string[]) {
  const project = await mkdtemp(join(tmpdir(), "idiom-review-screens-"));
  directories.push(project);
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom", "flows", "booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: ["The primary action is obvious."],
      setup: [],
      viewports: ["mobile"],
      states: [
        { id: "ready", description: "Ready", url: "/", expect: {} },
        {
          id: "confirmed",
          description: "Confirmed",
          url: "/confirmed",
          expect: {},
        },
      ],
    }),
  );
  const runId = "2026-08-21T12-00-00-000Z";
  for (const state of ["ready", "confirmed"]) {
    const tuple = join(project, ".idiom", "reports", runId, state, "mobile");
    await mkdir(tuple, { recursive: true });
    await Promise.all([
      writeFile(
        join(tuple, "metadata.json"),
        JSON.stringify({
          ...metadata(
            screenshotStates.includes(state)
              ? null
              : { stage: "navigation", message: "navigation timed out" },
          ),
          state: { id: state, description: state },
          viewport: {
            name: "mobile",
            width: 390,
            height: 844,
            deviceScaleFactor: 2,
          },
          url: {
            kind: "literal",
            origin: "http://127.0.0.1:3107",
            url: `http://127.0.0.1:3107/${state}`,
          },
        }),
      ),
      ...(screenshotStates.includes(state)
        ? [writeFile(join(tuple, "screenshot.png"), "png")]
        : []),
      writeFile(join(tuple, "dom.html"), `<h1>${state}</h1>`),
      writeFile(join(tuple, "console.jsonl"), ""),
      writeFile(join(tuple, "axe.json"), JSON.stringify({ violations: [] })),
      writeFile(
        join(tuple, "observations.json"),
        JSON.stringify({
          ...observations,
          viewport: { width: 390, height: 844 },
          document: {
            scrollWidth: 390,
            scrollHeight: 844,
            clientWidth: 390,
            clientHeight: 844,
          },
        }),
      ),
    ]);
  }
  return { project, runId };
}

function recordingCritique(
  result: () => Promise<CritiqueResult> = async () => ({
    findings: [],
    decisionObservations: [],
    discardedDecisionObservations: 0,
  }),
) {
  const calls: CritiqueInput[] = [];
  return {
    calls,
    adapter: {
      async critique(input: CritiqueInput) {
        calls.push(input);
        return result();
      },
    },
  };
}

test("no reviewable screenshots helpers name the tuple count", () => {
  const tuple = (screenshotPath?: string) =>
    ({
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
    }) as CheckTuple;
  expect(hasReviewableScreenshot([])).toBe(false);
  expect(noReviewableScreenshotsOutcome([])).toEqual({
    kind: "degraded",
    reason:
      "no reviewable screenshots: 0 of 0 capture tuples produced a screenshot, so model critique did not run",
  });
  expect(hasReviewableScreenshot([tuple()])).toBe(false);
  const single = noReviewableScreenshotsOutcome([tuple()]);
  expect(single.kind === "degraded" && single.reason).toContain(
    "0 of 1 capture tuple produced",
  );
  expect(hasReviewableScreenshot([tuple(), tuple("a/screenshot.png")])).toBe(
    true,
  );
});

test("a capture with no screenshots degrades the model layer without a provider request", async () => {
  const { project, runId } = await reviewFixture([]);
  const critique = recordingCritique();
  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: { critique: critique.adapter },
  });
  expect(critique.calls).toHaveLength(0);
  expect(result.outcome).toEqual({
    kind: "degraded",
    reason: expect.stringContaining(NO_REVIEWABLE_SCREENSHOTS_REASON),
  });
  const reason =
    result.outcome.kind === "degraded" ? result.outcome.reason : "";
  expect(reason).toContain("0 of 2 capture tuples");
  for (const providerWording of ["credential", "network", "malformed"])
    expect(reason.toLowerCase()).not.toContain(providerWording);
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("# Degraded review:");
  expect(report).toContain("Model layer did not run");
  expect(report).not.toContain("# Full review:");

  const deterministic = await runReview({
    project,
    flow: "booking",
    from: runId,
    deterministicOnly: true,
  });
  expect(result.findingCount).toBe(deterministic.findingCount);
  expect(JSON.parse(await readFile(result.findingsPath, "utf8"))).toEqual(
    JSON.parse(await readFile(deterministic.findingsPath, "utf8")),
  );
});

test("a provider failure keeps its own degradation reason", async () => {
  const { project, runId } = await reviewFixture(["ready", "confirmed"]);
  const critique = recordingCritique(async () => {
    throw new Error("network down");
  });
  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: { critique: critique.adapter },
  });
  expect(critique.calls).toHaveLength(1);
  expect(result.outcome.kind).toBe("degraded");
  expect(
    result.outcome.kind === "degraded" ? result.outcome.reason : "",
  ).not.toContain(NO_REVIEWABLE_SCREENSHOTS_REASON);
});

test("one reviewable screenshot keeps the full model review", async () => {
  const { project, runId } = await reviewFixture(["ready"]);
  const critique = recordingCritique();
  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    dependencies: { critique: critique.adapter },
  });
  expect(critique.calls).toHaveLength(1);
  expect(critique.calls[0]?.screenshots).toHaveLength(1);
  expect(result.outcome).toEqual({ kind: "full" });
});

test("a sweep over a capture with no screenshots degrades without a provider request", async () => {
  const { project, runId } = await reviewFixture([]);
  const critique = recordingCritique();
  const result = await runReview({
    project,
    flow: "booking",
    from: runId,
    mode: "sweep",
    dependencies: { critique: critique.adapter },
  });
  expect(critique.calls).toHaveLength(0);
  expect(result.outcome).toEqual({
    kind: "degraded",
    reason: expect.stringContaining(NO_REVIEWABLE_SCREENSHOTS_REASON),
  });
});
