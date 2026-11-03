import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  briefInputSchema,
  briefTriageResultSchema,
  formatBriefIssues,
  storedBriefSchema,
  storedTriageSchema,
} from "../src/schemas/brief.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);

function clone(): typeof fixture {
  return structuredClone(fixture);
}

function issues(input: unknown): string[] {
  const parsed = briefInputSchema.safeParse(input);
  if (parsed.success) return [];
  return formatBriefIssues(parsed.error);
}

test("the pinned-group brief is valid", () => {
  const brief = briefInputSchema.parse(fixture);
  expect(brief.options).toHaveLength(4);
  expect(brief.status).toBe("proposed");
});

test.each<[string, (brief: typeof fixture) => void, RegExp]>([
  [
    "finding without a source",
    (b) => delete b.research[0].findings[0].source,
    /^research\[0\]\.findings\[0\]\.source: /,
  ],
  [
    "non-http source",
    (b) => {
      b.research[0].findings[0].source = "ftp://example.com/x";
    },
    /^research\[0\]\.findings\[0\]\.source: must be an http or https URL/,
  ],
  [
    "verified outside the enum",
    (b) => {
      b.research[0].findings[0].verified = "assumed";
    },
    /^research\[0\]\.findings\[0\]\.verified: /,
  ],
  [
    "empty findings",
    (b) => {
      b.research[2].findings = [];
    },
    /^research\[2\]\.findings: use "nothing found"/,
  ],
  [
    "one option",
    (b) => {
      b.options = b.options.slice(1, 2);
    },
    /^options: /,
  ],
  [
    "five options",
    (b) => {
      b.options.push({ ...b.options[2], id: "extra" });
    },
    /^options: /,
  ],
  [
    "no dont-build option",
    (b) => {
      b.options[3].kind = "alternative";
    },
    /^options: exactly one option must be kind "dont-build"; found 0/,
  ],
  [
    "two dont-build options",
    (b) => {
      b.options[2].kind = "dont-build";
    },
    /^options: exactly one option must be kind "dont-build"; found 2/,
  ],
  [
    "named idea without a requester option",
    (b) => {
      b.options[0].kind = "alternative";
    },
    /^options: the request named an idea/,
  ],
  [
    "requester option without a named idea",
    (b) => {
      b.requestNamedIdea = false;
    },
    /^options: requestNamedIdea is false/,
  ],
  [
    "recommendation naming an unknown option",
    (b) => {
      b.recommendation.option = "missing";
    },
    /^recommendation\.option: names no option/,
  ],
  [
    "rejected option without a reason",
    (b) => delete b.options[2].rejectedBecause,
    /^options\[2\]\.rejectedBecause: every option except/,
  ],
  [
    "recommended option with a rejection",
    (b) => {
      b.options[1].rejectedBecause = "no";
    },
    /^options\[1\]\.rejectedBecause: the recommended option is not rejected/,
  ],
  [
    "missing cost field",
    (b) => delete b.options[1].cost.space,
    /^options\[1\]\.cost\.space: /,
  ],
  [
    "geometry without a unit",
    (b) => {
      b.acceptanceCriteria[0].statement = "The pin icon is small.";
    },
    /^acceptanceCriteria\[0\]\.statement: a geometry criterion must state a measurement/,
  ],
  [
    "contrast without a ratio",
    (b) => {
      b.acceptanceCriteria[2].statement = "The icon has good contrast.";
    },
    /^acceptanceCriteria\[2\]\.statement: a contrast criterion must state a ratio/,
  ],
  [
    "input states naming no input",
    (b) => {
      b.acceptanceCriteria[1].statement = "The pin is always reachable.";
    },
    /^acceptanceCriteria\[1\]\.statement: an input-states criterion must name an input/,
  ],
  [
    "decided without decidedBy",
    (b) => {
      b.status = "decided";
    },
    /^decidedBy: a "decided" brief names who decided/,
  ],
  [
    "superseded without supersededBy",
    (b) => {
      b.status = "superseded";
    },
    /^supersededBy: a "superseded" brief names the brief replacing it/,
  ],
])("rejects %s", (_name, mutate, expected) => {
  const brief = clone();
  mutate(brief);
  const found = issues(brief);
  expect(
    found.some((issue) => expected.test(issue)),
    found.join("\n"),
  ).toBe(true);
});

test("issue paths read like options[1].cost.space", () => {
  const brief = clone();
  delete brief.options[1].cost.space;
  delete brief.options[2].cost.code;
  expect(issues(brief).map((issue) => issue.split(":")[0])).toEqual([
    "options[1].cost.space",
    "options[2].cost.code",
  ]);
});

test("a triage verdict and its questions must agree", () => {
  expect(
    briefTriageResultSchema.safeParse({
      verdict: "design decision",
      reason: "adds a control",
      questions: [],
    }).success,
  ).toBe(false);
  expect(
    briefTriageResultSchema.safeParse({
      verdict: "no design decision",
      reason: "a typo",
      questions: ["what?"],
    }).success,
  ).toBe(false);
  expect(
    briefTriageResultSchema.safeParse({
      verdict: "no design decision",
      reason: "two\nlines",
      questions: [],
    }).success,
  ).toBe(false);
});

test("docs/brief.md's brief input example is valid and its quoted issue is real", () => {
  const docs = readFileSync(
    new URL("../docs/brief.md", import.meta.url),
    "utf8",
  );
  const start = docs.indexOf("**brief input**");
  const block = /```json\n([\s\S]*?)\n```/.exec(docs.slice(start))?.[1];
  const example = briefInputSchema.parse(JSON.parse(block as string));
  expect(example.recommendation.option).toBe("corner-pin");
  const broken = clone();
  delete broken.options[1].cost.space;
  const [issue] = issues(broken);
  expect(docs).toContain(`\`${issue}\``);
});

test("option label and sketch are optional and bounded", () => {
  const ok = clone();
  ok.options[1].label = "Corner pin";
  ok.options[1].sketch = Array.from({ length: 16 }, () => "x".repeat(72)).join(
    "\n",
  );
  expect(issues(ok)).toEqual([]);
  const tall = clone();
  tall.options[1].sketch = Array.from({ length: 17 }, () => "x").join("\n");
  expect(issues(tall)).toEqual(["options[1].sketch: at most 16 lines"]);
  const wide = clone();
  wide.options[1].sketch = "x".repeat(73);
  expect(issues(wide)).toEqual([
    "options[1].sketch: each line at most 72 characters",
  ]);
  const long = clone();
  long.options[1].label = "x".repeat(41);
  expect(issues(long)).toHaveLength(1);
  const twoLines = clone();
  twoLines.options[1].label = "a\nb";
  expect(issues(twoLines)).toEqual(["options[1].label: must be one line"]);
});

test("stakes and reversible are accepted; chosenOption must exist and needs a decided brief", () => {
  expect(issues({ ...clone(), stakes: "low", reversible: true })).toEqual([]);
  expect(issues({ ...clone(), stakes: "medium" })).toHaveLength(1);
  const decided = {
    ...clone(),
    status: "decided",
    decidedBy: "requester",
    chosenOption: "sibling-button",
  };
  expect(issues(decided)).toEqual([]);
  expect(issues({ ...decided, chosenOption: "nope" })).toEqual([
    "chosenOption: names no option; choose one of sibling-button, corner-pin, context-menu, dont-build",
  ]);
  expect(issues({ ...clone(), chosenOption: "corner-pin" })).toEqual([
    'chosenOption: only a "decided" brief names a chosen option',
  ]);
});

test("a stored triage record is strict", () => {
  const record = {
    version: 1,
    id: "triage-0123456789",
    request: "r",
    rubricVersion: 1,
    createdAt: "2026-10-31T10:00:00.000Z",
    verdict: "no design decision",
    reason: "copy",
    questions: [],
  };
  expect(storedTriageSchema.safeParse(record).success).toBe(true);
  expect(storedTriageSchema.safeParse({ ...record, extra: 1 }).success).toBe(
    false,
  );
  expect(
    storedTriageSchema.safeParse({ ...record, id: "triage-XYZ" }).success,
  ).toBe(false);
});

const stored = {
  version: 1,
  ...structuredClone(fixture),
  slug: "pinned-group-in-the-add-drawer",
  status: "proposed",
  outOfScope: [],
  rubricVersion: 1,
  createdAt: "2026-10-31T10:00:00.000Z",
  updatedAt: "2026-10-31T10:00:00.000Z",
};
const run = {
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  budgetMs: 900_000,
  durationMs: 1_000,
  calls: 1,
};
const incomplete = {
  stage: "research",
  note: "Research incomplete: the budget ran out.",
  unresearched: ["How big?"],
};

function withoutOptions(brief: Record<string, unknown>) {
  const {
    decision: _decision,
    requestNamedIdea: _idea,
    options: _options,
    recommendation: _recommendation,
    acceptanceCriteria: _criteria,
    ...rest
  } = brief;
  return rest;
}

function storedIssues(brief: unknown): string[] {
  const parsed = storedBriefSchema.safeParse(brief);
  return parsed.success ? [] : formatBriefIssues(parsed.error);
}

test("a stored brief with incomplete research may stop before options", () => {
  expect(
    storedIssues({
      ...withoutOptions(stored),
      research: [],
      researchRun: { ...run, incomplete },
    }),
  ).toEqual([]);
  expect(
    storedIssues({ ...stored, researchRun: { ...run, incomplete } }),
  ).toEqual([]);
});

test("the incomplete relaxation applies only to incomplete research", () => {
  expect(storedIssues(withoutOptions(stored))).toEqual(
    expect.arrayContaining(["options: required", "decision: required"]),
  );
  expect(
    storedIssues({ ...withoutOptions(stored), researchRun: run }),
  ).toContain("options: required");
  expect(
    storedIssues({
      ...stored,
      status: "decided",
      decidedBy: "requester",
      researchRun: { ...run, incomplete },
    }),
  ).toEqual([
    'status: a brief with incomplete research stays "proposed"; record a complete brief to decide it',
  ]);
  const { options: _options, ...partial } = stored;
  expect(
    storedIssues({ ...partial, researchRun: { ...run, incomplete } }).join(
      "\n",
    ),
  ).toMatch(/every options-stage field or none; missing options/);
});

test("record input never carries researchRun", () => {
  expect(issues({ ...clone(), researchRun: run })).toEqual([
    expect.stringMatching(/researchRun/),
  ]);
});
