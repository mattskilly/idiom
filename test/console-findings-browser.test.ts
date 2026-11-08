import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { runCapture } from "../src/capture/run.js";
import type { ConsoleRecord } from "../src/capture/types.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import { initProject } from "../src/commands/init.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { fixtureCommand } from "./support/fixture-server.js";

const PREVIEW =
  '<!doctype html><html lang="en"><title>Preview</title><main><h1>Preview</h1><img alt="Preview" src="/preview/123?thumbnail=1&token=s3cret"></main></html>';
// `sandbox` undefined: same-origin srcdoc; "allow-scripts": opaque origin with
// scripts; "": opaque origin where no script, Idiom's included, runs.
const srcdoc = (sandbox?: string) =>
  `<!doctype html><html lang="en"><title>CSP</title><main><h1>CSP</h1><iframe id="preview" title="Preview"${sandbox === undefined ? "" : ` sandbox="${sandbox}"`} srcdoc="<meta http-equiv='Content-Security-Policy' content=&quot;style-src-attr 'none'&quot;><div class='card' style='color:red'>x</div>"></iframe></main></html>`;

let directory: string;
let browser: Browser;
let runDirectory: string;

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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "idiom-console-findings-"));
  await initProject({ project: directory, yes: true });
  const port = await freePort();
  const script = join(directory, "server.mjs");
  const pages = {
    "/preview-page": PREVIEW,
    "/csp": srcdoc(),
    "/csp-sandboxed": srcdoc("allow-scripts"),
    "/csp-scriptless": srcdoc(""),
  };
  await writeFile(
    script,
    `import { createServer } from 'node:http';
    const pages = ${JSON.stringify(pages)};
    createServer((req, res) => {
      if (req.url.startsWith('/preview/')) {
        console.error('render timed out for preview 123');
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('timeout');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pages[req.url] ?? '<!doctype html><html lang="en"><title>Home</title><main><h1>Home</h1></main></html>');
    }).listen(Number(process.env.PORT), '127.0.0.1');`,
  );
  const project = projectSchema.parse({
    version: 1,
    app: { name: "console", framework: "other" },
    server: {
      build: "node -e 0",
      start: fixtureCommand(script),
      readyUrl: `http://127.0.0.1:${port}/`,
      port,
      env: { PORT: String(port) },
    },
    viewports: [{ name: "phone", width: 390, height: 844 }],
    capture: { settleMs: 0 },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
  const flow = flowSchema.parse({
    id: "console",
    title: "Console",
    setup: [],
    intent: [],
    states: [
      {
        id: "preview",
        description: "Preview",
        url: "/preview-page",
        expect: { status: 200 },
      },
      { id: "csp", description: "CSP", url: "/csp", expect: { status: 200 } },
      {
        id: "sandboxed",
        description: "Sandboxed CSP",
        url: "/csp-sandboxed",
        expect: { status: 200 },
      },
      {
        id: "scriptless",
        description: "Scriptless sandboxed CSP",
        url: "/csp-scriptless",
        expect: { status: 200 },
      },
    ],
  });
  browser = await chromium.launch({ headless: true });
  const capture = await runCapture({
    projectDirectory: directory,
    project,
    flow,
    dependencies: {
      snapshotSource: async () => ({ commit: "fixture", dirty: false }),
      browserLauncher: createBrowserLauncher({
        launch: async () => browser,
        createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
      }),
    },
  });
  expect(capture.counts.failed).toBe(0);
  runDirectory = capture.runDirectory;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function consoleRecords(state: string): Promise<ConsoleRecord[]> {
  return (
    await readFile(join(runDirectory, state, "phone", "console.jsonl"), "utf8")
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ConsoleRecord);
}

async function consoleFindings(state: string) {
  const loaded = await loadCaptureRun({
    runDirectory,
    expectedFlow: "console",
  });
  const tuple = loaded.tuples.find((candidate) => candidate.state === state);
  return runDeterministicChecks(tuple ? [tuple] : [])
    .candidates.filter(
      ({ candidate }) => candidate.category === "console-error",
    )
    .map(({ candidate }) => candidate);
}

test("a failed sub-resource names its request and attaches the owned server's log", async () => {
  const log = await readFile(join(runDirectory, "server.log"), "utf8");
  expect(log).toMatch(/^\S+ stderr render timed out for preview 123$/m);
  const failed = (await consoleRecords("preview")).find(
    (record) => record.request?.status === 500,
  );
  expect(failed?.request).toMatchObject({
    method: "GET",
    status: 500,
    resourceType: "image",
  });
  expect(failed?.request?.url).toMatch(
    /\/preview\/123\?thumbnail=1&token=\[redacted\]$/,
  );
  expect(typeof failed?.request?.at).toBe("number");
  const [finding] = await consoleFindings("preview");
  expect(finding?.explanation).toContain(
    "GET /preview/123?thumbnail=1&token=[redacted] returned 500",
  );
  expect(finding?.serverLogExcerpt).toContain(
    "render timed out for preview 123",
  );
});

test("a CSP violation in a srcdoc frame names the directive, element and owner iframe", async () => {
  const records = await consoleRecords("csp");
  expect(
    records.some(
      (record) => record.text === "Content Security Policy violation",
    ),
  ).toBe(false);
  const findings = await consoleFindings("csp");
  expect(findings).toHaveLength(1);
  const [finding] = findings;
  expect(finding?.explanation).toContain("style-src-attr");
  expect(finding?.explanation).toContain("inline");
  expect(finding?.explanation).toMatch(
    /on html > body\S* > div:nth-of-type\(1\) \(style-src-attr\)/,
  );
  expect(finding?.explanation).toContain("inside iframe #preview");
  expect(
    findings.some(
      (candidate) =>
        candidate.explanation.startsWith("console.error") &&
        candidate.explanation.includes("Refused to"),
    ),
  ).toBe(false);
});

test("a CSP violation in an opaque-origin srcdoc frame still names the element and owner iframe", async () => {
  const records = await consoleRecords("sandboxed");
  const findings = await consoleFindings("sandboxed");
  expect(findings, JSON.stringify(records)).toHaveLength(1);
  expect(findings[0]?.explanation).toMatch(
    /^Content Security Policy blocked inline style on html > body\S* > div\S* \(style-src-attr\) inside iframe #preview\./,
  );
});

test("a frame that runs no script keeps Chromium's CSP line and Idiom adds nothing", async () => {
  const records = await consoleRecords("scriptless");
  expect(records.every((record) => record.csp === undefined)).toBe(true);
  const findings = await consoleFindings("scriptless");
  expect(
    findings.some((finding) => finding.explanation.includes("style-src-attr")),
  ).toBe(true);
  expect(
    records.filter(
      (record) => record.text === "Content Security Policy violation",
    ),
  ).toEqual([]);
});
