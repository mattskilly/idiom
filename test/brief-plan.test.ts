import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  BRIEF_PLAN_CHECKS,
  BRIEF_PLAN_RULES,
  buildBriefPlan,
  renderBriefPlan,
} from "../src/brief/plan.js";
import {
  briefInputFieldNames,
  briefInputSchema,
} from "../src/schemas/brief.js";

const pinned = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/triage/pinned-group.json", import.meta.url),
    "utf8",
  ),
);
const triage = {
  id: "triage-0123456789",
  verdict: "design decision" as const,
  reason: pinned.response.reason,
};

test("a plan from a triage carries its id, questions and every check per question", () => {
  const plan = buildBriefPlan({
    request: pinned.request,
    questions: pinned.response.questions,
    triage,
    references: [],
  });
  expect(plan.triageId).toBe("triage-0123456789");
  expect(plan.questions).toHaveLength(8);
  for (const question of plan.questions)
    expect(question.check).toEqual(BRIEF_PLAN_CHECKS.map((c) => c.check));
  expect(plan.checks.map((check) => check.id)).toEqual([
    "hover",
    "touch",
    "keyboard",
    "small-screen",
    "empty-state",
    "error-state",
  ]);
  expect(plan.budget).toEqual({ minutes: 10, searches: { min: 3, max: 6 } });
  expect(plan.rules).toEqual([...BRIEF_PLAN_RULES]);
  expect(plan.rules).toContain("Cite every claim with a source URL.");
  expect(plan.rules).toContain('Say "nothing found" rather than guess.');
  expect(plan.rules).toContain(
    'Treat "a competitor has it" as a signal to investigate, not a reason to build.',
  );
  expect(plan.recordShape.triage).toEqual({
    verdict: "design decision",
    reason: pinned.response.reason,
    questions: pinned.response.questions,
  });
});

test("references group by tier, bar first; none configured adds the note", () => {
  const plan = buildBriefPlan({
    request: "r",
    questions: ["q?"],
    references: [
      { name: "Floor", tier: "floor", note: "minimum" },
      { name: "Other", tier: "peer", note: "peer" },
      { name: "Bar", tier: "bar", note: "the bar" },
      { name: "Always", tier: "always", note: "always" },
    ],
  });
  expect(Object.keys(plan.references)).toEqual([
    "bar",
    "always",
    "floor",
    "peer",
  ]);
  expect(plan.references.bar).toEqual([{ name: "Bar", note: "the bar" }]);
  expect(plan.referencesNote).toBeUndefined();
  const none = buildBriefPlan({
    request: "r",
    questions: ["q?"],
    references: [],
  });
  expect(none.references).toEqual({});
  expect(none.referencesNote).toMatch(/^None configured: name 2–3/);
});

test("standards match the request's keywords; ARIA patterns always appear", () => {
  const pinnedPlan = buildBriefPlan({
    request: pinned.request,
    questions: pinned.response.questions,
    references: [],
  });
  const topics = pinnedPlan.standards.map((standard) => standard.topic);
  for (const topic of [
    "Target size",
    "Content on hover or focus",
    "Keyboard",
    "Non-text contrast",
    "ARIA patterns",
  ])
    expect(topics).toContain(topic);
  const refactor = buildBriefPlan({
    request: "Rename the internal store module",
    questions: ["Which module name reads best to maintainers?"],
    references: [],
  });
  expect(refactor.standards.map((standard) => standard.topic)).toEqual([
    "ARIA patterns",
  ]);
});

test("the record shape covers every input field and parses once filled", () => {
  const plan = buildBriefPlan({
    request: pinned.request,
    questions: ["How large is the pin?"],
    triage,
    references: [],
  });
  expect(Object.keys(plan.recordShape)).toEqual(
    expect.arrayContaining(briefInputFieldNames),
  );
  const shape = structuredClone(plan.recordShape) as {
    options: Array<Record<string, unknown>>;
  };
  const filled: Record<string, unknown> = {
    ...shape,
    slug: "pinned-group",
    title: "Pinned group",
    decision: "How does a user pin an item?",
    requestNamedIdea: true,
    research: [
      {
        question: "How large is the pin?",
        findings: [
          {
            claim: "Small.",
            source: "https://example.com/a",
            verified: "read",
          },
        ],
      },
    ],
    options: shape.options.map((option, index) => {
      const { label: _label, sketch: _sketch, ...rest } = option;
      const id = ["sibling", "corner", "dont-build"][index] as string;
      const filledOption: Record<string, unknown> = {
        ...rest,
        id,
        title: `Option ${index}`,
        summary: "one line",
        cost: { space: "none", steps: "one", concepts: "none", code: "small" },
      };
      if (index === 1) delete filledOption.rejectedBecause;
      else filledOption.rejectedBecause = "worse";
      return filledOption;
    }),
    recommendation: { option: "corner", reason: "best" },
    acceptanceCriteria: [
      { kind: "geometry", statement: "at most 20px" },
      { kind: "input-states", statement: "on touch it is visible" },
      { kind: "contrast", statement: "meets 3:1" },
      { kind: "behaviour", statement: "pins" },
    ],
    outOfScope: [],
    stakes: "high",
    reversible: false,
  };
  delete filled.decidedBy;
  delete filled.supersededBy;
  delete filled.chosenOption;
  const parsed = briefInputSchema.safeParse(filled);
  expect(parsed.error?.issues).toBeUndefined();
  expect(parsed.success).toBe(true);
});

test("a no-design-decision triage plans nothing", () => {
  const plan = buildBriefPlan({
    request: "fix the typo",
    questions: [],
    triage: {
      id: "triage-aaaaaaaaaa",
      verdict: "no design decision",
      reason: "copy fix",
    },
    references: [],
  });
  expect(plan.noDecision).toBe(true);
  expect(plan.questions).toEqual([]);
  expect(renderBriefPlan(plan)).toBe(
    "No design decision: write the ticket as usual.",
  );
});

test("the rendered plan lists rules, questions, standards and a JSON record shape", () => {
  const text = renderBriefPlan(
    buildBriefPlan({
      request: pinned.request,
      questions: ["How large is the pin?"],
      triage,
      references: [],
      minutes: 5,
    }),
  );
  expect(text).toContain("Triage id: triage-0123456789");
  expect(text).toContain("Budget: about 5 minutes and 3–6 searches.");
  expect(text).toContain("1. How large is the pin?");
  expect(text).toContain("https://www.w3.org/WAI/ARIA/apg/patterns/");
  const json = /```json\n([\s\S]+?)\n```/.exec(text)?.[1] ?? "";
  expect(JSON.parse(json).request).toBe(pinned.request);
});
