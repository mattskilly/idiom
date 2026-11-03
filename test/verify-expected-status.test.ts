import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runCapture } from "../src/capture/run.js";
import type {
  BrowserLauncher,
  ConsoleRecord,
  TupleResult,
} from "../src/capture/types.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import type { CheckTuple } from "../src/checks/types.js";
import { initProject } from "../src/commands/init.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { findingSchema } from "../src/schemas/finding.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { runVerify } from "../src/verify/run.js";
import { artifactV2, freePort, png } from "./verify-support.js";

// Wrap the real loader so every verify load path is observable.
vi.mock("../src/review/artifacts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/review/artifacts.js")>();
  return { ...actual, loadCaptureRun: vi.fn(actual.loadCaptureRun) };
});

const directories: string[] = [];
const documentLoadError =
  "Failed to load resource: the server responded with a status of 404 (Not Found)";

beforeEach(() => {
  vi.mocked(loadCaptureRun).mockClear();
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Expected non-200 states: a direct one, one whose declared URL redirects
// before answering, and one whose declared URL carries a fragment.
const expectedStates = ["missing", "moved", "anchored"];

// The document response URL as Chromium reports it: after redirects and
// without the fragment, which is never sent to the server.
function finalDocumentUrl(navigationUrl: string): string {
  const url = new URL(navigationUrl);
  url.hash = "";
  if (url.pathname === "/moved") url.pathname = "/moved-gone";
  return url.href;
}

// The browser's own record for an expected 404 document, plus two control
// errors: an unrelated script error and the same message on another resource.
// Chromium keeps the navigation's fragment on the document record's location.
// With provenance, a script requested from the document's own URL fails with
// a record identical to the document's in all but its request.
function documentStatusConsole(
  navigationUrl: string,
  status: number,
  provenance = false,
): ConsoleRecord[] {
  if (status === 200) return [];
  const fragment = new URL(navigationUrl).hash;
  const documentRecord: ConsoleRecord = {
    type: "error",
    text: documentLoadError,
    location: {
      url: `${finalDocumentUrl(navigationUrl)}${fragment}`,
      lineNumber: 0,
      columnNumber: 0,
    },
  };
  return [
    provenance
      ? {
          ...documentRecord,
          request: { resourceType: "document", mainFrame: true },
        }
      : documentRecord,
    ...(provenance
      ? [
          {
            ...documentRecord,
            request: { resourceType: "script", mainFrame: true },
          },
        ]
      : []),
    {
      type: "error",
      text: "booking widget failed to mount",
      location: {
        url: new URL("/app.js", navigationUrl).href,
        lineNumber: 3,
        columnNumber: 7,
      },
    },
    {
      type: "error",
      text: documentLoadError,
      location: {
        url: new URL("/missing.png", navigationUrl).href,
        lineNumber: 0,
        columnNumber: 0,
      },
      ...(provenance
        ? { request: { resourceType: "image", mainFrame: true } }
        : {}),
    },
  ];
}

function browserWithDocumentStatus(
  text: string,
  provenance = false,
): BrowserLauncher {
  return async () => ({
    version: "Mock Chromium",
    async capture(tuple): Promise<TupleResult> {
      const status = tuple.state.expect.status ?? 200;
      return {
        ok: true,
        status,
        documentUrl: finalDocumentUrl(tuple.navigationUrl),
        dom: `<html><body><main>${text}</main></body></html>`,
        screenshot: png(),
        console: documentStatusConsole(tuple.navigationUrl, status, provenance),
        ...(provenance ? { consoleProvenance: true } : {}),
        axe: { violations: [] },
        observations: artifactV2(text),
        mismatches: [],
        startedAt: "2026-08-15T12:00:00.000Z",
        endedAt: "2026-08-15T12:00:01.000Z",
      };
    },
    async close() {},
  });
}

async function expectedStatusFixture(provenance = false): Promise<{
  projectDirectory: string;
  baselineDirectory: string;
  spec: string;
}> {
  const projectDirectory = await mkdtemp(
    join(tmpdir(), "idiom-verify-status-"),
  );
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
      {
        id: "missing",
        description: "Missing booking",
        url: "/missing",
        expect: { status: 404 },
      },
      {
        id: "moved",
        description: "Moved booking",
        url: "/moved",
        expect: { status: 404 },
      },
      {
        id: "anchored",
        description: "Missing booking details",
        url: "/anchored#details",
        expect: { status: 404 },
      },
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
  const baseline = await runCapture({
    projectDirectory,
    project,
    flow,
    out: baselineDirectory,
    dependencies: {
      browserLauncher: browserWithDocumentStatus("Before", provenance),
      inheritedEnvironment: { PATH: process.env.PATH },
      snapshotSource: async () => ({ commit: "abc123", dirty: false }),
    },
  });
  expect(baseline.counts.failed).toBe(0);
  const embedded = expectedStates.map((state, index) =>
    findingSchema.parse({
      id: `IDM-run-000${index + 1}`,
      fingerprint: `fingerprint-${state}`,
      createdAt: "2026-08-15T12:00:00.000Z",
      commit: "abc123",
      flow: "booking",
      state,
      viewport: "desktop",
      layer: "model",
      category: "hierarchy",
      severity: "major",
      confidence: 0.8,
      rule: "Hierarchy is clear",
      evidence: { screenshots: [`${state}/desktop/screenshot.png`] },
      explanation: "The hierarchy is flat.",
      acceptance: ["The primary content is clear."],
      verification: { kind: "recapture-visual" },
      status: "open",
    }),
  );
  await writeFile(
    join(baselineDirectory, "findings.json"),
    JSON.stringify(embedded),
  );
  const spec = join(projectDirectory, "spec.md");
  await writeFile(
    spec,
    `# Fix\n\n${embedded
      .map(
        (finding) =>
          `\`\`\`idiom:finding\n${JSON.stringify(finding)}\n\`\`\`\n`,
      )
      .join("\n")}`,
  );
  return { projectDirectory, baselineDirectory, spec };
}

function stateTuple(
  tuples: CheckTuple[],
  label: string,
  id = "missing",
): CheckTuple {
  const tuple = tuples.find(({ state }) => state === id);
  expect(tuple, `${label}: ${id} tuple loaded`).toBeDefined();
  return tuple as CheckTuple;
}

const withoutFragment = (url: string) => url.split("#", 1)[0] ?? url;

function consoleErrorHints(tuple: CheckTuple): string[] {
  return runDeterministicChecks([tuple])
    .candidates.filter(
      ({ candidate }) => candidate.category === "console-error",
    )
    .map(({ candidate }) => candidate.selectorHint);
}

function expectOnlyControlErrors(tuple: CheckTuple, label: string): void {
  const response = tuple.documentResponse;
  const documentUrl = withoutFragment(
    response?.finalUrl ?? response?.url ?? "",
  );
  const hints = consoleErrorHints(tuple);
  expect(
    hints.filter(
      (hint) =>
        withoutFragment(hint.split(":0:0")[0] ?? "").endsWith(documentUrl) &&
        hint.includes("status of 404"),
    ),
    `${label}: expected document-load error is suppressed`,
  ).toEqual([]);
  expect(
    hints.filter((hint) => hint.includes("booking widget failed to mount")),
    `${label}: unrelated script error remains`,
  ).toHaveLength(1);
  expect(
    hints.filter(
      (hint) => hint.includes("/missing.png") && hint.includes("status of 404"),
    ),
    `${label}: same message on another resource remains`,
  ).toHaveLength(1);
}

test("every verify load receives expected-status context and suppresses only the expected document error", async () => {
  const { projectDirectory, baselineDirectory, spec } =
    await expectedStatusFixture();
  vi.mocked(loadCaptureRun).mockClear();

  await runVerify({
    flow: "booking",
    spec,
    project: projectDirectory,
    against: baselineDirectory,
    dependencies: {
      gitTopology: async () => undefined,
      capture: {
        browserLauncher: browserWithDocumentStatus("After"),
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "def456", dirty: false }),
      },
    },
  });

  const { calls, results } = vi.mocked(loadCaptureRun).mock;
  const loads = await Promise.all(
    calls.map(async ([options], index) => {
      const result = results[index];
      if (result?.type !== "return") throw new Error("load did not return");
      const runDirectory = options.runDirectory;
      const label =
        runDirectory === baselineDirectory
          ? "baseline"
          : basename(runDirectory);
      return { label, options, loaded: await result.value };
    }),
  );
  // Historical (filmstrip) and evaluation baseline loads, then A and B.
  expect(loads.map(({ label }) => label).sort()).toEqual([
    "baseline",
    "baseline",
    "current-a",
    "current-b",
  ]);

  const declared = {
    missing: { url: /\/missing$/, finalUrl: /\/missing$/ },
    moved: { url: /\/moved$/, finalUrl: /\/moved-gone$/ },
    anchored: { url: /\/anchored#details$/, finalUrl: /\/anchored$/ },
  };
  for (const { label, options, loaded } of loads) {
    for (const [id, urls] of Object.entries(declared)) {
      const at = `${label} ${id}`;
      expect(
        options.expectedStatusByState?.get(id),
        `${at}: expected-status context passed`,
      ).toBe(404);
      const tuple = stateTuple(loaded.tuples, label, id);
      expect(tuple.documentResponse, `${at}: document response`).toEqual({
        url: expect.stringMatching(urls.url),
        finalUrl: expect.stringMatching(urls.finalUrl),
        actualStatus: 404,
        expectedStatus: 404,
      });
      expect(
        tuple.console.some(
          (record) =>
            record.text === documentLoadError &&
            withoutFragment(record.location?.url ?? "") ===
              tuple.documentResponse?.finalUrl,
        ),
        `${at}: expected document-load record captured`,
      ).toBe(true);
      expectOnlyControlErrors(tuple, at);
    }
  }
});

test("full-flow verification reports no expected document-load error as new", async () => {
  const { projectDirectory, baselineDirectory, spec } =
    await expectedStatusFixture();

  const result = await runVerify({
    flow: "booking",
    spec,
    project: projectDirectory,
    against: baselineDirectory,
    fullFlow: true,
    dependencies: {
      gitTopology: async () => undefined,
      capture: {
        browserLauncher: browserWithDocumentStatus("After"),
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "def456", dirty: false }),
      },
    },
  });

  // The fake supplies observations for every tuple, so full-flow coverage
  // holds and evaluation produces newFindings rather than a diagnostic.
  expect(result.causes.join("\n")).not.toContain("disagree");
  expect(result.newFindings).toBeDefined();
  expect(
    (result.newFindings ?? []).filter(
      (record) =>
        record.category === "console-error" &&
        /\/(missing|moved|moved-gone|anchored)(#details)?:0:0/.test(
          record.selector,
        ),
    ),
  ).toEqual([]);
});

test("without expected-status context the document-load error surfaces", async () => {
  const { baselineDirectory } = await expectedStatusFixture();
  const { loadCaptureRun: realLoadCaptureRun } = await vi.importActual<
    typeof import("../src/review/artifacts.js")
  >("../src/review/artifacts.js");

  const loaded = await realLoadCaptureRun({
    runDirectory: baselineDirectory,
    expectedFlow: "booking",
  });

  const tuple = stateTuple(loaded.tuples, "no context");
  expect(tuple.documentResponse).toBeUndefined();
  const hints = consoleErrorHints(tuple);
  expect(
    hints.filter(
      (hint) => /\/missing:0:0/.test(hint) && hint.includes(documentLoadError),
    ),
  ).toHaveLength(1);
});

test("with provenance every verify load suppresses the document but reports its same-URL script", async () => {
  const { projectDirectory, baselineDirectory, spec } =
    await expectedStatusFixture(true);
  vi.mocked(loadCaptureRun).mockClear();

  await runVerify({
    flow: "booking",
    spec,
    project: projectDirectory,
    against: baselineDirectory,
    dependencies: {
      gitTopology: async () => undefined,
      capture: {
        browserLauncher: browserWithDocumentStatus("After", true),
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "def456", dirty: false }),
      },
    },
  });

  const { results } = vi.mocked(loadCaptureRun).mock;
  expect(results).toHaveLength(4);
  for (const [index, result] of results.entries()) {
    if (result?.type !== "return") throw new Error("load did not return");
    const label = `load ${index}`;
    const tuple = stateTuple((await result.value).tuples, label);
    expect(tuple.consoleProvenance, `${label}: provenance flag`).toBe(true);
    const documentUrl = tuple.documentResponse?.url as string;
    const sameUrl = tuple.console.filter(
      (record) =>
        record.text === documentLoadError &&
        record.location?.url === documentUrl,
    );
    expect(
      sameUrl.map((record) => record.request),
      `${label}: both same-URL records keep their provenance`,
    ).toEqual([
      { resourceType: "document", mainFrame: true },
      { resourceType: "script", mainFrame: true },
    ]);
    const { candidates } = runDeterministicChecks([tuple]);
    const reported = candidates.filter(
      ({ candidate }) =>
        candidate.category === "console-error" &&
        candidate.selectorHint ===
          `error | ${documentUrl}:0:0 | ${documentLoadError}`,
    );
    expect(
      reported,
      `${label}: only the script record is reported`,
    ).toHaveLength(1);
    expect(reported[0]?.candidate.explanation).not.toContain("recorded");
  }
});
