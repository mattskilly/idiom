import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { afterEach, expect, test } from "vitest";
import { createProgram } from "../src/cli.js";
import { mcpClient } from "./mcp-support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type ParityRow = {
  command: string;
  tools: string[] | "CLI-only";
  reason: string;
};

/** Rows of the `## CLI parity` table in docs/mcp.md. */
function parityRows(markdown: string): ParityRow[] {
  const section = markdown.split(/^## CLI parity$/m)[1]?.split(/^## /m)[0];
  if (section === undefined) throw new Error("docs/mcp.md has no CLI parity");
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim());
      const [command = "", tools = "", reason = ""] = cells;
      const path = /^`([a-z][a-z -]*)`$/.exec(command)?.[1];
      if (path === undefined) throw new Error(`Bad command cell: ${line}`);
      if (tools === "CLI-only") return { command: path, tools, reason };
      const names = tools.split(", ").map((cell) => {
        const name = /^`(idiom_[a-z_]+)`$/.exec(cell)?.[1];
        if (name === undefined) throw new Error(`Bad tool cell: ${line}`);
        return name;
      });
      return { command: path, tools: names, reason };
    });
}

/** Every tool must be named by at least one row. */
function uncoveredTools(rows: ParityRow[], tools: string[]): string[] {
  const named = new Set(
    rows.flatMap((row) => (row.tools === "CLI-only" ? [] : row.tools)),
  );
  return tools.filter((tool) => !named.has(tool));
}

/**
 * Command paths needing a parity decision: every leaf command, plus any
 * parent with its own action (today `explore`). Commander keeps the action
 * on a private field; this is the only place that reads it.
 */
function commandPaths(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap((child) => {
    const path = [...prefix, child.name()];
    const own =
      child.commands.length === 0 ||
      (child as unknown as { _actionHandler?: unknown })._actionHandler != null
        ? [path.join(" ")]
        : [];
    return [...own, ...commandPaths(child, path)];
  });
}

test("docs/mcp.md parity table covers every CLI command and MCP tool", async () => {
  const rows = parityRows(
    await readFile(new URL("../docs/mcp.md", import.meta.url), "utf8"),
  );
  expect(rows.length).toBeGreaterThan(20);
  const session = await mcpClient({});
  cleanups.push(session.close);
  const tools = (await session.client.listTools()).tools.map(
    (tool) => tool.name,
  );
  const commands = commandPaths(createProgram());

  const listed = rows.map((row) => row.command);
  expect(
    listed.filter((path, index) => listed.indexOf(path) !== index),
    "duplicate command rows",
  ).toEqual([]);
  expect(
    commands.filter((path) => !listed.includes(path)),
    "CLI commands missing from the parity table",
  ).toEqual([]);
  expect(
    listed.filter((path) => !commands.includes(path)),
    "parity rows for commands the CLI does not have",
  ).toEqual([]);
  expect(
    uncoveredTools(rows, tools),
    "MCP tools missing from the parity table",
  ).toEqual([]);
  expect(
    rows
      .flatMap((row) => (row.tools === "CLI-only" ? [] : row.tools))
      .filter((tool) => !tools.includes(tool)),
    "parity rows naming tools the server does not advertise",
  ).toEqual([]);
  expect(
    rows
      .filter((row) => row.tools === "CLI-only" && row.reason === "")
      .map((row) => row.command),
    "CLI-only rows need a reason",
  ).toEqual([]);

  // The checks above must be able to fail: a table missing a tool is caught.
  expect(
    uncoveredTools(
      rows.filter((row) => row.command !== "coverage"),
      tools,
    ),
  ).toEqual(["idiom_coverage"]);
  expect(() =>
    parityRows("## CLI parity\n\n| `check` | idiom_check | |\n"),
  ).toThrow("Bad tool cell");
});
