import type { Argument, Command, Option } from "commander";
import { z } from "zod";
import { deterministicCheckIds } from "../src/checks/types.js";
import { createProgram } from "../src/cli.js";
import {
  commandStatus,
  fileFormats,
  jsonOutputs,
  mcpToolStatus,
  type SurfaceStatus,
} from "../src/interface/surfaces.js";
import { EXIT_CODES, INTERFACE_VERSION } from "../src/interface/version.js";
import { mcpClient } from "./mcp-support.js";

export type JsonSchema = Record<string, unknown>;
export type Direction = "input" | "output";

export type OptionSnapshot = {
  long: string;
  short: string | null;
  takesValue: boolean;
  valueOptional: boolean;
  mandatory: boolean;
  negate: boolean;
};
export type ArgumentSnapshot = {
  name: string;
  required: boolean;
  variadic: boolean;
};
export type CommandSnapshot = {
  path: string;
  status: SurfaceStatus | "unclassified";
  arguments: ArgumentSnapshot[];
  options: OptionSnapshot[];
};
export type InterfaceSnapshot = {
  interfaceVersion: number;
  globalOptions: OptionSnapshot[];
  commands: CommandSnapshot[];
  exitCodes: Record<string, number>;
  json: {
    id: string;
    command: string;
    status: SurfaceStatus;
    schema?: JsonSchema;
  }[];
  files: {
    id: string;
    path: string;
    direction: Direction;
    status: SurfaceStatus;
    schema?: JsonSchema;
  }[];
  mcp: {
    interfaceVersion: unknown;
    tools: {
      name: string;
      status: SurfaceStatus | "unclassified";
      inputSchema: JsonSchema;
      annotations: unknown;
    }[];
  };
  rules: string[];
};

const byKey =
  <T>(key: (value: T) => string) =>
  (left: T, right: T) =>
    key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;

function optionSnapshot(option: Option): OptionSnapshot {
  return {
    long: option.long ?? option.flags,
    short: option.short ?? null,
    takesValue: option.required || option.optional,
    valueOptional: option.optional,
    mandatory: option.mandatory,
    negate: option.negate,
  };
}

function argumentSnapshot(argument: Argument): ArgumentSnapshot {
  return {
    name: argument.name(),
    required: argument.required,
    variadic: argument.variadic,
  };
}

/** Every command path in the program, keyed by command.name() so `record <flow>` is `baseline record`. */
export function programCommands(program: Command = createProgram()) {
  const commands: { path: string; command: Command }[] = [];
  const walk = (parent: Command, prefix: string) => {
    for (const command of parent.commands) {
      const path =
        prefix === "" ? command.name() : `${prefix} ${command.name()}`;
      commands.push({ path, command });
      walk(command, path);
    }
  };
  walk(program, "");
  return commands;
}

function schemaOf(schema: z.ZodType, io: Direction): JsonSchema {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
}

export async function buildInterfaceSnapshot(): Promise<InterfaceSnapshot> {
  const program = createProgram();
  const commands = programCommands(program)
    .map(({ path, command }) => ({
      path,
      status: commandStatus[path] ?? ("unclassified" as const),
      arguments: command.registeredArguments.map(argumentSnapshot),
      options: command.options
        .map(optionSnapshot)
        .sort(byKey((option) => option.long)),
    }))
    .sort(byKey((command) => command.path));
  const globalOptions = program.options
    .filter((option) => option.long !== "--version")
    .map(optionSnapshot)
    .sort(byKey((option) => option.long));

  const { client, close } = await mcpClient({});
  let mcp: InterfaceSnapshot["mcp"];
  try {
    const capabilities = client.getServerCapabilities() as
      | { experimental?: { idiom?: { interfaceVersion?: unknown } } }
      | undefined;
    const { tools } = await client.listTools();
    mcp = {
      interfaceVersion: capabilities?.experimental?.idiom?.interfaceVersion,
      tools: tools
        .map((tool) => ({
          name: tool.name,
          status: mcpToolStatus[tool.name] ?? ("unclassified" as const),
          inputSchema: tool.inputSchema as JsonSchema,
          annotations: tool.annotations ?? null,
        }))
        .sort(byKey((tool) => tool.name)),
    };
  } finally {
    await close();
  }

  return {
    interfaceVersion: INTERFACE_VERSION,
    globalOptions,
    commands,
    exitCodes: { ...EXIT_CODES },
    json: jsonOutputs
      .map((output) => ({
        id: output.id,
        command: output.command,
        status: output.status,
        ...(output.contract === undefined
          ? {}
          : { schema: schemaOf(output.contract, "output") }),
      }))
      .sort(byKey((output) => output.id)),
    files: fileFormats
      .map((file) => ({
        id: file.id,
        path: file.path,
        direction: file.direction,
        status: file.status,
        ...(file.schema === undefined
          ? {}
          : // The on-disk shape is the schema's input side, also for files Idiom
            // writes (findingSchema ends in a transform); the comparison still
            // uses the file's direction.
            { schema: schemaOf(file.schema, "input") }),
      }))
      .sort(byKey((file) => file.id)),
    mcp,
    rules: [...deterministicCheckIds].sort(),
  };
}

const isStable = (status: string | undefined) =>
  status === "stable" || status === "stable-additive";

function compareOptions(
  label: string,
  previous: OptionSnapshot[],
  current: OptionSnapshot[],
): string[] {
  const issues: string[] = [];
  const now = new Map(current.map((option) => [option.long, option]));
  const before = new Set(previous.map((option) => option.long));
  for (const old of previous) {
    const next = now.get(old.long);
    if (next === undefined) {
      issues.push(`${label}: option ${old.long} removed`);
      continue;
    }
    if (old.short !== null && next.short !== old.short)
      issues.push(
        `${label}: option ${old.long} lost its short flag ${old.short}`,
      );
    if (next.takesValue !== old.takesValue)
      issues.push(
        `${label}: option ${old.long} ${old.takesValue ? "no longer takes a value" : "now takes a value"}`,
      );
    else if (old.valueOptional && !next.valueOptional)
      issues.push(`${label}: option ${old.long} now requires its value`);
    if (next.negate !== old.negate)
      issues.push(`${label}: option ${old.long} changed negation`);
    if (next.mandatory && !old.mandatory)
      issues.push(`${label}: option ${old.long} became mandatory`);
  }
  for (const option of current)
    if (!before.has(option.long) && option.mandatory)
      issues.push(`${label}: new option ${option.long} is mandatory`);
  return issues;
}

function compareArguments(
  label: string,
  previous: ArgumentSnapshot[],
  current: ArgumentSnapshot[],
): string[] {
  const issues: string[] = [];
  for (const [index, old] of previous.entries()) {
    const next = current[index];
    if (next === undefined) {
      issues.push(`${label}: argument <${old.name}> removed`);
      continue;
    }
    if (next.required && !old.required)
      issues.push(`${label}: argument <${old.name}> became required`);
    if (old.variadic && !next.variadic)
      issues.push(`${label}: argument <${old.name}> is no longer variadic`);
  }
  for (const next of current.slice(previous.length))
    if (next.required)
      issues.push(`${label}: new argument <${next.name}> is required`);
  return issues;
}

/** Breaking issues between two snapshots; empty when every change is additive. */
export function compareInterface(
  previous: InterfaceSnapshot,
  current: InterfaceSnapshot,
): string[] {
  const issues: string[] = [];

  for (const [name, code] of Object.entries(previous.exitCodes)) {
    if (current.exitCodes[name] === undefined)
      issues.push(`exit code ${name} (${code}) removed`);
    else if (current.exitCodes[name] !== code)
      issues.push(
        `exit code ${name} changed from ${code} to ${current.exitCodes[name]}`,
      );
  }

  issues.push(
    ...compareOptions(
      "global options",
      previous.globalOptions,
      current.globalOptions,
    ),
  );

  const commands = new Map(
    current.commands.map((entry) => [entry.path, entry]),
  );
  for (const old of previous.commands) {
    if (!isStable(old.status)) continue;
    const label = `command "${old.path}"`;
    const next = commands.get(old.path);
    if (next === undefined) {
      issues.push(`${label}: removed`);
      continue;
    }
    if (!isStable(next.status))
      issues.push(`${label}: demoted from ${old.status} to ${next.status}`);
    issues.push(...compareArguments(label, old.arguments, next.arguments));
    issues.push(...compareOptions(label, old.options, next.options));
  }

  const json = new Map(current.json.map((entry) => [entry.id, entry]));
  for (const old of previous.json) {
    if (!isStable(old.status)) continue;
    const label = `--json "${old.id}"`;
    const next = json.get(old.id);
    if (next === undefined) {
      issues.push(`${label}: removed`);
      continue;
    }
    if (!isStable(next.status))
      issues.push(`${label}: demoted from ${old.status} to ${next.status}`);
    if (old.schema !== undefined)
      issues.push(
        ...schemaIssues(old.schema, next.schema ?? {}, "output", label),
      );
  }

  const files = new Map(current.files.map((entry) => [entry.id, entry]));
  for (const old of previous.files) {
    if (!isStable(old.status)) continue;
    const label = `file "${old.id}"`;
    const next = files.get(old.id);
    if (next === undefined) {
      issues.push(`${label}: removed`);
      continue;
    }
    if (!isStable(next.status))
      issues.push(`${label}: demoted from ${old.status} to ${next.status}`);
    if (next.path !== old.path)
      issues.push(`${label}: path changed from ${old.path} to ${next.path}`);
    if (old.schema !== undefined)
      issues.push(
        ...schemaIssues(old.schema, next.schema ?? {}, old.direction, label),
      );
  }

  if (current.mcp.interfaceVersion !== previous.mcp.interfaceVersion)
    issues.push(
      `MCP capabilities.experimental.idiom.interfaceVersion changed from ${String(previous.mcp.interfaceVersion)} to ${String(current.mcp.interfaceVersion)}`,
    );
  const tools = new Map(current.mcp.tools.map((tool) => [tool.name, tool]));
  for (const old of previous.mcp.tools) {
    if (!isStable(old.status)) continue;
    const label = `MCP tool ${old.name}`;
    const next = tools.get(old.name);
    if (next === undefined) {
      issues.push(`${label}: removed`);
      continue;
    }
    if (!isStable(next.status))
      issues.push(`${label}: demoted from ${old.status} to ${next.status}`);
    issues.push(
      ...schemaIssues(old.inputSchema, next.inputSchema, "input", label),
    );
  }

  const rules = new Set(current.rules);
  for (const rule of previous.rules)
    if (!rules.has(rule)) issues.push(`rule id ${rule} removed`);

  return issues;
}

/* ---------- JSON Schema compatibility ---------- */

type Root = JsonSchema;
type Resolved = { schema: JsonSchema; ref?: string };

function asSchema(value: unknown): JsonSchema {
  if (value === true || value === undefined) return {};
  if (value === false) return { not: {} };
  return value as JsonSchema;
}

function resolve(value: unknown, root: Root): Resolved {
  let schema = asSchema(value);
  let ref: string | undefined;
  const seen = new Set<string>();
  while (typeof schema.$ref === "string") {
    ref = schema.$ref;
    if (seen.has(ref)) break;
    seen.add(ref);
    const target =
      ref === "#"
        ? root
        : ref
            .replace(/^#\//, "")
            .split("/")
            .reduce<unknown>(
              (node, key) =>
                (node as Record<string, unknown> | undefined)?.[key],
              root,
            );
    const { $ref: _ref, ...rest } = schema;
    schema = { ...asSchema(target), ...rest };
  }
  return ref === undefined ? { schema } : { schema, ref };
}

const constraining = [
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
];
const isAny = (schema: JsonSchema) =>
  !constraining.some((key) => key in schema);

function typesOf(schema: JsonSchema): string[] | undefined {
  if (schema.type === undefined) return undefined;
  return Array.isArray(schema.type)
    ? (schema.type as string[])
    : [schema.type as string];
}

const typeCovers = (types: string[], type: string) =>
  types.includes(type) || (type === "integer" && types.includes("number"));

function valuesOf(schema: JsonSchema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum as unknown[];
  if ("const" in schema) return [schema.const];
  return undefined;
}

function branchesOf(schema: JsonSchema): JsonSchema[] | undefined {
  const list = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (list === undefined) return undefined;
  const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema;
  return list.map((branch) => ({ ...rest, ...asSchema(branch) }));
}

const describe = (value: unknown) => JSON.stringify(value);

/**
 * Breaking differences from `previous` to `current`. Output: properties may
 * be added; existing ones stay, stay required and never widen. Input: existing
 * properties stay accepted, nothing optional becomes required. In both, enum
 * values and union variants may be added but not removed; an output gains
 * variants only if it was already a union. Descriptions,
 * defaults, formats, patterns, numeric bounds and additionalProperties are
 * not compared.
 */
export function schemaIssues(
  previous: JsonSchema,
  current: JsonSchema,
  direction: Direction,
  label: string,
): string[] {
  // Keyed by the pair of $refs being compared. A pair already in progress is
  // assumed compatible, which is what makes recursive schemas terminate.
  const memo = new Map<string, string[]>();

  const walk = (
    oldValue: unknown,
    newValue: unknown,
    path: string,
  ): string[] => {
    const oldResolved = resolve(oldValue, previous);
    const newResolved = resolve(newValue, current);
    let pair: string | undefined;
    if (oldResolved.ref !== undefined || newResolved.ref !== undefined) {
      pair = `${oldResolved.ref}|${newResolved.ref}`;
      const known = memo.get(pair);
      if (known !== undefined) return known;
      memo.set(pair, []);
    }
    const result = compare(oldResolved.schema, newResolved.schema, path);
    if (pair !== undefined) memo.set(pair, result);
    return result;
  };

  const compare = (old: JsonSchema, next: JsonSchema, path: string) => {
    const issues: string[] = [];
    const at = path === "" ? label : `${label} at ${path}`;

    if (isAny(next)) {
      if (direction === "output" && !isAny(old))
        issues.push(`${at}: output type widened to any`);
      return issues;
    }
    if (isAny(old)) {
      if (direction === "input")
        issues.push(`${at}: input that accepted anything is now constrained`);
      return issues;
    }

    const oldBranches = branchesOf(old);
    const newBranches = branchesOf(next);
    if (oldBranches !== undefined || newBranches !== undefined) {
      const olds = oldBranches ?? [old];
      const news = newBranches ?? [next];
      // Variants may only be added to an output that was already a union.
      // Retyping a single output into one (string to string|null) widens it,
      // so every new variant must fit within the old schema.
      if (direction === "output" && oldBranches === undefined) {
        for (const [index, branch] of news.entries()) {
          const trial = walk(old, branch, path);
          if (trial.length === 0) continue;
          if (news.length === 1) issues.push(...trial);
          else
            issues.push(
              `${at}: output widened by variant ${index} (${describe(typesOf(branch) ?? valuesOf(branch) ?? "schema")})`,
            );
        }
        return issues;
      }
      for (const [index, branch] of olds.entries()) {
        const trials = news.map((candidate) => walk(branch, candidate, path));
        if (trials.some((trial) => trial.length === 0)) continue;
        if (news.length === 1) issues.push(...(trials[0] ?? []));
        else
          issues.push(
            `${at}: variant ${index} (${describe(typesOf(branch) ?? valuesOf(branch) ?? "schema")}) no longer matched`,
          );
      }
      return issues;
    }

    const oldTypes = typesOf(old);
    const newTypes = typesOf(next);
    if (oldTypes !== undefined && newTypes !== undefined) {
      if (direction === "output") {
        const widened = newTypes.filter((type) => !typeCovers(oldTypes, type));
        if (widened.length > 0)
          issues.push(
            `${at}: type widened from ${describe(oldTypes)} to ${describe(newTypes)}`,
          );
      } else {
        const dropped = oldTypes.filter((type) => !typeCovers(newTypes, type));
        if (dropped.length > 0)
          issues.push(
            `${at}: type ${describe(dropped)} no longer accepted (now ${describe(newTypes)})`,
          );
      }
    } else if (oldTypes !== undefined && newTypes === undefined) {
      if (direction === "output" && valuesOf(next) === undefined)
        issues.push(`${at}: type ${describe(oldTypes)} no longer declared`);
    } else if (oldTypes === undefined && newTypes !== undefined) {
      if (direction === "input" && valuesOf(old) === undefined)
        issues.push(`${at}: now constrained to type ${describe(newTypes)}`);
    }

    const oldValues = valuesOf(old);
    const newValues = valuesOf(next);
    if (oldValues !== undefined && newValues !== undefined) {
      const removed = oldValues.filter(
        (value) =>
          !newValues.some(
            (candidate) => describe(candidate) === describe(value),
          ),
      );
      if (removed.length > 0)
        issues.push(`${at}: value(s) ${describe(removed)} removed`);
    } else if (oldValues !== undefined && direction === "output")
      issues.push(`${at}: enumerated values no longer constrained`);
    else if (newValues !== undefined && direction === "input")
      issues.push(`${at}: now restricted to ${describe(newValues)}`);

    const oldProperties = (old.properties ?? {}) as Record<string, unknown>;
    const newProperties = (next.properties ?? {}) as Record<string, unknown>;
    const oldRequired = new Set((old.required ?? []) as string[]);
    const newRequired = new Set((next.required ?? []) as string[]);
    for (const [name, schema] of Object.entries(oldProperties)) {
      if (!(name in newProperties)) {
        issues.push(`${at}: property ${name} removed`);
        continue;
      }
      if (
        direction === "output" &&
        oldRequired.has(name) &&
        !newRequired.has(name)
      )
        issues.push(`${at}: property ${name} is no longer always present`);
      issues.push(
        ...walk(
          schema,
          newProperties[name],
          path === "" ? name : `${path}.${name}`,
        ),
      );
    }
    if (direction === "input")
      for (const name of newRequired)
        if (!oldRequired.has(name))
          issues.push(`${at}: property ${name} is newly required`);

    if (old.items !== undefined && !Array.isArray(old.items))
      issues.push(
        ...walk(
          old.items,
          next.items === undefined || Array.isArray(next.items)
            ? {}
            : next.items,
          `${path}[]`,
        ),
      );
    return issues;
  };

  return [...new Set(walk(previous, current, ""))];
}
