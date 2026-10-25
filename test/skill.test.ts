import { expect, test } from "vitest";
import { createProgram } from "../src/cli.js";
import {
  readIdiomSkillFile,
  readIdiomSkillTemplate,
} from "../src/templates.js";

const guide = await readIdiomSkillFile("init.md");

test("the distributed Idiom skill has valid manual-invocation front matter", async () => {
  const skill = await readIdiomSkillTemplate();
  const lines = skill.split("\n");
  expect(lines.length).toBeLessThanOrEqual(100);
  expect(lines[0]).toBe("---");
  expect(skill).toMatch(/^---\nname: idiom\n/);
  expect(skill).toMatch(/\ndescription: \S[^\n]+\n/);
  expect(skill).toContain("disable-model-invocation: true");
  expect(skill.indexOf("\n---\n", 4)).toBeGreaterThan(0);
});

test("the skill resolves exploration from stored evidence", async () => {
  const skill = await readIdiomSkillTemplate();
  const generation = skill.indexOf("idiom explore <flow> --state <state>");
  const artifact = skill.indexOf("exploration.json");
  const presentation = skill.indexOf("In A/B/C order");
  const resolution = skill.indexOf("idiom explore resolve <runId>");
  expect(generation).toBeGreaterThan(-1);
  expect(artifact).toBeGreaterThan(generation);
  expect(presentation).toBeGreaterThan(artifact);
  expect(resolution).toBeGreaterThan(presentation);
  expect(skill).toContain("all screenshots below its stored `capture` path");
  expect(skill).toContain(
    "Pass the human's reason\ntext unchanged as one shell-safe CLI argument",
  );
  expect(skill).toContain("--none --reason <reason> --yes");
  expect(skill).toContain("add `--repairs` only when requested");
  expect(skill).toContain("Never infer a choice, offer refinement");
  expect(skill).toContain("leave the outcome only in the conversation");
});

test("the review workflow preserves the CLI lifecycle and immutable capture", async () => {
  const skill = await readIdiomSkillTemplate();
  const commands = [
    "idiom validate [flow]",
    "idiom capture <flow>",
    "idiom review <flow> --from <runId>",
    "idiom decide --list",
    "idiom decide --finding <id> --accept --reason <reason>",
    "idiom tickets --finding <id>...",
    "idiom instruction --finding <id>",
  ];
  let previous = -1;
  for (const command of commands) {
    const index = skill.indexOf(command);
    expect(index, command).toBeGreaterThan(previous);
    previous = index;
  }
  expect(skill).toContain("never recapture");
  expect(skill).toContain("deterministic filename order");
  expect(skill).toContain("exactly those IDs");
  expect(skill).toContain("failed tuples");
  expect(skill).toContain("publishes a run is reviewable evidence");
  expect(skill).toContain("continue");
  expect(skill).toContain(
    "Stop only when capture publishes no unambiguous run",
  );
  expect(skill).toContain(
    "If none\n   were accepted, do not run `idiom tickets`",
  );
  expect(skill).toContain("never run it without at least one\n   `--finding`");
  expect(skill).toContain("optional external handoff");
  expect(skill).toContain("Never\n   apply the instruction or send it");
});

test("the skill requires evidence-backed human decisions", async () => {
  const skill = await readIdiomSkillTemplate();
  expect(skill).toContain("evidence.screenshots");
  expect(skill).toContain("sibling `findings.json`");
  expect(skill).toContain("against the run directory");
  expect(skill).toContain("visual evidence is absent");
  expect(skill).toContain("degraded-review warning");
  expect(skill).toContain("do not revisit an occurrence already decided");
  expect(skill).toContain(
    "idiom decide --finding <id> --reject --scope <scope> --reason <reason>",
  );
  expect(skill).toContain("scope is `instance` or `rule`");
  expect(skill).toContain("reason text unchanged as one CLI argument");
});

test("the skill documents managed references before immutable review", async () => {
  const skill = await readIdiomSkillTemplate();
  expect(skill).toContain("idiom reference add <name> --url <url>");
  expect(skill).toContain("idiom reference list");
  expect(skill).toContain("Never invent the required note");
  expect(skill).toContain("before the immutable");
});

test("the skill keeps unruled decisions outside the finding decision loop", async () => {
  const skill = await readIdiomSkillTemplate();
  expect(skill).toContain("unruled-decisions.json");
  expect(skill).toContain("present recurrence, nearest law passage");
  expect(skill).toContain("candidate beside its citation");
  expect(skill).toContain("idiom ruling --decision <id> --candidate <n>");
  expect(skill).toContain("--wording <text>");
  expect(skill).toContain("--no-rule");
  expect(skill).toContain(
    "Never route rulings through accept/reject or tickets",
  );
});

test("verification and ownership boundaries are explicit", async () => {
  const skill = await readIdiomSkillTemplate();
  expect(skill).toContain("idiom verify <flow> --spec <ticket-or-spec>");
  expect(skill).toContain("Never edit product code");
  expect(skill).toContain("promote tickets");
  expect(skill).toContain("start Autobuild");
  expect(skill).toContain("Do not repair anything yourself");
});

test("the skill routes /idiom init to the guided initialization document", async () => {
  const skill = await readIdiomSkillTemplate();
  expect(skill).toContain("When `$ARGUMENTS` is `init`");
  expect(skill).toContain("`init.md` beside this file");
  expect(skill).toContain("idiom init --yes");
  expect(skill).toContain(
    "optional flow id — never `init`, `verify` or `check`",
  );
});

test("guided initialization scaffolds safely before it mines or asks", async () => {
  const phases = [
    "## Phase 0 — scaffold safely",
    "## Phase 1 — mine the repository first, ask nothing yet",
    "## Phase 2 — ask only what the code cannot answer",
    "## Phase 3 — capture the references",
    "## Phase 4 — draft both files",
    "## Phase 5 — hand it back",
  ];
  let previous = -1;
  for (const phase of phases) {
    const index = guide.indexOf(phase);
    expect(index, phase).toBeGreaterThan(previous);
    previous = index;
  }
  expect(guide).toContain("`idiom init --yes`");
  expect(guide).toContain("Never run `idiom init`\nwithout `--yes`");
  expect(guide).toContain(
    "`Preserved existing <file>` line marks a **human-owned**",
  );
  expect(guide).toContain("under\nfifteen minutes");
  expect(guide.split("\n").length).toBeLessThanOrEqual(150);
});

test("the interview asks only what the repository cannot answer", async () => {
  expect(guide).toContain("At most six questions");
  expect(guide).toContain("each must be underivable from");
  expect(guide).toContain("one to three links or screenshots");
  expect(guide).toContain("one to three they **dislike**");
  expect(guide).toContain("more than three liked");
  expect(guide).toContain("any taste quiz");
  expect(guide).toContain("any scoring");
  expect(guide).toContain("asking for adjectives instead of evidence");
  expect(guide).toContain("**an existing design language**");
  expect(guide).toContain("**none found**");
  expect(guide).toContain("**When Phase 1 found none**");
});

test("offered links become managed references at a configured viewport", async () => {
  expect(guide).toContain(
    "`idiom reference add <slug> --url <url> --viewport <viewport> --note",
  );
  expect(guide).toContain("`idiom reference add <slug> --file <path> --note");
  expect(guide).toContain("`--anti` for the disliked ones");
  expect(guide).toContain("read `viewports[].name` from `.idiom/project.json`");
  expect(guide).toContain("never invent the note");
  expect(guide).toContain("`--viewport` is required with `--url`");
  expect(guide).not.toContain("--viewport desktop");
});

test("every drafted claim carries its source and the files stay the human's", async () => {
  expect(guide).toContain("Every claim carries its source inline");
  expect(guide).toContain("explicit unknown, never guessed");
  expect(guide).toContain("they are the human's files to\ncorrect");
  expect(guide).toContain("never overwritten without explicit approval");
  expect(guide).toContain("Never edit product code");
  expect(guide).toContain("any other dispatcher");
});

test("the close runs only commands a freshly initialized project can pass", async () => {
  expect(guide.indexOf("Close with `idiom reference list`")).toBeGreaterThan(
    guide.indexOf("## Phase 5"),
  );
  for (const paragraph of guide.split("\n\n"))
    if (paragraph.includes("idiom validate"))
      expect(paragraph, "unconditional `idiom validate`").toContain("only if");
  expect(guide).toContain("no flow manifests found");
});

test("the interview names no command the CLI does not have", async () => {
  const registered = new Set(
    createProgram().commands.map((command) => command.name()),
  );
  const named = [...guide.matchAll(/`idiom ([a-z][a-z-]*)/g)].map(
    (match) => match[1],
  );
  expect(named.length).toBeGreaterThan(0);
  for (const command of new Set(named))
    expect([...registered], command).toContain(command);
});
