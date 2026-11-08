import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import {
  commandStatus,
  fileFormats,
  jsonOutputs,
  mcpToolStatus,
  reportFileNames,
} from "../src/interface/surfaces.js";
import { EXIT_CODES, INTERFACE_VERSION } from "../src/interface/version.js";

let doc: string;
beforeAll(async () => {
  doc = await readFile(
    join(import.meta.dirname, "..", "docs", "stability.md"),
    "utf8",
  );
});

/** Rows of the first table whose header line starts with `header`. */
function table(header: string): string[][] {
  const lines = doc.split("\n");
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

test("the MCP table matches the tool registry", () => {
  const rows = table("| Tool | Status |");
  expect(Object.fromEntries(rows)).toEqual(mcpToolStatus);
  expect(rows).toHaveLength(Object.keys(mcpToolStatus).length);
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
