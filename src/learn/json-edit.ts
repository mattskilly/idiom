import { isDeepStrictEqual } from "node:util";

type JsonNode =
  | { kind: "object"; start: number; end: number; entries: Entry[] }
  | { kind: "array"; start: number; end: number; items: JsonNode[] }
  | { kind: "value"; start: number; end: number };
type Entry = { key: string; node: JsonNode };

function parse(source: string): JsonNode {
  let index = 0;
  const space = () => {
    while (/\s/.test(source[index] ?? "")) index += 1;
  };
  const string = (): string => {
    const start = index;
    index += 1;
    while (source[index] !== '"') {
      if (source[index] === "\\") index += 1;
      index += 1;
      if (index >= source.length) throw new Error("unterminated string");
    }
    index += 1;
    return JSON.parse(source.slice(start, index)) as string;
  };
  const value = (): JsonNode => {
    space();
    const start = index;
    const char = source[index];
    if (char === "{") {
      index += 1;
      const entries: Entry[] = [];
      space();
      if (source[index] === "}") {
        index += 1;
        return { kind: "object", start, end: index, entries };
      }
      for (;;) {
        space();
        const key = string();
        space();
        if (source[index] !== ":") throw new Error("expected :");
        index += 1;
        entries.push({ key, node: value() });
        space();
        if (source[index] === ",") {
          index += 1;
          continue;
        }
        if (source[index] !== "}") throw new Error("expected }");
        index += 1;
        return { kind: "object", start, end: index, entries };
      }
    }
    if (char === "[") {
      index += 1;
      const items: JsonNode[] = [];
      space();
      if (source[index] === "]") {
        index += 1;
        return { kind: "array", start, end: index, items };
      }
      for (;;) {
        items.push(value());
        space();
        if (source[index] === ",") {
          index += 1;
          continue;
        }
        if (source[index] !== "]") throw new Error("expected ]");
        index += 1;
        return { kind: "array", start, end: index, items };
      }
    }
    if (char === '"') {
      string();
      return { kind: "value", start, end: index };
    }
    while (index < source.length && !/[\s,\]}]/.test(source[index] ?? ""))
      index += 1;
    if (index === start) throw new Error("unexpected token");
    return { kind: "value", start, end: index };
  };
  const root = value();
  space();
  if (index !== source.length) throw new Error("trailing content");
  return root;
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? "";
}

function pretty(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split("\n").join(`\n${indent}`);
}

/** Insert one member after a container's last member, or into an empty one. */
function insertMember(
  source: string,
  container: { start: number; end: number },
  last: JsonNode | undefined,
  member: (indent: string, inline: boolean) => string,
): string {
  const outer = lineIndent(source, container.start);
  if (last === undefined) {
    const indent = `${outer}  `;
    return `${source.slice(0, container.start + 1)}\n${indent}${member(indent, false)}\n${outer}${source.slice(container.end - 1)}`;
  }
  const inline = !source.slice(container.start, container.end).includes("\n");
  if (inline)
    return `${source.slice(0, last.end)}, ${member("", true)}${source.slice(last.end)}`;
  const indent = lineIndent(source, last.start);
  return `${source.slice(0, last.end)},\n${indent}${member(indent, false)}${source.slice(last.end)}`;
}

/**
 * Append `item` to the array at `path` in a JSON document, creating missing
 * objects and the array, while leaving every other byte as written so the
 * human's diff shows only what was learned. Returns undefined when the text
 * cannot be edited in place; the caller then re-serialises.
 */
export function appendJsonArrayItem(
  source: string,
  path: Array<string | number>,
  item: unknown,
): string | undefined {
  let root: JsonNode;
  let expected: unknown;
  try {
    root = parse(source);
    expected = JSON.parse(source);
  } catch {
    return undefined;
  }
  let node: JsonNode = root;
  let cursor = expected as Record<string | number, unknown>;
  for (const [depth, segment] of path.entries()) {
    const rest = path.slice(depth + 1);
    const last = depth === path.length - 1;
    if (typeof segment === "number") {
      if (node.kind !== "array") return undefined;
      const next: JsonNode | undefined = node.items[segment];
      if (next === undefined) return undefined;
      node = next;
      cursor = cursor[segment] as Record<string | number, unknown>;
      continue;
    }
    if (node.kind !== "object") return undefined;
    const entry: Entry | undefined = node.entries.find(
      (candidate) => candidate.key === segment,
    );
    if (entry === undefined) {
      // Build the missing tail and add it as a new property here.
      if (rest.some((part) => typeof part === "number")) return undefined;
      let created: unknown = [item];
      for (const key of [...rest].reverse()) created = { [key]: created };
      cursor[segment] = created;
      const edited = insertMember(
        source,
        node,
        node.entries.at(-1)?.node,
        (indent, inline) =>
          `${JSON.stringify(segment)}: ${inline ? JSON.stringify(created) : pretty(created, indent)}`,
      );
      return verified(edited, expected);
    }
    node = entry.node;
    if (last) {
      if (node.kind !== "array") return undefined;
      const list = cursor[segment];
      if (!Array.isArray(list)) return undefined;
      list.push(item);
      const edited = insertMember(
        source,
        node,
        node.items.at(-1),
        (indent, inline) =>
          inline ? JSON.stringify(item) : pretty(item, indent),
      );
      return verified(edited, expected);
    }
    cursor = cursor[segment] as Record<string | number, unknown>;
  }
  return undefined;
}

function verified(edited: string, expected: unknown): string | undefined {
  try {
    return isDeepStrictEqual(JSON.parse(edited), expected) ? edited : undefined;
  } catch {
    return undefined;
  }
}

/** Set one object path, preserving all bytes outside the affected value. */
export function setJsonValue(
  source: string,
  path: string[],
  value: unknown,
): string | undefined {
  let node: JsonNode;
  let expected: Record<string, unknown>;
  try {
    node = parse(source);
    expected = JSON.parse(source);
  } catch {
    return undefined;
  }
  let cursor = expected;
  for (const [index, key] of path.entries()) {
    if (node.kind !== "object") return undefined;
    const entry = node.entries.find((e) => e.key === key);
    if (!entry) {
      let created = value;
      for (const part of path.slice(index + 1).reverse())
        created = { [part]: created };
      cursor[key] = created;
      return verified(
        insertMember(
          source,
          node,
          node.entries.at(-1)?.node,
          (indent, inline) =>
            `${JSON.stringify(key)}: ${inline ? JSON.stringify(created) : pretty(created, indent)}`,
        ),
        expected,
      );
    }
    if (index === path.length - 1) {
      cursor[key] = value;
      return verified(
        source.slice(0, entry.node.start) +
          pretty(value, lineIndent(source, entry.node.start)) +
          source.slice(entry.node.end),
        expected,
      );
    }
    node = entry.node;
    cursor = cursor[key] as Record<string, unknown>;
  }
  return undefined;
}
