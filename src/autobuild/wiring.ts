import { parse, type TomlTable, type TomlValue } from "smol-toml";

type SourceTable = {
  name: string;
  headerStart: number;
  bodyStart: number;
  end: number;
};

export type AutobuildWiringPlan =
  | {
      kind: "ready";
      original: string;
      candidate: string;
      diff: string;
      complete: boolean;
      manualAddition: string;
    }
  | {
      kind: "manual";
      original: string;
      candidate: string;
      diff: string;
      complete: false;
      manualAddition: string;
      reason: string;
    };

export const gateCommand = "idiom check --gate --fail-on major --deferred warn";
const canonicalCommandPattern =
  /^idiom verify ([A-Za-z0-9][A-Za-z0-9._-]*) --spec \.ab\/spec\.md --out \.ab\/idiom$/;

function isRecord(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCompatibleIdiomCommand(value: unknown): boolean {
  return (
    typeof value === "string" &&
    canonicalCommandPattern.test(
      value
        .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
        .split(/[\t\n\f\r ]+/)
        .join(" "),
    )
  );
}

function newlineOf(source: string): "\r\n" | "\n" {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function endsWithNewline(source: string): boolean {
  return source.endsWith("\n");
}

export function structuralMask(source: string): string {
  const output = [...source];
  let index = 0;
  let mode: "normal" | "comment" | "basic" | "literal" = "normal";
  let multiline = false;

  const blank = (position: number): void => {
    if (source[position] !== "\n" && source[position] !== "\r")
      output[position] = " ";
  };

  while (index < source.length) {
    const char = source[index];
    if (mode === "comment") {
      if (char === "\n") mode = "normal";
      else blank(index);
      index += 1;
      continue;
    }
    if (mode === "basic" || mode === "literal") {
      const quote = mode === "basic" ? '"' : "'";
      if (multiline && source.startsWith(quote.repeat(3), index)) {
        index += 3;
        mode = "normal";
        multiline = false;
        continue;
      }
      if (!multiline && char === quote) {
        index += 1;
        mode = "normal";
        continue;
      }
      if (mode === "basic" && char === "\\") {
        blank(index);
        if (index + 1 < source.length) blank(index + 1);
        index += 2;
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }
    if (char === "#") {
      blank(index);
      mode = "comment";
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quoteMode = char === '"' ? "basic" : "literal";
      multiline = source.startsWith(char.repeat(3), index);
      mode = quoteMode;
      const count = multiline ? 3 : 1;
      index += count;
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function sourceLines(source: string): Array<{
  start: number;
  end: number;
  next: number;
  text: string;
}> {
  const lines: Array<{
    start: number;
    end: number;
    next: number;
    text: string;
  }> = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const next = newline === -1 ? source.length : newline + 1;
    let end = newline === -1 ? source.length : newline;
    if (end > start && source[end - 1] === "\r") end -= 1;
    lines.push({ start, end, next, text: source.slice(start, end) });
    start = next;
  }
  return lines;
}

function analyzeTables(source: string): {
  mask: string;
  tables: SourceTable[];
} {
  const mask = structuralMask(source);
  const headers: Array<{
    name: string | undefined;
    start: number;
    next: number;
  }> = [];
  for (const line of sourceLines(mask)) {
    const trimmed = line.text.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) continue;
    const supported = /^\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\]$/.exec(
      trimmed,
    );
    headers.push({ name: supported?.[1], start: line.start, next: line.next });
  }
  const tables: SourceTable[] = [];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (header === undefined) continue;
    if (header.name === undefined) continue;
    tables.push({
      name: header.name,
      headerStart: header.start,
      bodyStart: header.next,
      end: headers[index + 1]?.start ?? source.length,
    });
  }
  return { mask, tables };
}

function uniqueTable(source: string, name: string): SourceTable | undefined {
  const matches = analyzeTables(source).tables.filter(
    (table) => table.name === name,
  );
  if (matches.length > 1)
    throw new Error(`the [${name}] table is declared more than once`);
  return matches[0];
}

function assignmentValueSpan(
  source: string,
  tableName: string,
  key: string,
): { start: number; end: number } | undefined {
  const analysis = analyzeTables(source);
  const table = analysis.tables.find((entry) => entry.name === tableName);
  if (table === undefined) return undefined;
  const matches: Array<{ start: number; end: number }> = [];
  for (const line of sourceLines(
    analysis.mask.slice(table.bodyStart, table.end),
  )) {
    const match = new RegExp(`^\\s*${key.replaceAll("-", "\\-")}\\s*=`).exec(
      line.text,
    );
    if (match === null) continue;
    let start = table.bodyStart + line.start + match[0].length;
    while (/\s/.test(analysis.mask[start] ?? "")) start += 1;
    if (analysis.mask[start] !== "[")
      matches.push({ start, end: table.bodyStart + line.end });
    else {
      let depth = 0;
      let end = -1;
      for (let index = start; index < table.end; index += 1) {
        if (analysis.mask[index] === "[") depth += 1;
        if (analysis.mask[index] === "]") {
          depth -= 1;
          if (depth === 0) {
            end = index + 1;
            break;
          }
        }
      }
      if (end === -1)
        throw new Error(`${tableName}.${key} has no complete array`);
      matches.push({ start, end });
    }
  }
  if (matches.length > 1)
    throw new Error(`${tableName}.${key} is declared more than once`);
  return matches[0];
}

function addTableAtEnd(source: string, header: string, body: string[]): string {
  const newline = newlineOf(source);
  const finalNewline = endsWithNewline(source);
  const block = [`[${header}]`, ...body].join(newline);
  if (source.length === 0) return block;
  const withoutFinal = finalNewline ? source.slice(0, -newline.length) : source;
  return `${withoutFinal}${newline}${newline}${block}${finalNewline ? newline : ""}`;
}

function addAssignmentToTable(
  source: string,
  tableName: string,
  assignment: string,
): string {
  const table = uniqueTable(source, tableName);
  if (table === undefined)
    return addTableAtEnd(source, tableName, [assignment]);
  const newline = newlineOf(source);
  const body = source.slice(table.bodyStart, table.end);
  const trailingWhitespace = /[\t\r\n ]*$/.exec(body);
  const position = table.bodyStart + (trailingWhitespace?.index ?? body.length);
  const prefix = source.slice(0, position);
  const separator = endsWithNewline(prefix) ? "" : newline;
  const suffix = source.slice(position);
  const terminator =
    /^[\t ]*\r?\n/.test(suffix) || table.end === source.length ? "" : newline;
  return `${prefix}${separator}${assignment}${terminator}${suffix}`;
}

function insertVerifyParent(source: string, stepName: string): string {
  const analysis = analyzeTables(source);
  const child = analysis.tables.find((table) =>
    table.name.startsWith("verify."),
  );
  const childNames = analysis.tables
    .map((table) => /^verify\.([A-Za-z0-9_-]+)$/.exec(table.name)?.[1])
    .filter((name): name is string => name !== undefined);
  const selected = [...new Set([...childNames, stepName])];
  const newline = newlineOf(source);
  if (child === undefined)
    return addTableAtEnd(source, "verify", [
      `steps = [${selected.map((name) => JSON.stringify(name)).join(", ")}]`,
    ]);
  return `${source.slice(0, child.headerStart)}[verify]${newline}steps = [${selected.map((name) => JSON.stringify(name)).join(", ")}]${newline}${newline}${source.slice(child.headerStart)}`;
}

function appendIdiomToArray(
  source: string,
  span: { start: number; end: number },
  stepName: string,
): string {
  const array = source.slice(span.start, span.end);
  const mask = structuralMask(array);
  let last = mask.length - 2;
  while (last > 0 && /\s/.test(mask[last] ?? "")) last -= 1;
  if (last === 0)
    return `${source.slice(0, span.start + 1)}${JSON.stringify(stepName)}${source.slice(span.start + 1)}`;

  const close = array.length - 1;
  const closeLineStart = Math.max(array.lastIndexOf("\n", close - 1) + 1, 0);
  const beforeClose = mask.slice(closeLineStart, close).trim();
  if (!array.includes("\n") || beforeClose.length > 0) {
    const insertion = `${mask[last] === "," ? "" : ","} ${JSON.stringify(stepName)}`;
    const absolute = span.start + last + 1;
    return `${source.slice(0, absolute)}${insertion}${source.slice(absolute)}`;
  }

  const newline = newlineOf(source);
  const lastLineStart = Math.max(array.lastIndexOf("\n", last - 1) + 1, 0);
  const lastLine = array.slice(lastLineStart, last + 1);
  const indent = /^\s*/.exec(lastLine)?.[0] ?? "  ";
  let updated = array;
  if (mask[last] !== ",")
    updated = `${updated.slice(0, last + 1)},${updated.slice(last + 1)}`;
  const adjustedCloseLineStart = closeLineStart + (mask[last] === "," ? 0 : 1);
  updated = `${updated.slice(0, adjustedCloseLineStart)}${indent}${JSON.stringify(stepName)}${newline}${updated.slice(adjustedCloseLineStart)}`;
  return `${source.slice(0, span.start)}${updated}${source.slice(span.end)}`;
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function createAutobuildDiff(
  original: string,
  candidate: string,
  path = "autobuild.toml",
): string {
  if (original === candidate) return "";
  const before = splitLines(original);
  const after = splitLines(candidate);
  const rows = before.length + 1;
  const columns = after.length + 1;
  const lengths = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0),
  );
  const lengthAt = (left: number, right: number): number =>
    lengths[left]?.[right] ?? 0;
  for (let left = before.length - 1; left >= 0; left -= 1)
    for (let right = after.length - 1; right >= 0; right -= 1)
      (lengths[left] as number[])[right] =
        before[left] === after[right]
          ? lengthAt(left + 1, right + 1) + 1
          : Math.max(lengthAt(left + 1, right), lengthAt(left, right + 1));

  const changes: Array<{ kind: " " | "+" | "-"; line: string }> = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (before[left] === after[right]) {
      changes.push({ kind: " ", line: before[left] as string });
      left += 1;
      right += 1;
    } else if (
      right < after.length &&
      (left === before.length ||
        lengthAt(left, right + 1) > lengthAt(left + 1, right))
    ) {
      changes.push({ kind: "+", line: after[right] as string });
      right += 1;
    } else {
      changes.push({ kind: "-", line: before[left] as string });
      left += 1;
    }
  }
  const context = 3;
  const windows: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < changes.length; index += 1) {
    if (changes[index]?.kind === " ") continue;
    const start = Math.max(0, index - context);
    const end = Math.min(changes.length, index + context + 1);
    const previous = windows.at(-1);
    if (previous !== undefined && start <= previous.end) previous.end = end;
    else windows.push({ start, end });
  }

  const hunks = windows.map((window) => {
    const preceding = changes.slice(0, window.start);
    const selected = changes.slice(window.start, window.end);
    const oldStart =
      preceding.filter((change) => change.kind !== "+").length + 1;
    const newStart =
      preceding.filter((change) => change.kind !== "-").length + 1;
    const oldCount = selected.filter((change) => change.kind !== "+").length;
    const newCount = selected.filter((change) => change.kind !== "-").length;
    const body = selected
      .map((change) => `${change.kind}${change.line}`)
      .join("\n");
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
  });
  return `--- ${original ? `a/${path}` : "/dev/null"}\n+++ b/${path}\n${hunks.join("\n")}\n`;
}

function manualPlan(
  original: string,
  manualAddition: string,
  reason: string,
): AutobuildWiringPlan {
  return {
    kind: "manual",
    original,
    candidate: original,
    diff: "",
    complete: false,
    manualAddition,
    reason,
  };
}

export function isValidAutobuildPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path)
  )
    return false;
  return path.split("/").every((segment) => {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      /[[\]{}!\\]/.test(segment)
    )
      return false;
    return !segment.includes("**") || segment === "**";
  });
}

export function planAutobuildWiring(
  original: string,
  manualAddition: string,
): AutobuildWiringPlan {
  try {
    const document = parse(original);
    const template = parse(manualAddition);
    const tc = template.commands;
    const tv = template.verify;
    if (!isRecord(tc) || !isRecord(tv))
      throw new Error("Invalid shipped template");
    const stepName = Object.keys(tv).find((key) => key !== "steps");
    if (!stepName || !isRecord(tv[stepName]))
      throw new Error("Invalid shipped step");
    const expected = tv[stepName];
    const gate = stepName === "idiom-check";
    const commandKey = gate ? "idiom-check" : "idiom-verify";
    const expectedCommand = tc[commandKey];
    if (typeof expectedCommand !== "string")
      throw new Error("Invalid shipped command");
    const commands = document.commands;
    const verify = document.verify;
    if (commands !== undefined && !isRecord(commands))
      throw new Error("[commands] is not a table");
    if (verify !== undefined && !isRecord(verify))
      throw new Error("[verify] is not a table");
    const command = commands?.[commandKey];
    const normalized =
      typeof command === "string"
        ? command
            .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
            .split(/[\t\n\f\r ]+/)
            .join(" ")
        : command;
    if (
      command !== undefined &&
      (gate
        ? normalized !== gateCommand &&
          normalized !== "idiom check --gate --fail-on major"
        : !isCompatibleIdiomCommand(command))
    )
      throw new Error(
        `[commands].${commandKey} is owned by a different or incompatible command`,
      );
    const steps = verify?.steps;
    if (
      steps !== undefined &&
      (!Array.isArray(steps) || steps.some((step) => typeof step !== "string"))
    )
      throw new Error("verify.steps is not a string array");
    const count = Array.isArray(steps)
      ? steps.filter((step) => step === stepName).length
      : 0;
    if (count > 1)
      throw new Error(`verify.steps selects "${stepName}" more than once`);
    const existing = verify?.[stepName];
    if (
      existing !== undefined &&
      (!isRecord(existing) ||
        (gate
          ? !(
              (existing.kind === "check" && existing.command === commandKey) ||
              (existing.kind === "agent" && existing.skill === "idiom-verify")
            ) ||
            Object.keys(existing).some(
              (key) =>
                ![
                  "kind",
                  "command",
                  "skill",
                  "paths",
                  "always",
                  "afterReconcile",
                ].includes(key),
            ) ||
            (existing.kind === "agent" && existing.command !== undefined) ||
            (existing.kind === "check" && existing.skill !== undefined)
          : existing.kind !== expected.kind ||
            existing.skill !== "idiom-verify") ||
        (existing.paths !== undefined &&
          (!Array.isArray(existing.paths) ||
            !existing.paths.length ||
            !existing.paths.every(isValidAutobuildPath))))
    )
      throw new Error(
        `[verify.${stepName}] is owned by a different or incompatible verify step`,
      );
    let candidate = original;
    if (command === undefined)
      candidate = addAssignmentToTable(
        candidate,
        "commands",
        `${commandKey} = ${JSON.stringify(expectedCommand)}`,
      );
    else if (gate && normalized !== gateCommand)
      candidate = replaceScalar(
        candidate,
        "commands",
        commandKey,
        JSON.stringify(gateCommand),
      );
    if (!count) {
      if (uniqueTable(candidate, "verify") === undefined)
        candidate = insertVerifyParent(candidate, stepName);
      else if (steps === undefined)
        candidate = addAssignmentToTable(
          candidate,
          "verify",
          `steps = [${JSON.stringify(stepName)}]`,
        );
      else {
        const span = assignmentValueSpan(candidate, "verify", "steps");
        if (!span) throw new Error("verify.steps has no patchable source span");
        candidate = appendIdiomToArray(candidate, span, stepName);
      }
    }
    if (existing === undefined)
      candidate = addTableAtEnd(
        candidate,
        `verify.${stepName}`,
        Object.entries(expected).map(
          ([key, value]) => `${key} = ${JSON.stringify(value)}`,
        ),
      );
    else if (gate && isRecord(existing) && existing.paths !== undefined) {
      const span = assignmentValueSpan(
        candidate,
        `verify.${stepName}`,
        "paths",
      );
      if (!span) throw new Error("paths has no patchable source span");
      const start = candidate.lastIndexOf("\n", span.start) + 1;
      candidate =
        candidate.slice(0, start) +
        candidate
          .slice(span.end)
          .replace(/^[ \t]*(?=\r?\n)/, "")
          .replace(/^\r?\n/, "");
    }
    if (gate && isRecord(existing) && existing.kind === "check") {
      candidate = replaceScalar(
        candidate,
        `verify.${stepName}`,
        "kind",
        '"agent"',
      );
      const span = assignmentValueSpan(
        candidate,
        `verify.${stepName}`,
        "command",
      );
      if (!span) throw new Error("command has no patchable source span");
      const start = candidate.lastIndexOf("\n", span.start) + 1;
      const line = candidate.slice(start, span.start);
      candidate =
        candidate.slice(0, start) +
        line.replace(/command(\s*=\s*)$/, "skill$1") +
        '"idiom-verify"' +
        candidate
          .slice(span.end)
          .replace(
            /^/,
            candidate.slice(span.start, span.end).match(/([ \t]*#.*)$/)?.[1] ??
              "",
          );
    }
    if (!endsWithNewline(original) && endsWithNewline(candidate))
      candidate = candidate.slice(0, -newlineOf(candidate).length);
    const after = parse(candidate);
    const ac = after.commands;
    const av = after.verify;
    if (
      !isRecord(ac) ||
      !isRecord(av) ||
      !Array.isArray(av.steps) ||
      av.steps.filter((step) => step === stepName).length !== 1 ||
      !isRecord(av[stepName]) ||
      av[stepName].kind !== expected.kind ||
      (gate
        ? (ac[commandKey] !== gateCommand && normalized !== gateCommand) ||
          av[stepName].skill !== "idiom-verify" ||
          av[stepName].paths !== undefined
        : !isCompatibleIdiomCommand(ac[commandKey]) ||
          av[stepName].skill !== "idiom-verify")
    )
      throw new Error("Patched configuration did not validate semantically");
    if (endsWithNewline(candidate) !== endsWithNewline(original))
      throw new Error("Patch changed trailing-newline convention");
    return {
      kind: "ready",
      original,
      candidate,
      diff: createAutobuildDiff(original, candidate),
      complete: original === candidate,
      manualAddition,
    };
  } catch (error) {
    return manualPlan(
      original,
      manualAddition,
      `Autobuild configuration could not be edited safely: ${(error as Error).message}`,
    );
  }
}

function replaceScalar(
  source: string,
  table: string,
  key: string,
  value: string,
): string {
  const span = assignmentValueSpan(source, table, key);
  if (!span) throw new Error(`${table}.${key} has no patchable source span`);
  // Preserve comments, including # inside quoted scalar values.
  const tail = source.slice(span.start, span.end);
  const match = /^("(?:[^"\\]|\\.)*"|'[^']*')([ \t]*(?:#.*)?)$/.exec(tail);
  if (!match)
    throw new Error(`${table}.${key} has an unsupported scalar shape`);
  return (
    source.slice(0, span.start) + value + match[2] + source.slice(span.end)
  );
}

export function renameVerifierReferences(source: string): string {
  const document = parse(source);
  if (!isRecord(document.verify)) return source;
  let candidate = source;
  for (const [name, step] of Object.entries(document.verify)) {
    if (isRecord(step) && step.skill === "ab-verify-idiom")
      candidate = replaceScalar(
        candidate,
        `verify.${name}`,
        "skill",
        '"idiom-verify"',
      );
  }
  const after = parse(candidate);
  if (
    isRecord(after.verify) &&
    Object.values(after.verify).some(
      (step) => isRecord(step) && step.skill === "ab-verify-idiom",
    )
  )
    throw new Error("Unpatchable legacy reference");
  return candidate;
}
