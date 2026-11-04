import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type CommandSnapshot,
  compareInterface,
  type InterfaceSnapshot,
  type OptionSnapshot,
  schemaIssues,
} from "./contract-support.js";

const object = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
) => ({ type: "object", properties, required });

const option = (long: string, extra: Partial<OptionSnapshot> = {}) => ({
  long,
  short: null,
  takesValue: false,
  valueOptional: false,
  mandatory: false,
  negate: false,
  ...extra,
});

const command = (
  path: string,
  extra: Partial<CommandSnapshot> = {},
): CommandSnapshot => ({
  path,
  status: "stable",
  arguments: [],
  options: [],
  ...extra,
});

function snapshot(extra: Partial<InterfaceSnapshot> = {}): InterfaceSnapshot {
  return {
    interfaceVersion: 1,
    globalOptions: [],
    commands: [],
    exitCodes: { ok: 0, failed: 1, "run-failure": 2 },
    json: [],
    files: [],
    mcp: { interfaceVersion: 1, tools: [] },
    rules: [],
    ...extra,
  };
}

describe("output schema compatibility", () => {
  const base = object({
    flow: { type: "string" },
    blocking: { type: "number" },
  });

  it("allows an added property", () => {
    expect(
      schemaIssues(
        base,
        object({ ...base.properties, extra: { type: "boolean" } }),
        "output",
        "x",
      ),
    ).toEqual([]);
  });

  it("rejects a removed property", () => {
    expect(
      schemaIssues(base, object({ flow: { type: "string" } }), "output", "x"),
    ).toEqual(["x: property blocking removed"]);
  });

  it("rejects a widened type", () => {
    expect(
      schemaIssues(
        base,
        object({
          ...base.properties,
          blocking: { type: ["number", "string"] },
        }),
        "output",
        "x",
      ),
    ).toEqual([
      'x at blocking: type widened from ["number"] to ["number","string"]',
    ]);
  });

  it("rejects a property that is no longer required", () => {
    expect(
      schemaIssues(base, object(base.properties, ["flow"]), "output", "x"),
    ).toEqual(["x: property blocking is no longer always present"]);
  });

  it("accepts integer where number was", () => {
    expect(
      schemaIssues(
        base,
        object({ ...base.properties, blocking: { type: "integer" } }),
        "output",
        "x",
      ),
    ).toEqual([]);
  });
});

describe("input schema compatibility", () => {
  const base = object({ port: { type: "number" } }, []);

  it("rejects a property that becomes required", () => {
    expect(
      schemaIssues(base, object(base.properties, ["port"]), "input", "x"),
    ).toEqual(["x: property port is newly required"]);
  });

  it("allows an added optional property", () => {
    expect(
      schemaIssues(
        base,
        object({ ...base.properties, host: { type: "string" } }, []),
        "input",
        "x",
      ),
    ).toEqual([]);
  });

  it("allows a widened type and rejects a narrowed one", () => {
    const wide = object({ port: { type: ["number", "string"] } }, []);
    expect(schemaIssues(base, wide, "input", "x")).toEqual([]);
    expect(schemaIssues(wide, base, "input", "x")).toEqual([
      'x at port: type ["string"] no longer accepted (now ["number"])',
    ]);
  });
});

describe("enums and unions", () => {
  const severity = { type: "string", enum: ["blocker", "major", "minor"] };

  it("rejects a removed enum value in either direction", () => {
    const fewer = { type: "string", enum: ["blocker", "major"] };
    for (const direction of ["input", "output"] as const)
      expect(schemaIssues(severity, fewer, direction, "x")).toEqual([
        'x: value(s) ["minor"] removed',
      ]);
  });

  it("allows an added enum value", () => {
    const more = {
      type: "string",
      enum: ["blocker", "major", "minor", "info"],
    };
    expect(schemaIssues(severity, more, "output", "x")).toEqual([]);
    expect(schemaIssues(severity, more, "input", "x")).toEqual([]);
  });

  it("allows an added union variant and rejects a removed one", () => {
    const two = { anyOf: [{ type: "string" }, { type: "number" }] };
    const three = {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    };
    expect(schemaIssues(two, three, "input", "x")).toEqual([]);
    expect(schemaIssues(three, two, "input", "x")).toEqual([
      'x: variant 2 (["boolean"]) no longer matched',
    ]);
  });

  it("rejects retyping a single output into a union", () => {
    const json = (schema: z.ZodType) =>
      z.toJSONSchema(schema) as Record<string, unknown>;
    const before = json(z.object({ flow: z.string() }));
    expect(
      schemaIssues(
        before,
        json(z.object({ flow: z.string().nullable() })),
        "output",
        "x",
      ),
    ).toEqual(['x at flow: output widened by variant 1 (["null"])']);
    expect(
      schemaIssues(
        before,
        json(z.object({ flow: z.union([z.string(), z.number()]) })),
        "output",
        "x",
      ),
    ).toEqual(['x at flow: output widened by variant 1 (["number"])']);
  });

  it("allows retyping a single input into a union", () => {
    const string = { type: "string" };
    const nullable = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(schemaIssues(string, nullable, "input", "x")).toEqual([]);
  });

  it("allows an output union whose variants all fit the old schema", () => {
    const string = { type: "string" };
    const literals = {
      anyOf: [
        { type: "string", const: "a" },
        { type: "string", const: "b" },
      ],
    };
    expect(schemaIssues(string, literals, "output", "x")).toEqual([]);
  });
});

describe("$ref recursion", () => {
  it("terminates on a recursive schema", () => {
    const tree = {
      $ref: "#/$defs/node",
      $defs: {
        node: object({
          name: { type: "string" },
          children: { type: "array", items: { $ref: "#/$defs/node" } },
        }),
      },
    };
    expect(schemaIssues(tree, structuredClone(tree), "output", "x")).toEqual(
      [],
    );
    const changed = structuredClone(tree);
    (changed.$defs.node.properties as Record<string, unknown>).name = {
      type: "number",
    };
    expect(schemaIssues(tree, changed, "output", "x")).toEqual([
      'x at name: type widened from ["string"] to ["number"]',
    ]);
  });
});

describe("CLI compatibility", () => {
  const before = snapshot({
    commands: [
      command("check", {
        options: [option("--json"), option("--fail-on", { takesValue: true })],
      }),
      command("sweep", { status: "experimental", options: [option("--json")] }),
    ],
  });

  const withCheck = (check: CommandSnapshot) =>
    snapshot({
      commands: [
        check,
        ...before.commands.filter((entry) => entry.path !== "check"),
      ],
    });

  it("rejects a removed option", () => {
    expect(
      compareInterface(
        before,
        withCheck(command("check", { options: [option("--json")] })),
      ),
    ).toEqual(['command "check": option --fail-on removed']);
  });

  it("rejects an option that changes from a boolean to a value", () => {
    expect(
      compareInterface(
        before,
        withCheck(
          command("check", {
            options: [
              option("--json", { takesValue: true }),
              option("--fail-on", { takesValue: true }),
            ],
          }),
        ),
      ),
    ).toEqual(['command "check": option --json now takes a value']);
  });

  it("rejects a new mandatory option and allows a new optional one", () => {
    const options = before.commands[0]?.options ?? [];
    expect(
      compareInterface(
        before,
        withCheck(
          command("check", {
            options: [...options, option("--token", { mandatory: true })],
          }),
        ),
      ),
    ).toEqual(['command "check": new option --token is mandatory']);
    expect(
      compareInterface(
        before,
        withCheck(
          command("check", { options: [...options, option("--quiet")] }),
        ),
      ),
    ).toEqual([]);
  });

  it("rejects a removed stable command and allows a removed experimental one", () => {
    expect(
      compareInterface(
        before,
        snapshot({ commands: [before.commands[1] as CommandSnapshot] }),
      ),
    ).toEqual(['command "check": removed']);
    expect(
      compareInterface(
        before,
        snapshot({ commands: [before.commands[0] as CommandSnapshot] }),
      ),
    ).toEqual([]);
  });

  it("rejects a demotion and allows a promotion", () => {
    const options = before.commands[0]?.options ?? [];
    expect(
      compareInterface(
        before,
        withCheck(command("check", { status: "experimental", options })),
      ),
    ).toEqual(['command "check": demoted from stable to experimental']);
    expect(
      compareInterface(
        before,
        snapshot({
          commands: [
            before.commands[0] as CommandSnapshot,
            command("sweep", { options: [option("--json")] }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a required argument that was optional", () => {
    const optional = snapshot({
      commands: [
        command("review", {
          arguments: [{ name: "flow", required: false, variadic: false }],
        }),
      ],
    });
    const required = snapshot({
      commands: [
        command("review", {
          arguments: [{ name: "flow", required: true, variadic: false }],
        }),
      ],
    });
    expect(compareInterface(optional, required)).toEqual([
      'command "review": argument <flow> became required',
    ]);
  });
});

describe("exit codes", () => {
  it("rejects a removed exit code and allows an added one", () => {
    const current = snapshot();
    expect(
      compareInterface(current, snapshot({ exitCodes: { ok: 0, failed: 1 } })),
    ).toEqual(["exit code run-failure (2) removed"]);
    expect(
      compareInterface(
        current,
        snapshot({ exitCodes: { ...current.exitCodes, partial: 3 } }),
      ),
    ).toEqual([]);
  });
});
