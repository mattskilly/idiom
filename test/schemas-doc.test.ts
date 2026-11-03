import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { findingSchema } from "../src/schemas/finding.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const root = join(import.meta.dirname, "..");
let markdown = "";

beforeAll(async () => {
  markdown = await readFile(join(root, "docs", "schemas.md"), "utf8");
});

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

/** The contents of every ```ts fence in `text`. */
function tsFences(text: string): string[] {
  return [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
}

/** From the `(` at `open` to its matching `)`, inclusive; skips quoted text. */
function balancedCall(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced call at: ${text.slice(open, open + 60)}`);
}

/** Top-level argument count of a balanced `( … )` call. */
function topLevelArgs(call: string): number {
  const inner = call.slice(1, -1);
  if (inner.trim() === "") return 0;
  let depth = 0;
  let commas = 0;
  for (const char of inner) {
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) commas++;
  }
  return commas + 1;
}

/** The line of `text` containing offset `index`. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

/** The ts fences between `heading` and the next `## ` heading. */
function sectionFences(heading: string): string {
  const start = markdown.indexOf(`\n${heading}`);
  if (start === -1) throw new Error(`missing section: ${heading}`);
  const end = markdown.indexOf("\n## ", start + 1);
  return tsFences(markdown.slice(start, end === -1 ? undefined : end)).join(
    "\n",
  );
}

/** Every `key: z.record(…)` expression in a section, with trailing modifiers. */
function fieldExpressions(heading: string, key: string): string[] {
  const code = sectionFences(heading);
  const expressions: string[] = [];
  for (const match of code.matchAll(
    new RegExp(`\\b${key}: z\\.record\\(`, "g"),
  )) {
    const start = (match.index ?? 0) + key.length + 2;
    const open = start + "z.record".length;
    let expression = `z.record${balancedCall(code, open)}`;
    let rest = code.slice(open + expression.length - "z.record".length);
    for (;;) {
      const modifier = /^\.(optional|default)\(/.exec(rest);
      if (!modifier) break;
      const call = balancedCall(rest, modifier[0].length - 1);
      const text = `.${modifier[1]}${call}`;
      expression += text;
      rest = rest.slice(text.length);
    }
    expressions.push(expression);
  }
  return expressions;
}

/** Builds a documented expression against the installed zod. */
function documentedSchema(expression: string): z.ZodType {
  return new Function("z", `return ${expression}`)(z) as z.ZodType;
}

type FieldResult = { success: boolean; value?: unknown };

const probes: { name: string; value: unknown }[] = [
  { name: "string map", value: { A: "1" } },
  { name: "empty map", value: {} },
  { name: "number value", value: { A: 1 } },
  { name: "non-object", value: "x" },
  { name: "omitted", value: undefined },
];

function setField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

let projectFixture: Record<string, unknown>;
let findingFixture: Record<string, unknown>;

beforeAll(async () => {
  projectFixture = await json("examples/booking/.idiom/project.json");
  findingFixture = await json("examples/booking/records/finding.json");
});

function webFlow(env: unknown) {
  const step: Record<string, unknown> = { run: "true" };
  setField(step, "env", env);
  return {
    id: "example",
    title: "Example",
    intent: [],
    setup: [step],
    states: [{ id: "home", description: "Home", url: "/", expect: {} }],
  };
}

function electronFlow(env: unknown) {
  const launch: Record<string, unknown> = { executablePath: "electron" };
  setField(launch, "env", env);
  return {
    id: "desktop",
    title: "Desktop",
    intent: [],
    setup: [],
    target: { kind: "electron", launch, window: { title: "Fixture" } },
    states: [{ id: "home", description: "Home", steps: [], expect: {} }],
  };
}

const fields: {
  name: string;
  heading: string;
  key: string;
  occurrence: number;
  count: number;
  parseWith: (value: unknown) => FieldResult;
}[] = [
  {
    name: "server.env",
    heading: "## 1. Project",
    key: "env",
    occurrence: 0,
    count: 1,
    parseWith(value) {
      const project = structuredClone(projectFixture);
      const server = { ...(project.server as Record<string, unknown>) };
      setField(server, "env", value);
      project.server = server;
      const parsed = projectSchema.safeParse(project);
      return parsed.success
        ? { success: true, value: parsed.data.server.env }
        : { success: false };
    },
  },
  {
    name: "setup[].env",
    heading: "## 2. Flow manifest",
    key: "env",
    occurrence: 0,
    count: 2,
    parseWith(value) {
      const parsed = flowSchema.safeParse(webFlow(value));
      return parsed.success
        ? { success: true, value: parsed.data.setup[0]?.env }
        : { success: false };
    },
  },
  {
    name: "Electron target.launch.env",
    heading: "## 2. Flow manifest",
    key: "env",
    occurrence: 1,
    count: 2,
    parseWith(value) {
      const parsed = flowSchema.safeParse(electronFlow(value));
      if (!parsed.success) return { success: false };
      const target = parsed.data.target;
      return {
        success: true,
        value: target.kind === "electron" ? target.launch.env : undefined,
      };
    },
  },
  {
    name: "verification.params",
    heading: "## 4. Finding",
    key: "params",
    occurrence: 0,
    count: 1,
    parseWith(value) {
      const finding = structuredClone(findingFixture);
      const verification = {
        ...(finding.verification as Record<string, unknown>),
      };
      setField(verification, "params", value);
      finding.verification = verification;
      const parsed = findingSchema.safeParse(finding);
      return parsed.success
        ? { success: true, value: parsed.data.verification.params }
        : { success: false };
    },
  },
];

describe("docs/schemas.md record examples", () => {
  // Zod 4 still accepts z.record(value) at runtime; only its types reject it,
  // so the single-argument form is caught here rather than by parsing.
  test("every documented z.record uses Zod 4's two-argument form", () => {
    const calls: string[] = [];
    for (const fence of tsFences(markdown)) {
      for (const match of fence.matchAll(/\bz\.record\(/g)) {
        const open = (match.index ?? 0) + "z.record".length;
        const call = balancedCall(fence, open);
        calls.push(call);
        expect(
          topLevelArgs(call),
          `single-argument z.record: ${lineAt(fence, open)}`,
        ).toBe(2);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  test.each(fields)(
    "$name agrees with src/schemas under the pinned zod",
    ({ heading, key, occurrence, count, parseWith }) => {
      const expressions = fieldExpressions(heading, key);
      expect(expressions).toHaveLength(count);
      const expression = expressions[occurrence] ?? "";
      const documented = documentedSchema(expression);
      expect(parseWith({ A: "1" }).success, "baseline fixture parses").toBe(
        true,
      );

      for (const probe of probes) {
        const source = parseWith(probe.value);
        const doc = documented.safeParse(probe.value);
        expect(
          { success: doc.success, value: doc.success ? doc.data : undefined },
          `${expression} on ${probe.name}`,
        ).toEqual({
          success: source.success,
          value: source.success ? source.value : undefined,
        });
      }
    },
  );
});
