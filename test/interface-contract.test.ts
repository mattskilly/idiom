import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  commandStatus,
  jsonOutputs,
  mcpOutputs,
  mcpToolStatus,
} from "../src/interface/surfaces.js";
import { INTERFACE_VERSION } from "../src/interface/version.js";
import {
  advertisedOutputSchemas,
  buildInterfaceSnapshot,
  type CommandSnapshot,
  compareInterface,
  type InterfaceSnapshot,
  type JsonSchema,
  type OptionSnapshot,
  programCommands,
  schemaIssues,
} from "./contract-support.js";

const snapshotFile = new URL("./contract/interface.json", import.meta.url);
const updating = process.env.IDIOM_UPDATE_CONTRACT === "1";

const BREAKING_MESSAGE =
  "Breaking change to a stable Idiom interface. See docs/stability.md: either keep the change additive, or bump INTERFACE_VERSION in src/interface/version.ts, list it under Interface in the CHANGELOG, and run `bun run contract:update`.";

describe("stable interface contract", () => {
  it("matches the recorded snapshot or moves the interface version", async () => {
    const current = await buildInterfaceSnapshot();
    const recorded = existsSync(snapshotFile)
      ? (JSON.parse(readFileSync(snapshotFile, "utf8")) as InterfaceSnapshot)
      : undefined;
    if (updating) {
      if (
        recorded !== undefined &&
        recorded.interfaceVersion === INTERFACE_VERSION
      ) {
        const issues = compareInterface(recorded, current);
        if (issues.length > 0)
          throw new Error(
            `Refusing to record a breaking change without an interface bump:\n${issues.join("\n")}\n${BREAKING_MESSAGE}`,
          );
      }
      writeFileSync(snapshotFile, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    expect(
      recorded,
      "test/contract/interface.json is missing; run `bun run contract:update`",
    ).toBeDefined();
    if (recorded === undefined) return;
    expect(
      INTERFACE_VERSION,
      "INTERFACE_VERSION is lower than the recorded snapshot's; it may only move up. See docs/stability.md.",
    ).toBeGreaterThanOrEqual(recorded.interfaceVersion);
    // A moved version allows any change; the release check re-records it.
    if (INTERFACE_VERSION > recorded.interfaceVersion) return;
    expect(compareInterface(recorded, current), BREAKING_MESSAGE).toEqual([]);
  });

  it("advertises the interface version in the MCP initialize result", async () => {
    const current = await buildInterfaceSnapshot();
    expect(current.mcp.interfaceVersion).toBe(INTERFACE_VERSION);
  });

  it("classifies every command, and only real ones", () => {
    const paths = programCommands().map(({ path }) => path);
    expect(new Set(Object.keys(commandStatus))).toEqual(new Set(paths));
  });

  it("lists a --json payload for every command with --json, and only those", () => {
    const withJson = programCommands()
      .filter(({ command }) =>
        command.options.some((option) => option.long === "--json"),
      )
      .map(({ path }) => path);
    expect(new Set(jsonOutputs.map((output) => output.command))).toEqual(
      new Set(withJson),
    );
  });

  it("classifies every MCP tool, and only real ones", async () => {
    const current = await buildInterfaceSnapshot();
    expect(new Set(Object.keys(mcpToolStatus))).toEqual(
      new Set(current.mcp.tools.map((tool) => tool.name)),
    );
  });

  it("gives a contract to exactly the stable-additive payloads", () => {
    for (const output of jsonOutputs)
      expect(
        output.contract !== undefined,
        `${output.id}: a contract is present exactly when status is stable-additive`,
      ).toBe(output.status === "stable-additive");
  });

  it("reports nothing when a snapshot is compared with itself", async () => {
    const current = await buildInterfaceSnapshot();
    expect(
      compareInterface(current, structuredClone(current) as InterfaceSnapshot),
    ).toEqual([]);
  });

  it("reports removing findings from the check contract", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const check = mutated.json.find((output) => output.id === "check");
    const properties = check?.schema?.properties as Record<string, unknown>;
    delete properties.findings;
    expect(compareInterface(current, mutated)).toEqual([
      '--json "check": property findings removed',
    ]);
  });

  it("classifies every MCP tool's output, and only real ones", async () => {
    const current = await buildInterfaceSnapshot();
    expect(new Set(Object.keys(mcpOutputs))).toEqual(
      new Set(current.mcp.tools.map((tool) => tool.name)),
    );
  });

  it("gives an output contract to exactly the stable-additive MCP outputs, and a reason to exactly the experimental ones", async () => {
    for (const [tool, output] of Object.entries(mcpOutputs)) {
      expect(
        output.contract !== undefined,
        `${tool}: a contract is present exactly when the output is stable-additive`,
      ).toBe(output.status === "stable-additive");
      expect(
        output.reason !== undefined,
        `${tool}: a reason is present exactly when the output is experimental`,
      ).toBe(output.status === "experimental");
    }
    const current = await buildInterfaceSnapshot();
    for (const tool of current.mcp.tools)
      expect(
        tool.outputSchema !== undefined,
        `${tool.name}: the snapshot records the outputSchema exactly when the output is stable-additive`,
      ).toBe(tool.outputStatus === "stable-additive");
  });

  const stableOutput = (snapshot: InterfaceSnapshot, name: string) => {
    const tool = snapshot.mcp.tools.find((entry) => entry.name === name);
    if (tool?.outputSchema === undefined)
      throw new Error(`${name} has no recorded output schema`);
    return tool;
  };
  const doctorOutput = (snapshot: InterfaceSnapshot) =>
    stableOutput(snapshot, "idiom_doctor");
  const json = (snapshot: InterfaceSnapshot, id: string) => {
    const schema = snapshot.json.find((output) => output.id === id)?.schema;
    if (schema === undefined) throw new Error(`${id} has no recorded schema`);
    return schema;
  };
  type Properties = Record<string, JsonSchema>;
  const properties = (schema: JsonSchema | undefined) =>
    schema?.properties as Properties;

  it("reports removing a property from a stable MCP output", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const properties = doctorOutput(mutated).outputSchema?.properties as Record<
      string,
      unknown
    >;
    delete properties.ok;
    expect(compareInterface(current, mutated)).toEqual([
      "MCP tool idiom_doctor output: property ok removed",
    ]);
  });

  it("reports retyping a property of a stable MCP output", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const properties = doctorOutput(mutated).outputSchema?.properties as Record<
      string,
      Record<string, unknown>
    >;
    properties.ok = { type: "string" };
    const issues = compareInterface(current, mutated);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join("\n")).toContain("MCP tool idiom_doctor output");
    expect(issues.join("\n")).toContain("ok");
  });

  it("reports demoting a stable MCP output", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const tool = doctorOutput(mutated);
    tool.outputStatus = "experimental";
    delete tool.outputSchema;
    expect(compareInterface(current, mutated)).toContain(
      "MCP tool idiom_doctor: output demoted from stable-additive to experimental",
    );
  });

  it("reports removing a promised finding field from idiom_quick", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const findings = properties(
      stableOutput(mutated, "idiom_quick").outputSchema,
    ).findings as JsonSchema;
    const finding = properties(findings.items as JsonSchema)
      .finding as JsonSchema;
    delete properties(finding).rule;
    expect(compareInterface(current, mutated)).toEqual([
      "MCP tool idiom_quick output at findings[].finding: property rule removed",
    ]);
  });

  it("reports retyping idiom_verify's success", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    properties(stableOutput(mutated, "idiom_verify").outputSchema).success = {
      type: "string",
    };
    expect(compareInterface(current, mutated)).toEqual([
      'MCP tool idiom_verify output at success: type widened from ["boolean"] to ["string"]',
    ]);
  });

  it("reports retyping a promised nested field of idiom_issue", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const coordinate = properties(
      stableOutput(mutated, "idiom_issue").outputSchema,
    ).coordinate;
    properties(coordinate).viewport = { type: "number" };
    expect(compareInterface(current, mutated)).toEqual([
      'MCP tool idiom_issue output at coordinate.viewport: type widened from ["string"] to ["number"]',
    ]);
  });

  it("reports removing decisionQuestion from the gate that ran", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const ran = (json(mutated, "check --gate").anyOf as JsonSchema[]).find(
      (branch) => "decisionNeeded" in properties(branch),
    );
    if (ran === undefined) throw new Error("no ran form in check --gate");
    delete properties(ran).decisionQuestion;
    ran.required = (ran.required as string[]).filter(
      (name) => name !== "decisionQuestion",
    );
    const issues = compareInterface(current, mutated);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(
      /^--json "check --gate": variant \d+ .*no longer matched$/,
    );
  });

  it("reports removing selection from check --changed", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    delete properties(json(mutated, "check --changed")).selection;
    expect(compareInterface(current, mutated)).toEqual([
      '--json "check --changed": property selection removed',
    ]);
  });

  it("allows a new property on a stable output, at the root and in a finding detail", async () => {
    const current = await buildInterfaceSnapshot();
    const mutated = structuredClone(current) as InterfaceSnapshot;
    const check = properties(stableOutput(mutated, "idiom_check").outputSchema);
    check.newRootField = { type: "string" };
    const detail = (check.newFindings as JsonSchema).items as JsonSchema;
    properties(detail).newDetailField = { type: "number" };
    (detail.required as string[]).push("newDetailField");
    properties(json(mutated, "check --changed")).newChangedField = {
      type: "boolean",
    };
    expect(compareInterface(current, mutated)).toEqual([]);
  });

  it("advertises an outputSchema that honours each stable output's contract", async () => {
    const current = await buildInterfaceSnapshot();
    const advertised = await advertisedOutputSchemas();
    const stable = current.mcp.tools.filter(
      (tool) => tool.outputStatus === "stable-additive",
    );
    expect(stable.map((tool) => tool.name).sort()).toEqual([
      "idiom_check",
      "idiom_doctor",
      "idiom_issue",
      "idiom_quick",
      "idiom_verify",
    ]);
    for (const tool of stable)
      expect(
        schemaIssues(
          tool.outputSchema ?? {},
          advertised[tool.name] ?? {},
          "output",
          tool.name,
        ),
        `${tool.name}: the advertised outputSchema must keep every promised field, required where promised, never widened`,
      ).toEqual([]);
  });
});

describe("promoted commands", () => {
  const promoted = [
    "fix",
    "ruling",
    "baseline advance",
    "design",
    "design add",
    "reference",
    "reference add",
    "reference list",
    "reference remove",
  ];
  const withOptions = [
    "fix",
    "ruling",
    "baseline advance",
    "design add",
    "reference add",
    "reference remove",
  ];
  const withArguments = [
    "fix",
    "baseline advance",
    "design add",
    "reference add",
    "reference remove",
  ];
  let current: InterfaceSnapshot;
  let recorded: InterfaceSnapshot;
  beforeAll(async () => {
    current = await buildInterfaceSnapshot();
    recorded = JSON.parse(
      readFileSync(snapshotFile, "utf8"),
    ) as InterfaceSnapshot;
  });

  const entry = (snapshot: InterfaceSnapshot, path: string) => {
    const found = snapshot.commands.find((command) => command.path === path);
    if (found === undefined) throw new Error(`no command ${path}`);
    return found;
  };
  /** A copy of the live snapshot with `edit` applied to one command. */
  const edited = (path: string, edit: (command: CommandSnapshot) => void) => {
    const next = structuredClone(current);
    edit(entry(next, path));
    return next;
  };
  const promised = (path: string): OptionSnapshot[] =>
    entry(current, path).options.filter((option) => !option.experimental);

  it.each(promoted)(
    "records %s as stable with its current options and arguments",
    (path) => {
      expect(entry(current, path).status).toBe("stable");
      expect(entry(recorded, path)).toEqual(entry(current, path));
    },
  );

  it.each(withOptions)("reports removing a promised option from %s", (path) => {
    const [first] = promised(path);
    if (first === undefined) throw new Error(`${path} has no promised option`);
    const next = edited(path, (command) => {
      command.options = command.options.filter(
        (option) => option.long !== first.long,
      );
    });
    expect(compareInterface(current, next)).toContain(
      `command "${path}": option ${first.long} removed`,
    );
  });

  it.each(withArguments)("reports removing the argument of %s", (path) => {
    const [first] = entry(current, path).arguments;
    if (first === undefined) throw new Error(`${path} has no argument`);
    const next = edited(path, (command) => {
      command.arguments = [];
    });
    expect(compareInterface(current, next)).toContain(
      `command "${path}": argument <${first.name}> removed`,
    );
  });

  it.each(promoted)("reports renaming %s", (path) => {
    const next = edited(path, (command) => {
      command.path = `${path}-renamed`;
    });
    expect(compareInterface(current, next)).toContain(
      `command "${path}": removed`,
    );
  });

  it.each(promoted)("allows a new optional option on %s", (path) => {
    const next = edited(path, (command) => {
      command.options.push({
        long: "--brand-new",
        short: null,
        takesValue: false,
        valueOptional: false,
        mandatory: false,
        negate: false,
      });
    });
    expect(compareInterface(current, next)).toEqual([]);
  });

  it("reports an option of fix becoming mandatory", () => {
    const next = edited("fix", (command) => {
      const top = command.options.find((option) => option.long === "--top");
      if (top === undefined) throw new Error("fix has no --top");
      top.mandatory = true;
    });
    expect(compareInterface(current, next)).toEqual([
      'command "fix": option --top became mandatory',
    ]);
  });

  it("does not pin the experimental options of baseline advance, and reports demoting a promised one", () => {
    const withoutFetch = edited("baseline advance", (command) => {
      command.options = command.options.filter(
        (option) => option.long !== "--fetch",
      );
    });
    expect(compareInterface(current, withoutFetch)).toEqual([]);
    const demoted = edited("baseline advance", (command) => {
      const target = command.options.find(
        (option) => option.long === "--target",
      );
      if (target === undefined)
        throw new Error("baseline advance has no --target");
      target.experimental = true;
    });
    expect(compareInterface(current, demoted)).toEqual([
      'command "baseline advance": option --target demoted to experimental',
    ]);
  });
});
