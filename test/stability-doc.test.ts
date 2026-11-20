import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import {
  commandStatus,
  experimentalOptions,
  fileFormats,
  jsonOutputs,
  mcpOutputs,
  mcpToolStatus,
  reportFileNames,
} from "../src/interface/surfaces.js";
import { EXIT_CODES, INTERFACE_VERSION } from "../src/interface/version.js";
import { projectFileFormats } from "../src/migrations/formats.js";

let doc: string;
let mcpDoc: string;
beforeAll(async () => {
  const read = (name: string) =>
    readFile(join(import.meta.dirname, "..", "docs", name), "utf8");
  doc = await read("stability.md");
  mcpDoc = await read("mcp.md");
});

/** Rows of the first table in `source` whose header line starts with `header`. */
function table(header: string, source: string = doc): string[][] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start < 0) throw new Error(`missing table: ${header}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replace(/^`(.*)`$/, "$1")),
    );
  }
  return rows;
}

test("the command table matches the status registry", () => {
  expect(Object.fromEntries(table("| Command | Status |"))).toEqual(
    commandStatus,
  );
  expect(table("| Command | Status |")).toHaveLength(
    Object.keys(commandStatus).length,
  );
});

test("every experimental command has a reason", () => {
  for (const [command, status, notes] of table("| Command | Status |"))
    if (status === "experimental")
      expect(notes, `${command} reason`).toMatch(/^(?!—$)\S/);
});

test("the command table names exactly the experimental options", () => {
  for (const [command, status, notes] of table("| Command | Status |")) {
    if (status !== "stable") continue;
    const named = [...(notes ?? "").matchAll(/`(--[a-z-]+)`/g)].map(
      (match) => match[1],
    );
    expect(new Set(named), `${command} experimental options`).toEqual(
      new Set(experimentalOptions[command as string] ?? []),
    );
  }
  for (const command of Object.keys(experimentalOptions))
    expect(commandStatus[command], command).toBe("stable");
});

test("the --json table matches the payload registry", () => {
  const rows = table("| Payload | Command | Status |");
  expect(
    rows.map(([id, command, status]) => ({ id, command, status })),
  ).toEqual(
    expect.arrayContaining(
      jsonOutputs.map(({ id, command, status }) => ({ id, command, status })),
    ),
  );
  expect(rows).toHaveLength(jsonOutputs.length);
});

test("the MCP table matches the tool and output registries", () => {
  const rows = table("| Tool | Status |");
  expect(Object.fromEntries(rows.map((row) => [row[0], row[1]]))).toEqual(
    mcpToolStatus,
  );
  expect(rows).toHaveLength(Object.keys(mcpToolStatus).length);
  for (const [tool, , output, why] of rows) {
    const registered = mcpOutputs[tool as string];
    expect(output, `${tool} output status`).toBe(registered?.status);
    expect(why?.replaceAll("`", ""), `${tool} output reason`).toBe(
      registered?.reason ?? "—",
    );
  }
});

test("the MCP doc's output status table matches the tool and output registries", () => {
  const rows = table("| Tool | Status | Output |", mcpDoc);
  expect(rows).toHaveLength(Object.keys(mcpToolStatus).length);
  expect(
    Object.fromEntries(rows.map(([tool, status]) => [tool, status])),
  ).toEqual(mcpToolStatus);
  expect(
    Object.fromEntries(rows.map(([tool, , output]) => [tool, output])),
  ).toEqual(
    Object.fromEntries(
      Object.entries(mcpOutputs).map(([tool, output]) => [tool, output.status]),
    ),
  );
});

test("the stable-fields sections name every stable-additive payload and MCP output", () => {
  const jsonFields = doc.slice(
    doc.indexOf("The stable fields:"),
    doc.indexOf("## MCP"),
  );
  for (const output of jsonOutputs.filter(
    (entry) => entry.status === "stable-additive",
  ))
    expect(jsonFields, output.id).toContain(`**\`${output.id}\`**`);
  const mcpSection = doc.slice(doc.indexOf("## MCP"), doc.indexOf("## Files"));
  const mcpFields = mcpSection.slice(
    mcpSection.indexOf("The stable output fields:"),
    mcpSection.indexOf("| Tool | Status |"),
  );
  for (const [tool, output] of Object.entries(mcpOutputs))
    if (output.status === "stable-additive")
      expect(mcpFields, tool).toContain(`**\`${tool}\`**`);
});

test("the file table lists every file format with its status", () => {
  const rows = table("| File | Direction | Status |");
  expect(rows).toHaveLength(fileFormats.length);
  const counts = (statuses: string[]) =>
    statuses.reduce<Record<string, number>>((tally, status) => {
      tally[status] = (tally[status] ?? 0) + 1;
      return tally;
    }, {});
  expect(counts(rows.map((row) => row[2] as string))).toEqual(
    counts(fileFormats.map((file) => file.status)),
  );
  for (const file of fileFormats.filter((entry) => entry.schema !== undefined))
    expect(doc, file.id).toContain(file.path.replace("<run directory>/", ""));
  for (const name of reportFileNames) expect(doc).toContain(`\`${name}\``);
});

test("the exit-code list matches EXIT_CODES", () => {
  const section = doc.slice(
    doc.indexOf("## Exit codes"),
    doc.indexOf("## JSON output"),
  );
  const codes = Array.from(section.matchAll(/^- `(\d+)`:/gm), (match) =>
    Number(match[1]),
  );
  expect(codes).toEqual(Object.values(EXIT_CODES));
});

test("the doc names the current interface version", () => {
  expect(doc).toContain(`interface version ${INTERFACE_VERSION}`);
  expect(doc).toContain(`"interfaceVersion": ${INTERFACE_VERSION}`);
});

test("the doc says which shared logs skip records a newer Idiom wrote", () => {
  const start = doc.indexOf("### Records a newer Idiom wrote");
  expect(start).toBeGreaterThan(0);
  const section = doc.slice(start, doc.indexOf("\n## ", start));
  expect(section).toContain("`.idiom/decisions.jsonl`");
  expect(section).toContain("`.idiom/learned.jsonl`");
  expect(section).toContain("additive");
});

test("the format-version table lists every versioned project file", () => {
  const rows = table("| File | Format version | Migrated from |");
  const expected = projectFileFormats.flatMap((format) =>
    format.locations.map((location) => [
      `.idiom/${location}`,
      format.kind === "log"
        ? `${format.current} (per record)`
        : String(format.current),
    ]),
  );
  expect(rows.map(([file, version]) => [file, version])).toEqual(expected);
  const none = projectFileFormats.every(
    (format) => Object.keys(format.migrations).length === 0,
  );
  expect(doc.includes("No migrations are currently needed")).toBe(none);
});
