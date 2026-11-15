import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import {
  learnImportCommand,
  learnReplayCommand,
  newStateDescription,
  renderLearnImport,
  renderLearnReplay,
} from "../src/commands/learn-import.js";
import {
  learnCoveredCommand,
  learnListCommand,
  renderLearnList,
} from "../src/commands/learn-misses.js";
import { nextLearnedId } from "../src/learn/draft.js";
import {
  type LearnedEntry,
  learnedEntrySchema,
} from "../src/schemas/learned.js";
import { studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const fixtures = resolve("test", "fixtures", "learn-import");
const first = new Date("2026-11-15T10:00:00.000Z");
const second = new Date("2026-11-15T11:00:00.000Z");

/** A studio-lab project with three states and the catalog as `misses.md`. */
type Fixture = "catalog" | "catalog-v2" | "page-builder-catalog";

async function importProject(version: Fixture = "catalog") {
  const { project } = await studioProject(directories, [
    "editor",
    "settings",
    "publish-dialog",
  ]);
  await copyFile(join(fixtures, `${version}.md`), join(project, "misses.md"));
  return project;
}

const importFile = (project: string, at = first) =>
  learnImportCommand({
    project,
    file: "misses.md",
    cwd: project,
    clock: () => at,
  });

async function useVersion(project: string, version: "catalog" | "catalog-v2") {
  await copyFile(join(fixtures, `${version}.md`), join(project, "misses.md"));
}

const logPath = (project: string) => join(project, ".idiom", "learned.jsonl");

async function records(project: string): Promise<LearnedEntry[]> {
  return (await readFile(logPath(project), "utf8"))
    .trim()
    .split("\n")
    .map((line) => learnedEntrySchema.parse(JSON.parse(line)));
}

async function proposals(project: string): Promise<Record<string, string>> {
  const directory = join(project, ".idiom", "proposals", "states");
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(
        async (name) =>
          [name, await readFile(join(directory, name), "utf8")] as const,
      ),
    ),
  );
}

async function optional(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}

/** Ids are unique and the log's line count equals its record count. */
async function expectIdsConsistent(project: string) {
  const lines = (await readFile(logPath(project), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");
  const ids = lines.map((line) => JSON.parse(line).id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(await nextLearnedId(project)).toBe(`learned-${ids.length + 1}`);
}

/** A stored run with a captured DOM per state and these findings. */
async function storedRun(
  project: string,
  runId: string,
  states: string[],
  findings: Array<{ state: string; category: string; createdAt: string }>,
) {
  const directory = join(project, ".idiom", "reports", runId);
  for (const state of states) {
    const tuple = join(directory, state, "desktop");
    await mkdir(tuple, { recursive: true });
    await writeFile(join(tuple, "dom.html"), "<main></main>");
    await writeFile(
      join(tuple, "metadata.json"),
      JSON.stringify({ flow: { id: "studio-lab" } }),
    );
  }
  await writeFile(
    join(directory, "findings.json"),
    JSON.stringify(
      findings.map((finding, index) => ({
        id: `finding-${index + 1}`,
        flow: "studio-lab",
        viewport: "desktop",
        ...finding,
      })),
    ),
  );
}

test("the first import creates one observation record per row, reports every skip, and touches no config or law", async () => {
  const project = await importProject();
  const projectJson = await readFile(
    join(project, ".idiom", "project.json"),
    "utf8",
  );
  const design = await optional(join(project, "DESIGN.md"));
  const flow = await readFile(
    join(project, ".idiom", "flows", "studio-lab.json"),
    "utf8",
  );

  const result = await importFile(project);
  expect(result).toMatchObject({
    name: "misses",
    source: "misses.md",
    rows: 25,
    updated: [],
    changed: [],
    notInFile: [],
    coveredByRule: 16,
    needNewState: 6,
  });
  expect(result.created).toHaveLength(20);
  expect(result.skipped.map((row) => [row.line, row.id, row.code])).toEqual([
    [38, undefined, "blank-id"],
    [39, "M-19", "blank-rule"],
    [40, "M-03", "duplicate-id"],
    [41, "M-20", "too-many-cells"],
    [42, undefined, "empty-row"],
  ]);
  expect(renderLearnImport(result)).toBe(
    [
      'Imported misses.md as "misses": 25 rows — 20 created, 0 updated (0 changed), 5 skipped.',
      "Covered by an existing rule: 16 of 20. Need a new state: 6 (drafts in .idiom/proposals/states/).",
      "Skipped:",
      "  line 38   —     blank id",
      "  line 39   M-19  blank rule",
      "  line 40   M-03  duplicate id M-03 (first on line 22)",
      "  line 41   M-20  8 cells, header has 6; escape | in a cell as \\|",
      "  line 42   —     empty row",
      "Ignored the table on line 7 (Week | Misses): missing id, observation, rule.",
      "Next: idiom learn --list --import misses; idiom learn --replay misses",
      "Commit .idiom/learned.jsonl and .idiom/proposals/.",
    ].join("\n"),
  );

  const entries = await records(project);
  expect(entries).toHaveLength(20);
  for (const entry of entries) {
    expect(entry.kind).toBe("observation");
    expect(entry.candidate).toBeDefined();
    expect(entry.import).toMatchObject({ name: "misses", source: "misses.md" });
    expect(entry.recordedAt).toBe(first.toISOString());
    expect(entry.target).toEqual({ file: "misses.md" });
  }
  const byRow = new Map(entries.map((entry) => [entry.import?.row, entry]));
  expect(byRow.get("M-01")).toMatchObject({
    id: "learned-1",
    flow: "studio-lab",
    state: "editor",
    placement: { via: "state" },
    candidate: {
      rule: "Text meets 4.5:1 contrast against its background.",
      kind: "ruling",
      checkable: "deterministic",
    },
    import: {
      row: "M-01",
      line: 20,
      category: "Color",
      how: "`contrast`",
      state: "editor",
      checks: ["contrast"],
    },
  });
  expect(byRow.get("M-02")?.candidate).toEqual({
    rule: "The resize handles should be 8px.",
    kind: "component",
    checkable: "deterministic",
  });
  expect(byRow.get("M-02")?.import?.checks).toEqual(["component-size"]);
  expect(byRow.get("M-03")?.candidate?.kind).toBe("glossary");
  expect(byRow.get("M-03")?.import?.checks).toEqual(["copy-lint"]);
  expect(byRow.get("M-04")).toMatchObject({
    state: "settings",
    placement: { via: "state" },
  });
  expect(byRow.get("M-06")).toMatchObject({
    state: "settings",
    placement: { via: "words" },
  });
  expect(byRow.get("M-07")).toMatchObject({
    state: "publish-dialog",
    placement: { via: "words" },
  });
  expect(byRow.get("M-09")?.candidate?.checkable).toBe("reference");
  expect(byRow.get("M-11")?.import?.checks).toEqual([]);
  expect(byRow.get("M-11")?.candidate?.checkable).toBe("judged");
  expect(byRow.get("M-13")?.candidate?.kind).toBe("mirrored");

  const proposed = entries.filter(
    (entry) => entry.placement?.via === "proposed",
  );
  expect(proposed.map((entry) => entry.import?.row)).toEqual([
    "M-05",
    "M-08",
    "M-09",
    "M-10",
    "M-15",
    "M-21",
  ]);
  const drafts = await proposals(project);
  expect(Object.keys(drafts)).toEqual(
    proposed.map((entry) => `${entry.id}.json`).sort(),
  );
  const stateIds = Object.values(drafts).map(
    (text) => JSON.parse(text).state.id,
  );
  expect(new Set(stateIds).size).toBe(6);
  for (const entry of proposed) {
    const draft = JSON.parse(drafts[`${entry.id}.json`] ?? "{}");
    expect(draft.state.id).toBe(entry.state);
    // The draft records the row's own words, not the state hint.
    expect(draft.observation).toBe(entry.observation);
  }

  expect(await readFile(join(project, ".idiom", "project.json"), "utf8")).toBe(
    projectJson,
  );
  expect(await optional(join(project, "DESIGN.md"))).toBe(design);
  expect(
    await readFile(join(project, ".idiom", "flows", "studio-lab.json"), "utf8"),
  ).toBe(flow);
  await expectIdsConsistent(project);
});

test("re-importing the same file updates by id and changes no bytes", async () => {
  const project = await importProject();
  await importFile(project);
  const log = await readFile(logPath(project), "utf8");
  const drafts = await proposals(project);
  const again = await importFile(project, second);
  expect(again.created).toEqual([]);
  expect(again.updated).toHaveLength(20);
  expect(again.changed).toEqual([]);
  expect(renderLearnImport(again)).toContain(
    "25 rows — 0 created, 20 updated (0 changed), 5 skipped",
  );
  expect(renderLearnImport(again)).not.toContain("Commit ");
  expect(await readFile(logPath(project), "utf8")).toBe(log);
  expect(await proposals(project)).toEqual(drafts);
  await expectIdsConsistent(project);
});

test("re-importing an edited file changes edited rows in place, creates added rows, and keeps removed ones", async () => {
  const project = await importProject();
  await importFile(project);
  const before = await records(project);
  await useVersion(project, "catalog-v2");
  const result = await importFile(project, second);
  expect(result.created).toEqual(["learned-21"]);
  expect(result.changed).toEqual(["learned-1", "learned-5"]);
  expect(result.updated).toHaveLength(19);
  expect(result.notInFile).toEqual([{ id: "learned-20", row: "M-22" }]);
  expect(renderLearnImport(result)).toContain(
    "Not in this file (kept): learned-20 (M-22)",
  );

  const after = await records(project);
  expect(after).toHaveLength(21);
  expect(after.map((entry) => entry.id)).toEqual([
    ...before.map((entry) => entry.id),
    "learned-21",
  ]);
  const one = after[0];
  expect(one).toMatchObject({
    id: "learned-1",
    recordedAt: first.toISOString(),
    observation: "The canvas text on the dark toolbar is barely legible",
    import: { row: "M-01", updatedAt: second.toISOString() },
  });
  // Re-placed on its own proposal: no -2 suffix.
  expect(after[4]).toMatchObject({
    id: "learned-5",
    state: before[4]?.state,
    placement: { via: "proposed" },
  });
  const draft = JSON.parse(
    (await proposals(project))["learned-5.json"] ?? "{}",
  );
  expect(draft.observation).toBe("Layer list rows jump sideways when hovered");
  expect(after[19]).toEqual(before[19]);
  expect(after[20]).toMatchObject({
    import: { row: "M-23", checks: ["a11y-label"] },
    state: "publish-dialog",
  });
  // Unchanged rows are byte-identical and carry no updatedAt.
  expect(after[1]).toEqual(before[1]);
  await expectIdsConsistent(project);
});

test("a covered mark survives a re-import that changes the record", async () => {
  const project = await importProject();
  await importFile(project);
  await learnCoveredCommand({
    project,
    id: "learned-1",
    by: "contrast",
    clock: () => first,
  });
  await useVersion(project, "catalog-v2");
  await importFile(project, second);
  const [entry] = await records(project);
  expect(entry?.covered).toEqual({ by: "contrast", at: first.toISOString() });
  expect(entry?.import?.updatedAt).toBe(second.toISOString());
});

test("lines a newer Idiom wrote are preserved verbatim and keep their ids", async () => {
  const project = await importProject();
  const future = JSON.stringify({
    version: 1,
    id: "learned-1",
    kind: "from-the-future",
    shape: { anything: true },
  });
  await writeFile(logPath(project), `${future}\n`);
  const result = await importFile(project);
  expect(result.created[0]).toBe("learned-2");
  await useVersion(project, "catalog-v2");
  await importFile(project, second);
  const lines = (await readFile(logPath(project), "utf8")).split("\n");
  expect(lines[0]).toBe(future);
  expect(lines.filter((line) => line !== "")).toHaveLength(22);
});

test("an ambiguous state and an unknown flow are skipped with reasons; --flow resolves the ambiguity", async () => {
  const project = await importProject();
  await writeFile(
    join(project, ".idiom", "flows", "studio-two.json"),
    JSON.stringify({
      id: "studio-two",
      title: "Studio two",
      intent: ["Second editor"],
      setup: [],
      viewports: ["desktop"],
      states: [
        {
          id: "editor",
          description: "editor",
          url: "/two",
          expect: { status: 200 },
        },
      ],
    }),
  );
  await writeFile(
    join(project, "misses.md"),
    [
      "| ID | Observation | Rule | State |",
      "| --- | --- | --- | --- |",
      "| A-1 | Handles overlap | Handles never overlap | editor |",
      "| A-2 | Text is clipped | Text is never clipped | ghost/editor |",
      "| A-3 | The settings are cramped | Settings breathe | studio-two/editor |",
    ].join("\n"),
  );
  const result = await importFile(project);
  expect(result.skipped).toEqual([
    {
      line: 3,
      id: "A-1",
      code: "ambiguous-state",
      reason:
        "state editor is declared by studio-lab, studio-two; pass --flow or write flow/state",
    },
    {
      line: 4,
      id: "A-2",
      code: "unknown-flow",
      reason: 'unknown flow "ghost" in state ghost/editor',
    },
  ]);
  expect(result.records).toEqual([
    expect.objectContaining({
      row: "A-3",
      flow: "studio-two",
      state: "editor",
      via: "state",
    }),
  ]);
  const scoped = await learnImportCommand({
    project,
    cwd: project,
    file: "misses.md",
    flow: "studio-lab",
    clock: () => second,
  });
  expect(scoped.created).toHaveLength(1);
  expect(scoped.records[0]).toMatchObject({
    row: "A-1",
    flow: "studio-lab",
    state: "editor",
  });
});

test("--list --import filters to the import and shows each record's import and checks", async () => {
  const project = await importProject();
  await importFile(project);
  await writeFile(
    join(project, "other.md"),
    "| ID | Observation | Rule |\n| - | - | - |\n| O-1 | Something else | Another rule |\n",
  );
  await learnImportCommand({
    project,
    cwd: project,
    file: "other.md",
    clock: () => first,
  });

  const all = await learnListCommand({ project });
  expect(all.statuses).toHaveLength(21);
  const result = await learnListCommand({
    project,
    cwd: project,
    importName: "misses",
  });
  expect(result.importName).toBe("misses");
  expect(result.statuses).toHaveLength(20);
  // The file path names the same import.
  expect(
    (await learnListCommand({ project, cwd: project, importName: "misses.md" }))
      .statuses,
  ).toHaveLength(20);
  const text = renderLearnList(result, second);
  const lines = text.split("\n");
  expect(lines[0]).toBe(
    'learned-1  open  studio-lab/editor (state matched)  observation  import misses#M-01  checks contrast  "The canvas text on the dark toolbar is hard to read"',
  );
  expect(lines[4]).toBe(
    'learned-5  open  studio-lab/layer-list-row-jump (state proposed: .idiom/proposals/states/learned-5.json)  observation  import misses#M-05  "Layer list rows jump when hovered"',
  );
  expect(lines.at(-1)).toBe(
    "Import misses: 20 records, 0 covered, 20 open, 6 need a new state.",
  );
  await expect(
    learnListCommand({ project, cwd: project, importName: "nope" }),
  ).rejects.toThrow(
    'no imported records named "nope"; known imports: misses, other',
  );
});

test("list coverage counts a finding whose category is a check the row names, after it was recorded", async () => {
  const project = await importProject();
  await importFile(project);
  await storedRun(
    project,
    "2026-11-15T09-00-00-000Z",
    ["editor"],
    [
      {
        state: "editor",
        category: "contrast",
        createdAt: "2026-11-15T09:00:00.000Z",
      },
    ],
  );
  let statuses = (await learnListCommand({ project })).statuses;
  expect(statuses[0]?.status).toBe("open");
  await storedRun(
    project,
    "2026-11-15T12-00-00-000Z",
    ["editor", "settings"],
    [
      {
        state: "editor",
        category: "contrast",
        createdAt: "2026-11-15T12:00:00.000Z",
      },
      // Not a check the settings rows name.
      {
        state: "settings",
        category: "motion",
        createdAt: "2026-11-15T12:00:00.000Z",
      },
    ],
  );
  statuses = (await learnListCommand({ project })).statuses;
  expect(statuses[0]).toMatchObject({
    status: "covered",
    via: "run",
    rule: "contrast",
    runId: "2026-11-15T12-00-00-000Z",
    coverage: "rule",
  });
  expect(statuses.filter((status) => status.status === "covered")).toHaveLength(
    1,
  );
});

test("replay reads the latest capture of each record's state and counts what its findings catch", async () => {
  const project = await importProject();
  await importFile(project);
  const older = "2026-11-14T12-00-00-000Z";
  const newer = "2026-11-15T12-00-00-000Z";
  await storedRun(
    project,
    older,
    ["editor", "settings"],
    [
      {
        state: "editor",
        category: "contrast",
        createdAt: "2026-11-14T12:00:00.000Z",
      },
      {
        state: "settings",
        category: "target-size",
        createdAt: "2026-11-14T12:00:00.000Z",
      },
    ],
  );
  // The newer editor capture no longer has the contrast finding.
  await storedRun(
    project,
    newer,
    ["editor"],
    [
      {
        state: "editor",
        category: "glyph-icon",
        createdAt: "2026-11-15T12:00:00.000Z",
      },
    ],
  );
  const log = await readFile(logPath(project), "utf8");
  const result = await learnReplayCommand({
    project,
    cwd: project,
    importName: "misses",
  });
  expect(await readFile(logPath(project), "utf8")).toBe(log);
  expect(result).toMatchObject({
    name: "misses",
    total: 20,
    caught: 2,
    notCaught: 18,
  });
  expect(result.runs).toEqual({ "studio-lab": [newer, older] });
  const byRow = new Map(result.records.map((record) => [record.row, record]));
  expect(byRow.get("M-01")).toMatchObject({
    status: "not-caught",
    reason: `no contrast finding in run ${newer}`,
    runId: newer,
  });
  expect(byRow.get("M-04")).toMatchObject({
    status: "caught",
    check: "target-size",
    runId: older,
  });
  expect(byRow.get("M-22")).toMatchObject({
    status: "caught",
    check: "glyph-icon",
    runId: newer,
  });
  expect(byRow.get("M-05")).toMatchObject({
    status: "not-caught",
    reason: "no check named",
  });
  expect(byRow.get("M-08")).toMatchObject({
    status: "not-caught",
    reason: "state not declared (.idiom/proposals/states/learned-8.json)",
  });
  expect(byRow.get("M-03")).toMatchObject({
    status: "not-caught",
    reason: "never captured",
  });
  const text = renderLearnReplay(result);
  expect(text.split("\n")[0]).toBe(
    'Replay "misses": the latest checks catch 2 of 20.',
  );
  expect(text).toMatch(
    /^ {2}caught {2}learned-4 +M-04 +studio-lab\/settings +target-size \(run 2026-11-14T12-00-00-000Z\)$/m,
  );
  expect(text).toMatch(
    /^ {2}open {4}learned-8 +M-08 +studio-lab\/template-card-uneven-gap +state not declared/m,
  );
  expect(text).toContain(`Read runs: studio-lab ${newer}, ${older}`);
  expect(text).toContain(
    "idiom review <flow> --from <run> --deterministic-only",
  );
});

async function cli(project: string, args: string[]) {
  const output: string[] = [];
  const errors: string[] = [];
  const code = await run(["node", "idiom", ...args, "--project", project], {
    cwd: project,
    stdout: (message) => output.push(message),
    stderr: (message) => errors.push(message),
    learn: { clock: () => first },
  });
  return { code, text: output.join(""), error: errors.join("") };
}

test("learn CLI imports, lists by import, replays, prints JSON, and rejects conflicting modes", async () => {
  const project = await importProject();
  const imported = await cli(project, ["learn", "--import", "misses.md"]);
  expect(imported.code).toBe(0);
  expect(imported.text).toContain(
    'Imported misses.md as "misses": 25 rows — 20 created, 0 updated (0 changed), 5 skipped.',
  );
  const json = await cli(project, [
    "learn",
    "--import",
    "misses.md",
    "--json",
    "--yes",
  ]);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.text)).toMatchObject({
    name: "misses",
    created: [],
    changed: [],
  });

  const listed = await cli(project, ["learn", "--list", "--import", "misses"]);
  expect(listed.text).toContain(
    "Import misses: 20 records, 0 covered, 20 open, 6 need a new state.",
  );
  const listedJson = JSON.parse(
    (await cli(project, ["learn", "--list", "--import", "misses", "--json"]))
      .text,
  );
  expect(listedJson.importName).toBe("misses");
  expect(listedJson.statuses[0].entry.import.row).toBe("M-01");

  const replay = await cli(project, ["learn", "--replay", "misses"]);
  expect(replay.code).toBe(0);
  expect(replay.text).toContain(
    'Replay "misses": the latest checks catch 0 of 20.',
  );
  expect(
    JSON.parse(
      (await cli(project, ["learn", "--replay", "misses", "--json"])).text,
    ),
  ).toMatchObject({ total: 20, caught: 0 });

  for (const [args, message] of [
    [
      ["learn", "--import", "misses.md", "--list", "--replay", "misses"],
      "choose exactly one learn mode",
    ],
    [
      ["learn", "the dots should be 8px", "--import", "misses.md"],
      "--import <file.md>, or --replay <import>",
    ],
    [
      ["learn", "--import", "misses.md", "--state", "editor"],
      "--state applies only to an observation, not with --import",
    ],
    [
      ["learn", "--replay", "misses", "--ruling", "--wording", "x"],
      "--ruling, --wording apply only to an observation, not with --replay",
    ],
    [
      ["learn", "--list", "--screenshot", "a.png"],
      "--screenshot applies only to an observation, not with --list",
    ],
    [
      ["learn", "--covered", "learned-1", "--by", "x", "--json"],
      "--json requires --list, --harvest, --import <file.md> or --replay",
    ],
  ] as const) {
    const result = await cli(project, [...args]);
    expect(result.code).not.toBe(0);
    expect(result.error).toContain(message);
  }
});

test("a page builder's catalog in its own headers imports one record per row; NEW: states draft what they say", async () => {
  const project = await importProject("page-builder-catalog");
  const result = await importFile(project);
  expect(result).toMatchObject({
    rows: 21,
    updated: [],
    changed: [],
    needNewState: 5,
  });
  expect(result.created).toHaveLength(19);
  expect(result.rows).toBe(result.created.length + result.skipped.length);
  expect(renderLearnImport(result)).toBe(
    [
      'Imported misses.md as "misses": 21 rows — 19 created, 0 updated (0 changed), 2 skipped.',
      "Covered by an existing rule: 6 of 19. Need a new state: 5 (drafts in .idiom/proposals/states/).",
      "Skipped:",
      "  line 37   PB-012  blank rule",
      "  line 42   PB-013  duplicate id PB-013 (first on line 38)",
      "Ignored the table on line 10 (id | ruling | date): missing observation, rule.",
      "Ignored the table on line 17 (state | description): missing id, rule.",
      "Next: idiom learn --list --import misses; idiom learn --replay misses",
      "Commit .idiom/learned.jsonl and .idiom/proposals/.",
    ].join("\n"),
  );
  expect(result.records[0]).toMatchObject({
    row: "PB-001",
    surface: "Editor toolbar",
    state: "editor",
  });

  const entries = await records(project);
  expect(entries).toHaveLength(19);
  const byRow = new Map(entries.map((entry) => [entry.import?.row, entry]));
  // Rows marked † import as written, one record each.
  expect(["PB-004†", "PB-010†", "PB-014†"].every((row) => byRow.has(row))).toBe(
    true,
  );
  expect(byRow.get("PB-001")?.import).toMatchObject({
    surface: "Editor toolbar",
    date: "2026-09-14",
    rowSource: "director",
    state: "editor",
    checks: ["contrast"],
  });
  expect(byRow.get("PB-005")).toMatchObject({
    state: "settings",
    placement: { via: "state" },
  });

  const drafts = await proposals(project);
  const fresh: Array<[string, string, string]> = [
    [
      "PB-007",
      "text-block-inline-editor",
      "A text block with the inline editor open.",
    ],
    ["PB-008", "empty-canva", "Empty canvas."],
    // Shares "publish dialog" with a declared state, still a new state.
    [
      "PB-009",
      "publish-dialog-failed-publish",
      "Publish dialog with a failed publish error.",
    ],
    [
      "PB-018",
      "link-popover-open-near",
      "Link popover open near the right edge.",
    ],
  ];
  for (const [row, state, description] of fresh) {
    const entry = byRow.get(row);
    expect(entry).toMatchObject({ state, placement: { via: "proposed" } });
    expect(entry?.import?.state).toMatch(/^NEW: /);
    const draft = JSON.parse(drafts[`${entry?.id}.json`] ?? "{}");
    expect(draft.state).toMatchObject({ id: state, description });
    expect(draft.observation).toBe(entry?.observation);
  }

  const again = await importFile(project, second);
  expect(again.created).toEqual([]);
  expect(again.updated).toHaveLength(19);
  expect(again.changed).toEqual([]);
  expect((await records(project)).map((entry) => entry.state)).toEqual(
    entries.map((entry) => entry.state),
  );
  expect(await proposals(project)).toEqual(drafts);

  const lines = renderLearnList(
    await learnListCommand({ project, cwd: project, importName: "misses" }),
    second,
  ).split("\n");
  expect(lines[0]).toBe(
    'learned-1  open  studio-lab/editor (state matched)  observation  import misses#PB-001  surface Editor toolbar  checks contrast  "Grey icon labels on the dark toolbar are hard to read"',
  );
  expect(lines.at(-1)).toBe(
    "Import misses: 19 records, 0 covered, 19 open, 5 need a new state.",
  );
  await expectIdsConsistent(project);
});

test("a NEW: state cell names its description; anything else does not", () => {
  expect(newStateDescription("NEW: inline editor open")).toBe(
    "inline editor open",
  );
  expect(newStateDescription("  new :  empty canvas ")).toBe("empty canvas");
  expect(newStateDescription("NEW:")).toBeUndefined();
  expect(newStateDescription("NEW:   ")).toBeUndefined();
  expect(newStateDescription("editor")).toBeUndefined();
  expect(newStateDescription("renewal: settings")).toBeUndefined();
  expect(newStateDescription(undefined)).toBeUndefined();
});
