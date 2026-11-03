// Pure helpers for scripts/brief-eval.mjs, unit-tested in test/brief-eval.test.ts.

const BASH_TRIAGE = /\bidiom\s+brief\s+triage\b/;
const TICKETS_PATH = /(?:^|[\s/"'=])tickets\//;
const BASH_WRITE_INTO_TICKETS =
  /(?:>>?|\btee\b(?:\s+-a)?|\bcp\b|\bmv\b|\btouch\b|\bcat\s*<<)[^|;&]*\btickets\//;

function toolUses(event) {
  if (event?.type !== "assistant") return [];
  const content = event.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === "tool_use");
}

function isTriage(use) {
  if (typeof use.name !== "string") return false;
  if (use.name.endsWith("idiom_brief_triage")) return true;
  return use.name === "Bash" && BASH_TRIAGE.test(use.input?.command ?? "");
}

function isSkillLoad(use) {
  if (use.name === "Skill")
    return /\bidiom\b/.test(JSON.stringify(use.input ?? {}));
  if (use.name === "Read")
    return /skills\/idiom\/SKILL\.md$/.test(use.input?.file_path ?? "");
  return false;
}

function isTicketWrite(use) {
  if (["Write", "Edit", "MultiEdit"].includes(use.name))
    return TICKETS_PATH.test(use.input?.file_path ?? "");
  if (use.name === "Bash")
    return BASH_WRITE_INTO_TICKETS.test(use.input?.command ?? "");
  return false;
}

/**
 * Classifies one stream-json transcript (one JSON event per line). Unknown
 * events and unparseable lines are ignored, so newer event shapes don't break it.
 */
export function classifyTranscript(lines) {
  const tools = [];
  let triagedAt;
  let ticketAt;
  let skillLoaded = false;
  for (const line of lines) {
    let event;
    try {
      event = typeof line === "string" ? JSON.parse(line) : line;
    } catch {
      continue;
    }
    for (const use of toolUses(event)) {
      const index = tools.length;
      tools.push(use.name);
      if (triagedAt === undefined && isTriage(use)) triagedAt = index;
      if (ticketAt === undefined && isTicketWrite(use)) ticketAt = index;
      if (isSkillLoad(use)) skillLoaded = true;
    }
  }
  return {
    triaged: triagedAt !== undefined,
    triagedBeforeTicket:
      triagedAt !== undefined &&
      (ticketAt === undefined || triagedAt < ticketAt),
    skillLoaded,
    ticketWritten: ticketAt !== undefined,
    tools,
  };
}

export function renderEvalTable(rows) {
  const lines = [
    "| Arm | Run | Skill loaded | Triaged | Triaged before ticket | Ticket written | Tool calls |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.arm} | ${row.run} | ${yes(row.skillLoaded)} | ${yes(row.triaged)} | ${yes(row.triagedBeforeTicket)} | ${yes(row.ticketWritten)} | ${row.tools.length} |`,
    ),
  ];
  const arms = [...new Set(rows.map((row) => row.arm))];
  for (const arm of arms) {
    const armRows = rows.filter((row) => row.arm === arm);
    lines.push(
      "",
      `${arm}: ${armRows.filter((row) => row.triagedBeforeTicket).length}/${armRows.length} triaged before writing a ticket.`,
    );
  }
  return lines.join("\n");
}

function yes(value) {
  return value ? "yes" : "no";
}

/** Kept equal to src/brief/instruction.ts's BRIEF_INSTRUCTION by a test. */
export const EVAL_BRIEF_INSTRUCTION = `## Design decisions (Idiom)
Before writing a ticket or code that involves a design decision, run \`idiom brief triage "<request>"\` (or the \`idiom_brief_triage\` MCP tool) and follow it.
`;
