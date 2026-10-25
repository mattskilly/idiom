import { expect, test } from "vitest";
import {
  explorationCandidatesJsonSchema,
  explorationRefinementJsonSchema,
  MalformedExplorationError,
  parseCandidateOutput,
  parseRefinementOutput,
} from "../src/explore/schema.js";
import { appendRuling, parseRulingBlocks } from "../src/rulings/law.js";
import {
  explorationCandidatesSchema,
  explorationEditSchema,
  explorationRefinementSchema,
  explorationRunSchema,
} from "../src/schemas/exploration.js";

function candidate(
  label: string,
  direction = label,
  references: string[] = [],
) {
  return {
    label,
    direction,
    choiceKey: `choice-${label}`,
    rule: `Prefer ${direction}.`,
    reason: `${direction} makes the hierarchy clear.`,
    category: "hierarchy" as const,
    repair: `Bring the surface to ${direction}.`,
    references,
    edits: [{ path: "src/app.tsx", oldText: "old", newText: label }],
  };
}

test("exploration candidates are exactly three distinct strict directions", () => {
  expect(
    explorationCandidatesSchema.parse([
      candidate("A"),
      candidate("B"),
      candidate("C"),
    ]),
  ).toHaveLength(3);
  expect(() =>
    explorationCandidatesSchema.parse([candidate("A"), candidate("B")]),
  ).toThrow();
  expect(() =>
    explorationCandidatesSchema.parse([
      candidate("A", "same"),
      candidate("B", " SAME "),
      candidate("C"),
    ]),
  ).toThrow("must be unique");
});

test("exploration candidate labels are exactly A, B, and C case-insensitively", () => {
  expect(
    explorationCandidatesSchema.parse([
      candidate(" c "),
      candidate("a"),
      candidate("B"),
    ]),
  ).toHaveLength(3);

  for (const candidates of [
    [candidate("A"), candidate("A", "second"), candidate("C")],
    [candidate("A"), candidate("B")],
    [candidate("D"), candidate("B"), candidate("A")],
  ])
    expect(explorationCandidatesSchema.safeParse(candidates).success).toBe(
      false,
    );

  const invalid = explorationCandidatesSchema.safeParse([
    candidate("Direction one"),
    candidate("Direction two"),
    candidate("Direction three"),
  ]);
  expect(invalid.success).toBe(false);
  if (!invalid.success)
    expect(invalid.error.issues.map((issue) => issue.message).join(" ")).toBe(
      'labels must be exactly the unique set A, B, and C; received ["Direction one","Direction two","Direction three"]',
    );
});

test("exploration transport constrains labels without unsupported array cardinality", () => {
  const candidates = explorationCandidatesJsonSchema([
    "reference:Canonical",
    "anti-reference:Avoid",
  ]).properties.candidates;
  expect(candidates).not.toHaveProperty("minItems");
  expect(candidates).not.toHaveProperty("maxItems");
  expect(candidates.items.properties.label).toEqual({
    type: "string",
    enum: ["A", "B", "C"],
  });
  expect(candidates.items.properties.references).toEqual({
    type: "array",
    minItems: 1,
    items: {
      type: "string",
      enum: ["reference:Canonical", "anti-reference:Avoid"],
    },
  });

  const emptyReferences = explorationRefinementJsonSchema([]).properties
    .refinement.properties.references;
  expect(emptyReferences).toEqual({
    type: "array",
    items: { type: "string" },
  });
  expect(emptyReferences).not.toHaveProperty("maxItems");
});

test("candidate citations canonicalize normalized matches and enforce the catalog", () => {
  const parsed = parseCandidateOutput(
    {
      candidates: [
        candidate("A", "A", [" REFERENCE:CANONICAL "]),
        candidate("B", "B", ["reference:Canonical"]),
        candidate("C", "C", ["reference:Canonical"]),
      ],
    },
    ["reference:Canonical"],
  );
  expect(parsed.map((item) => item.references)).toEqual([
    ["reference:Canonical"],
    ["reference:Canonical"],
    ["reference:Canonical"],
  ]);

  expect(() =>
    parseCandidateOutput(
      {
        candidates: [
          candidate("A", "A", ["DESIGN.md: hierarchy law"]),
          candidate("B", "B", ["unknown:one", "unknown:two"]),
          candidate("C"),
        ],
      },
      ["reference:Canonical", "anti-reference:Avoid"],
    ),
  ).toThrow(MalformedExplorationError);
  try {
    parseCandidateOutput(
      {
        candidates: [
          candidate("A", "A", ["DESIGN.md: hierarchy law"]),
          candidate("B", "B", ["unknown:one", "unknown:two"]),
          candidate("C"),
        ],
      },
      ["reference:Canonical", "anti-reference:Avoid"],
    );
  } catch (error) {
    expect(error).toBeInstanceOf(MalformedExplorationError);
    const issues = (error as MalformedExplorationError).issues;
    expect(issues).toHaveLength(4);
    expect(issues.join("\n")).toContain("DESIGN.md: hierarchy law");
    expect(issues.join("\n")).toContain("unknown:two");
    expect(issues.join("\n")).toContain(
      '["reference:Canonical","anti-reference:Avoid"]',
    );
    expect(issues.join("\n")).toContain("must cite at least one");
  }
});

test("empty catalogs require empty citations for candidates and refinements", () => {
  const { label: _label, ...refinement } = candidate("A");
  expect(
    parseCandidateOutput(
      {
        candidates: [candidate("A"), candidate("B"), candidate("C")],
      },
      [],
    ),
  ).toHaveLength(3);
  expect(parseRefinementOutput({ refinement }, []).references).toEqual([]);
  const { label: _citedLabel, ...citedRefinement } = candidate("A", "A", [
    "DESIGN.md: law",
  ]);
  expect(() =>
    parseRefinementOutput({ refinement: citedRefinement }, []),
  ).toThrow("permitted labels: []");
});

test("ambiguous normalized catalog labels are malformed", () => {
  expect(() =>
    parseCandidateOutput(
      {
        candidates: [
          candidate("A", "A", ["REFERENCE:ONE"]),
          candidate("B", "B", ["reference:one"]),
          candidate("C", "C", ["reference:one"]),
        ],
      },
      ["reference:one", " reference:one "],
    ),
  ).toThrow("does not unambiguously match");
});

test("exploration edits reject paths and output authored by the provider", () => {
  for (const path of [
    "/tmp/app.tsx",
    "../app.tsx",
    "src\\app.tsx",
    ".idiom-explore-evidence/a.png",
  ])
    expect(() =>
      explorationEditSchema.parse({ path, oldText: "old", newText: "new" }),
    ).toThrow();
  expect(() =>
    explorationRefinementSchema.parse({
      ...candidate("A"),
      label: undefined,
      outputPath: "mockup.png",
    }),
  ).toThrow();
});

test("stored exploration runs validate lifecycle, capture containment, and refined winners", () => {
  const stored = (label: "A" | "B" | "C", refined = false) => {
    const { edits: _edits, ...record } = candidate(label);
    return {
      ...record,
      label,
      capture: `candidates/candidate-${label.toLowerCase()}${refined ? "-refined" : ""}`,
      refined,
    };
  };
  const run = {
    version: 1 as const,
    flow: "fixture",
    state: "ready",
    question: "Which hierarchy should govern?",
    candidates: [stored("A"), stored("B"), stored("C"), stored("A", true)],
    selected: "A" as const,
    refined: "A",
    resolution: {
      outcome: "rule" as const,
      reason: "A is clearest.",
      recordedAt: "2026-08-29T12:00:00.000Z",
      selected: "A" as const,
      ruling: {
        id: "ruling-1",
        fingerprint: "fingerprint",
        choiceKey: "choice-a",
      },
      repairs: false,
    },
  };
  expect(explorationRunSchema.parse(run).resolution?.outcome).toBe("rule");
  expect(
    explorationRunSchema.safeParse({
      ...run,
      candidates: run.candidates.map((item, index) =>
        index === 0 ? { ...item, capture: "../outside" } : item,
      ),
    }).success,
  ).toBe(false);
  expect(
    explorationRunSchema.safeParse({ ...run, selected: "B" }).success,
  ).toBe(false);
  expect(
    explorationRunSchema.safeParse({
      ...run,
      candidates: [stored("A"), stored("B"), stored("B")],
      selected: undefined,
      refined: undefined,
      resolution: undefined,
    }).success,
  ).toBe(false);
});

test("ruling reasons round trip while old blocks remain valid", () => {
  const oldLaw = appendRuling("# Law\n", {
    id: "ruling-1",
    fingerprint: "old",
    choiceKey: "old-choice",
    outcome: "rule",
    wording: "Keep actions clear.",
    recordedAt: "2026-08-27T12:00:00.000Z",
  });
  const completed = appendRuling(oldLaw, {
    id: "ruling-2",
    fingerprint: "new",
    choiceKey: "new-choice",
    outcome: "rule",
    wording: "Group advanced controls behind disclosure.",
    reason: "The primary path became easier to scan.",
    recordedAt: "2026-08-27T12:01:00.000Z",
  });
  const resolutions = parseRulingBlocks(completed).resolutions;
  expect(resolutions[0]).toMatchObject({ id: "ruling-1" });
  expect(resolutions[0]).not.toHaveProperty("reason");
  expect(resolutions[1]).toMatchObject({
    id: "ruling-2",
    reason: "The primary path became easier to scan.",
  });
  expect(() =>
    appendRuling("# Law\n", {
      id: "ruling-1",
      fingerprint: "bad",
      choiceKey: "bad",
      outcome: "no-rule",
      reason: "not permitted",
      recordedAt: "2026-08-27T12:00:00.000Z",
    }),
  ).toThrow();
});
