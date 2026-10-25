import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { critiquePrompt } from "../src/critique/prompt.js";
import {
  MalformedCritiqueError,
  validateCritiqueResult,
} from "../src/critique/schema.js";
import type {
  CritiqueInput,
  ModelFindingCandidate,
  PageCritiqueContext,
  ScreenshotRef,
} from "../src/critique/types.js";

const fixtures = join(import.meta.dirname, "fixtures/critique");

const screenshot: ScreenshotRef = {
  label: "page-1/desktop",
  path: "page-1/desktop/screenshot.png",
  readPath: "/tmp/none.png",
  state: "page-1",
  viewport: "desktop",
};

const page: PageCritiqueContext = {
  url: "https://example.test/",
  sections: [
    { id: "s1", role: "hero", heading: "Your page, done", selector: "#hero" },
    { id: "s2", role: "final", selector: "#closing" },
  ],
  brief: {
    path: "brief.md",
    lines: ["# Brief", "Launch in 3 days for $49/month.", ""],
  },
  direction: { path: "direction.md", lines: ["Calm editorial layout."] },
  focus: ["hierarchy"],
};

const claim: ModelFindingCandidate = {
  category: "unsupported-claim",
  severity: "major",
  confidence: 0.8,
  rule: "Brief: every statistic must come from the brief",
  selectorHint: "#hero p",
  state: "page-1",
  viewport: "desktop",
  screenshots: ["page-1/desktop"],
  references: [],
  explanation: 'The hero claims "4.9/5 rating from 87% of teams".',
  suggestedArea: "hero",
  acceptance: ["The hero states only figures from the brief."],
  section: "s1",
  citations: [
    { source: "brief", line: 2, excerpt: "Launch in 3   days for $49/month." },
  ],
  fix: "Replace the claim with the brief's launch promise.",
  focus: "hierarchy",
};

function validate(
  findings: ModelFindingCandidate[],
  context: PageCritiqueContext | undefined,
) {
  return validateCritiqueResult({
    result: { findings },
    screenshots: [screenshot],
    designMd: "",
    page: context,
  });
}

function issues(finding: ModelFindingCandidate, context = page): string[] {
  try {
    validate([finding], context);
  } catch (error) {
    if (error instanceof MalformedCritiqueError) return error.issues;
    throw error;
  }
  return [];
}

describe("page critique prompt", () => {
  test("the flow prompt is byte-identical without a page", async () => {
    const input = JSON.parse(
      await readFile(join(fixtures, "flow-input.json"), "utf8"),
    ) as CritiqueInput;
    expect(critiquePrompt(input, input.screenshots)).toBe(
      await readFile(join(fixtures, "flow-prompt.txt"), "utf8"),
    );
  });

  test("a page prompt numbers brief and direction lines and lists sections", async () => {
    const input = JSON.parse(
      await readFile(join(fixtures, "flow-input.json"), "utf8"),
    ) as CritiqueInput;
    const prompt = critiquePrompt({ ...input, page }, input.screenshots);
    expect(prompt).toContain("L2: Launch in 3 days for $49/month.");
    expect(prompt).toContain("L1: Calm editorial layout.");
    expect(prompt).toContain('"id": "s1"');
    expect(prompt).toContain('"heading": "Your page, done"');
    expect(prompt).toContain(
      "reference-mismatch, direction-drift, offer-change, or unsupported-claim",
    );
    expect(prompt).toContain("- hierarchy: one clear reading order");
  });
});

describe("page critique validation", () => {
  test("accepts a cited claim; quoted page copy may mention a rating", () => {
    expect(validate([claim], page).findings).toEqual([claim]);
  });

  test.each([
    ["unknown section", { ...claim, section: "s9" }, "unknown section"],
    [
      "line out of range",
      { ...claim, citations: [{ source: "brief", line: 9, excerpt: "x" }] },
      "L9 does not exist",
    ],
    [
      "excerpt not on the line",
      {
        ...claim,
        citations: [{ source: "brief", line: 2, excerpt: "Launch in 5 days" }],
      },
      "not found verbatim",
    ],
    [
      "empty excerpt",
      { ...claim, citations: [{ source: "brief", line: 3, excerpt: " " }] },
      "not found verbatim",
    ],
    ["missing fix", { ...claim, fix: undefined }, "a concrete fix is required"],
    ["missing section", { ...claim, section: undefined }, "section: required"],
    [
      "unrequested focus",
      { ...claim, focus: "jargon" },
      "was not a requested focus area",
    ],
    [
      "claim without a brief citation",
      {
        ...claim,
        citations: [{ source: "direction", line: 1, excerpt: "Calm" }],
      },
      "unsupported-claim must cite a brief line",
    ],
  ] as Array<[string, ModelFindingCandidate, string]>)(
    "rejects %s",
    (_label, finding, message) => {
      expect(issues(finding).join("\n")).toContain(message);
    },
  );

  test("rejects direction-drift when no direction was supplied", () => {
    const drift: ModelFindingCandidate = {
      ...claim,
      category: "direction-drift",
      explanation: "The closing section uses a loud gradient.",
      citations: [{ source: "direction", line: 1, excerpt: "Calm" }],
    };
    expect(validate([drift], page).findings).toHaveLength(1);
    expect(
      issues(drift, { ...page, direction: undefined }).join("\n"),
    ).toContain("no direction was supplied");
  });

  test("flow reviews reject page categories and page fields", () => {
    expect(() => validate([claim], undefined)).toThrow(
      "page fields require a page review",
    );
    const { section: _s, citations: _c, fix: _f, focus: _o, ...rest } = claim;
    // Flow reviews keep the strict no-rating rule even inside quotes.
    const plain = { ...rest, explanation: "The hero overstates its proof." };
    expect(() =>
      validate([{ ...rest, category: "hierarchy" }], undefined),
    ).toThrow("design-rating language is forbidden");
    expect(() =>
      validate([{ ...plain, category: "hierarchy" }], undefined),
    ).not.toThrow();
    expect(() =>
      validate([{ ...plain, category: "hierarchy", fix: "x" }], undefined),
    ).toThrow("page fields require a page review");
  });
});

test("a page with no detected sections accepts findings on the whole-page section", () => {
  const whole: PageCritiqueContext = {
    ...page,
    sections: [{ id: "s0", role: "page", selector: "body" }],
  };
  expect(issues({ ...claim, section: "s0" }, whole)).toEqual([]);
  expect(issues(claim, whole)).toEqual([
    'findings.0.section: unknown section "s1"',
  ]);
});

describe("advisory pattern critique (dogfooding request #69)", () => {
  const pattern = {
    id: "carousel-cards",
    intent: "A heading introduces a row of equal cards.",
    reference: "reference:carousel-cards",
    aspects: ["spacing", "hierarchy", "coherence"] as const,
  };
  const patternPage: PageCritiqueContext = {
    url: "/patterns/carousel-cards",
    sections: [
      { id: "s1", role: "body", heading: "Featured", selector: "#cards" },
    ],
    focus: [],
    pattern,
  };
  const spacing: ModelFindingCandidate = {
    category: "hierarchy",
    severity: "major",
    confidence: 0.8,
    rule: "Pattern intent: the heading sits apart from the cards",
    selectorHint: "#cards h2",
    state: "page-1",
    viewport: "desktop",
    screenshots: ["page-1/desktop"],
    references: [],
    explanation: "The heading sits 0px above the card row.",
    suggestedArea: "carousel section",
    acceptance: ["The heading has a clear gap above the cards."],
    section: "s1",
    fix: "Add a gap between the heading and the card row.",
    aspect: "spacing",
  };

  test("the pattern prompt states the intent, reference and aspects", async () => {
    const input = JSON.parse(
      await readFile(join(fixtures, "flow-input.json"), "utf8"),
    ) as CritiqueInput;
    const prompt = critiquePrompt(
      { ...input, page: patternPage },
      input.screenshots,
    );
    expect(prompt).toContain("## Pattern under review");
    expect(prompt).toContain(
      "intent: A heading introduces a row of equal cards.",
    );
    expect(prompt).toContain("design reference: reference:carousel-cards");
    expect(prompt).toContain("Report only spacing, hierarchy, or coherence");
    expect(prompt).toContain('"aspect": "spacing"');
    expect(prompt).not.toContain("## Brief");
    expect(prompt).not.toContain("offer-change");
    expect(
      critiquePrompt(
        {
          ...input,
          page: {
            ...patternPage,
            pattern: { ...pattern, reference: undefined },
          },
        },
        input.screenshots,
      ),
    ).toContain("design reference: no design reference");
  });

  test("a pattern finding needs an aspect, a section and a fix", () => {
    expect(validate([spacing], patternPage).findings).toEqual([spacing]);
    expect(issues({ ...spacing, aspect: undefined }, patternPage)).toEqual([
      "findings.0.aspect: required in a pattern review",
    ]);
    expect(
      issues({ ...spacing, section: undefined }, patternPage).join("\n"),
    ).toContain("section: required");
    expect(
      issues({ ...spacing, fix: undefined }, patternPage).join("\n"),
    ).toContain("a concrete fix is required");
  });

  test("a pattern review rejects page categories, citations and focus", () => {
    expect(
      issues({ ...spacing, category: "direction-drift" }, patternPage).join(
        "\n",
      ),
    ).toContain("page-review categories need a brief or direction");
    expect(
      issues({ ...spacing, focus: "hierarchy" }, patternPage).join("\n"),
    ).toContain("citations and focus are not part of a pattern review");
  });

  test("aspect is rejected outside a pattern review", () => {
    expect(issues({ ...claim, aspect: "spacing" }).join("\n")).toContain(
      "aspect requires a pattern review",
    );
    const { section: _s, fix: _f, aspect: _a, ...flowFinding } = spacing;
    expect(() =>
      validate([{ ...flowFinding, aspect: "spacing" }], undefined),
    ).toThrow("page fields require a page review");
  });
});
