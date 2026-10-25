import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  cleanupWorkspace,
  createArtifactWorkspace,
  scanForSecrets,
  writeBaselineReport,
  writeTupleArtifacts,
} from "../src/capture/artifacts.js";
import { isPortOpen } from "../src/capture/process.js";
import {
  resolveStates,
  selectCaptureTuples,
  selectColorSchemes,
  selectViewports,
  snapshotSource,
} from "../src/capture/resolve.js";
import { runCapture, sanitizeDerivedResult } from "../src/capture/run.js";
import type {
  BrowserLauncher,
  BrowserTuple,
  TupleResult,
} from "../src/capture/types.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

import { productionFixture } from "./production-support.js";

const exampleDirectory = join(import.meta.dirname, "..", "examples", "booking");
const dataDirectoryPlaceholder = "$" + "{dataDir}";
const execFileAsync = promisify(execFile);

function emptyObservations(width = 800, height = 600) {
  return {
    version: 1 as const,
    viewport: { width, height },
    document: {
      scrollWidth: width,
      scrollHeight: height,
      clientWidth: width,
      clientHeight: height,
    },
    elements: [],
    headings: [],
    tokens: { status: "not-configured" as const },
  };
}

async function exampleRecords() {
  const project = projectSchema.parse(
    JSON.parse(
      await readFile(join(exampleDirectory, ".idiom", "project.json"), "utf8"),
    ),
  );
  const flow = flowSchema.parse(
    JSON.parse(
      await readFile(
        join(exampleDirectory, ".idiom", "flows", "booking.json"),
        "utf8",
      ),
    ),
  );
  const transcript = await readFile(
    join(
      import.meta.dirname,
      "..",
      "test",
      "fixtures",
      "booking",
      "seed-stdout.txt",
    ),
    "utf8",
  );
  return { project, flow, transcript };
}

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

async function initializeGitRepository(directory: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
  });
  await execFileAsync("git", ["config", "user.name", "Capture Test"], {
    cwd: directory,
  });
  await writeFile(join(directory, "tracked.txt"), "unchanged\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: directory });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: directory,
  });
}

async function normalizedArtifactTree(
  directory: string,
): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const key = relative(directory, path);
        if (entry.name === "run.json") {
          const record = JSON.parse(await readFile(path, "utf8"));
          record.timings.build.ms = 0;
          record.timings.start.ms = 0;
          record.timings.probe.ms = 0;
          for (const tuple of record.timings.tuples) {
            tuple.total.ms = 0;
            tuple.probe.ms = 0;
          }
          tree[key] = JSON.stringify(record);
        } else if (entry.name === "metadata.json") {
          const metadata = JSON.parse(await readFile(path, "utf8"));
          metadata.timestamps = {
            startedAt: "<timestamp>",
            endedAt: "<timestamp>",
          };
          tree[key] = JSON.stringify(metadata);
        } else {
          tree[key] = (await readFile(path)).toString("base64");
        }
      }
    }
  };
  await visit(directory);
  return tree;
}

describe("booking capture contract", () => {
  test("expands ordered state × viewport × scheme triples and honors flow narrowing", async () => {
    const records = await exampleRecords();
    const project = projectSchema.parse({
      ...records.project,
      colorSchemes: ["light", "dark"],
    });
    const flow = flowSchema.parse({
      ...records.flow,
      states: records.flow.states.slice(0, 2),
      viewports: ["mobile", "desktop"],
    });
    expect(selectColorSchemes(project, flow)).toEqual(["light", "dark"]);
    expect(
      selectCaptureTuples({ project, flow }).map(
        ({ state, viewport, colorScheme }) =>
          `${state.id}/${viewport.name}/${colorScheme}`,
      ),
    ).toEqual([
      `${flow.states[0]?.id}/mobile/light`,
      `${flow.states[0]?.id}/mobile/dark`,
      `${flow.states[0]?.id}/desktop/light`,
      `${flow.states[0]?.id}/desktop/dark`,
      `${flow.states[1]?.id}/mobile/light`,
      `${flow.states[1]?.id}/mobile/dark`,
      `${flow.states[1]?.id}/desktop/light`,
      `${flow.states[1]?.id}/desktop/dark`,
    ]);
    const narrowed = flowSchema.parse({ ...flow, colorSchemes: ["dark"] });
    expect(
      selectCaptureTuples({ project, flow: narrowed }).map(
        ({ colorScheme, colorSchemeAxis }) => [colorScheme, colorSchemeAxis],
      ),
    ).toEqual([
      ["dark", true],
      ["dark", true],
      ["dark", true],
      ["dark", true],
    ]);
  });

  test("resolves all 14 real states in declaration order across two viewports", async () => {
    const { project, flow, transcript } = await exampleRecords();
    const states = resolveStates({ project, flow, setupStdout: [transcript] });
    expect(states).toHaveLength(14);
    expect(states.every((state) => state.ok)).toBe(true);
    expect(
      states.map((state) => (state.ok ? state.value.state.id : "failed")),
    ).toEqual(flow.states.map((state) => state.id));
    expect(selectViewports(project, flow).map(({ name }) => name)).toEqual([
      "desktop",
      "mobile",
    ]);
    expect(states.length * selectViewports(project, flow).length).toBe(28);
    const notFound = states[6];
    expect(notFound?.ok && notFound.value.navigationUrl).toBe(
      "http://127.0.0.1:3107/b/nope/nope?tz=America/New_York",
    );
  });

  test("keeps random setup values ephemeral while provenance remains byte-stable", async () => {
    const { project, flow, transcript } = await exampleRecords();
    const changed = transcript.replaceAll(
      "wENwnDXjm_XEO3yr",
      "DIFFERENT_PRIVATE",
    );
    const first = resolveStates({ project, flow, setupStdout: [transcript] });
    const second = resolveStates({ project, flow, setupStdout: [changed] });
    const anonymousFirst = first[1];
    const anonymousSecond = second[1];
    expect(anonymousFirst?.ok && anonymousSecond?.ok).toBe(true);
    if (!(anonymousFirst?.ok && anonymousSecond?.ok)) return;
    expect(anonymousFirst.value.navigationUrl).not.toBe(
      anonymousSecond.value.navigationUrl,
    );
    expect(anonymousFirst.value.metadataUrl).toEqual(
      anonymousSecond.value.metadataUrl,
    );
    expect(anonymousFirst.value.metadataUrl).toMatchObject({
      template:
        "http://127.0.0.1:3107/{setup-stdout:valid-anonymous}?tz=America/New_York",
    });
    expect(JSON.stringify(anonymousFirst.value.metadataUrl)).not.toContain(
      "wENwnDXjm_XEO3yr",
    );
  });

  test("records URL resolution failures and refuses external origins", async () => {
    const { project, flow } = await exampleRecords();
    const missing = resolveStates({ project, flow, setupStdout: ["nothing"] });
    expect(missing[0]).toMatchObject({ ok: false });

    const external = flowSchema.parse({
      ...flow,
      states: [
        {
          id: "external",
          description: "must stay local",
          url: "https://example.com/",
          expect: {},
        },
      ],
    });
    expect(
      resolveStates({ project, flow: external, setupStdout: [] })[0],
    ).toMatchObject({ ok: false });
  });
});

test("artifact publication inputs are stable apart from timestamps", async () => {
  const { flow, project } = await exampleRecords();
  const workspace = await createArtifactWorkspace({
    projectDirectory: exampleDirectory,
    out: join(exampleDirectory, ".idiom", "reports", "artifact-test"),
  });
  const state = flow.states[6];
  const viewport = project.viewports[0];
  if (state === undefined || viewport === undefined) {
    throw new Error("example state or viewport missing");
  }
  const tuple = {
    flow,
    state,
    viewport,
    metadataUrl: {
      kind: "literal" as const,
      origin: "http://127.0.0.1:3107",
      url: "http://127.0.0.1:3107/b/nope/nope?tz=America/New_York",
    },
    result: {
      ok: true as const,
      status: 404,
      dom: "<html>stable</html>",
      screenshot: Buffer.from("stable-png"),
      console: [],
      axe: { violations: [] },
      observations: emptyObservations(viewport.width, viewport.height),
      mismatches: [],
      startedAt: "2026-08-14T12:00:00.000Z",
      endedAt: "2026-08-14T12:00:01.000Z",
    },
  };
  try {
    await writeTupleArtifacts({
      stagingDirectory: workspace.stagingDirectory,
      tuple,
      source: { commit: "abc123", dirty: false },
      browserVersion: "Chromium 1",
      fallbackTimestamp: "unused",
    });
    const counts = await writeBaselineReport({
      stagingDirectory: workspace.stagingDirectory,
      flow,
      tuples: [tuple],
    });
    expect(counts).toEqual({ passed: 1, failed: 0, total: 1 });
    const path = join(
      workspace.stagingDirectory,
      state.id,
      viewport.name,
      "metadata.json",
    );
    const first = JSON.parse(await readFile(path, "utf8"));
    tuple.result.startedAt = "2026-08-14T13:00:00.000Z";
    tuple.result.endedAt = "2026-08-14T13:00:01.000Z";
    await writeTupleArtifacts({
      stagingDirectory: workspace.stagingDirectory,
      tuple,
      source: { commit: "abc123", dirty: false },
      browserVersion: "Chromium 1",
      fallbackTimestamp: "unused",
    });
    const second = JSON.parse(await readFile(path, "utf8"));
    first.timestamps = { startedAt: "changed", endedAt: "changed" };
    second.timestamps = { startedAt: "changed", endedAt: "changed" };
    expect(first).toEqual(second);
    expect(
      await readFile(join(workspace.stagingDirectory, "baseline.md"), "utf8"),
    ).toContain("[screenshot.png](not-found/desktop/screenshot.png)");
    expect(
      await readFile(join(workspace.stagingDirectory, "baseline.md"), "utf8"),
    ).toContain("[observations.json](not-found/desktop/observations.json)");
  } finally {
    await cleanupWorkspace(workspace);
  }
});

test("axis artifact writes round-trip through three-level capture discovery", async () => {
  const { flow, project } = await exampleRecords();
  const directory = await mkdtemp(join(tmpdir(), "idiom-axis-artifacts-"));
  const state = flow.states[6];
  const viewport = project.viewports[0];
  if (state === undefined || viewport === undefined) {
    throw new Error("example state or viewport missing");
  }
  const makeTuple = (colorScheme: "light" | "dark") => ({
    flow,
    state,
    viewport,
    colorScheme,
    colorSchemeAxis: true,
    metadataUrl: {
      kind: "literal" as const,
      origin: "http://127.0.0.1:3107",
      url: "http://127.0.0.1:3107/b/nope/nope?tz=America/New_York",
    },
    result: {
      ok: true as const,
      status: 404,
      dom: `<html data-color-scheme="${colorScheme}"></html>`,
      screenshot: Buffer.from(`${colorScheme}-png`),
      console: [],
      axe: { violations: [] },
      observations: emptyObservations(viewport.width, viewport.height),
      mismatches: [],
      startedAt: "2026-08-14T12:00:00.000Z",
      endedAt: "2026-08-14T12:00:01.000Z",
    },
  });

  try {
    for (const colorScheme of ["light", "dark"] as const) {
      await writeTupleArtifacts({
        stagingDirectory: directory,
        tuple: makeTuple(colorScheme),
        source: { commit: "abc123", dirty: false },
        browserVersion: "Chromium 1",
        fallbackTimestamp: "unused",
      });
    }

    const loaded = await loadCaptureRun({
      runDirectory: directory,
      expectedFlow: flow.id,
      stateOrder: [state.id],
      viewportOrder: [viewport.name],
      colorSchemeOrder: ["dark", "light"],
      legacyColorScheme: "light",
    });
    expect(
      loaded.tuples.map(({ colorScheme, colorSchemeAxis, metadataPath }) => ({
        colorScheme,
        colorSchemeAxis,
        metadataPath,
      })),
    ).toEqual([
      {
        colorScheme: "dark",
        colorSchemeAxis: true,
        metadataPath: `${state.id}/${viewport.name}/dark/metadata.json`,
      },
      {
        colorScheme: "light",
        colorSchemeAxis: true,
        metadataPath: `${state.id}/${viewport.name}/light/metadata.json`,
      },
    ]);
    await expect(
      access(join(directory, state.id, viewport.name, "metadata.json")),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("setup-derived private URLs are redacted from every textual browser artifact", () => {
  const navigationUrl =
    "http://127.0.0.1:3107/book/jane/private-slug?tz=America/New_York";
  const metadataUrl = {
    kind: "setup-stdout" as const,
    origin: "http://127.0.0.1:3107",
    source: "setup-stdout" as const,
    pattern: "URL (\\S+)",
    append: "?tz=America/New_York",
    template: "http://127.0.0.1:3107/{setup-stdout:state}?tz=America/New_York",
  };
  const result = sanitizeDerivedResult(
    {
      ok: true,
      status: 200,
      dom: '<form action="/book/jane/private-slug"></form>',
      screenshot: Buffer.from("png"),
      console: [
        {
          type: "log",
          text: navigationUrl,
          location: { url: navigationUrl, lineNumber: 1, columnNumber: 1 },
        },
      ],
      axe: { url: navigationUrl, html: "/book/jane/private-slug" },
      observations: {
        ...emptyObservations(),
        headings: [
          {
            selector: "h1",
            level: 1,
            text: "/book/jane/private-slug",
          },
        ],
      },
      mismatches: [],
      startedAt: "start",
      endedAt: "end",
    },
    navigationUrl,
    metadataUrl,
  );
  expect(JSON.stringify(result)).not.toContain("private-slug");
  expect(JSON.stringify(result)).toContain("setup-stdout:state");
});

test("secret scanning covers text, JSON, and binary bytes before publication", async () => {
  const workspace = await createArtifactWorkspace({
    projectDirectory: exampleDirectory,
    out: join(exampleDirectory, ".idiom", "reports", "secret-test"),
  });
  try {
    await writeFile(
      join(workspace.stagingDirectory, "binary.png"),
      Buffer.from([0, 1, ...Buffer.from("private-value"), 2]),
    );
    await expect(
      scanForSecrets(workspace.stagingDirectory, [
        { SERVICE_TOKEN: "developer-shell-value" },
        { SERVICE_TOKEN: "private-value" },
      ]),
    ).rejects.toThrow("SERVICE_TOKEN in binary.png");
    await expect(access(workspace.finalDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await cleanupWorkspace(workspace);
  }
});

test("baseline report keeps multiline failures inside one Markdown table row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-report-"));
  const flow = flowSchema.parse({
    id: "report",
    title: "Report",
    intent: [],
    setup: [],
    states: [
      { id: "broken", description: "Broken", url: "/broken", expect: {} },
      { id: "later", description: "Later", url: "/later", expect: {} },
    ],
  });
  const viewport = { name: "desktop", width: 800, height: 600 };
  const broken = flow.states[0];
  const later = flow.states[1];
  if (broken === undefined || later === undefined)
    throw new Error("missing state");
  try {
    await writeBaselineReport({
      stagingDirectory: directory,
      flow,
      tuples: [
        {
          flow,
          state: broken,
          viewport,
          result: {
            ok: false,
            stage: "navigation",
            message:
              "page.goto: net::ERR_CONNECTION_REFUSED\nCall log:\n  - navigating to local URL",
            console: [],
            mismatches: [],
            startedAt: "start",
            endedAt: "end",
          },
        },
        {
          flow,
          state: later,
          viewport,
          resolutionFailure: "still listed",
        },
      ],
    });
    const report = await readFile(join(directory, "baseline.md"), "utf8");
    expect(report).toContain(
      "failed: page.goto: net::ERR_CONNECTION_REFUSED<br>Call log:<br>  - navigating",
    );
    expect(
      report.split("\n").filter((line) => line.startsWith("| broken")),
    ).toHaveLength(1);
    expect(
      report.split("\n").filter((line) => line.startsWith("| later")),
    ).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two full captures remain equivalent and ignore prior managed reports in source identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-two-runs-"));
  const projectDirectory = join(directory, "project");
  await mkdir(projectDirectory, { recursive: true });
  await initializeGitRepository(projectDirectory);
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
      // Byte-identical artifact trees need the same served origin each run.
      fixedPort: true,
      env: { PORT: String(port) },
      startupTimeoutMs: 5_000,
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "derived",
    title: "Derived",
    intent: [],
    setup: [
      {
        run: `node -e "process.stdout.write('URL /book/' + process.env.SEED_SLUG + '\\n')"`,
        captureStdout: true,
      },
    ],
    states: [
      {
        id: "state",
        description: "Derived state",
        urlFrom: { source: "setup-stdout", pattern: "URL (\\S+)" },
        expect: {},
      },
    ],
  });
  const navigations: string[] = [];
  let runNumber = 0;
  const browserLauncher: BrowserLauncher = async () => ({
    version: "Mock Chromium",
    async capture(tuple): Promise<TupleResult> {
      navigations.push(tuple.navigationUrl);
      return {
        ok: true,
        status: 200,
        dom: "<html>stable</html>",
        screenshot: Buffer.from("stable-png"),
        console: [],
        axe: { violations: [] },
        mismatches: [],
        startedAt: `2026-08-14T1${runNumber}:00:00.000Z`,
        endedAt: `2026-08-14T1${runNumber}:00:01.000Z`,
      };
    },
    async close() {},
  });
  try {
    runNumber = 2;
    const first = await runCapture({
      projectDirectory,
      project,
      flow,
      dependencies: {
        browserLauncher,
        inheritedEnvironment: {
          PATH: process.env.PATH,
          SEED_SLUG: "first-private-value",
        },
        now: () => new Date("2026-08-14T12:00:00.000Z"),
      },
    });
    const afterFirst = await snapshotSource(projectDirectory, {
      excludedPaths: [join(projectDirectory, ".idiom", "reports")],
    });
    expect(afterFirst.dirty).toBe(false);
    await writeFile(
      join(projectDirectory, ".idiom", "reports", "system.html"),
      "<!doctype html><title>Generated system page</title>",
    );
    const afterSystemPage = await snapshotSource(projectDirectory, {
      excludedPaths: [join(projectDirectory, ".idiom", "reports")],
    });
    expect(afterSystemPage.dirty).toBe(false);
    runNumber = 3;
    const second = await runCapture({
      projectDirectory,
      project,
      flow,
      dependencies: {
        browserLauncher,
        inheritedEnvironment: {
          PATH: process.env.PATH,
          SEED_SLUG: "second-private-value",
        },
        now: () => new Date("2026-08-14T13:00:00.000Z"),
      },
    });
    expect(navigations).toEqual([
      `http://127.0.0.1:${port}/book/first-private-value`,
      `http://127.0.0.1:${port}/book/second-private-value`,
    ]);
    expect(await normalizedArtifactTree(first.runDirectory)).toEqual(
      await normalizedArtifactTree(second.runDirectory),
    );
    const firstMetadata = JSON.parse(
      await readFile(
        join(first.runDirectory, "state", "desktop", "metadata.json"),
        "utf8",
      ),
    );
    const secondMetadata = JSON.parse(
      await readFile(
        join(second.runDirectory, "state", "desktop", "metadata.json"),
        "utf8",
      ),
    );
    expect(firstMetadata.source.dirty).toBe(false);
    expect(secondMetadata.source.dirty).toBe(false);
    expect(JSON.stringify(secondMetadata)).not.toContain(
      "second-private-value",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filtered capture preserves exact manifest-ordered tuple pairs without cross-products", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-filtered-capture-"));
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
    viewports: [
      { name: "desktop", width: 800, height: 600 },
      { name: "mobile", width: 390, height: 844 },
    ],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "filtered",
    title: "Filtered",
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
  const captured: string[] = [];
  const browserLauncher: BrowserLauncher = async () => ({
    version: "Mock Chromium",
    async capture(tuple): Promise<TupleResult> {
      captured.push(`${tuple.state.id}/${tuple.viewport.name}`);
      return {
        ok: true,
        status: 200,
        dom: "<html></html>",
        screenshot: Buffer.from("png"),
        console: [],
        axe: { violations: [] },
        observations: emptyObservations(
          tuple.viewport.width,
          tuple.viewport.height,
        ),
        mismatches: [],
        startedAt: "2026-08-15T12:00:00.000Z",
        endedAt: "2026-08-15T12:00:01.000Z",
      };
    },
    async close() {},
  });
  try {
    await runCapture({
      projectDirectory: directory,
      project,
      flow,
      out: join(directory, "out"),
      tuples: [
        { state: "taken", viewport: "mobile" },
        { state: "confirmed", viewport: "desktop" },
        { state: "taken", viewport: "mobile" },
      ],
      dependencies: {
        browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "abc123", dirty: false }),
      },
    });
    expect(captured).toEqual(["confirmed/desktop", "taken/mobile"]);
    expect(captured).not.toContain("confirmed/mobile");
    expect(captured).not.toContain("taken/desktop");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repo-internal explicit output must be managed or gitignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-output-source-"));
  await initializeGitRepository(directory);
  const unsafeOut = join(directory, "capture-output");
  try {
    await expect(
      snapshotSource(directory, {
        excludedPaths: [unsafeOut],
        explicitOutputPath: unsafeOut,
      }),
    ).rejects.toThrow("repo-internal --out must be gitignored");
    await writeFile(join(directory, ".gitignore"), "capture-output/\n");
    await expect(
      snapshotSource(directory, {
        excludedPaths: [unsafeOut],
        explicitOutputPath: unsafeOut,
      }),
    ).resolves.toMatchObject({ dirty: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("teardown rejection still removes the exact data and staging directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-cleanup-"));
  const stagingDirectory = join(directory, "staging");
  const dataDirectory = join(directory, "data");
  const finalDirectory = join(directory, "final");
  await mkdir(stagingDirectory, { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
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
      env: { PORT: String(port), IGNORE_TERM: "1" },
      startupTimeoutMs: 5_000,
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "cleanup",
    title: "Cleanup",
    intent: [],
    setup: [],
    states: [{ id: "state", description: "State", url: "/", expect: {} }],
  });
  const browserLauncher: BrowserLauncher = async () => {
    throw new Error("browser launch failed");
  };
  try {
    await expect(
      runCapture({
        projectDirectory: directory,
        project,
        flow,
        out: finalDirectory,
        dependencies: {
          browserLauncher,
          inheritedEnvironment: { PATH: process.env.PATH },
          snapshotSource: async () => ({ commit: "abc123", dirty: false }),
          createArtifactWorkspace: async () => ({
            finalDirectory,
            stagingDirectory,
            dataDirectory,
          }),
          process: { teardownTimeoutMs: 0 },
        },
      }),
    ).rejects.toThrow("browser launch failed");
    await expect(access(stagingDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(dataDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(finalDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("orchestration continues after a failed tuple and releases the server port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-capture-run-"));
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
      env: { PORT: String(port), DATA: dataDirectoryPlaceholder },
      startupTimeoutMs: 5_000,
    },
    viewports: [{ name: "desktop", width: 800, height: 600 }],
    capture: {},
    design: { tokensFile: "theme.css" },
    model: { provider: "anthropic", model: "unused" },
  });
  await writeFile(
    join(directory, "theme.css"),
    ":root { --ink: light-dark(#101210, #ebeEeb); }\n",
  );
  const flow = flowSchema.parse({
    id: "flow",
    title: "Fixture flow",
    intent: [],
    setup: [],
    states: [
      { id: "first", description: "fails", url: "/first", expect: {} },
      { id: "second", description: "passes", url: "/second", expect: {} },
      {
        id: "unresolved",
        description: "explicit URL failure",
        urlFrom: { source: "setup-stdout", pattern: "MISSING (\\S+)" },
        expect: {},
      },
    ],
  });
  let captures = 0;
  const capturedTokens: BrowserTuple["tokens"][] = [];
  let browserClosed = false;
  const browserLauncher: BrowserLauncher = async () => ({
    version: "Mock Chromium",
    async capture(tuple): Promise<TupleResult> {
      captures += 1;
      capturedTokens.push(tuple.tokens);
      return {
        ok: true,
        status: 200,
        dom: `<html>${captures}</html>`,
        screenshot: Buffer.from(`png-${captures}`),
        console: [],
        axe: { violations: [] },
        mismatches:
          captures === 1 ? [{ kind: "text-present", expected: "missing" }] : [],
        startedAt: "2026-08-14T12:00:00.000Z",
        endedAt: "2026-08-14T12:00:01.000Z",
      };
    },
    async close() {
      browserClosed = true;
    },
  });
  const out = join(directory, "run");
  try {
    const result = await runCapture({
      projectDirectory: directory,
      project,
      flow,
      out,
      dependencies: {
        browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        snapshotSource: async () => ({ commit: "abc123", dirty: false }),
      },
    });
    expect(result.counts).toEqual({ passed: 1, failed: 2, total: 3 });
    expect(captures).toBe(2);
    expect(capturedTokens).toMatchObject([
      {
        status: "configured",
        source: "theme.css",
        declarations: { "--ink": "light-dark(#101210, #ebeEeb)" },
        values: ["light-dark(#101210, #ebeEeb)"],
      },
      {
        status: "configured",
        source: "theme.css",
        declarations: { "--ink": "light-dark(#101210, #ebeEeb)" },
        values: ["light-dark(#101210, #ebeEeb)"],
      },
    ]);
    expect(capturedTokens[0]).toBe(capturedTokens[1]);
    expect(browserClosed).toBe(true);
    expect(await isPortOpen(port)).toBe(false);
    expect(await readFile(join(out, "baseline.md"), "utf8")).toContain(
      "first | desktop | failed",
    );
    for (const state of ["first", "second"]) {
      for (const artifact of [
        "screenshot.png",
        "dom.html",
        "console.jsonl",
        "axe.json",
        "metadata.json",
      ]) {
        await expect(
          access(join(out, state, "desktop", artifact)),
        ).resolves.toBeUndefined();
      }
    }
    const unresolvedMetadata = JSON.parse(
      await readFile(
        join(out, "unresolved", "desktop", "metadata.json"),
        "utf8",
      ),
    );
    expect(unresolvedMetadata).toMatchObject({
      url: {
        kind: "unresolved",
        declaration: {
          urlFrom: { source: "setup-stdout", pattern: "MISSING (\\S+)" },
        },
      },
      status: null,
      failure: { stage: "url-resolution" },
    });
    await expect(
      access(join(out, "unresolved", "desktop", "screenshot.png")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(out, "baseline.md"), "utf8")).toContain(
      "unresolved | desktop | failed: setup stdout did not match",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production resolver rebases exact original origins and preserves URL components", async () => {
  const { project: original, flow: base } = await exampleRecords();
  const project = {
    ...original,
    server: {
      ...original.server,
      readyUrl: "http://127.0.0.1:45678/",
      port: 45678,
    },
  };
  const originalReadyUrl = "http://127.0.0.1:3107/";
  for (const url of [
    "/private?q=value#hash",
    "http://127.0.0.1:3107/private?q=value#hash",
    "http://127.0.0.1:45678/private?q=value#hash",
  ]) {
    for (const derived of [false, true]) {
      const flow = flowSchema.parse({
        ...base,
        states: [
          {
            id: "url",
            description: "URL",
            expect: {},
            ...(derived
              ? {
                  urlFrom: {
                    source: "setup-stdout",
                    pattern: "URL=(.*)",
                    append: "-suffix",
                  },
                }
              : { url }),
          },
        ],
      });
      const [result] = resolveStates({
        project,
        flow,
        originalReadyUrl,
        setupStdout: [`URL=${url}`],
      });
      expect(result?.ok).toBe(true);
      if (!result?.ok) throw new Error("resolution failed");
      expect(result.value.navigationUrl).toBe(
        `http://127.0.0.1:45678/private?q=value#hash${derived ? "-suffix" : ""}`,
      );
      expect(result.value.metadataUrl.origin).toBe("http://127.0.0.1:45678");
      if (derived) {
        expect(JSON.stringify(result.value.metadataUrl)).not.toContain(
          "private",
        );
        expect(result.value.metadataUrl).toMatchObject({
          template: "http://127.0.0.1:45678/{setup-stdout:url}-suffix",
          append: "-suffix",
          pattern: "URL=(.*)",
        });
      }
    }
  }
  for (const url of [
    "https://example.com/private",
    "http://localhost:3107/private",
    "http://127.0.0.1:3108/private",
  ]) {
    for (const derived of [false, true]) {
      const flow = flowSchema.parse({
        ...base,
        states: [
          {
            id: "url",
            description: "URL",
            expect: {},
            ...(derived
              ? { urlFrom: { source: "setup-stdout", pattern: "URL=(.*)" } }
              : { url }),
          },
        ],
      });
      expect(
        resolveStates({
          project,
          flow,
          originalReadyUrl,
          setupStdout: [`URL=${url}`],
        })[0],
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining("does not match local server origin"),
      });
    }
  }
  const flow = flowSchema.parse({
    ...base,
    states: [
      {
        id: "url",
        description: "URL",
        url: "http://127.0.0.1:3107/private",
        expect: {},
      },
    ],
  });
  expect(resolveStates({ project, flow, setupStdout: [] })[0]).toMatchObject({
    ok: false,
  });
});

test.each([false, true])(
  "production captures the built client on its selected port (flow default %s)",
  async (defaultMode) => {
    const f = await productionFixture();
    try {
      const flow = flowSchema.parse({
        ...f.flow,
        ...(defaultMode ? { server: "production" } : {}),
        states: [
          ...f.flow.states,
          {
            id: "absolute",
            description: "Original absolute origin",
            url: `${f.project.server.readyUrl}page?q=literal#hash`,
            expect: { textPresent: ["CLIENT API OK"] },
          },
        ],
      });
      await mkdir(join(f.directory, "production-output"));
      await writeFile(join(f.directory, "production-output", "old"), "keep");
      const result = await runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow,
        prod: !defaultMode,
      });
      expect(result.counts).toEqual({ passed: 2, failed: 0, total: 2 });
      expect(result.build).toEqual({
        kind: "production",
        id: "fixture-production-id",
      });
      const audit = await f.audit();
      const built = audit[0];
      if (built === undefined) throw new Error("no build audit");
      expect(audit.map((entry) => entry.phase)).toEqual(["build", "start"]);
      expect(audit[0]?.port).not.toBe(String(f.project.server.port));
      expect(audit[0]?.data).toBe(audit[1]?.data);
      await expect(access(built.data)).rejects.toThrow();
      expect(await isPortOpen(Number(audit[0]?.port))).toBe(false);
      const dom = await readFile(
        join(result.runDirectory, "home", "desktop", "dom.html"),
        "utf8",
      );
      expect(dom).toContain("PRODUCTION MARKER");
      expect(dom).toContain("CLIENT API OK");
      expect(dom).not.toContain("DEVELOPMENT MARKER");
      const metadata = JSON.parse(
        await readFile(
          join(result.runDirectory, "absolute", "desktop", "metadata.json"),
          "utf8",
        ),
      );
      expect(metadata.url).toEqual({
        kind: "literal",
        origin: `http://127.0.0.1:${audit[0]?.port}`,
        url: `http://127.0.0.1:${audit[0]?.port}/page?q=literal#hash`,
        canonicalOrigin: new URL(f.project.server.readyUrl).origin,
      });
      expect(metadata.build).toEqual(result.build);
      expect(
        await readFile(join(result.runDirectory, "baseline.md"), "utf8"),
      ).toContain("Production build: `fixture-production-id`");
      expect(await readdir(join(f.directory, "production-output"))).toEqual([
        "old",
      ]);
      expect(
        (
          await loadCaptureRun({
            runDirectory: result.runDirectory,
            expectedFlow: "fixture",
          })
        ).build,
      ).toEqual(result.build);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.each([
  "production-only-sensitive-value",
  `secret-${dataDirectoryPlaceholder}`,
])(
  "production-only secret scanning prevents publication (%s)",
  async (secret) => {
    const f = await productionFixture({ SESSION_SECRET: secret });
    delete f.project.server.env.SESSION_SECRET;
    const out = join(f.directory, ".idiom", "reports", "rejected-run");
    try {
      const error = await runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow: f.flow,
        prod: true,
        out,
        dependencies: { inheritedEnvironment: { PATH: process.env.PATH } },
      }).catch((error: unknown) => error);
      expect(String(error)).toMatch(
        /secret scan found SESSION_SECRET.*no capture was published/,
      );
      const audit = await f.audit();
      const built = audit[0];
      if (built === undefined) throw new Error("no build audit");
      expect(String(error)).not.toContain(
        secret.replace(dataDirectoryPlaceholder, built.data),
      );
      expect(await isPortOpen(Number(audit[0]?.port))).toBe(false);
      await expect(access(built.data)).rejects.toThrow();
      await expect(access(out)).rejects.toThrow();
      await expect(
        access(join(f.directory, "production-output")),
      ).rejects.toThrow();
      expect(
        (await readdir(f.directory)).filter(
          (name) =>
            name.includes("staging") || name.startsWith(".idiom-production-"),
        ),
      ).toEqual([]);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "rebased setup URLs stay private in successful and failed tuple artifacts (%s)",
  async (failTuple) => {
    const f = await productionFixture();
    try {
      const privateUrl = `${f.project.server.readyUrl}private-booking?q=private-token&other=value#hash`;
      const flow = flowSchema.parse({
        ...f.flow,
        setup: [
          {
            run: "node -e 'console.log(process.env.SETUP_URL)'",
            captureStdout: true,
            env: { SETUP_URL: privateUrl },
          },
        ],
        states: [
          {
            id: "derived",
            description: "Derived",
            urlFrom: {
              source: "setup-stdout",
              pattern: "(http[^\\s]+)",
              append: "-suffix",
            },
            expect: {},
          },
        ],
      });
      let effective = "";
      const result = await runCapture({
        projectDirectory: f.directory,
        project: f.project,
        flow,
        prod: true,
        dependencies: {
          browserLauncher: async () => ({
            version: "Fixture browser",
            close: async () => {},
            capture: async (tuple) => {
              effective = tuple.navigationUrl;
              expect(effective).toMatch(
                /\/private-booking\?q=private-token&other=value#hash-suffix$/,
              );
              expect(new URL(effective).port).not.toBe(
                String(f.project.server.port),
              );
              expect(await (await fetch(effective)).text()).toContain(
                "PRODUCTION MARKER",
              );
              const echo = `${privateUrl}-suffix ${effective} ${effective.replaceAll("&", "&amp;")} ${`${privateUrl}-suffix`.replaceAll("&", "&amp;")}`;
              const common = {
                dom: echo,
                screenshot: Buffer.from("png"),
                console: [
                  {
                    type: "log",
                    text: echo,
                    location: {
                      url: `${privateUrl}-suffix`,
                      lineNumber: 1,
                      columnNumber: 1,
                    },
                  },
                ],
                axe: { violations: [], echo },
                observations: {
                  ...emptyObservations(),
                  headings: [{ selector: "h1", level: 1, text: echo }],
                },
                mismatches: [],
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                status: 200,
              };
              return failTuple
                ? { ...common, ok: false, stage: "navigation", message: echo }
                : { ...common, ok: true };
            },
          }),
        },
      });
      expect(result.counts.failed).toBe(failTuple ? 1 : 0);
      const path = join(result.runDirectory, "derived", "desktop");
      const metadata = await readFile(join(path, "metadata.json"), "utf8");
      const files = [
        "metadata.json",
        "dom.html",
        "console.jsonl",
        "axe.json",
        "observations.json",
      ];
      for (const file of files) {
        const text = await readFile(join(path, file), "utf8");
        expect(text, file).not.toContain("private-booking");
        expect(text, file).not.toContain("private-token");
        // Derived text is canonicalized to the configured origin; only the
        // metadata keeps the served origin as provenance.
        if (file !== "metadata.json")
          expect(text, file).not.toContain(new URL(effective).origin);
      }
      expect(JSON.parse(metadata).url.canonicalOrigin).toBe(
        new URL(f.project.server.readyUrl).origin,
      );
      expect(metadata).not.toContain("sanitizationAliases");
      expect(metadata).toContain(new URL(effective).origin);
      expect(
        await readFile(join(result.runDirectory, "baseline.md"), "utf8"),
      ).not.toContain("private-token");
      expect(
        (
          await loadCaptureRun({
            runDirectory: result.runDirectory,
            expectedFlow: "fixture",
          })
        ).tuples,
      ).toHaveLength(1);
      const audit = await f.audit();
      const built = audit[0];
      if (built === undefined) throw new Error("no build audit");
      expect(await isPortOpen(Number(audit[0]?.port))).toBe(false);
      await expect(access(built.data)).rejects.toThrow();
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test("SIGTERM during a production build cleans the process, data, output and reserved port", async () => {
  const f = await productionFixture({ HANG_BUILD: "1" });
  try {
    const capture = runCapture({
      projectDirectory: f.directory,
      project: f.project,
      flow: f.flow,
      prod: true,
      out: join(f.directory, ".idiom", "reports", "interrupted"),
      dependencies: { process: { teardownTimeoutMs: 50 } },
    });
    const rejected = expect(capture).rejects.toThrow(/interrupted/);
    let audit: Awaited<ReturnType<typeof f.audit>> = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      audit = await f.audit().catch(() => []);
      if (audit.length) break;
      await new Promise((accept) => setTimeout(accept, 10));
    }
    expect(audit).toHaveLength(1);
    const built = audit[0];
    if (built === undefined) throw new Error("no build audit");
    process.emit("SIGTERM");
    await rejected;
    expect(() => process.kill(built.pid, 0)).toThrow();
    expect(await isPortOpen(Number(audit[0]?.port))).toBe(false);
    await expect(access(built.data)).rejects.toThrow();
    await expect(
      access(join(f.directory, "production-output")),
    ).rejects.toThrow();
    await expect(
      access(join(f.directory, ".idiom", "reports", "interrupted")),
    ).rejects.toThrow();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test.each(["web", "electron"])(
  "forwards additive invariants to every %s tuple independently of probes",
  async (target) => {
    const f = await productionFixture();
    try {
      const project = projectSchema.parse({
        ...f.project,
        colorSchemes: ["light", "dark"],
        viewports: [
          { name: "phone", width: 390, height: 600 },
          { name: "desktop", width: 800, height: 600 },
        ],
        checks: {
          probe: { enabled: true },
          shellVisibility: { floatingOverlays: ["#toolbar", "#breadcrumb"] },
        },
      });
      const base = {
        id: "invariants",
        shell: ".ed-shell",
        title: "Invariants",
        setup: [],
        intent: [],
        invariants: [
          { name: "flow assertion", selector: ".controls", height: 64 },
        ],
      };
      const flow = flowSchema.parse(
        target === "web"
          ? {
              ...base,
              routes: ["/extra"],
              states: [
                {
                  id: "editor",
                  description: "Editor",
                  url: "/",
                  expect: {},
                  invariants: [
                    { name: "local assertion", selector: ".local", width: 320 },
                  ],
                },
              ],
            }
          : {
              ...base,
              target: {
                kind: "electron",
                launch: { executablePath: "unused" },
                window: { title: "Editor" },
              },
              states: [
                {
                  id: "editor",
                  description: "Editor",
                  expect: {},
                  invariants: [
                    { name: "local assertion", selector: ".local", width: 320 },
                  ],
                },
                {
                  id: "other",
                  description: "Other",
                  expect: {},
                  invariants: [],
                },
              ],
            },
      );
      const seen: Array<
        BrowserTuple | import("../src/capture/types.js").ElectronTuple
      > = [];
      const capture = async (
        tuple: BrowserTuple | import("../src/capture/types.js").ElectronTuple,
      ): Promise<TupleResult> => {
        seen.push(tuple);
        return {
          ok: true,
          status: 200,
          dom: "<html></html>",
          screenshot: Buffer.from("png"),
          console: [],
          axe: { violations: [] },
          observations: emptyObservations(),
          mismatches: [],
          startedAt: "2026-10-22T00:00:00.000Z",
          endedAt: "2026-10-22T00:00:01.000Z",
        };
      };
      const result = await runCapture({
        projectDirectory: f.directory,
        project,
        flow,
        dependencies: {
          snapshotSource: async () => ({ commit: "fixture", dirty: false }),
          browserLauncher: async () => ({
            version: "mock",
            capture,
            close: async () => {},
          }),
          electronLauncher: async () => ({
            effectiveEnvironment: {},
            capture: async (tuple) => ({
              result: await capture(tuple),
              version: "mock Electron",
            }),
            close: async () => {},
          }),
        },
      });
      expect(result.counts.total).toBe(8);
      expect(seen).toHaveLength(8);
      for (const tuple of seen) {
        expect(tuple.shell).toBe(".ed-shell");
        expect(tuple.project.checks.shellVisibility?.floatingOverlays).toEqual([
          "#toolbar",
          "#breadcrumb",
        ]);
        expect(
          tuple.invariants?.map(({ declaration }) => declaration.name),
        ).toEqual(
          tuple.state.id === "editor"
            ? ["flow assertion", "local assertion"]
            : ["flow assertion"],
        );
        expect(tuple.invariants?.[0]?.origin).toEqual({
          scope: "flow",
          id: "invariants",
          index: 0,
        });
        if (tuple.state.id === "editor")
          expect(tuple.invariants?.[1]?.origin).toEqual({
            scope: "state",
            id: "editor",
            index: 0,
          });
      }
      if (target === "web")
        expect(
          seen.filter((tuple) => "probe" in tuple && tuple.probe),
        ).toHaveLength(2);
      expect(flow.invariants).toHaveLength(1);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
);

test("a published flow captures its synthesized widths and asks for image evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-published-capture-"));
  const projectDirectory = join(directory, "project");
  await mkdir(projectDirectory, { recursive: true });
  await initializeGitRepository(projectDirectory);
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
    id: "site",
    title: "Site",
    intent: [],
    setup: [],
    kind: "published",
    pages: ["/"],
  });
  const captured: Array<{
    viewport: string;
    width: number;
    published?: boolean;
  }> = [];
  const browserLauncher: BrowserLauncher = async () => ({
    version: "Mock Chromium",
    async capture(tuple): Promise<TupleResult> {
      captured.push({
        viewport: tuple.viewport.name,
        width: tuple.viewport.width,
        ...(tuple.published === undefined
          ? {}
          : { published: tuple.published }),
      });
      return {
        ok: true,
        status: 200,
        dom: "<html>page</html>",
        screenshot: Buffer.from("png"),
        console: [],
        axe: { violations: [] },
        mismatches: [],
        startedAt: "2026-10-23T12:00:00.000Z",
        endedAt: "2026-10-23T12:00:01.000Z",
      };
    },
    async close() {},
  });
  try {
    const result = await runCapture({
      projectDirectory,
      project,
      flow,
      dependencies: {
        browserLauncher,
        inheritedEnvironment: { PATH: process.env.PATH },
        now: () => new Date("2026-10-23T12:00:00.000Z"),
      },
    });
    expect(result.counts).toEqual({ passed: 3, failed: 0, total: 3 });
    expect(captured).toEqual([
      { viewport: "1280", width: 1280, published: true },
      { viewport: "768", width: 768, published: true },
      { viewport: "375", width: 375, published: true },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selectViewports resolves a published flow's widths and still rejects unknown names", () => {
  const project = projectSchema.parse({
    version: 1,
    app: { name: "fixture", framework: "other" },
    server: {
      build: "node -e 0",
      start: "node -e 0",
      readyUrl: "http://127.0.0.1:1/",
      port: 1,
      env: {},
    },
    capture: {},
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const published = flowSchema.parse({
    id: "site",
    title: "Site",
    intent: [],
    setup: [],
    kind: "published",
    pages: ["/"],
    viewports: [1280, "mobile"],
  });
  expect(selectViewports(project, published)).toEqual([
    { name: "1280", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ]);
  const unknown = flowSchema.parse({
    id: "app",
    title: "App",
    intent: [],
    setup: [],
    states: [],
    viewports: ["1280"],
  });
  expect(() => selectViewports(project, unknown)).toThrow(
    'unknown project viewport "1280"',
  );
});
