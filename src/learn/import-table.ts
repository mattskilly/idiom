import { deterministicCheckIds } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import type { LearnedCandidate } from "../schemas/learned.js";
import { LEARNED_RULES } from "./misses.js";

/**
 * Reading a Markdown catalog of human-found misses: GitHub-flavoured tables
 * whose columns name an id, the observation and the general rule, and
 * optionally a category, how it could be checked, the check, the state that
 * would show it, and the row's surface, date and source as provenance.
 * Headers are matched forgivingly: case, emphasis, punctuation and any
 * parenthetical note are ignored. Pure: text in, rows and skip reasons out.
 */

export const importRoles = [
  "id",
  "observation",
  "rule",
  "category",
  "how",
  "check",
  "state",
  "surface",
  "date",
  "source",
] as const;
export type ImportRole = (typeof importRoles)[number];

/** The header words each column role accepts, exact first, then as a prefix. */
export const IMPORT_HEADER_ALIASES: Record<ImportRole, readonly string[]> = {
  id: ["id", "#", "no", "number", "ref", "key"],
  observation: [
    "observation",
    "miss",
    "what was seen",
    "issue",
    "problem",
    "finding",
    "what was wrong",
    "what went wrong",
    "catch",
    "description",
  ],
  rule: [
    "rule",
    "general rule",
    "generalised rule",
    "generalized rule",
    "principle",
  ],
  category: ["category", "type", "area"],
  how: [
    "how",
    "how to check",
    "how it could be checked",
    "detection",
    "checkable",
    "check",
  ],
  check: ["idiom check", "check id", "check ids"],
  state: [
    "state",
    "state that would show it",
    "where",
    "shows in",
    "idiom state",
    "capture state",
  ],
  surface: ["surface", "screen", "page", "view"],
  date: ["date", "when"],
  source: ["source", "sources", "found by", "reporter"],
};

const REQUIRED: readonly ImportRole[] = ["id", "observation", "rule"];

export type ImportRow = {
  line: number;
  id: string;
  observation: string;
  rule: string;
  category?: string | undefined;
  how?: string | undefined;
  check?: string | undefined;
  state?: string | undefined;
  surface?: string | undefined;
  date?: string | undefined;
  source?: string | undefined;
};

export const skipReasons = [
  "empty-row",
  "too-many-cells",
  "blank-id",
  "blank-observation",
  "blank-rule",
  "duplicate-id",
  "ambiguous-state",
  "unknown-flow",
] as const;
export type SkipReasonCode = (typeof skipReasons)[number];

export type SkippedRow = {
  line: number;
  id?: string | undefined;
  code: SkipReasonCode;
  /** One line for the human. */
  reason: string;
};

export type IgnoredTable = {
  line: number;
  columns: string[];
  missing: ImportRole[];
};

export type IgnoredColumn = { line: number; column: number; header: string };

export type ParsedImportTable = {
  rows: ImportRow[];
  skipped: SkippedRow[];
  tables: Array<{ line: number; columns: Partial<Record<ImportRole, number>> }>;
  ignoredTables: IgnoredTable[];
  ignoredColumns: IgnoredColumn[];
};

const DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Cells of one row: unescaped pipes split, one outer pipe each side dropped. */
export function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  const trimmed = line.trim();
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) cells.pop();
  return cells.map((cell) => cell.replace(/<br\s*\/?>/gi, " ").trim());
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * A header as its role matcher reads it: no emphasis, punctuation, case or
 * parenthetical note (`General rule (checkable law)` reads `general rule`).
 * A header that is only a note keeps the note's words.
 */
export function normalizeHeader(header: string): string {
  const plain = header.replace(/\*\*|__|`/g, "").trim();
  if (plain === "#") return "#";
  const unnoted = words(plain.replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
  return unnoted === "" ? words(plain) : unnoted;
}

export function headerRole(header: string): ImportRole | undefined {
  const normalized = normalizeHeader(header);
  if (normalized === "") return undefined;
  for (const role of importRoles)
    if (IMPORT_HEADER_ALIASES[role].includes(normalized)) return role;
  for (const role of importRoles)
    if (
      IMPORT_HEADER_ALIASES[role].some(
        (alias) => alias !== "#" && normalized.startsWith(`${alias} `),
      )
    )
      return role;
  return undefined;
}

const isRowLine = (line: string) => line.trim() !== "" && line.includes("|");

/** A table found in the text: its header line, headers and body lines. */
type RawTable = {
  line: number;
  headers: string[];
  body: Array<{ line: number; text: string }>;
};

function findTables(text: string): RawTable[] {
  const lines = text.split(/\r?\n/);
  const tables: RawTable[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const opener = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (
        opener !== undefined &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      )
        fence = undefined;
      continue;
    }
    if (opener !== undefined) {
      fence = opener;
      continue;
    }
    const next = lines[index + 1];
    if (!isRowLine(line) || next === undefined || !DELIMITER.test(next))
      continue;
    const table: RawTable = {
      line: index + 1,
      headers: splitCells(line),
      body: [],
    };
    index += 2;
    while (index < lines.length && isRowLine(lines[index] ?? "")) {
      if (FENCE.test(lines[index] ?? "")) break;
      table.body.push({ line: index + 1, text: lines[index] ?? "" });
      index += 1;
    }
    index -= 1;
    tables.push(table);
  }
  return tables;
}

/**
 * Every qualifying table's rows, in file order, with a skip for every body
 * row that is not imported. Never drops a row silently.
 */
export function parseImportTable(text: string): ParsedImportTable {
  const result: ParsedImportTable = {
    rows: [],
    skipped: [],
    tables: [],
    ignoredTables: [],
    ignoredColumns: [],
  };
  const found = findTables(text);
  const seen = new Map<string, number>();
  for (const table of found) {
    const columns: Partial<Record<ImportRole, number>> = {};
    const ignored: IgnoredColumn[] = [];
    // A bare `Check` header reads as how, unless the table has another how
    // column: then it is the check-id column, as in `How | Check` tables.
    const bareCheck = (index: number) =>
      normalizeHeader(table.headers[index] ?? "") === "check";
    for (const [index, header] of table.headers.entries()) {
      const role = headerRole(header);
      if (role === undefined) {
        ignored.push({ line: table.line, column: index + 1, header });
        continue;
      }
      const earlier = columns[role];
      if (
        role === "how" &&
        earlier !== undefined &&
        columns.check === undefined &&
        bareCheck(index) !== bareCheck(earlier)
      ) {
        if (bareCheck(earlier)) columns.how = index;
        columns.check = bareCheck(earlier) ? earlier : index;
        continue;
      }
      if (earlier !== undefined)
        throw new IdiomError(
          `table on line ${table.line}: columns ${earlier + 1} and ${index + 1} both read as ${role}`,
        );
      columns[role] = index;
    }
    const howIsCheck =
      columns.how !== undefined &&
      columns.check === undefined &&
      bareCheck(columns.how);
    const missing = REQUIRED.filter((role) => columns[role] === undefined);
    if (missing.length > 0) {
      result.ignoredTables.push({
        line: table.line,
        columns: table.headers,
        missing,
      });
      continue;
    }
    result.tables.push({ line: table.line, columns });
    result.ignoredColumns.push(...ignored);
    const width = table.headers.length;
    for (const { line, text: rowText } of table.body) {
      const cells = splitCells(rowText);
      const cell = (role: ImportRole): string => {
        const index = columns[role];
        return index === undefined ? "" : (cells[index] ?? "");
      };
      const optional = (role: ImportRole) => cell(role) || undefined;
      const id = cell("id") || undefined;
      const skip = (code: SkipReasonCode, reason: string) =>
        result.skipped.push({ line, ...(id ? { id } : {}), code, reason });
      if (cells.every((value) => value === "")) {
        skip("empty-row", "empty row");
        continue;
      }
      if (cells.slice(width).some((value) => value !== "")) {
        skip(
          "too-many-cells",
          `${cells.length} cells, header has ${width}; escape | in a cell as \\|`,
        );
        continue;
      }
      if (id === undefined) {
        skip("blank-id", "blank id");
        continue;
      }
      if (cell("observation") === "") {
        skip("blank-observation", "blank observation");
        continue;
      }
      if (cell("rule") === "") {
        skip("blank-rule", "blank rule");
        continue;
      }
      const first = seen.get(id);
      if (first !== undefined) {
        skip("duplicate-id", `duplicate id ${id} (first on line ${first})`);
        continue;
      }
      seen.set(id, line);
      result.rows.push({
        line,
        id,
        observation: cell("observation"),
        rule: cell("rule"),
        category: optional("category"),
        how: optional("how"),
        check: howIsCheck ? optional("how") : optional("check"),
        state: optional("state"),
        surface: optional("surface"),
        date: optional("date"),
        source: optional("source"),
      });
    }
  }
  if (result.tables.length === 0) {
    const headers = found.map((table) => table.headers.join(" | "));
    throw new IdiomError(
      `no table with id, observation and rule columns${headers.length === 0 ? " (no Markdown tables found)" : `; found: ${headers.map((header) => `"${header}"`).join(", ")}`}. Accepted headers: ${REQUIRED.map((role) => `${role} (${IMPORT_HEADER_ALIASES[role].join(", ")})`).join("; ")}`,
    );
  }
  return result;
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The shipped check ids a row names, in registry order: any id in the
 * `check` cell; in `how`, hyphenated ids as whole tokens, single-word ids
 * only when backticked or written `idiom:<id>` (bare English would over-match).
 */
export function namedChecks(
  how?: string | undefined,
  check?: string | undefined,
): string[] {
  const tokens = new Set(
    (check ?? "")
      .toLowerCase()
      .split(/[\s,/]+/)
      .map((token) => token.replace(/`/g, "").replace(/^idiom:/, ""))
      .filter((token) => token !== ""),
  );
  const text = how ?? "";
  return deterministicCheckIds.filter((id) => {
    if (tokens.has(id)) return true;
    if (text === "") return false;
    const quoted = escapeRegExp(id);
    if (id.includes("-"))
      return new RegExp(`(?<![\\w-])${quoted}(?![\\w-])`, "i").test(text);
    return new RegExp(`\`${quoted}\`|idiom:${quoted}(?![\\w-])`, "i").test(
      text,
    );
  });
}

/**
 * The checks a row names, plus the check its measured candidate maps to (a
 * law's own check, passed as `lawCheck`).
 */
export function importChecks(
  row: Pick<ImportRow, "how" | "check">,
  kind: LearnedCandidate["kind"],
  lawCheck?: string | undefined,
): string[] {
  const named = namedChecks(row.how, row.check);
  // A law maps to the check it measures when known; otherwise only the
  // checks the row names count.
  const mapped =
    kind === "ruling"
      ? undefined
      : kind === "law"
        ? lawCheck
        : LEARNED_RULES[kind].check;
  if (mapped === undefined || named.includes(mapped)) return named;
  const all = new Set([...named, mapped]);
  return deterministicCheckIds.filter((id) => all.has(id));
}
