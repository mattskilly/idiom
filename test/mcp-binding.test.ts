import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  type CallToolResult,
  InMemoryTransport,
} from "@modelcontextprotocol/server";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { isIdiomPluginInstall } from "../src/mcp/binding.js";
import { createIdiomMcpServer } from "../src/mcp/server.js";
import { mcpClient, toolData } from "./mcp-support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "idiom binding "));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
/** The shape a plugin host installs: Idiom's package and plugin manifests. */
async function pluginInstall() {
  const path = await directory();
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ name: "@mattskilly/idiom", version: "0.16.1" }),
  );
  await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "idiom" }));
  return path;
}
async function project() {
  const path = await directory();
  await initProject({ project: path, yes: true });
  return path;
}
/** A client that advertises MCP roots, as plugin hosts may. */
async function rootsClient(
  options: Parameters<typeof createIdiomMcpServer>[0],
  roots: () => string[],
) {
  const server = createIdiomMcpServer(options);
  const client = new Client(
    { name: "roots-test", version: "1" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler("roots/list", async () => ({
    roots: roots().map((path) => ({ uri: pathToFileURL(path).href })),
  }));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
const call = (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
const text = (result: CallToolResult) =>
  result.content.map((item) => (item.type === "text" ? item.text : "")).join();

test("recognises Idiom's plugin install but not projects or other packages", async () => {
  const plugin = await pluginInstall();
  expect(await isIdiomPluginInstall(plugin)).toBe(true);
  expect(await isIdiomPluginInstall(await project())).toBe(false);
  const other = await directory();
  await writeFile(join(other, "package.json"), '{"name":"app"}');
  await writeFile(join(other, "plugin.json"), "{}");
  expect(await isIdiomPluginInstall(other)).toBe(false);
  // Idiom's own checkout, initialised as a project, stays a project.
  await initProject({ project: plugin, yes: true });
  expect(await isIdiomPluginInstall(plugin)).toBe(false);
});

test("started in the plugin install, the server binds to the client's project root", async () => {
  const plugin = await pluginInstall();
  const app = await project();
  const elsewhere = await directory();
  const client = await rootsClient({ cwd: plugin }, () => [elsewhere, app]);
  expect(
    toolData<{ brief: string }>(await call(client, "idiom_context")).brief,
  ).toContain("Design");
  expect(await readdir(plugin)).toEqual(["package.json", "plugin.json"]);
});

test("roots changes rebind the project", async () => {
  const plugin = await pluginInstall();
  const first = await project();
  const second = await directory();
  let roots = [first];
  const client = await rootsClient({ cwd: plugin }, () => roots);
  expect((await call(client, "idiom_context")).isError).toBeFalsy();
  roots = [second];
  await client.sendRootsListChanged();
  const error = await call(client, "idiom_context");
  expect(error.isError).toBe(true);
  expect(text(error)).toContain(second);
});

test("in the plugin install without roots, tools fail clearly and write nothing", async () => {
  const plugin = await pluginInstall();
  const session = await mcpClient({ cwd: plugin });
  cleanups.push(session.close);
  for (const [name, args] of [
    ["idiom_context", {}],
    ["idiom_init", {}],
  ] as const) {
    const error = await call(session.client, name, args);
    expect(error.isError).toBe(true);
    expect(text(error)).toContain("its own plugin directory");
    expect(text(error)).toContain("--project");
  }
  expect(await readdir(plugin)).toEqual(["package.json", "plugin.json"]);
});

test("an explicit project and an ordinary working directory ignore client roots", async () => {
  const app = await project();
  const other = await project();
  await writeFile(join(app, "PRODUCT.md"), "# Product\n\nmarker-app\n");
  await writeFile(join(other, "PRODUCT.md"), "# Product\n\nmarker-other\n");
  const explicit = await rootsClient({ project: app, cwd: other }, () => [
    other,
  ]);
  const fromCwd = await rootsClient({ cwd: app }, () => [other]);
  for (const client of [explicit, fromCwd]) {
    const context = await call(client, "idiom_context");
    const { brief } = toolData<{ brief: string }>(context);
    expect(brief).toContain("marker-app");
    expect(brief).not.toContain("marker-other");
  }
});
