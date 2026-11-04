import type { Command, Help } from "commander";

/** The opening workflow of `idiom --help`: where to start and when setup is done. */
export const START_HERE: readonly (readonly [string, string])[] = [
  [
    "idiom init",
    "scaffold PRODUCT.md, DESIGN.md and .idiom, then hand setup to your coding agent",
  ],
  [
    "idiom init --validate",
    "confirm setup is done: prints ready, or the first problem and its fix",
  ],
  ["idiom check <flow>", "capture the flow and gate new findings"],
  [
    "idiom fix / idiom decide",
    "repair findings with your agent, or record accept and reject decisions",
  ],
];

/**
 * Every top-level command, exactly once, in the order the root help lists it.
 * Each line's sentence is the command's own `.description()`.
 */
export const HELP_GROUPS: readonly {
  title: string;
  commands: readonly string[];
}[] = [
  {
    title: "Setup",
    commands: ["init", "validate", "doctor", "reference", "design"],
  },
  {
    title: "Daily loop",
    commands: [
      "check",
      "review",
      "fix",
      "verify",
      "capture",
      "report",
      "compare",
    ],
  },
  { title: "Judgment and decisions", commands: ["decide", "ruling", "learn"] },
  { title: "Briefs", commands: ["brief"] },
  {
    title: "Explore and inspect",
    commands: ["quick", "sweep", "coverage", "explore", "system"],
  },
  {
    title: "Agents and integration",
    commands: ["mcp", "context", "instruction", "tickets"],
  },
  { title: "Maintenance", commands: ["upgrade", "baseline"] },
];

/** Examples shown after each of the most-used commands' own help. */
export const COMMAND_EXAMPLES: Record<
  "init" | "check" | "review" | "fix" | "decide" | "brief",
  readonly string[]
> = {
  init: [
    "idiom init --agent claude-code  # hand setup to your coding agent",
    "idiom init --print-setup-prompt  # paste into any agent",
    "idiom init --yes",
    "idiom init --flows --yes  # also generate a site flow",
    "idiom init --validate  # setup is done when this prints ready",
    "idiom init --validate --flow booking --json",
  ],
  check: [
    "idiom check booking",
    "idiom check booking --since-baseline",
    "idiom check --gate --budget 3m  # build gate for the current change",
    "idiom check booking --fail-on major",
  ],
  review: [
    "idiom review booking",
    "idiom review booking --deterministic-only  # no model or external detector",
    "idiom review --page http://localhost:3000/pricing",
    "idiom review booking --from <runId>",
  ],
  fix: [
    "idiom fix booking",
    "idiom fix booking --dry-run  # print the repair prompt only",
    "idiom fix booking --top 3 --max-rounds 2",
  ],
  decide: [
    "idiom decide --list",
    "idiom decide --finding finding-3 --accept",
    'idiom decide --finding finding-3 --reject --scope rule --reason "intentional brand colour"',
  ],
  brief: [
    'idiom brief triage "<request>"',
    'idiom brief "<request>" --research',
    "idiom brief plan <id>",
    "idiom brief decide <slug> --option <id>",
  ],
};

const FOOTER =
  "Run idiom help <command> or idiom <command> --help for details and examples.";

/** Registered commands the catalog misses, names it lists that do not exist, and repeats. */
export function helpCoverage(program: Command): {
  missing: string[];
  unknown: string[];
  duplicated: string[];
} {
  const registered = program.commands.map((command) => command.name());
  const listed = HELP_GROUPS.flatMap((group) => group.commands);
  return {
    missing: registered.filter((name) => !listed.includes(name)),
    unknown: listed.filter((name) => !registered.includes(name)),
    duplicated: listed.filter((name, index) => listed.indexOf(name) !== index),
  };
}

/** The root help: Start here, options, then commands by group. */
export function formatRootHelp(cmd: Command, helper: Help): string {
  // visibleCommands also yields the implicit help command; the footer names it.
  const commands = helper
    .visibleCommands(cmd)
    .filter((sub) => cmd.commands.includes(sub));
  const byName = new Map(commands.map((sub) => [sub.name(), sub]));
  const groups = HELP_GROUPS.map((group) => ({
    title: group.title,
    commands: group.commands.flatMap((name) => byName.get(name) ?? []),
  }));
  const listed = new Set(HELP_GROUPS.flatMap((group) => group.commands));
  const other = commands.filter((sub) => !listed.has(sub.name()));
  if (other.length > 0)
    groups.push({ title: "Other commands", commands: other });

  const options = helper.visibleOptions(cmd);
  const termWidth = Math.max(
    ...START_HERE.map(([term]) => helper.displayWidth(term)),
    ...options.map((option) => helper.displayWidth(helper.optionTerm(option))),
    ...commands.map((sub) => helper.displayWidth(helper.subcommandTerm(sub))),
  );
  const item = (term: string, description: string) =>
    helper.formatItem(term, termWidth, description, helper);
  const section = (title: string, items: string[]) =>
    items.length === 0 ? [] : [helper.styleTitle(title), ...items, ""];

  const description = helper.commandDescription(cmd);
  return [
    `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
    "",
    ...(description === ""
      ? []
      : [helper.styleCommandDescription(description), ""]),
    ...section(
      "Start here:",
      START_HERE.map(([term, sentence]) => item(term, sentence)),
    ),
    ...section(
      "Options:",
      options.map((option) =>
        item(
          helper.styleOptionTerm(helper.optionTerm(option)),
          helper.styleOptionDescription(helper.optionDescription(option)),
        ),
      ),
    ),
    ...groups.flatMap((group) =>
      section(
        `${group.title}:`,
        group.commands.map((sub) =>
          item(
            helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
            helper.styleSubcommandDescription(
              helper.subcommandDescription(sub),
            ),
          ),
        ),
      ),
    ),
    FOOTER,
    "",
  ].join("\n");
}

/** Group the root help and attach Examples; call after every command is registered. */
export function applyHelp(program: Command): void {
  // Subcommands copied the previous help configuration when they were
  // created, so this replaces only the root's renderer.
  program.configureHelp({ formatHelp: formatRootHelp });
  for (const [name, lines] of Object.entries(COMMAND_EXAMPLES)) {
    const command = program.commands.find((entry) => entry.name() === name);
    if (command === undefined)
      throw new Error(`help examples name unregistered command ${name}`);
    command.addHelpText(
      "after",
      `\nExamples:\n${lines.map((line) => `  ${line}`).join("\n")}`,
    );
  }
}
