import { expect, test } from "vitest";
// @ts-expect-error The eval helpers are plain Node ESM without declarations.
import * as lib from "../scripts/brief-eval-lib.mjs";
import { BRIEF_INSTRUCTION } from "../src/brief/instruction.js";

const { classifyTranscript, EVAL_BRIEF_INSTRUCTION, renderEvalTable } = lib;

const use = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  });

test("an MCP triage before the ticket write counts", () => {
  const result = classifyTranscript([
    JSON.stringify({ type: "system", subtype: "init" }),
    use("Skill", { skill: "idiom" }),
    use("mcp__idiom__idiom_brief_triage", { request: "add a pin" }),
    use("Write", { file_path: "/tmp/p/tickets/pinned.md", content: "x" }),
    JSON.stringify({ type: "result", is_error: false }),
  ]);
  expect(result).toEqual({
    triaged: true,
    triagedBeforeTicket: true,
    skillLoaded: true,
    ticketWritten: true,
    tools: ["Skill", "mcp__idiom__idiom_brief_triage", "Write"],
  });
});

test("a Bash triage after the ticket write does not count as before", () => {
  const result = classifyTranscript([
    use("Write", { file_path: "tickets/pinned.md", content: "x" }),
    use("Bash", { command: 'idiom brief triage "add a pin" --json' }),
  ]);
  expect(result.triaged).toBe(true);
  expect(result.triagedBeforeTicket).toBe(false);
  expect(result.skillLoaded).toBe(false);
});

test("no triage, and unknown or broken lines are ignored", () => {
  const result = classifyTranscript([
    "not json",
    JSON.stringify({ type: "future_event", data: {} }),
    use("Read", { file_path: "/p/.claude/skills/idiom/SKILL.md" }),
    use("Edit", { file_path: "tickets/pinned.md" }),
  ]);
  expect(result).toMatchObject({
    triaged: false,
    triagedBeforeTicket: false,
    skillLoaded: true,
    ticketWritten: true,
  });
});

test("a Bash heredoc into tickets/ is a ticket write", () => {
  const result = classifyTranscript([
    use("Bash", { command: "cat > tickets/pinned.md <<'EOF'\n# Pinned\nEOF" }),
    use("Bash", { command: "ls tickets/" }),
  ]);
  expect(result.ticketWritten).toBe(true);
  expect(
    classifyTranscript([use("Bash", { command: "ls tickets/" })]).ticketWritten,
  ).toBe(false);
});

test("the eval's instruction matches the one init offers, and the table counts passes", () => {
  expect(EVAL_BRIEF_INSTRUCTION).toBe(BRIEF_INSTRUCTION);
  const table = renderEvalTable([
    {
      arm: "skill",
      run: 1,
      skillLoaded: true,
      triaged: true,
      triagedBeforeTicket: true,
      ticketWritten: true,
      tools: ["a"],
    },
    {
      arm: "skill",
      run: 2,
      skillLoaded: false,
      triaged: false,
      triagedBeforeTicket: false,
      ticketWritten: true,
      tools: [],
    },
  ]);
  expect(table).toContain("skill: 1/2 triaged before writing a ticket.");
});
