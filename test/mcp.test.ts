import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  type CallToolResult,
  InMemoryTransport,
} from "@modelcontextprotocol/server";
import { afterEach, expect, test, vi } from "vitest";
import type { BrowserSession } from "../src/capture/types.js";
import { initProject } from "../src/commands/init.js";
import { evidencePath } from "../src/mcp/evidence.js";
import { createIdiomMcpServer } from "../src/mcp/server.js";
import { writeUnruledDecisions } from "../src/rulings/artifacts.js";
import { mcpClient, toolData } from "./mcp-support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "idiom mcp "));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function connect(options: Parameters<typeof createIdiomMcpServer>[0]) {
  const session = await mcpClient(options);
  cleanups.push(session.close);
  return session.client;
}
const call = (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

test("uninitialized server advertises exactly fifteen described strict schemas and survives tool errors", async () => {
  const directory = await root();
  const client = await connect({ project: directory });
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).sort()).toEqual([
    "idiom_baseline",
    "idiom_check",
    "idiom_choose",
    "idiom_context",
    "idiom_coverage",
    "idiom_decide",
    "idiom_design_add",
    "idiom_fix_plan",
    "idiom_flows",
    "idiom_init",
    "idiom_issue",
    "idiom_quick",
    "idiom_sweep",
    "idiom_tickets",
    "idiom_verify",
  ]);
  for (const tool of tools) {
    expect(tool.description?.length).toBeGreaterThan(70);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }
  const quick = tools.find((tool) => tool.name === "idiom_quick");
  expect(quick?.inputSchema.required).toEqual(["url"]);
  for (const route of [
    "public page",
    "zero configuration",
    "idiom_check",
    "idiom_fix_plan",
    "idiom_verify",
  ]) {
    expect(quick?.description).toContain(route);
  }
  expect(quick?.inputSchema.properties).not.toHaveProperty("design");
  const check = tools.find((tool) => tool.name === "idiom_check");
  for (const route of [
    "configured flow",
    "intended designs",
    "idiom_design_add",
    "idiom_choose",
    "idiom_fix_plan",
    "idiom_verify",
  ]) {
    expect(check?.description).toContain(route);
  }
  expect(quick?.inputSchema.properties).toMatchObject({
    viewports: {
      type: "array",
      minItems: 1,
      items: { enum: ["desktop", "mobile"] },
    },
    probe: { type: "boolean" },
    probeBudgetMs: { type: "integer", maximum: 600000 },
  });
  expect(quick?.description).toContain("safely probes controls");
  expect(
    tools.find((tool) => tool.name === "idiom_verify")?.inputSchema.properties,
  ).toMatchObject({
    findings: {
      type: "array",
      minItems: 1,
      items: { required: ["id", "runId"] },
    },
  });
  expect(
    tools.find((tool) => tool.name === "idiom_decide")?.inputSchema.properties,
  ).toMatchObject({
    decision: { enum: ["accept", "reject", "add-step", "drift"] },
    token: { type: "string" },
  });
  for (const name of ["idiom_context", "idiom_flows", "idiom_check"]) {
    const error = await call(
      client,
      name,
      name === "idiom_check" ? { flow: "checkout" } : {},
    );
    expect(error.isError).toBe(true);
    expect(error.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("idiom init"),
        }),
      ]),
    );
  }
  await initProject({ project: directory, yes: true });
  expect(
    toolData<{ brief: string }>(await call(client, "idiom_context")).brief,
  ).toContain("Design");
});

test("invalid inputs are tool errors; missing/empty flows differ from malformed manifests", async () => {
  const directory = await root();
  await initProject({ project: directory, yes: true });
  const client = await connect({
    cwd: join(directory, "sub directory"),
    project: "..",
  });
  for (const [name, args] of [
    ["idiom_quick", {}],
    ["idiom_quick", { url: "file:///etc/passwd" }],
    ["idiom_quick", { url: "https://example.com", viewports: [] }],
    [
      "idiom_quick",
      { url: "https://example.com", viewports: ["mobile", "mobile"] },
    ],
    ["idiom_quick", { url: "https://example.com", probeBudgetMs: 0 }],
    ["idiom_quick", { url: "https://example.com", probeBudgetMs: -1 }],
    ["idiom_quick", { url: "https://example.com", probeBudgetMs: 1.5 }],
    ["idiom_quick", { url: "https://example.com", probeBudgetMs: 600001 }],
    ["idiom_quick", { url: "https://example.com", probe: "yes" }],
    [
      "idiom_quick",
      { url: "https://example.com", probe: false, probeBudgetMs: 1000 },
    ],
    ["idiom_check", { flow: "../escape" }],
    ["idiom_check", { flow: "checkout", states: ["cart", "cart"] }],
    ["idiom_context", { project: directory }],
    ["idiom_fix_plan", { flow: "checkout", top: 0 }],
    ["idiom_decide", { id: "finding-1", decision: "accept", reason: "  " }],
    ["idiom_tickets", { out: "/tmp/elsewhere" }],
    ["idiom_tickets", { out: "../elsewhere" }],
    ["idiom_sweep", { flow: "checkout", emitTickets: "/tmp/triage" }],
    ["idiom_choose", { id: "finding-1", reference: "figma", reason: " " }],
    ["idiom_baseline", { action: "show", from: "run-1" }],
    ["idiom_baseline", { action: "show", latest: true }],
    ["idiom_coverage", { crawl: "file:///etc/passwd" }],
    ["idiom_init", { flows: true, project: "/elsewhere" }],
    ["idiom_design_add", { state: "home", source: "../outside.html" }],
    [
      "idiom_verify",
      { flow: "checkout", findings: [{ id: "finding-1", runId: "../x" }] },
    ],
  ] as const)
    expect(
      (await call(client, name, args)).isError,
      `${name} ${JSON.stringify(args)}`,
    ).toBe(true);
  const flows = join(directory, ".idiom/flows");
  await rm(flows, { recursive: true });
  expect(toolData(await call(client, "idiom_flows"))).toEqual({
    flows: [],
    guidance: "Call idiom_init with flows:true (or run idiom init --flows)",
  });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(flows);
  expect(toolData(await call(client, "idiom_flows"))).toMatchObject({
    flows: [],
  });
  await writeFile(join(flows, "broken.json"), "{");
  const malformed = await call(client, "idiom_flows");
  expect(malformed.isError).toBe(true);
  expect(JSON.stringify(malformed)).toContain("malformed JSON");
  expect((await call(client, "idiom_context")).isError).not.toBe(true);
});

test.each([
  "Executable doesn't exist: browser. Run playwright install",
  "EADDRINUSE: configured port pinned",
])(
  "capture failure has recovery and does not kill protocol: %s",
  async (message) => {
    const client = await connect({
      project: await root(),
      dependencies: {
        quick: {
          browserLauncher: async () => {
            throw new Error(message);
          },
        },
      },
    });
    const error = await call(client, "idiom_quick", {
      url: "https://example.com",
    });
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error.content)).toContain(
      message.startsWith("Executable")
        ? "npx playwright install chromium"
        : "Free the configured port",
    );
    expect((await client.listTools()).tools).toHaveLength(15);
  },
);

test("evidence refuses traversal and symlink escapes", async () => {
  const directory = await root();
  const other = await root();
  await writeFile(join(other, "private.png"), "private");
  await symlink(join(other, "private.png"), join(directory, "crop.png"));
  await expect(evidencePath(directory, "../escape")).rejects.toThrow("escapes");
  await expect(evidencePath(directory, "crop.png")).rejects.toThrow(
    "symlink escapes",
  );
});

test("a persistent SDK session cancels active and queued work, closes late launchers, and serves the next call", async () => {
  const directory = await root();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: (browser: BrowserSession) => void;
  const pending = new Promise<BrowserSession>((resolve) => {
    release = resolve;
  });
  const launcher = vi.fn(async () => {
    enter();
    return pending;
  });
  const server = createIdiomMcpServer({
    project: directory,
    dependencies: { quick: { browserLauncher: launcher } },
  });
  const client = new Client(
    { name: "cancellation-test", version: "1" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();
  const progress: number[] = [];
  const active = client.callTool(
    { name: "idiom_quick", arguments: { url: "https://example.com" } },
    {
      signal: activeAbort.signal,
      onprogress: (event) => progress.push(event.progress),
    },
  );
  const activeRejected = expect(active).rejects.toThrow();
  await entered;
  const queued = client.callTool(
    { name: "idiom_quick", arguments: { url: "https://example.com" } },
    { signal: queuedAbort.signal },
  );
  const queuedRejected = expect(queued).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 10));
  queuedAbort.abort();
  activeAbort.abort();
  await Promise.all([activeRejected, queuedRejected]);
  const close = vi.fn(async () => {});
  release({ version: "late", capture: vi.fn(), close });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(launcher).toHaveBeenCalledOnce();
  expect(progress.length).toBeGreaterThan(0);
  expect(
    progress.every(
      (value, index) => index === 0 || value > (progress[index - 1] ?? 0),
    ),
  ).toBe(true);
  const error = await call(client, "idiom_flows");
  expect(error.isError).toBe(true);
  expect((await client.listTools()).tools).toHaveLength(15);
  expect(
    await readFile(join(directory, "missing"), "utf8").catch(() => "absent"),
  ).toBe("absent");
});

test("context projects configured tokens, rules, craft checks and design law through MCP", async () => {
  const directory = await root();
  await initProject({ project: directory, yes: true });
  const configPath = join(directory, ".idiom/project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.design.tokensFile = "tokens.css";
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(directory, "tokens.css"),
    ":root{--space-unit:8px;--brand:#123456}",
  );
  await writeFile(
    join(directory, "DESIGN.md"),
    "# Design law\nUse the 8px spacing scale.\n",
  );
  await writeFile(
    join(directory, ".idiom/rules.json"),
    JSON.stringify({
      version: 1,
      overrides: [
        {
          id: "brand",
          match: { category: "contrast" },
          action: "severity",
          severity: "minor",
          reason: "Brand palette",
        },
      ],
    }),
  );
  const client = await connect({ project: directory });
  const brief = toolData<{ brief: string }>(
    await call(client, "idiom_context"),
  ).brief;
  expect(brief).toContain("--space-unit: 8px");
  expect(brief).toContain("8px spacing scale");
  expect(brief).toContain("Brand palette");
  expect(brief).toContain("Craft checks");
});

test("activity without an MCP progress token emits no progress notifications", async () => {
  const server = createIdiomMcpServer({
    project: await root(),
    dependencies: {
      quick: {
        browserLauncher: async () => {
          throw new Error("expected launch failure");
        },
      },
    },
  });
  const client = new Client({ name: "no-progress", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const notified = vi.fn();
  client.setNotificationHandler("notifications/progress", notified);
  expect(
    (await call(client, "idiom_quick", { url: "https://example.com" })).isError,
  ).toBe(true);
  expect(notified).not.toHaveBeenCalled();
});

test("idiom_quick probes by default, reports progress and returns the interaction", async () => {
  const directory = await root();
  const captured: Array<{
    probe?: boolean | undefined;
    budget?: number | undefined;
  }> = [];
  const browserLauncher = async () =>
    ({
      version: "Mock Chromium",
      async capture(tuple) {
        captured.push({
          probe: tuple.probe,
          budget: tuple.probePageBudgetMs,
        });
        if (tuple.probe)
          tuple.onProbeProgress?.({
            completed: 0,
            selector: "#go",
            phase: "observe",
          });
        return {
          ok: true,
          status: 200,
          dom: "<!doctype html><html><body><h1>Quick</h1></body></html>",
          screenshot: Buffer.from("png"),
          console: [],
          axe: { violations: [] },
          observations: {
            version: 1,
            viewport: { width: 1, height: 1 },
            document: {
              scrollWidth: 1,
              scrollHeight: 1,
              clientWidth: 1,
              clientHeight: 1,
            },
            elements: [],
            headings: [],
            tokens: { status: "not-configured" },
          },
          mismatches: [],
          startedAt: "2026-10-26T00:00:00.000Z",
          endedAt: "2026-10-26T00:00:01.000Z",
        };
      },
      async close() {},
    }) satisfies BrowserSession;
  const server = createIdiomMcpServer({
    project: directory,
    dependencies: { quick: { browserLauncher } },
  });
  const client = new Client(
    { name: "quick-probe-test", version: "1" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const messages: string[] = [];
  const response = (await client.callTool(
    {
      name: "idiom_quick",
      arguments: { url: "https://example.com", probeBudgetMs: 2000 },
    },
    {
      onprogress: (event) => {
        if (event.message) messages.push(event.message);
      },
    },
  )) as CallToolResult;
  expect(response.isError).not.toBe(true);
  expect(captured.filter((tuple) => tuple.probe)).toEqual([
    { probe: true, budget: 2000 },
  ]);
  expect(messages.some((message) => message.startsWith("Probe #go"))).toBe(
    true,
  );
  expect(
    toolData<{ interaction: { status: string; budgetMs: number } }>(response)
      .interaction,
  ).toMatchObject({ status: "probed", budgetMs: 2000 });

  captured.length = 0;
  const off = await client.callTool({
    name: "idiom_quick",
    arguments: { url: "https://example.com", probe: false },
  });
  expect(captured.some((tuple) => tuple.probe)).toBe(false);
  expect(toolData<{ interaction: unknown }>(off).interaction).toEqual({
    status: "off",
  });
  expect(JSON.stringify((off as CallToolResult).content)).toContain(
    "probe off",
  );
});

test("idiom_decide answers a design system question by its ruling id", async () => {
  const directory = await root();
  await initProject({ project: directory, yes: true });
  const run = join(directory, ".idiom", "reports", "2026-10-27-check");
  await mkdir(run, { recursive: true });
  await writeUnruledDecisions(run, [
    {
      id: "ruling-1",
      fingerprint: "scale-print",
      choiceKey: "scale-cluster:v1 height 36px",
      question: "36px height appears 6 times on controls in main at desktop…",
      nearestLawExcerpt: "checks.scales.controlHeights: [32px, 40px]",
      occurrences: [
        { state: "editor", viewport: "desktop", screenshot: "editor/desktop" },
      ],
      candidates: [],
      scaleCluster: {
        property: "height",
        value: "36px",
        count: 6,
        distinctStates: 1,
        distinctElements: 6,
        context: {
          landmark: "main",
          component: "control",
          viewport: "desktop",
        },
        componentLabel: "controls",
        nearestSteps: { below: "32px", above: "40px", steps: ["32px", "40px"] },
        suggestedToken: "height-control-main",
        examples: [
          {
            state: "editor",
            viewport: "desktop",
            screenshot: "editor/desktop",
            selector: "#save",
          },
        ],
      },
    },
  ]);
  const client = await connect({ project: directory });
  const accepted = await call(client, "idiom_decide", {
    id: "ruling-1",
    decision: "accept",
    reason: "Looks right",
  });
  expect(accepted.isError).toBe(true);
  expect(JSON.stringify(accepted.content)).toContain(
    "answer it with add-step or drift",
  );
  const misrouted = await call(client, "idiom_decide", {
    id: "finding-1",
    decision: "drift",
    reason: "Not a question",
  });
  expect(misrouted.isError).toBe(true);
  expect(JSON.stringify(misrouted.content)).toContain(
    "answers a design system question",
  );
  const added = await call(client, "idiom_decide", {
    id: "ruling-1",
    decision: "add-step",
    token: "height-row",
    reason: "Dense rows are a real size.",
  });
  expect(added.isError).not.toBe(true);
  const law = await readFile(join(directory, "DESIGN.md"), "utf8");
  expect(law).toContain(
    "Add the `height-row` step: 36px height for control in main at desktop.",
  );
  expect(law).toContain("Reason: Dense rows are a real size.");
});
