import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { baselineProject, commit } from "./baseline-support.js";
import { fixture } from "./benchmark-support.js";
import { freePort } from "./doctor-support.js";
import { BROWSER_TOOLS, validOutput } from "./mcp-output-support.js";
import { mcpClient } from "./mcp-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const page = (size: number) =>
  `<!doctype html><html lang="en"><head><title>Repair</title><style>body{background:#fff;color:#111;font:16px sans-serif;margin:32px}button{width:${size}px;height:${size}px;padding:0;border:0;font-size:10px}main{width:300px}</style></head><body><main><h1>Repair</h1><span style="display:inline-flex;align-items:center;gap:4px"><button id="target" aria-label="Toggle">+</button><button aria-label="Neighbor" style="width:44px;height:44px"></button></span></main></body></html>`;

/** A committed studio flow served by a fixture server, as test/mcp-browser.test.ts sets it up. */
async function configured(html: string) {
  const setup = await baselineProject({
    states: ["editor"],
    required: [],
    maxFindings: 1,
  });
  cleanups.push(() => rm(setup.project, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(setup.configPath, "utf8"));
  const port = await freePort();
  config.server = {
    build: "node -e 0",
    start: fixtureCommand("server.mjs"),
    port,
    readyUrl: `http://127.0.0.1:${port}`,
    env: {},
  };
  config.capture.settleMs = 0;
  config.checks = { probe: { enabled: false } };
  await writeFile(setup.configPath, JSON.stringify(config));
  await writeFile(join(setup.project, "page.html"), html);
  await writeFile(
    join(setup.project, "server.mjs"),
    `import {createServer} from 'node:http'; import {readFile} from 'node:fs/promises';
createServer(async (req,res)=>{res.setHeader('content-type','text/html');res.end(await readFile('page.html'));}).listen(Number(process.env.PORT),'127.0.0.1');`,
  );
  const flowPath = join(setup.project, ".idiom/flows/studio.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8"));
  for (const state of flow.states as Array<Record<string, unknown>>) {
    state.loadingSettleMs = 50;
    state.url = "/";
  }
  await writeFile(flowPath, JSON.stringify(flow));
  await commit(setup.project, "MCP application");
  const session = await mcpClient({ project: setup.project });
  cleanups.push(session.close);
  return session;
}

test("every capturing tool returns structuredContent its schema accepts", async () => {
  const called = new Set<string>();

  const html = await fixture("before.html");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const directory = await mkdtemp(join(tmpdir(), "idiom-output-browser-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const quick = await mcpClient({ cwd: directory });
  cleanups.push(quick.close);
  validOutput(
    called,
    quick.validators,
    "idiom_quick",
    await quick.client.callTool({
      name: "idiom_quick",
      arguments: {
        url: `http://127.0.0.1:${address.port}`,
        viewports: ["mobile"],
        probe: false,
      },
    }),
  );

  const session = await configured(page(12));
  const valid = <T = Record<string, unknown>>(
    name: string,
    response: unknown,
  ) => validOutput<T>(called, session.validators, name, response);
  const checked = valid<{ findings: Array<{ id: string }> }>(
    "idiom_check",
    await session.client.callTool({
      name: "idiom_check",
      arguments: { flow: "studio", all: true },
    }),
  );
  const first = checked.findings[0];
  if (first === undefined) throw new Error("Expected a finding");
  valid(
    "idiom_issue",
    await session.client.callTool({
      name: "idiom_issue",
      arguments: { id: first.id },
    }),
  );
  valid(
    "idiom_decide",
    await session.client.callTool({
      name: "idiom_decide",
      arguments: { id: first.id, decision: "accept", reason: "Intentional" },
    }),
  );
  const plan = valid<{ next: { arguments: Record<string, unknown> } | null }>(
    "idiom_fix_plan",
    await session.client.callTool({
      name: "idiom_fix_plan",
      arguments: { flow: "studio", top: 1 },
    }),
  );
  if (plan.next === null) throw new Error("Expected a repair assignment");
  valid(
    "idiom_verify",
    await session.client.callTool({
      name: "idiom_verify",
      arguments: plan.next.arguments,
    }),
  );

  expect([...called].sort()).toEqual([...BROWSER_TOOLS].sort());
}, 240_000);
