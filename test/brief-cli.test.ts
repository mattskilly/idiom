import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { triageId } from "../src/brief/store.js";
import { type ProgramDependencies, run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";

const fixtureText = readFileSync(
  new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
  "utf8",
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function temporary(init: boolean): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-brief-cli-"));
  directories.push(directory);
  if (init) await initProject({ project: directory, yes: true });
  return directory;
}

async function idiom(
  cwd: string,
  args: string[],
  brief: ProgramDependencies["brief"] = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", ...args], {
    cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    brief: { now: () => new Date("2026-10-31T10:00:00Z"), ...brief },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

const verdict = {
  verdict: "design decision",
  reason: "adds a per-tile control",
  questions: ["How large is the pin?", "How does it behave on touch?"],
};

test("triage --json prints id, verdict, reason and questions and stores the triage", async () => {
  const directory = await temporary(true);
  const result = await idiom(
    directory,
    ["brief", "triage", "add a pin to every tile", "--json"],
    { invoke: async () => ({ ...verdict }) },
  );
  expect(result.code).toBe(0);
  const printed = JSON.parse(result.stdout);
  expect(Object.keys(printed)).toEqual([
    "interfaceVersion",
    "id",
    "verdict",
    "reason",
    "questions",
  ]);
  expect(printed).toEqual({
    interfaceVersion: 1,
    id: triageId(1, "add a pin to every tile"),
    ...verdict,
  });
  const stored = JSON.parse(
    await readFile(
      join(directory, ".idiom", "briefs", "triage", `${printed.id}.json`),
      "utf8",
    ),
  );
  expect(stored).toMatchObject({ version: 1, id: printed.id, ...verdict });
});

test("triage prints the verdict line, one line per question, the id and the next step", async () => {
  const directory = await temporary(true);
  const result = await idiom(
    directory,
    ["brief", "triage", "add a pin to every tile"],
    { invoke: async () => verdict },
  );
  const id = triageId(1, "add a pin to every tile");
  expect(result.stdout).toBe(
    `design decision: adds a per-tile control\n- How large is the pin?\n- How does it behave on touch?\n\nTriage id: ${id}\nNext: idiom brief plan ${id}\n`,
  );
});

test("--no-model works without a project and prints the rubric and a JSON shape", async () => {
  const directory = await temporary(false);
  const result = await idiom(directory, [
    "brief",
    "triage",
    "fix the typo",
    "--no-model",
  ]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("# Design decision rubric");
  expect(result.stdout).toContain("## Request\n\nfix the typo");
  expect(result.stdout).toContain('```json\n{\n  "verdict"');
  const json = await idiom(directory, [
    "brief",
    "triage",
    "fix the typo",
    "--no-model",
    "--json",
  ]);
  expect(JSON.parse(json.stdout)).toMatchObject({
    rubricVersion: 1,
    request: "fix the typo",
    context: { references: [] },
  });
});

test("triage without a project points at idiom init and --no-model", async () => {
  const directory = await temporary(false);
  const result = await idiom(directory, ["brief", "triage", "add a pin"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/run idiom init .* --no-model/);
});

test("record, list and show round-trip a brief", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "brief.json"), fixtureText);
  const recorded = await idiom(directory, ["brief", "record", "brief.json"]);
  expect(recorded.code).toBe(0);
  expect(recorded.stdout).toMatch(
    new RegExp(
      `^Recorded brief pinned-group-in-the-add-drawer \\(created, proposed\\) — ${join(".idiom", "briefs", "pinned-group-in-the-add-drawer.md").replace(/\./g, "\\.")}\n\nAsk the requester: `,
    ),
  );
  expect(recorded.stdout).toContain(
    "1. A small corner pin icon inside the tile (Recommended) [corner-pin]",
  );
  expect(recorded.stdout).toContain(
    "Ask: must ask: the recommendation overrides the requester's own idea. Then run idiom brief decide pinned-group-in-the-add-drawer --option <id>.",
  );
  const decided = JSON.stringify({
    ...JSON.parse(fixtureText),
    status: "decided",
    decidedBy: "requester",
  });
  const viaStdin = await idiom(directory, ["brief", "record", "-"], {
    readStdin: async () => decided,
  });
  expect(viaStdin.stdout).toContain("(updated, decided)");
  expect(viaStdin.stdout).toContain("\nDecided by requester\n");

  const list = await idiom(directory, ["brief", "list"]);
  expect(list.stdout).toBe(
    "pinned-group-in-the-add-drawer  decided by requester  Pinned group in the Add drawer\n",
  );
  const listJson = await idiom(directory, ["brief", "list", "--json"]);
  expect(JSON.parse(listJson.stdout)[0].slug).toBe(
    "pinned-group-in-the-add-drawer",
  );
  const show = await idiom(directory, [
    "brief",
    "show",
    "pinned-group-in-the-add-drawer",
  ]);
  expect(show.stdout).toMatch(/^# Pinned group in the Add drawer\n/);
  expect(show.stdout).toContain("## Acceptance criteria");
  const showJson = await idiom(directory, [
    "brief",
    "show",
    "pinned-group-in-the-add-drawer",
    "--json",
  ]);
  expect(JSON.parse(showJson.stdout)).toMatchObject({
    status: "decided",
    decidedBy: "requester",
  });
});

test("invalid brief input exits non-zero with every issue on stderr", async () => {
  const directory = await temporary(true);
  const input = JSON.parse(fixtureText);
  input.options = input.options.slice(0, 1);
  input.research[0].findings[0].verified = "assumed";
  await writeFile(join(directory, "bad.json"), JSON.stringify(input));
  const result = await idiom(directory, ["brief", "record", "bad.json"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("brief rejected:");
  expect(result.stderr).toContain("research[0].findings[0].verified");
  expect(result.stderr).toMatch(/\n {2}options: /);
  const notJson = await idiom(directory, ["brief", "record", "-"], {
    readStdin: async () => "{",
  });
  expect(notJson.stderr).toMatch(/brief input is not valid JSON/);
  expect((await idiom(directory, ["brief", "list"])).stdout).toBe(
    "No briefs.\n",
  );
});

test("record --json returns the ask in AskUserQuestion shape", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "brief.json"), fixtureText);
  const result = await idiom(directory, [
    "brief",
    "record",
    "brief.json",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const printed = JSON.parse(result.stdout);
  expect(printed).toMatchObject({
    slug: "pinned-group-in-the-add-drawer",
    outcome: "created",
    status: "proposed",
    markdownPath: join(".idiom", "briefs", "pinned-group-in-the-add-drawer.md"),
    ask: { recommendation: "corner-pin", proceed: { allowed: false } },
  });
  expect(printed.ask.askUserQuestion.questions[0]).toMatchObject({
    question:
      "How does a user pin an item in the Add drawer without making every tile bigger?",
    header: "Design call",
    multiSelect: false,
  });
});

test("plan reads a stored triage by id", async () => {
  const directory = await temporary(true);
  const triage = await idiom(
    directory,
    ["brief", "triage", "add a pin to every tile", "--json"],
    { invoke: async () => verdict },
  );
  const { id } = JSON.parse(triage.stdout);
  const invoke = async () => {
    throw new Error("plan by id must not call a model");
  };
  const plan = await idiom(directory, ["brief", "plan", id, "--json"], {
    invoke,
  });
  expect(plan.code).toBe(0);
  const printed = JSON.parse(plan.stdout);
  expect(printed.triageId).toBe(id);
  expect(printed.inventoryInstructions.join(" ")).toContain(
    "real objects and magnitudes",
  );
  expect(printed.stateChecklist.join(" ")).toContain("editor+menu");
  expect(printed.request).toBe("add a pin to every tile");
  expect(
    printed.questions.map((q: { question: string }) => q.question),
  ).toEqual(verdict.questions);
  const text = await idiom(directory, ["brief", "plan", id], { invoke });
  expect(text.stdout).toMatch(/^# Research plan\n/);
  expect(text.stdout).toContain("## Inventory before options");
  expect(text.stdout).toContain("## Build every state");
  const missing = await idiom(directory, [
    "brief",
    "plan",
    "triage-0000000000",
  ]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain(
    "no triage named triage-0000000000; run idiom brief triage first",
  );
});

test("plan with --question works outside a project and needs no model", async () => {
  const directory = await temporary(false);
  const result = await idiom(directory, [
    "brief",
    "plan",
    "add a pin to every tile",
    "--question",
    "How large is the pin?",
    "--question",
    "How does it work on touch?",
    "--minutes",
    "5",
    "--json",
  ]);
  expect(result.code).toBe(0);
  const printed = JSON.parse(result.stdout);
  expect(printed.triageId).toBeUndefined();
  expect(printed.questions).toHaveLength(2);
  expect(printed.budget.minutes).toBe(5);
  expect(printed.referencesNote).toMatch(/^None configured/);
});

test("plan with only a request runs and stores a triage first", async () => {
  const directory = await temporary(true);
  let calls = 0;
  const result = await idiom(
    directory,
    ["brief", "plan", "add a pin to every tile", "--json"],
    {
      invoke: async () => {
        calls += 1;
        return verdict;
      },
    },
  );
  expect(result.code).toBe(0);
  expect(calls).toBe(1);
  expect(JSON.parse(result.stdout).triageId).toBe(
    triageId(1, "add a pin to every tile"),
  );
  const outside = await idiom(await temporary(false), [
    "brief",
    "plan",
    "add a pin",
  ]);
  expect(outside.code).toBe(1);
  expect(outside.stderr).toMatch(/run idiom init .* --question/);
});

test("plan rejects an out-of-range budget and too many questions", async () => {
  const directory = await temporary(false);
  const zero = await idiom(directory, [
    "brief",
    "plan",
    "add a pin",
    "--question",
    "q?",
    "--minutes",
    "0",
  ]);
  expect(zero.code).toBe(1);
  expect(zero.stderr).toContain(
    "--minutes must be a whole number from 1 to 60",
  );
  const many = await idiom(directory, [
    "brief",
    "plan",
    "add a pin",
    ...Array.from({ length: 9 }, (_, i) => ["--question", `q${i}?`]).flat(),
  ]);
  expect(many.code).toBe(1);
  expect(many.stderr).toContain("at most 8 questions");
});

test("decide records the choice, re-renders the brief and warns when it differs", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "brief.json"), fixtureText);
  await idiom(directory, ["brief", "record", "brief.json"]);
  const markdown = join(
    ".idiom",
    "briefs",
    "pinned-group-in-the-add-drawer.md",
  );
  const decided = await idiom(directory, [
    "brief",
    "decide",
    "pinned-group-in-the-add-drawer",
    "--option",
    "corner-pin",
  ]);
  expect(decided.code).toBe(0);
  expect(decided.stdout).toBe(
    `Decided brief pinned-group-in-the-add-drawer: A small corner pin icon inside the tile (by requester) — ${markdown}\n`,
  );
  expect(await readFile(join(directory, markdown), "utf8")).toContain(
    "**Decision:** A small corner pin icon inside the tile (decided by requester).",
  );
  const other = await idiom(directory, [
    "brief",
    "decide",
    "pinned-group-in-the-add-drawer",
    "--option",
    "sibling-button",
    "--by",
    "a designer",
    "--json",
  ]);
  expect(JSON.parse(other.stdout)).toMatchObject({
    outcome: "re-decided",
    chosen: "sibling-button",
    recommended: "corner-pin",
    decidedBy: "a designer",
    warning: expect.stringMatching(/re-record the brief/),
  });
  const overridden = await readFile(join(directory, markdown), "utf8");
  expect(overridden).toContain("not ticket-ready");
  expect(overridden).toContain(
    "**Not ticket-ready.** These criteria were written for the recommendation (A small corner pin icon inside the tile), not the chosen",
  );
  expect(overridden).not.toContain("- [ ]");
  const declined = await idiom(directory, [
    "brief",
    "decide",
    "pinned-group-in-the-add-drawer",
    "--option",
    "dont-build",
  ]);
  expect(declined.code).toBe(0);
  expect(declined.stdout).toContain("nothing to build");
  const nothing = await readFile(join(directory, markdown), "utf8");
  expect(nothing).toContain("**Decision:** Don't build it");
  expect(nothing).toContain("**Nothing to build.**");
  expect(nothing).not.toContain("- [ ]");
  const back = await idiom(directory, [
    "brief",
    "decide",
    "pinned-group-in-the-add-drawer",
    "--option",
    "corner-pin",
  ]);
  expect(back.stdout).not.toContain("Warning");
  const restored = await readFile(join(directory, markdown), "utf8");
  expect(restored).toContain("- [ ] ");
  expect(restored).not.toContain("ticket-ready");
  const unknown = await idiom(directory, [
    "brief",
    "decide",
    "pinned-group-in-the-add-drawer",
    "--option",
    "nope",
  ]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("choose one of sibling-button, corner-pin");
});

const {
  research: _research,
  request: _request,
  ...optionsAnswer
} = JSON.parse(fixtureText);
const researchStub: NonNullable<ProgramDependencies["brief"]>["research"] =
  async (call) =>
    call.stage === "research"
      ? {
          answer: {
            findings: [
              {
                claim: "Pins sit in the tile corner.",
                source: "https://example.com/pins",
                verified: "read",
              },
            ],
          },
          turns: 4,
          tokens: { input: 1_000, output: 200 },
        }
      : { answer: optionsAnswer, turns: 1 };

function clock() {
  let now = 0;
  return () => {
    now += 46_000;
    return now;
  };
}

test("--research triages, researches, stores, and prints the cost", async () => {
  const directory = await temporary(true);
  const result = await idiom(
    directory,
    ["brief", "Add a pin button to every tile", "--research"],
    { invoke: async () => verdict, research: researchStub, clock: clock() },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    [
      `Recorded brief pinned-group-in-the-add-drawer (created, proposed) — ${join(".idiom", "briefs", "pinned-group-in-the-add-drawer.md")}`,
      "Cost: 46s, 3 calls, 9 turns, 2,000 input / 400 output tokens (budget 15 minutes)",
      "",
    ].join("\n"),
  );
  expect(result.stderr).toContain("Researching 1/2: How large is the pin?");
  const list = await idiom(directory, ["brief", "list"]);
  expect(list.stdout).toContain("pinned-group-in-the-add-drawer  proposed");
});

test("--research --json prints the outcome", async () => {
  const directory = await temporary(true);
  const result = await idiom(
    directory,
    ["brief", "Add a pin button to every tile", "--research", "--json"],
    { invoke: async () => verdict, research: researchStub, clock: clock() },
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    interfaceVersion: 1,
    outcome: "stored",
    triage: verdict,
    slug: "pinned-group-in-the-add-drawer",
    markdown: join(".idiom", "briefs", "pinned-group-in-the-add-drawer.md"),
    status: "proposed",
    researchRun: {
      provider: "claude-code",
      model: expect.any(String),
      budgetMs: 900_000,
      durationMs: 46_000,
      calls: 3,
      turns: 9,
      tokens: { input: 2_000, output: 400 },
    },
  });
});

test("--research with no design decision runs no research", async () => {
  const directory = await temporary(true);
  let calls = 0;
  const result = await idiom(
    directory,
    ["brief", "fix the typo", "--research"],
    {
      invoke: async () => ({
        verdict: "no design decision",
        reason: "a copy fix",
        questions: [],
      }),
      research: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    },
  );
  expect(result.code).toBe(0);
  expect(calls).toBe(0);
  expect(result.stdout).toBe(
    "no design decision: a copy fix\nNo design decision; no research run.\n",
  );
});

test("--research refuses an anthropic-only provider before triage", async () => {
  const directory = await temporary(true);
  const path = join(directory, ".idiom", "project.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.model = { provider: "anthropic", model: "claude-sonnet-5-5" };
  await writeFile(path, JSON.stringify(config));
  let triaged = false;
  const result = await idiom(directory, ["brief", "add a pin", "--research"], {
    invoke: async () => {
      triaged = true;
      return verdict;
    },
  });
  expect(result.code).toBe(1);
  expect(triaged).toBe(false);
  expect(result.stderr).toMatch(
    /--research needs model.provider \(or model.fallback\) claude-code or codex/,
  );
});

test("a bare request without --research errors; bare brief shows help", async () => {
  const directory = await temporary(true);
  const result = await idiom(directory, ["brief", "add a pin"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/pass --research/);
  const bare = await idiom(directory, ["brief"]);
  expect(bare.code).toBe(1);
  expect(bare.stderr).toMatch(/^Usage: idiom brief/);
});

test("subcommand --json survives the parent's --json, before or after the name", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "brief.json"), fixtureText);
  await idiom(directory, ["brief", "record", "brief.json"]);
  const triage = await idiom(
    directory,
    ["brief", "triage", "x", "--json", "--project", directory],
    { invoke: async () => verdict },
  );
  expect(JSON.parse(triage.stdout)).toMatchObject(verdict);
  for (const args of [
    ["brief", "list", "--json"],
    ["brief", "--json", "list"],
  ]) {
    const listed = await idiom(directory, args);
    expect(JSON.parse(listed.stdout)[0].slug).toBe(
      "pinned-group-in-the-add-drawer",
    );
  }
  for (const args of [
    ["brief", "record", "brief.json", "--json"],
    ["brief", "--json", "record", "brief.json"],
  ]) {
    const recorded = await idiom(directory, args);
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      slug: "pinned-group-in-the-add-drawer",
      outcome: "updated",
    });
  }
  const shown = await idiom(directory, [
    "brief",
    "show",
    "pinned-group-in-the-add-drawer",
    "--json",
  ]);
  expect(JSON.parse(shown.stdout).slug).toBe("pinned-group-in-the-add-drawer");
  const noModel = await idiom(directory, [
    "brief",
    "triage",
    "x",
    "--no-model",
    "--json",
  ]);
  expect(JSON.parse(noModel.stdout).request).toBe("x");
});

test("stray parent flags are refused where they do nothing", async () => {
  const directory = await temporary(true);
  const list = await idiom(directory, ["brief", "list", "--research"]);
  expect(list.code).toBe(1);
  expect(list.stderr).toMatch(/--research applies only to idiom brief/);
  const plan = await idiom(directory, [
    "brief",
    "plan",
    "x",
    "--question",
    "q?",
    "--research",
  ]);
  expect(plan.code).toBe(1);
  expect(plan.stderr).toMatch(/--research applies only to idiom brief/);
});

const slug = "pinned-group-in-the-add-drawer";

function counting(answer: object) {
  const calls: string[] = [];
  return {
    calls,
    invoke: async (prompt: string) => {
      calls.push(prompt);
      return { ...answer };
    },
  };
}

const noDecision = {
  verdict: "no design decision",
  reason: "copy change only",
  questions: [],
};

test("gate warns on a UI ticket without a brief and exits 0", async () => {
  const directory = await temporary(true);
  await writeFile(
    join(directory, "pin.md"),
    "# Pin\n\nAdd a pin to every tile.\n",
  );
  const model = counting(verdict);
  const result = await idiom(directory, ["brief", "gate", "pin.md"], {
    invoke: model.invoke,
  });
  expect(result.code).toBe(0);
  expect(model.calls).toHaveLength(1);
  const id = triageId(1, "# Pin\n\nAdd a pin to every tile.\n");
  expect(result.stdout).toBe(
    [
      "Warning: pin.md adds a design decision with no brief.",
      "  - How large is the pin?",
      "  - How does it behave on touch?",
      `  Run: idiom brief plan ${id} (or: idiom brief "pin.md" --research)`,
      '  Then link it with a "brief: <slug>" line, or paste .idiom/briefs/<slug>.md into the ticket.',
      "1 of 1 ticket(s) need a decided brief.\n",
    ].join("\n"),
  );
});

test("gate passes a ticket linking or embedding a decided brief with no model call", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "brief.json"), fixtureText);
  await idiom(directory, ["brief", "record", "brief.json"]);
  await idiom(directory, ["brief", "decide", slug, "--option", "corner-pin"]);
  await writeFile(
    join(directory, "linked.md"),
    `# Pin\n\nAdd a pin to every tile.\n\n- brief: ${slug}\n`,
  );
  const rendered = await readFile(
    join(directory, ".idiom", "briefs", `${slug}.md`),
    "utf8",
  );
  await writeFile(
    join(directory, "embedded.md"),
    `# Pin\n\nAdd a pin to every tile.\n\n${rendered}`,
  );
  const model = counting(verdict);
  const result = await idiom(
    directory,
    ["brief", "gate", "linked.md", "embedded.md", "--strict"],
    { invoke: model.invoke },
  );
  expect(result).toMatchObject({ code: 0, stdout: "" });
  expect(model.calls).toHaveLength(0);
});

test("gate warns that a proposed brief's decision is still open", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "brief.json"), fixtureText);
  await idiom(directory, ["brief", "record", "brief.json"]);
  await writeFile(join(directory, "t.md"), `# Pin\n\nbrief: ${slug}\n`);
  const result = await idiom(directory, ["brief", "gate", "t.md"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `Warning: t.md links brief ${slug}, which is still proposed: the decision is open.`,
  );
  expect(result.stdout).toContain(
    `Run: ask the requester, then idiom brief decide ${slug} --option <id>`,
  );
});

test("gate passes a copy-fix ticket with one triage call and no research", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "copy.md"), "# Typo\n\nFix 'recieve'.\n");
  const model = counting(noDecision);
  let researched = false;
  const result = await idiom(directory, ["brief", "gate", "copy.md"], {
    invoke: model.invoke,
    research: async () => {
      researched = true;
      throw new Error("research must not run");
    },
  });
  expect(result).toMatchObject({ code: 0, stdout: "" });
  expect(model.calls).toHaveLength(1);
  expect(researched).toBe(false);
});

test("gate --strict exits 1 on a warning and 0 when every ticket passes", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "pin.md"), "# Pin\n\nAdd a pin.\n");
  const warned = await idiom(
    directory,
    ["brief", "gate", "pin.md", "--strict"],
    {
      invoke: async () => ({ ...verdict }),
    },
  );
  expect(warned.code).toBe(1);
  expect(warned.stdout).toContain("Warning: pin.md adds a design decision");
  expect(warned.stderr).toContain(
    "Error: brief gate: 1 ticket(s) need a decided brief",
  );
  const passed = await idiom(
    directory,
    ["brief", "gate", "pin.md", "--strict"],
    {
      invoke: async () => ({ ...noDecision }),
    },
  );
  expect(passed).toMatchObject({ code: 0, stdout: "" });
});

test("gate --json reports each ticket's outcome and reason", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "brief.json"), fixtureText);
  await idiom(directory, ["brief", "record", "brief.json"]);
  await idiom(directory, ["brief", "decide", slug, "--option", "corner-pin"]);
  await writeFile(join(directory, "pin.md"), "# Pin\n\nAdd a pin.\n");
  await writeFile(join(directory, "copy.md"), "# Typo\n\nFix it.\n");
  await writeFile(join(directory, "ok.md"), `**Brief:** \`${slug}\`\n`);
  for (const args of [
    ["brief", "gate", "pin.md", "copy.md", "ok.md", "--json"],
    ["brief", "--json", "gate", "pin.md", "copy.md", "ok.md"],
  ]) {
    const result = await idiom(directory, args, {
      invoke: async (prompt: string) =>
        prompt.includes("Add a pin") ? { ...verdict } : { ...noDecision },
    });
    expect(result.code).toBe(0);
    const printed = JSON.parse(result.stdout);
    expect(Object.keys(printed)).toEqual([
      "interfaceVersion",
      "strict",
      "warnings",
      "tickets",
    ]);
    expect(printed.strict).toBe(false);
    expect(printed.warnings).toBe(1);
    expect(
      printed.tickets.map((t: { outcome: string; reason: string }) => [
        t.outcome,
        t.reason,
      ]),
    ).toEqual([
      ["warn", "no-brief"],
      ["pass", "no-decision"],
      ["pass", "decided"],
    ]);
    expect(printed.tickets[0]).toMatchObject({
      path: "pin.md",
      briefs: [],
      triage: { verdict: "design decision", questions: verdict.questions },
      next: [
        expect.stringMatching(/^idiom brief plan triage-/),
        'idiom brief "pin.md" --research',
      ],
    });
    expect(printed.tickets[1]).not.toHaveProperty("message");
    expect(printed.tickets[2]).toEqual({
      path: "ok.md",
      outcome: "pass",
      reason: "decided",
      briefs: [{ source: "link", slug, status: "decided" }],
    });
  }
});

test("a triage failure warns by default and fails under --strict", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "pin.md"), "# Pin\n\nAdd a pin.\n");
  const failing = {
    invoke: async () => {
      throw new Error("provider is down");
    },
  };
  const warned = await idiom(directory, ["brief", "gate", "pin.md"], failing);
  expect(warned.code).toBe(0);
  expect(warned.stdout).toContain(
    "Warning: could not triage pin.md: provider is down",
  );
  const strict = await idiom(
    directory,
    ["brief", "gate", "pin.md", "--strict"],
    failing,
  );
  expect(strict.code).toBe(1);
  const json = await idiom(
    directory,
    ["brief", "gate", "pin.md", "--json"],
    failing,
  );
  expect(JSON.parse(json.stdout).tickets[0]).toMatchObject({
    outcome: "error",
    reason: "triage-failed",
  });
});

test("gate usage errors exit 1 before any model call", async () => {
  const directory = await temporary(true);
  const model = counting(verdict);
  await writeFile(join(directory, "pin.md"), "# Pin\n");
  const missing = await idiom(
    directory,
    ["brief", "gate", "pin.md", "nope.md"],
    { invoke: model.invoke },
  );
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("no ticket file at nope.md");
  await writeFile(join(directory, "empty.md"), "  \n");
  const empty = await idiom(directory, ["brief", "gate", "empty.md"], {
    invoke: model.invoke,
  });
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("ticket empty.md is empty");
  expect(model.calls).toHaveLength(0);
  const outside = await temporary(false);
  await writeFile(join(outside, "pin.md"), "# Pin\n");
  const noProject = await idiom(outside, ["brief", "gate", "pin.md"], {
    invoke: model.invoke,
  });
  expect(noProject.code).toBe(1);
  expect(noProject.stderr).toMatch(/run idiom init/);
  expect(model.calls).toHaveLength(0);
});

test("a linked brief that does not exist warns as missing-brief", async () => {
  const directory = await temporary(true);
  await writeFile(join(directory, "t.md"), "- brief: no-such-brief\n");
  const result = await idiom(directory, ["brief", "gate", "t.md", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).tickets[0]).toMatchObject({
    outcome: "warn",
    reason: "missing-brief",
    briefs: [{ source: "link", slug: "no-such-brief", status: "missing" }],
  });
});

test("CLI record and decide retain optional screen inventory", async () => {
  const directory = await temporary(true);
  const inventory = {
    screenQuestion: "What needs action?",
    inventory: ["12 items"],
  };
  await writeFile(
    join(directory, "brief.json"),
    JSON.stringify({ ...JSON.parse(fixtureText), ...inventory }),
  );
  expect(
    (await idiom(directory, ["brief", "record", "brief.json", "--json"])).code,
  ).toBe(0);
  expect(
    (
      await idiom(directory, [
        "brief",
        "decide",
        "pinned-group-in-the-add-drawer",
        "--option",
        "corner-pin",
      ])
    ).code,
  ).toBe(0);
  const base = join(directory, ".idiom/briefs/pinned-group-in-the-add-drawer");
  expect(JSON.parse(await readFile(`${base}.json`, "utf8"))).toMatchObject(
    inventory,
  );
  expect(await readFile(`${base}.md`, "utf8")).toContain(
    "**Screen question:** What needs action?",
  );
});
