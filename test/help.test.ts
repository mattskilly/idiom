import type { Command } from "commander";
import { expect, test } from "vitest";
import { createProgram, run } from "../src/cli.js";
import {
  COMMAND_EXAMPLES,
  HELP_GROUPS,
  helpCoverage,
  START_HERE,
} from "../src/help.js";

async function help(...args: string[]): Promise<string> {
  const stdout: string[] = [];
  await run(["node", "idiom", ...args], {
    stdout: (message) => stdout.push(message),
    stderr: () => undefined,
  });
  return stdout.join("");
}

test("the help catalog lists every registered command exactly once", () => {
  expect(helpCoverage(createProgram())).toEqual({
    missing: [],
    unknown: [],
    duplicated: [],
  });
});

test("root help opens with Start here, then groups every command once", async () => {
  const output = await help("--help");
  const lines = output.split("\n");
  const startHere = lines.indexOf("Start here:");
  const options = lines.indexOf("Options:");
  expect(startHere).toBeGreaterThan(0);
  expect(options).toBeGreaterThan(startHere);
  const rows = lines
    .slice(startHere + 1, lines.indexOf("", startHere))
    .filter((line) => /^ {2}idiom /.test(line));
  expect(rows.length).toBeGreaterThanOrEqual(3);
  expect(rows.length).toBeLessThanOrEqual(4);
  expect(START_HERE.map(([term]) => term)).toEqual([
    "idiom init",
    "idiom init --validate",
    "idiom check <flow>",
    "idiom fix / idiom decide",
  ]);

  const titles = HELP_GROUPS.map((group) => lines.indexOf(`${group.title}:`));
  for (const index of titles) expect(index).toBeGreaterThan(options);
  expect([...titles].sort((left, right) => left - right)).toEqual(titles);
  expect(output).not.toContain("Other commands:");

  const groupLines = lines.slice(titles[0]);
  const names = createProgram().commands.map((command) => command.name());
  expect(names).toContain("validate");
  for (const name of names)
    expect(
      groupLines.filter((line) => new RegExp(`^ {2}${name}(\\s|$)`).test(line)),
      name,
    ).toHaveLength(1);
  expect(lines.filter((line) => /^ {2}validate\s/.test(line))).toHaveLength(1);
  expect(output.trimEnd().split("\n").at(-1)).toBe(
    "Run idiom help <command> or idiom <command> --help for details and examples.",
  );
});

test("idiom help with no command prints the same grouped help", async () => {
  expect(await help("help")).toBe(await help("--help"));
});

test("subcommand help keeps commander's default layout", async () => {
  const output = await help("validate", "--help");
  expect(output.startsWith("Usage: idiom validate")).toBe(true);
  expect(output).not.toContain("Start here");
  expect(output).not.toContain("Examples:");
});

test("the six most-used commands show Examples in their own help", async () => {
  for (const name of Object.keys(COMMAND_EXAMPLES)) {
    const output = await help(name, "--help");
    expect(output, name).toContain("\nExamples:\n");
    expect(output, name).toContain(`  idiom ${name}`);
  }
});

function longOptions(command: Command): string[] {
  return command.options.flatMap((option) => option.long ?? []);
}

test("every example uses only registered commands and flags", () => {
  const program = createProgram();
  for (const [name, lines] of Object.entries(COMMAND_EXAMPLES)) {
    const command = program.commands.find((entry) => entry.name() === name);
    if (command === undefined) throw new Error(`no ${name} command`);
    for (const line of lines) {
      const tokens = (line.split("  #")[0] ?? "").trim().split(/\s+/);
      expect(tokens.slice(0, 2), line).toEqual(["idiom", name]);
      const sub = command.commands.find((entry) => entry.name() === tokens[2]);
      const allowed = new Set([
        ...longOptions(program),
        ...longOptions(command),
        ...(sub === undefined ? [] : longOptions(sub)),
      ]);
      for (const flag of tokens.filter((token) => token.startsWith("--")))
        expect(allowed.has(flag), `${line}: ${flag}`).toBe(true);
    }
  }
});
