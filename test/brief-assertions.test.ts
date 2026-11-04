import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { briefCheckFrom } from "../src/brief/assertions.js";
import { renderBrief } from "../src/brief/render.js";
import { loadBriefChecks, recordBrief } from "../src/brief/store.js";
import { projectChecksConfig } from "../src/checks/project-config.js";
import type {
  CheckTuple,
  ObservedElementV2,
  SelectorMark,
} from "../src/checks/types.js";
import { briefDecideCommand, recordBriefInput } from "../src/commands/brief.js";
import { learnCommand } from "../src/commands/learn.js";
import { collectDesignBrief, renderDesignBrief } from "../src/context/brief.js";
import {
  briefCoverageLines,
  computeBriefCoverage,
} from "../src/coverage/briefs.js";
import { settingsIdentity } from "../src/findings/contract.js";
import {
  briefCriterionSchema,
  type CompleteStoredBrief,
  formatBriefIssues,
  isCompleteBrief,
  storedBriefSchema,
} from "../src/schemas/brief.js";
import { learnedEntrySchema } from "../src/schemas/learned.js";
import { briefSettings } from "../src/schemas/project.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";
import { studioProject } from "./stored-run-support.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const noTopology = async () => undefined;

const tileHeight = {
  flow: "studio-lab",
  state: "editor",
  selector: ".drawer-item",
  height: 56,
};
const pinWithin = {
  flow: "studio-lab",
  state: "editor",
  selector: ".drawer-item .pin",
  within: ".tile",
};

/** The fixture brief with assertions on its geometry criterion. */
function withAssertions(assertions: unknown[], extra: object = {}) {
  return {
    ...fixture,
    slug: "pinned-group",
    acceptanceCriteria: fixture.acceptanceCriteria.map(
      (criterion: { kind: string }, index: number) =>
        index === 0 ? { ...criterion, assertions } : criterion,
    ),
    ...extra,
  };
}

function issues(value: unknown): string[] {
  const parsed = briefCriterionSchema.safeParse(value);
  return parsed.success ? [] : formatBriefIssues(parsed.error);
}

describe("assertion schema", () => {
  const criterion = (assertion: object) => ({
    kind: "behaviour",
    statement: "the pin stays put",
    assertions: [{ flow: "f", state: "s", selector: ".pin", ...assertion }],
  });
  test("every form parses, with a 1px default tolerance", () => {
    for (const form of [
      { height: 56 },
      { width: { min: 20, max: 24 } },
      { sameSizeAs: ".tile" },
      { within: ".tile" },
      { visibleWithoutHover: true },
      { stableOnHover: true },
      { minContrast: 3 },
    ])
      expect(issues(criterion(form))).toEqual([]);
    expect(
      briefCriterionSchema.parse(criterion({ sameSizeAs: ".tile" }))
        .assertions?.[0],
    ).toMatchObject({ tolerance: 1, axis: "both" });
  });
  test("rejects malformed assertions with path: message issues", () => {
    expect(issues(criterion({}))).toEqual([
      "assertions[0]: must declare width or height",
    ]);
    expect(issues(criterion({ minContrast: 30 }))).toEqual([
      "assertions[0].minContrast: Too big: expected number to be <=21",
    ]);
    expect(issues(criterion({ height: 56, selector: " " }))).toEqual([
      "assertions[0].selector: Too small: expected string to have >=1 characters",
    ]);
    expect(
      issues(criterion({ within: ".tile", stableOnHover: true })).length,
    ).toBeGreaterThan(0);
    expect(issues(criterion({ height: 56, colour: "red" })).length).toBe(1);
    expect(
      issues({ kind: "behaviour", statement: "x", assertions: [] }),
    ).toEqual(["assertions: Too small: expected array to have >=1 items"]);
  });
});

describe("record and decide", () => {
  test("an unknown flow or state is rejected, listing the valid ids", async () => {
    const { project } = await studioProject(directories, ["editor", "open"]);
    await expect(
      recordBriefInput({
        project,
        input: withAssertions([{ ...tileHeight, flow: "studio" }]),
      }),
    ).rejects.toThrow(
      'brief rejected:\n  acceptanceCriteria[0].assertions[0].flow: no flow "studio"; flows: studio-lab',
    );
    await expect(
      recordBriefInput({
        project,
        input: withAssertions([{ ...tileHeight, state: "pinned" }]),
      }),
    ).rejects.toThrow(
      'acceptanceCriteria[0].assertions[0].state: flow studio-lab declares no state "pinned"; states: editor, open',
    );
    const recorded = await recordBriefInput({
      project,
      input: withAssertions([tileHeight, pinWithin]),
    });
    expect(
      recorded.brief.acceptanceCriteria?.[0]?.assertions?.[0]?.tolerance,
    ).toBe(1);
  });

  test("a brief without assertions never loads flows", async () => {
    const { project } = await studioProject(directories);
    const recorded = await recordBrief({
      projectDirectory: project,
      input: fixture,
      now: new Date("2026-10-31T10:00:00Z"),
      rubricVersion: 1,
      settings: briefSettings(undefined),
      flows: async () => {
        throw new Error("flows loaded");
      },
    });
    expect(recorded.outcome).toBe("created");
  });

  test("decide re-validates against the flows as they are now", async () => {
    const { project } = await studioProject(directories, ["editor"]);
    await recordBriefInput({ project, input: withAssertions([tileHeight]) });
    await writeFile(
      join(project, ".idiom", "flows", "studio-lab.json"),
      JSON.stringify({
        id: "studio-lab",
        title: "Studio",
        intent: ["Editor chrome"],
        setup: [],
        viewports: ["desktop"],
        states: [
          {
            id: "drawer",
            description: "drawer",
            url: "/lab/drawer",
            expect: { status: 200 },
          },
        ],
      }),
    );
    await expect(
      briefDecideCommand({
        project,
        slug: "pinned-group",
        option: "corner-pin",
      }),
    ).rejects.toThrow('declares no state "editor"; states: drawer');
  });

  test("the Markdown lists how each criterion is checked", async () => {
    const brief = storedBriefSchema.parse({
      version: 1,
      ...withAssertions([tileHeight, pinWithin]),
      rubricVersion: 1,
      createdAt: "2026-10-31T10:00:00.000Z",
      updatedAt: "2026-10-31T10:00:00.000Z",
    });
    const markdown = renderBrief(brief, briefSettings(undefined));
    expect(markdown).toContain(
      "- [ ] The pin icon is at most 20px square and tile height is unchanged.\n  - Checked by Idiom: studio-lab/editor — `.drawer-item` height 56px ±1\n  - Checked by Idiom: studio-lab/editor — `.drawer-item .pin` within `.tile`\n",
    );
  });
});

const element = (
  selector: string,
  rect: object,
  ancestors: string[] = [],
): ObservedElementV2 =>
  ({
    selector,
    tag: "div",
    visible: true,
    ancestorSelectors: ancestors,
    rect: { x: 0, y: 0, width: 100, height: 56, ...rect },
    styles: { opacity: "1", visibility: "visible", display: "block" },
  }) as unknown as ObservedElementV2;

function tuple(itemHeight: number, marks = true): CheckTuple {
  return {
    ...invariantTuple({
      ...invariantObservations(),
      elements: [
        element("#a", { height: itemHeight }),
        element("#a .tile", {}, ["#a"]),
        element("#a .pin", { x: 70, y: 4, width: 20, height: 20 }, [
          "#a .tile",
          "#a",
        ]),
      ],
      selectorMarks: (marks
        ? [
            { selector: ".drawer-item", matches: ["#a"] },
            { selector: ".drawer-item .pin", matches: ["#a .pin"] },
            { selector: ".tile", matches: ["#a .tile"] },
          ]
        : []
      ).map((mark) => ({ purpose: "brief", ...mark })) as SelectorMark[],
    }),
    flow: "studio-lab",
  };
}

describe("coverage", () => {
  const stored = (input: object): CompleteStoredBrief => {
    const brief = storedBriefSchema.parse({
      version: 1,
      status: "decided",
      decidedBy: "requester",
      rubricVersion: 1,
      createdAt: "2026-10-31T10:00:00.000Z",
      updatedAt: "2026-10-31T10:00:00.000Z",
      ...input,
    });
    if (!isCompleteBrief(brief)) throw new Error("fixture brief is incomplete");
    return brief;
  };
  const checked = briefCheckFrom(
    stored(withAssertions([tileHeight, pinWithin])),
  );
  const elsewhere = briefCheckFrom(
    stored(
      withAssertions([{ ...tileHeight, flow: "settings" }], {
        slug: "elsewhere",
      }),
    ),
  );
  const plain = briefCheckFrom(stored({ ...fixture, slug: "plain" }));
  const skipped = briefCheckFrom(
    stored({ ...fixture, slug: "skipped", chosenOption: "dont-build" }),
  );

  test("statuses across tuples, omitting briefs for other flows", () => {
    const coverage = computeBriefCoverage(
      [tuple(100), tuple(56, false)],
      [checked, elsewhere, plain, skipped],
      "studio-lab",
    );
    expect(coverage.entries.map((entry) => [entry.slug, entry.status])).toEqual(
      [
        ["pinned-group", "checked"],
        ["plain", "not-checkable"],
        ["skipped", "skipped"],
      ],
    );
    expect(coverage.entries[0]).toMatchObject({
      assertions: [
        { form: "size", passed: 0, mismatched: 1 },
        { form: "within", passed: 1, mismatched: 0 },
      ],
    });
    expect(briefCoverageLines(coverage)).toEqual([
      "Decided briefs: 3 apply to this flow.",
      "- Pinned group in the Add drawer (pinned-group): checked; 1 passed, 1 mismatched, 0 unmeasured",
      "- Pinned group in the Add drawer (plain): decided, not checkable",
      "- Pinned group in the Add drawer (skipped): skipped (decided not to build; nothing to check)",
    ]);
  });

  test("not captured, and unmeasured with a reason", () => {
    expect(
      computeBriefCoverage(
        [{ ...tuple(56), state: "other" }],
        [checked],
        "studio-lab",
      ).entries[0],
    ).toMatchObject({ status: "not-captured", states: ["editor"] });
    expect(
      briefCoverageLines(
        computeBriefCoverage([tuple(56, false)], [checked], "studio-lab"),
      )[2],
    ).toBe(
      "  - criterion 0 assertion 0 (size .drawer-item at editor): the capture predates the brief and did not measure .drawer-item; recapture",
    );
  });

  test("a partly measured assertion names the matches it skipped", () => {
    const contrast = briefCheckFrom(
      stored(
        withAssertions([
          {
            flow: "studio-lab",
            state: "editor",
            selector: ".pin",
            minContrast: 3,
          },
        ]),
      ),
    );
    const pin = (selector: string, styles: object) =>
      ({
        ...element(selector, {}, ["#a .tile"]),
        tag: "svg",
        styles: {
          opacity: "1",
          visibility: "visible",
          display: "block",
          color: "rgba(0, 0, 0, 0)",
          backgroundColor: "rgba(0, 0, 0, 0)",
          stroke: "none",
          ...styles,
        },
      }) as unknown as ObservedElementV2;
    const subject: CheckTuple = {
      ...invariantTuple({
        ...invariantObservations(),
        elements: [
          {
            ...element("#a .tile", {}),
            styles: {
              opacity: "1",
              visibility: "visible",
              display: "block",
              backgroundColor: "rgb(255, 255, 255)",
            },
          } as unknown as ObservedElementV2,
          pin("#a .pin:nth-of-type(1)", { fill: "rgb(0, 0, 0)" }),
          pin("#a .pin:nth-of-type(2)", { fill: "rgba(0, 0, 0, 0)" }),
        ],
        selectorMarks: [
          {
            purpose: "brief",
            selector: ".pin",
            matches: ["#a .pin:nth-of-type(1)", "#a .pin:nth-of-type(2)"],
          },
        ] as SelectorMark[],
      }),
      flow: "studio-lab",
    };
    const note =
      "1 of 2 .pin matches had no painted foreground and were not measured: #a .pin:nth-of-type(2)";
    const coverage = computeBriefCoverage([subject], [contrast], "studio-lab");
    expect(coverage.entries[0]).toMatchObject({
      status: "checked",
      assertions: [{ passed: 1, mismatched: 0, notes: [note] }],
    });
    expect(briefCoverageLines(coverage).slice(1)).toEqual([
      "- Pinned group in the Add drawer (pinned-group): checked; 1 passed, 0 mismatched, 0 unmeasured",
      `  - criterion 0 assertion 0 (minContrast .pin at editor): ${note}`,
    ]);
  });
});

describe("project config, context and learn", () => {
  async function decidedProject(assertions: unknown[] = [tileHeight]) {
    const { project } = await studioProject(directories);
    await recordBriefInput({ project, input: withAssertions(assertions) });
    await briefDecideCommand({
      project,
      slug: "pinned-group",
      option: "corner-pin",
    });
    return project;
  }

  test("checks read decided briefs; settings identity ignores them", async () => {
    const project = await decidedProject();
    const config = await projectChecksConfig({
      projectDirectory: project,
      project: {
        checks: (await import("../src/schemas/project.js"))
          .defaultChecksSettings,
      },
    });
    expect(config.briefs?.map((brief) => brief.slug)).toEqual(["pinned-group"]);
    expect(settingsIdentity(config)).toBe(
      settingsIdentity({ ...config, briefs: undefined }),
    );
    expect(await loadBriefChecks(project)).toHaveLength(1);
  });

  test("idiom context lists decided briefs relevant to the flow", async () => {
    const project = await decidedProject();
    await writeFile(join(project, "DESIGN.md"), "# Design\n");
    await writeFile(join(project, "PRODUCT.md"), "# Product\n");
    const brief = await collectDesignBrief({
      project,
      flow: "studio-lab",
      dependencies: { gitTopology: undefined },
    });
    const rendered = renderDesignBrief(brief);
    expect(rendered).toContain(
      [
        "## Decided design briefs",
        "",
        "- Pinned group in the Add drawer (.idiom/briefs/pinned-group.md)",
        "  Decision: A small corner pin icon inside the tile",
        "  - [checked] The pin icon is at most 20px square and tile height is unchanged.",
      ].join("\n"),
    );
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(12_000);
  });

  test("learn --from-brief promotes size criteria to state invariants", async () => {
    const project = await decidedProject([tileHeight, pinWithin]);
    let shown = "";
    const result = await learnCommand({
      project,
      fromBrief: "pinned-group",
      observation: "every tile got taller once pins were added",
      yes: true,
      write: (diff) => {
        shown = diff;
      },
      dependencies: {
        clock: () => new Date("2026-10-31T12:00:00.000Z"),
        gitTopology: noTopology,
      },
    });
    expect(result).toMatchObject({
      recorded: true,
      kind: "invariant",
      next: "Next: idiom check studio-lab — the brief's size criteria are now flow invariants.",
    });
    const flow = JSON.parse(
      await readFile(
        join(project, ".idiom", "flows", "studio-lab.json"),
        "utf8",
      ),
    );
    expect(flow.states[0].invariants).toEqual([
      {
        name: "pinned-group: The pin icon is at most 20px square and tile height is unchanged.",
        selector: ".drawer-item",
        height: 56,
        tolerance: 1,
      },
    ]);
    expect(shown).toContain("--- a/.idiom/flows/studio-lab.json");
    expect(shown).toContain(
      '"selector":".drawer-item","height":56,"tolerance":1}]}]}',
    );
    const [line] = (
      await readFile(join(project, ".idiom", "learned.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(learnedEntrySchema.parse(JSON.parse(line ?? ""))).toMatchObject({
      kind: "invariant",
      brief: "pinned-group",
      flow: "studio-lab",
      state: "editor",
      target: { selector: ".drawer-item" },
    });

    // Already declared: nothing measurable is left, so it becomes a ruling.
    await writeFile(join(project, "DESIGN.md"), "# Design\n");
    const ruling = await learnCommand({
      project,
      fromBrief: "pinned-group",
      observation:
        "flag per-item controls that materially increase a repeated item's size",
      yes: true,
      dependencies: { gitTopology: noTopology },
    });
    expect(ruling).toMatchObject({ recorded: true, kind: "ruling" });
    expect(await readFile(join(project, "DESIGN.md"), "utf8")).toContain(
      "Flag per-item controls that materially increase a repeated item's size (from brief pinned-group).",
    );
  });

  test("learn --from-brief rejects a proposed brief and asks for --state when ambiguous", async () => {
    const { project } = await studioProject(directories, ["editor", "open"]);
    await recordBriefInput({
      project,
      input: withAssertions([tileHeight, { ...pinWithin, state: "open" }]),
    });
    await expect(
      learnCommand({
        project,
        fromBrief: "pinned-group",
        observation: "too tall",
        yes: true,
      }),
    ).rejects.toThrow(
      "brief pinned-group is proposed; learn from a decided brief",
    );
    await briefDecideCommand({
      project,
      slug: "pinned-group",
      option: "corner-pin",
    });
    await expect(
      learnCommand({
        project,
        fromBrief: "pinned-group",
        observation: "too tall",
        yes: true,
      }),
    ).rejects.toThrow(
      "brief pinned-group names several flow states (studio-lab/editor, studio-lab/open); pass --state",
    );
  });
});
