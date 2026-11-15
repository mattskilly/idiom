import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  headerRole,
  importChecks,
  namedChecks,
  parseImportTable,
  splitCells,
} from "../src/learn/import-table.js";

const catalog = () =>
  readFile(join("test", "fixtures", "learn-import", "catalog.md"), "utf8");

const table = (rows: string[], header = "| ID | Observation | Rule |") =>
  [header, "| --- | --- | --- |", ...rows].join("\n");

test("header aliases read by role, emphasis and punctuation ignored, exact before prefix", () => {
  expect(headerRole("**ID**")).toBe("id");
  expect(headerRole("#")).toBe("id");
  expect(headerRole("`No.`")).toBe("id");
  expect(headerRole("What was seen")).toBe("observation");
  expect(headerRole("Observation (what we saw)")).toBe("observation");
  expect(headerRole("__General rule__")).toBe("rule");
  expect(headerRole("Generalized rule")).toBe("rule");
  expect(headerRole("How it could be checked")).toBe("how");
  expect(headerRole("Checkable?")).toBe("how");
  expect(headerRole("Check id")).toBe("check");
  expect(headerRole("State that would show it")).toBe("state");
  expect(headerRole("Shows in")).toBe("state");
  // Prefixes need a word boundary: "Notes" is not "no", "Keyboard" not "key".
  expect(headerRole("Notes")).toBeUndefined();
  expect(headerRole("Keyboard")).toBeUndefined();
  expect(headerRole("Owner")).toBeUndefined();
});

test.each([
  ["what was wrong", "observation"],
  ["What went wrong", "observation"],
  ["Catch", "observation"],
  ["Description", "observation"],
  ["Observation", "observation"],
  ["general rule (checkable law)", "rule"],
  ["General Rule [law]:", "rule"],
  ["idiom state", "state"],
  ["Idiom State", "state"],
  ["capture state", "state"],
  ["State", "state"],
  ["how", "how"],
  ["How to check", "how"],
  ["check", "how"],
  ["Check id", "check"],
  ["Idiom check", "check"],
  ["surface", "surface"],
  ["**Surface**:", "surface"],
  ["date", "date"],
  ["source", "source"],
  ["(notes)", undefined],
])("header %j reads as %s", (header, role) => {
  expect(headerRole(header)).toBe(role);
});

test("a bare Check column is how alone, and the check-id column beside a How column", () => {
  const both = parseImportTable(
    "| ID | Observation | Rule | How | Check |\n| - | - | - | - | - |\n| A-1 | Seen | A rule | by eye | `contrast` |",
  );
  expect(both.tables[0]?.columns).toMatchObject({ how: 3, check: 4 });
  expect(both.rows[0]).toMatchObject({ how: "by eye", check: "`contrast`" });
  const first = parseImportTable(
    "| ID | Observation | Rule | Check | How to check |\n| - | - | - | - | - |\n| A-1 | Seen | A rule | contrast | by eye |",
  );
  expect(first.tables[0]?.columns).toMatchObject({ how: 4, check: 3 });
  const alone = parseImportTable(
    "| ID | Observation | Rule | Check |\n| - | - | - | - |\n| A-1 | Seen | A rule | contrast |",
  );
  const row = alone.rows[0];
  expect(row).toMatchObject({ how: "contrast", check: "contrast" });
  expect(namedChecks(row?.how, row?.check)).toContain("contrast");
  expect(() =>
    parseImportTable(
      "| ID | Observation | Rule | How | Detection |\n| - | - | - | - | - |\n| A-1 | Seen | A rule | x | y |",
    ),
  ).toThrow("columns 4 and 5 both read as how");
});

test("the page builder catalog: only its catalog table is read, with provenance and † rows verbatim", async () => {
  const parsed = parseImportTable(
    await readFile(
      join("test", "fixtures", "learn-import", "page-builder-catalog.md"),
      "utf8",
    ),
  );
  expect(parsed.tables).toEqual([
    {
      line: 24,
      columns: {
        id: 0,
        date: 1,
        surface: 2,
        observation: 3,
        rule: 4,
        category: 5,
        how: 6,
        state: 7,
        source: 8,
      },
    },
  ]);
  expect(parsed.ignoredTables.map((table) => table.columns)).toEqual([
    ["id", "ruling", "date"],
    ["state", "description"],
  ]);
  expect(parsed.ignoredColumns).toEqual([]);
  expect(parsed.rows).toHaveLength(19);
  expect(parsed.skipped.map((row) => [row.id, row.code])).toEqual([
    ["PB-012", "blank-rule"],
    ["PB-013", "duplicate-id"],
  ]);
  const byId = new Map(parsed.rows.map((row) => [row.id, row]));
  expect(byId.get("PB-004†")).toMatchObject({
    surface: "Settings",
    date: "2026-09-16",
    source: "director",
    state: "settings",
  });
  expect(byId.get("PB-014†")?.state).toBeUndefined();
  expect(byId.get("PB-007")?.state).toBe(
    "NEW: A text block with the inline editor open",
  );
});

test("cells split on unescaped pipes; \\| and <br> survive as text", () => {
  expect(splitCells("| a | b \\| c | d<br>e | f<br/>g |")).toEqual([
    "a",
    "b | c",
    "d e",
    "f g",
  ]);
  expect(splitCells("a | b")).toEqual(["a", "b"]);
});

test("the fixture: every body row is imported or skipped with its line, id and reason", async () => {
  const parsed = parseImportTable(await catalog());
  expect(parsed.rows).toHaveLength(20);
  expect(parsed.rows.length + parsed.skipped.length).toBe(25);
  expect(parsed.skipped).toEqual([
    { line: 38, code: "blank-id", reason: "blank id" },
    { line: 39, id: "M-19", code: "blank-rule", reason: "blank rule" },
    {
      line: 40,
      id: "M-03",
      code: "duplicate-id",
      reason: "duplicate id M-03 (first on line 22)",
    },
    {
      line: 41,
      id: "M-20",
      code: "too-many-cells",
      reason: "8 cells, header has 6; escape | in a cell as \\|",
    },
    { line: 42, code: "empty-row", reason: "empty row" },
  ]);
  const byId = new Map(parsed.rows.map((row) => [row.id, row]));
  expect(byId.get("M-01")).toEqual({
    line: 20,
    id: "M-01",
    observation: "The canvas text on the dark toolbar is hard to read",
    rule: "Text meets 4.5:1 contrast against its background",
    category: "Color",
    how: "`contrast`",
    check: undefined,
    state: "editor",
  });
  expect(byId.get("M-05")?.state).toBeUndefined();
  expect(byId.get("M-14")?.observation).toBe(
    'The "Grid | Free" toggle reads as one label',
  );
  expect(byId.get("M-18")?.observation).toBe(
    "Section padding differs between blocks on the canvas",
  );
  // The fenced example table is never read.
  expect(byId.has("X-1")).toBe(false);
  expect(parsed.ignoredTables).toEqual([
    {
      line: 7,
      columns: ["Week", "Misses"],
      missing: ["id", "observation", "rule"],
    },
  ]);
  expect(parsed.tables).toEqual([
    {
      line: 18,
      columns: {
        id: 0,
        observation: 1,
        rule: 2,
        category: 3,
        how: 4,
        state: 5,
      },
    },
  ]);
});

test("blank observation, unrecognised columns, and fewer cells padded as blanks", () => {
  const parsed = parseImportTable(
    table(
      ["| A-1 |  | A rule | x |", "| A-2 | Seen | A rule |", "| A-3 | Seen |"],
      "| ID | Observation | Rule | Owner |",
    ).replace("| --- | --- | --- |", "| --- | --- | --- | --- |"),
  );
  expect(parsed.rows.map((row) => row.id)).toEqual(["A-2"]);
  expect(parsed.skipped).toEqual([
    {
      line: 3,
      id: "A-1",
      code: "blank-observation",
      reason: "blank observation",
    },
    { line: 5, id: "A-3", code: "blank-rule", reason: "blank rule" },
  ]);
  expect(parsed.ignoredColumns).toEqual([
    { line: 1, column: 4, header: "Owner" },
  ]);
});

test("duplicate ids are caught across tables; the first wins", () => {
  const parsed = parseImportTable(
    [
      table(["| A-1 | One | Rule one |"]),
      "",
      table(["| A-1 | Two | Rule two |"]),
    ].join("\n"),
  );
  expect(parsed.rows).toEqual([
    expect.objectContaining({ id: "A-1", observation: "One" }),
  ]);
  expect(parsed.skipped).toEqual([
    {
      line: 7,
      id: "A-1",
      code: "duplicate-id",
      reason: "duplicate id A-1 (first on line 3)",
    },
  ]);
});

test("two columns claiming one role is an error naming both", () => {
  expect(() =>
    parseImportTable(
      "| ID | Rule | Observation | Principle |\n| - | - | - | - |\n| a | b | c | d |",
    ),
  ).toThrow("table on line 1: columns 2 and 4 both read as rule");
});

test("no qualifying table names the headers found and the accepted aliases", () => {
  expect(() =>
    parseImportTable("| Week | Misses |\n| --- | --- |\n| 1 | 2 |"),
  ).toThrow(
    /no table with id, observation and rule columns; found: "Week \| Misses"\. Accepted headers: id \(id, #, no, number, ref, key\); observation \(observation, miss, what was seen, issue, problem, finding, what was wrong, what went wrong, catch, description\); rule \(rule, general rule/,
  );
  expect(() => parseImportTable("Just prose.")).toThrow(
    "(no Markdown tables found)",
  );
});

test("named checks: hyphenated ids bare, single-word ids only backticked or idiom:-prefixed, the check column", () => {
  expect(namedChecks("measure target-size and overflow-clip")).toEqual([
    "overflow-clip",
    "target-size",
  ]);
  expect(namedChecks("the contrast ratio and motion, by eye")).toEqual([]);
  expect(namedChecks("`contrast`, then idiom:motion")).toEqual([
    "contrast",
    "motion",
  ]);
  // Whole tokens only: no id inside a longer hyphenated word.
  expect(namedChecks("pre-target-size-ish")).toEqual([]);
  expect(
    namedChecks(undefined, "idiom:contrast, target-size / motion"),
  ).toEqual(["contrast", "target-size", "motion"]);
  expect(namedChecks(undefined, "not-a-check")).toEqual([]);
});

test("import checks add the check a measured candidate maps to, once", () => {
  expect(importChecks({ how: "by eye" }, "component")).toEqual([
    "component-size",
  ]);
  expect(importChecks({ how: "component-size" }, "component")).toEqual([
    "component-size",
  ]);
  expect(importChecks({ how: "`contrast`" }, "glossary")).toEqual([
    "contrast",
    "copy-lint",
  ]);
  expect(importChecks({ how: "by eye" }, "ruling")).toEqual([]);
});
