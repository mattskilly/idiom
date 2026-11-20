import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  capSubject,
  DEFAULT_LINT_CONTEXT,
  extractCriteria,
  findCap,
  type LintContext,
  lintCriteria,
  lintJson,
  lintMarkdown,
  lintResult,
  renderLint,
} from "../src/brief/lint.js";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/brief-lint/${name}`, import.meta.url),
    "utf8",
  );

const criteria = (...texts: string[]) =>
  texts.map((text, index) => ({ text, line: index + 1 }));

describe("extractCriteria", () => {
  test("reads list items under a heading at any level until the next same-or-higher heading", () => {
    const text = [
      "# Title",
      "### Acceptance Criteria",
      "- first",
      "  continues here",
      "* second",
      "+ third",
      "1. fourth",
      "2) fifth",
      "- [ ] sixth",
      "- [x] seventh",
      "#### Sub-heading keeps the section",
      "- eighth",
      "## Out of scope",
      "- not a criterion",
    ].join("\n");
    const { section, criteria } = extractCriteria(text);
    expect(section).toBe(true);
    expect(criteria.map((c) => c.text)).toEqual([
      "first continues here",
      "second",
      "third",
      "fourth",
      "fifth",
      "sixth",
      "seventh",
      "eighth",
    ]);
    expect(criteria[0]?.line).toBe(3);
    expect(criteria[7]?.line).toBe(12);
  });

  test("accepts the bold and colon forms, ended by any heading", () => {
    for (const label of ["**Acceptance criteria**", "Acceptance criteria:"]) {
      const { section, criteria } = extractCriteria(
        [label, "- one", "- two", "### Next", "- three"].join("\n"),
      );
      expect(section).toBe(true);
      expect(criteria.map((c) => c.text)).toEqual(["one", "two"]);
    }
  });

  test("ignores fenced lines", () => {
    const { criteria } = extractCriteria(
      [
        "## Acceptance criteria",
        "```md",
        "## Out of scope",
        "- fenced item",
        "```",
        "- real item",
      ].join("\n"),
    );
    expect(criteria.map((c) => c.text)).toEqual(["real item"]);
  });

  test("keeps rendered-brief sub-labels in the section and sub-bullets with their parent", () => {
    const { criteria } = extractCriteria(
      [
        "## Acceptance criteria",
        "",
        "**Geometry**",
        "",
        "- [ ] The pin icon is at most 20px square.",
        "  - Checked by Idiom: never overlaps the tile label",
        "",
        "**Behavior**",
        "",
        "- [ ] Pinning adds the tile to the group.",
      ].join("\n"),
    );
    expect(criteria).toEqual([
      {
        text: "The pin icon is at most 20px square.",
        line: 5,
        detail: "Checked by Idiom: never overlaps the tile label",
      },
      { text: "Pinning adds the tile to the group.", line: 10 },
    ]);
    expect(lintCriteria(criteria)).toEqual([]);
  });

  test("a document with no section has no criteria", () => {
    expect(extractCriteria("# Title\n\n- at most 64px\n")).toEqual({
      section: false,
      criteria: [],
    });
  });
});

describe("the ten-criterion fixture", () => {
  const file = lintMarkdown("criteria.md", fixture("criteria.md"));
  const byText = new Map(file.warnings.map((w) => [w.criterion, w]));
  const cases: [string, string | undefined, string[]][] = [
    [
      "The chip adds at most 64px to the toolbar",
      "size",
      ["≥4px between items", "no overlap", "one row at 1024px"],
    ],
    [
      "The selection toolbar is at most 640px wide, keeps ≥4px between items glyph to glyph, never overlaps, and stays on one row at 1024px",
      undefined,
      [],
    ],
    [
      "Button labels are no longer than 24 characters",
      "length",
      ["one line at 1024px", "no clipping"],
    ],
    [
      "The overflow menu shows at most 5 items",
      "count",
      ["stays reachable", "clipped or overlapped"],
    ],
    [
      "The panel fade-in lasts no more than 200ms",
      "time",
      ["end state is visible and complete"],
    ],
    ["The e2e test suite times out after at most 30s", undefined, []],
    ["The change touches at most 3 files", undefined, []],
    ["Card padding is at most 16px and at least 8px", undefined, []],
    ["The sidebar is max 280px wide", undefined, []],
    ["Sidebar nav items never overlap or truncate", undefined, []],
    [
      "Toolbar buttons are ≤ 32px tall",
      "size",
      ["each control stays ≥24px (≥44px below 768px)"],
    ],
  ];

  test("finds every criterion", () => {
    expect(file.section).toBe(true);
    expect(file.criteria).toBe(cases.length);
  });

  test.each(cases)("%s → %s", (criterion, kind, expected) => {
    const warning = byText.get(criterion);
    expect(warning?.cap.kind).toBe(kind);
    const texts = (warning?.suggestions ?? []).map((s) => s.text).join("\n");
    for (const part of expected) expect(texts).toContain(part);
  });

  test("warns on exactly the expected criteria", () => {
    expect(file.warnings.map((w) => w.line)).toEqual([5, 7, 8, 9, 15]);
  });
});

describe("findCap", () => {
  test.each([
    ["retries the request at most 3 times", undefined],
    ["Search loads in under 2 seconds", undefined],
    ["The banner sits under the toolbar", undefined],
    ["The page loads in under 2 seconds and the spinner shows", "time"],
    ["The chip stays within 300ms of the click to appear", "time"],
    ["The toolbar fits within 600px", undefined],
    ["max-width: 200px on the label", "size"],
    ["The toast shows 3 actions or fewer", "count"],
    ["The menu shows up to 7 options", "count"],
    ["The title is at most 40 chars", "length"],
    ["Tabs never exceed 30% of the header", "size"],
    ["The build finishes in under 5 minutes", undefined],
    ["The bundle adds at most 20 KB", undefined],
    ["The label is no less than 12px", undefined],
    ["Shows a result count of 5", undefined],
  ])("%s → %s", (criterion, kind) => {
    expect(findCap(criterion)?.kind).toBe(kind);
  });

  test("a unit is a token after the number, not a word ending in s", () => {
    expect(findCap("The dialog fades in under 2 s")?.kind).toBe("time");
    expect(findCap("The list shows at most 4 cards")?.kind).toBe("count");
  });
});

describe("pairing", () => {
  test("the subject is the head of the first run of UI nouns", () => {
    expect(capSubject("Toolbar buttons are ≤ 32px tall")).toBe("button");
    expect(capSubject("The selection toolbar is at most 640px")).toBe(
      "toolbar",
    );
    expect(capSubject("The text label is at most 40px")).toBe("label");
  });

  test("a sibling that shares only a generic noun does not pair the cap", () => {
    const warnings = lintCriteria(
      criteria(
        "The banner text is at most 40px tall",
        "Body text never truncates",
      ),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.cap.kind).toBe("size");
  });

  test("a sibling naming the subject with an outcome pairs the cap", () => {
    expect(
      lintCriteria(
        criteria("The badge is at most 20px wide", "Badges never clip"),
      ),
    ).toEqual([]);
  });

  test("any floor in the same criterion pairs it (documented simplification)", () => {
    expect(
      lintCriteria(criteria("The chip adds at most 64px and at least one tab")),
    ).toEqual([]);
  });
});

describe("context", () => {
  const custom: LintContext = {
    controlGapMin: 6,
    targetSize: { fine: 32, coarse: 48, narrowBelow: 600 },
    rowWidth: 1280,
    rowWidthSource: "viewports",
    rulings: [
      { id: "ruling-1", wording: "Keep 8px gap between toolbar items" },
      { id: "ruling-2", wording: "Labels never wrap in toolbars" },
      { id: "ruling-3", wording: "Rows keep one line of text" },
      { id: "ruling-4", wording: "Legible type at every size" },
      { id: "ruling-5", wording: "Motion respects reduced motion" },
    ],
  };

  test("project numbers and rulings flow into suggestions, at most 3 rulings", () => {
    const [warning] = lintCriteria(
      criteria("The chip adds at most 64px to the toolbar"),
      custom,
    );
    expect(warning?.suggestions).toEqual([
      {
        text: "keep ≥6px between items, glyph to glyph",
        source: "control-gap",
      },
      {
        text: "no overlap with neighbouring controls or text",
        source: "element-overlap",
      },
      { text: "stays on one row at 1280px", source: "viewports" },
      {
        text: "text keeps its normal word- and letter-spacing (no negative spacing)",
        source: "negative-spacing",
      },
      {
        text: "each control stays ≥32px (≥48px below 600px)",
        source: "target-size",
      },
      { text: "Keep 8px gap between toolbar items", source: "ruling:ruling-1" },
      { text: "Labels never wrap in toolbars", source: "ruling:ruling-2" },
      { text: "Rows keep one line of text", source: "ruling:ruling-3" },
    ]);
  });

  test("a width the criterion names wins", () => {
    const [warning] = lintCriteria(
      criteria("The header adds at most 40px at 1280px"),
    );
    expect(warning?.suggestions).toContainEqual({
      text: "stays on one row at 1280px",
      source: "criterion",
    });
  });

  test("time caps match only time rulings", () => {
    const [warning] = lintCriteria(
      criteria("The panel fade-in lasts no more than 200ms"),
      custom,
    );
    expect(warning?.suggestions.map((s) => s.source)).toEqual([
      "outcome",
      "ruling:ruling-5",
    ]);
  });
});

describe("rendering", () => {
  test("a paired spec prints nothing", () => {
    const file = lintMarkdown("paired.md", fixture("paired.md"));
    expect(file.criteria).toBe(4);
    expect(renderLint(lintResult([file], false))).toBe("");
  });

  test("the offset-chip criterion warns with its paired suggestions", () => {
    const result = lintResult(
      [lintMarkdown("offset-chip.md", fixture("offset-chip.md"))],
      false,
    );
    expect(renderLint(result)).toMatchInlineSnapshot(`
      "Warning: offset-chip.md:9 caps size with no floor or outcome: "The chip adds at most 64px to the toolbar."
        Pair it with: keep ≥4px between items, glyph to glyph
        Pair it with: no overlap with neighbouring controls or text
        Pair it with: stays on one row at 1024px
        Pair it with: text keeps its normal word- and letter-spacing (no negative spacing)
        Pair it with: each control stays ≥24px (≥44px below 768px)
      1 criterion warning(s) in 1 file(s)."
    `);
  });

  test("a file without a section prints a note even with no warnings", () => {
    const result = lintResult(
      [lintMarkdown("notes.md", "# Notes\n\nNothing here.\n")],
      true,
    );
    expect(result.warnings).toBe(0);
    expect(renderLint(result)).toBe(
      "Note: notes.md has no acceptance criteria section.",
    );
  });

  test("lintJson has the documented shape", () => {
    const json = lintJson(
      lintResult(
        [lintMarkdown("offset-chip.md", fixture("offset-chip.md"))],
        true,
      ),
    );
    expect(json).toEqual({
      strict: true,
      warnings: 1,
      files: [
        {
          path: "offset-chip.md",
          section: true,
          criteria: 2,
          warnings: [
            {
              criterion: "The chip adds at most 64px to the toolbar.",
              line: 9,
              cap: { kind: "size", text: "at most 64px" },
              suggestions: expect.any(Array),
            },
          ],
        },
      ],
    });
  });

  test("defaults are Idiom's", () => {
    expect(DEFAULT_LINT_CONTEXT.controlGapMin).toBe(4);
    expect(DEFAULT_LINT_CONTEXT.rowWidth).toBe(1024);
  });
});
