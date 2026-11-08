import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { renderBrief } from "../src/brief/render.js";
import {
  briefsDirectory,
  decideBrief,
  listBriefs,
  readBrief,
  readTriage,
  recordBrief,
  saveTriage,
  storeResearchedBrief,
  triageId,
} from "../src/brief/store.js";
import { briefInputSchema, storedBriefSchema } from "../src/schemas/brief.js";
import { briefConfigSchema, briefSettings } from "../src/schemas/project.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);
const settings = briefSettings(undefined);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-brief-store-"));
  directories.push(directory);
  return directory;
}

function record(projectDirectory: string, input: unknown, at: string) {
  return recordBrief({
    projectDirectory,
    input,
    now: new Date(at),
    rubricVersion: 1,
    settings,
  });
}

test("record writes JSON and Markdown under a slug derived from the title", async () => {
  const directory = await project();
  const recorded = await record(directory, fixture, "2026-10-31T10:00:00Z");
  expect(recorded.slug).toBe("pinned-group-in-the-add-drawer");
  expect(recorded.outcome).toBe("created");
  expect(recorded.jsonPath).toBe(
    join(briefsDirectory(directory), "pinned-group-in-the-add-drawer.json"),
  );
  const stored = storedBriefSchema.parse(
    JSON.parse(await readFile(recorded.jsonPath, "utf8")),
  );
  expect(stored).toMatchObject({
    version: 1,
    rubricVersion: 1,
    status: "proposed",
    createdAt: "2026-10-31T10:00:00.000Z",
  });
  expect(await readFile(recorded.markdownPath, "utf8")).toBe(
    renderBrief(stored, settings),
  );
});

test("re-recording as decided keeps createdAt and reports an update", async () => {
  const directory = await project();
  await record(directory, fixture, "2026-10-31T10:00:00Z");
  const decided = await record(
    directory,
    { ...fixture, status: "decided", decidedBy: "requester" },
    "2026-10-31T11:00:00Z",
  );
  expect(decided.outcome).toBe("updated");
  expect(decided.brief.createdAt).toBe("2026-10-31T10:00:00.000Z");
  expect(decided.brief.updatedAt).toBe("2026-10-31T11:00:00.000Z");
  expect(await readFile(decided.markdownPath, "utf8")).toContain(
    "Status: decided · decided by requester · rubric v1",
  );
});

test("supersededBy must name a stored brief", async () => {
  const directory = await project();
  await expect(
    record(
      directory,
      { ...fixture, status: "superseded", supersededBy: "missing" },
      "2026-10-31T10:00:00Z",
    ),
  ).rejects.toThrow(/supersededBy: no brief named missing/);
});

test("invalid input lists every issue", async () => {
  const directory = await project();
  const input = structuredClone(fixture);
  delete input.options[1].cost.space;
  input.research[2].findings = [];
  await expect(
    record(directory, input, "2026-10-31T10:00:00Z"),
  ).rejects.toThrow(
    /brief rejected:\n {2}research\[2\]\.findings: .*\n {2}options\[1\]\.cost\.space: /,
  );
});

test("show refuses a path-like slug", async () => {
  const directory = await project();
  await expect(readBrief(directory, "../x")).rejects.toThrow(
    /invalid brief name/,
  );
  await expect(readBrief(directory, "absent")).rejects.toThrow(
    /no brief named absent/,
  );
});

test("list sorts newest first and reports an unreadable brief", async () => {
  const directory = await project();
  expect(await listBriefs(directory)).toEqual([]);
  await record(
    directory,
    { ...fixture, slug: "older" },
    "2026-10-30T10:00:00Z",
  );
  await record(
    directory,
    { ...fixture, slug: "newer" },
    "2026-10-31T10:00:00Z",
  );
  await mkdir(briefsDirectory(directory), { recursive: true });
  await writeFile(join(briefsDirectory(directory), "broken.json"), "{");
  const listed = await listBriefs(directory);
  expect(listed.map((entry) => entry.slug)).toEqual([
    "newer",
    "older",
    "broken",
  ]);
  expect(listed[2]).toMatchObject({ slug: "broken" });
  expect("error" in (listed[2] as object)).toBe(true);
});

test("the default template renders the autobuild spec headings", async () => {
  const directory = await project();
  const { brief } = await record(directory, fixture, "2026-10-31T10:00:00Z");
  expect(renderBrief(brief, settings)).toMatchInlineSnapshot(`
    "# Pinned group in the Add drawer

    Status: proposed · rubric v1

    ## What and why

    How does a user pin an item in the Add drawer without making every tile bigger?

    **Recommendation:** A small corner pin icon inside the tile. An outline pin in the tile corner on hover and focus, always visible on touch, filled when pinned.

    Why: Established pattern, no added height, works on touch and keyboard.

    Cost: space: none; sits inside the tile; steps: one click; new concepts: pinning; code: small

    **Rejected options:**

    - **A pin button beside every tile**: it doubles the drawer's height for a secondary action (cost: space: roughly doubles the drawer's height; steps: one click; new concepts: pinning; code: small)
    - **Pin from a right-click menu**: undiscoverable, and absent on touch (cost: space: none; steps: two; new concepts: pinning, context menus; code: medium)
    - **Don't build it — Keep the drawer as it is**: the requester wants quicker access to frequent items (cost: space: none; steps: none; new concepts: none; code: none)

    ## Acceptance criteria

    **Geometry**

    - [ ] The pin icon is at most 20px square and tile height is unchanged.

    **Input states**

    - [ ] On touch the pin is visible without hover; with a keyboard it appears on focus.

    **Contrast**

    - [ ] The outline icon meets 3:1 against the tile background.

    **Behaviour**

    - [ ] Pinning a tile adds it to the end of the Pinned group.

    ## Out of scope

    - Reordering pinned items

    ## Evidence

    ### How do established tools let users pin items in a dense grid?

    - A small pin icon in the tile corner, outlined when off and filled when on, appears on hover. ([source](https://example.com/pinning-patterns), verified: hands-on)
    - Hover-only controls fail on touch, so touch needs a visible fallback. ([source](https://example.com/hover-on-touch), verified: read)

    ### Do adaptive most-used menus beat fixed ones?

    - Adaptive menus are slower than fixed ones (Findlater & McGrenere). ([source](https://example.com/findlater-mcgrenere), verified: read)

    ### Is right-click pinning discoverable?

    - Nothing found.

    Request:

    > Add a default Pinned group at the top of the Add drawer that users can customize.
    "
  `);
});

test("a project template renames sections and adds fixed blocks", async () => {
  const directory = await project();
  const { brief } = await record(directory, fixture, "2026-10-31T10:00:00Z");
  const custom = briefSettings({
    brief: briefConfigSchema.parse({
      references: [{ name: "Figma", tier: "bar", note: "tile density" }],
      ticketTemplate: {
        sections: [
          { heading: "Decision", content: "decision" },
          { heading: "Why (evidence)", content: "evidence" },
          { heading: "Options", content: "options" },
          { heading: "Bar", content: "references" },
          { heading: "Done when", content: "criteria" },
          {
            heading: "Notes",
            content: "text",
            body: "Ask before widening scope.",
          },
        ],
      },
    }),
  });
  const rendered = renderBrief(brief, custom);
  expect(rendered.match(/^## .*$/gm)).toEqual([
    "## Decision",
    "## Why (evidence)",
    "## Options",
    "## Bar",
    "## Done when",
    "## Notes",
  ]);
  expect(rendered).toContain("- **Figma** (bar): tile density");
  expect(rendered).toContain(
    "| A small corner pin icon inside the tile (recommended) |",
  );
  expect(rendered).toContain("Ask before widening scope.");
});

test("the brief config requires decision, criteria and evidence once each", () => {
  const sections = (list: unknown[]) =>
    briefConfigSchema.safeParse({ ticketTemplate: { sections: list } });
  expect(
    sections([
      { heading: "A", content: "decision" },
      { heading: "B", content: "evidence" },
    ]).success,
  ).toBe(false);
  expect(
    sections([
      { heading: "A", content: "decision" },
      { heading: "A2", content: "decision" },
      { heading: "B", content: "evidence" },
      { heading: "C", content: "criteria" },
    ]).success,
  ).toBe(false);
  expect(
    sections([
      { heading: "A", content: "decision" },
      { heading: "B", content: "evidence" },
      { heading: "C", content: "criteria" },
      { heading: "D", content: "text" },
    ]).success,
  ).toBe(false);
  expect(briefConfigSchema.parse({}).references).toEqual([]);
});

test("triage ids are stable per request and rubric version", () => {
  expect(triageId(1, "add a pin")).toBe(triageId(1, "add a pin"));
  expect(triageId(1, "add a pin")).toMatch(/^triage-[0-9a-f]{10}$/);
  expect(triageId(2, "add a pin")).not.toBe(triageId(1, "add a pin"));
  expect(triageId(1, "add a star")).not.toBe(triageId(1, "add a pin"));
});

test("a saved triage reads back; a missing one names the next step; list ignores triage records", async () => {
  const directory = await project();
  const saved = await saveTriage({
    projectDirectory: directory,
    request: "add a pin",
    rubricVersion: 1,
    result: {
      verdict: "design decision",
      reason: "control",
      questions: ["How big?"],
    },
    now: new Date("2026-10-31T10:00:00Z"),
  });
  expect(await readTriage(directory, saved.id)).toEqual(saved);
  await expect(readTriage(directory, "triage-0000000000")).rejects.toThrow(
    "no triage named triage-0000000000; run idiom brief triage first",
  );
  await expect(readTriage(directory, "../x")).rejects.toThrow(
    /invalid triage id/,
  );
  expect(await listBriefs(directory)).toEqual([]);
});

function decide(directory: string, option: string, at: string, by?: string) {
  return decideBrief({
    projectDirectory: directory,
    slug: "pinned-group-in-the-add-drawer",
    option,
    by,
    now: new Date(at),
    settings,
  });
}

test("decide records the choice, keeps createdAt and re-renders the Markdown", async () => {
  const directory = await project();
  await record(directory, fixture, "2026-10-31T10:00:00Z");
  const decided = await decide(directory, "corner-pin", "2026-10-31T11:00:00Z");
  expect(decided.outcome).toBe("decided");
  expect(decided.criteriaWarning).toBeUndefined();
  expect(decided.brief).toMatchObject({
    status: "decided",
    decidedBy: "requester",
    chosenOption: "corner-pin",
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T11:00:00.000Z",
  });
  const markdown = await readFile(decided.markdownPath, "utf8");
  expect(markdown).toBe(renderBrief(decided.brief, settings));
  expect(markdown).toContain(
    "**Decision:** A small corner pin icon inside the tile (decided by requester).",
  );
  const again = await decide(
    directory,
    "sibling-button",
    "2026-10-31T12:00:00Z",
    "a designer",
  );
  expect(again.outcome).toBe("re-decided");
  expect(again.brief.decidedBy).toBe("a designer");
  expect(again.criteriaWarning).toMatch(
    /acceptance criteria were written for the recommendation \(corner-pin\)/,
  );
});

test("decide rejects an unknown option and a superseded brief", async () => {
  const directory = await project();
  await record(directory, fixture, "2026-10-31T10:00:00Z");
  await expect(
    decide(directory, "nope", "2026-10-31T11:00:00Z"),
  ).rejects.toThrow(
    'has no option "nope"; choose one of sibling-button, corner-pin, context-menu, dont-build',
  );
  await record(directory, { ...fixture, slug: "v2" }, "2026-10-31T10:00:00Z");
  await record(
    directory,
    { ...fixture, status: "superseded", supersededBy: "v2" },
    "2026-10-31T10:30:00Z",
  );
  await expect(
    decide(directory, "corner-pin", "2026-10-31T11:00:00Z"),
  ).rejects.toThrow(/is superseded by v2; decide v2 instead/);
});

test("a decided brief leads with the decision; a different choice notes the recommendation", async () => {
  const directory = await project();
  await record(directory, fixture, "2026-10-31T10:00:00Z");
  const { brief } = await decide(
    directory,
    "sibling-button",
    "2026-10-31T11:00:00Z",
  );
  const markdown = renderBrief(brief, settings);
  expect(markdown).toContain(
    "Status: decided · decided by requester · not ticket-ready · rubric v1",
  );
  expect(markdown).toContain(
    "**Decision:** A pin button beside every tile (decided by requester). A full-size sibling button, visible without hover and keyboard reachable.",
  );
  expect(markdown).toContain(
    "Recommended was A small corner pin icon inside the tile: Established pattern, no added height, works on touch and keyboard.",
  );
  expect(markdown).toContain("**Other options:**");
  expect(markdown).toContain(
    "- **A small corner pin icon inside the tile**: recommended, not chosen",
  );
  expect(markdown).not.toContain("**Rejected options:**");
  const table = renderBrief(brief, {
    ...settings,
    sections: [{ heading: "Options", content: "options" }],
  });
  expect(table).toContain("| A pin button beside every tile (chosen) |");
  expect(table).toContain(
    "| A small corner pin icon inside the tile (recommended) |",
  );
});

const researchRun = {
  provider: "codex" as const,
  model: "gpt-5.5",
  budgetMs: 900_000,
  durationMs: 61_000,
  calls: 4,
  turns: 6,
  searches: 3,
  tokens: { input: 41_200, output: 6_100 },
};

test("deciding a researched brief keeps what the research cost", async () => {
  const directory = await project();
  const researched = await storeResearchedBrief({
    projectDirectory: directory,
    brief: briefInputSchema.parse(fixture),
    researchRun,
    now: new Date("2026-10-31T10:00:00Z"),
    rubricVersion: 1,
    settings,
  });
  expect(researched.brief.researchRun).toEqual(researchRun);
  expect(await readFile(researched.markdownPath, "utf8")).toContain(
    "Research run: codex gpt-5.5, 1m 1s, 4 calls, 6 turns, 3 searches, 41,200 input / 6,100 output tokens (budget 15 minutes).",
  );
  const decided = await record(
    directory,
    { ...fixture, status: "decided", decidedBy: "requester" },
    "2026-10-31T11:00:00Z",
  );
  expect(decided.brief.researchRun).toEqual(researchRun);
  expect(decided.brief.createdAt).toBe("2026-10-31T10:00:00.000Z");
});

test("a complete brief recorded over incomplete research drops the stale run", async () => {
  const directory = await project();
  const { options: _options, ...rest } = briefInputSchema.parse(fixture);
  const {
    decision: _d,
    requestNamedIdea: _r,
    recommendation: _c,
    acceptanceCriteria: _a,
    ...partial
  } = rest;
  const incomplete = await storeResearchedBrief({
    projectDirectory: directory,
    brief: partial,
    researchRun: {
      ...researchRun,
      incomplete: {
        stage: "research",
        note: "Research incomplete: the 15 minutes research budget ran out.",
        unresearched: [],
      },
    },
    now: new Date("2026-10-31T10:00:00Z"),
    rubricVersion: 1,
    settings,
  });
  expect((await listBriefs(directory))[0]).toMatchObject({
    slug: incomplete.slug,
  });
  await expect(
    decideBrief({
      projectDirectory: directory,
      slug: incomplete.slug,
      option: "corner-pin",
      now: new Date("2026-10-31T10:30:00Z"),
      settings,
    }),
  ).rejects.toThrow(/has incomplete research and no options to decide/);
  const complete = await record(directory, fixture, "2026-10-31T11:00:00Z");
  expect(complete.slug).toBe(incomplete.slug);
  expect(complete.brief.researchRun).toBeUndefined();
});

test("research settings default to 15 minutes and 5 searches, within bounds", () => {
  expect(settings).toMatchObject({
    researchBudgetMs: 900_000,
    researchMaxSearches: 5,
  });
  expect(
    briefSettings({
      brief: briefConfigSchema.parse({
        researchBudgetMs: 120_000,
        researchMaxSearches: 3,
      }),
    }),
  ).toMatchObject({ researchBudgetMs: 120_000, researchMaxSearches: 3 });
  expect(briefConfigSchema.safeParse({ researchBudgetMs: 1_000 }).success).toBe(
    false,
  );
  expect(briefConfigSchema.safeParse({ researchMaxSearches: 0 }).success).toBe(
    false,
  );
});

test("screen inventory persists through record, read and decide before alternatives", async () => {
  const directory = await project();
  const inventory = {
    screenQuestion: "What needs action?",
    inventory: ["12 items", "0–5 queued jobs per item"],
  };
  const recorded = await record(
    directory,
    { ...fixture, ...inventory },
    "2026-10-31T10:00:00Z",
  );
  const assertMarkdown = (text: string) => {
    expect(text).toContain("**Screen question:** What needs action?");
    expect(text).toContain("- 12 items");
    expect(text.indexOf("**Inventory:**")).toBeLessThan(
      text.indexOf("**Other options:**") < 0
        ? text.indexOf("**Rejected options:**")
        : text.indexOf("**Other options:**"),
    );
  };
  expect((await readBrief(directory, recorded.slug)).brief).toMatchObject(
    inventory,
  );
  assertMarkdown(await readFile(recorded.markdownPath, "utf8"));
  await decide(directory, "corner-pin", "2026-10-31T11:00:00Z");
  const { brief: stored } = await readBrief(directory, recorded.slug);
  expect(stored).toMatchObject(inventory);
  assertMarkdown(await readFile(recorded.markdownPath, "utf8"));
  const custom = {
    ...settings,
    sections: settings.sections.map((section) =>
      section.content === "decision"
        ? { ...section, heading: "Our choice" }
        : section,
    ),
  };
  const rendered = renderBrief(stored, custom);
  expect(rendered).toContain("## Our choice");
  assertMarkdown(rendered);
});
