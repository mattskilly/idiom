import { describe, expect, test } from "vitest";
import { modelEvaluation } from "../src/critique/evaluation.js";

describe("modelEvaluation", () => {
  test.each([
    "The star-rating control has no visible focus ring.",
    "The rating widget displays 4.2/5 but its label is clipped.",
    "The score field and its label are misaligned.",
    "The grade selector collapses at mobile width.",
    "The grade selector has a disabled state.",
    "The rubric total row is hidden below the fold.",
    "Ratings bars use three different greens.",
    "The average rating sits above the reviews list without hierarchy.",
    "The total score is rendered in body text instead of the heading style.",
    "The rating shows 4.2 stars in a muted grey that fails contrast.",
    "Make the score readout match the DESIGN.md numeral style.",
    "DESIGN.md: rating controls use the accent star glyph",
    "The list shows 12 ratings without pagination.",
    "The rating is 14px while DESIGN.md requires 16px.",
    "Render the score at 24px to match the numeral style.",
    "The rating sits at 12px with 2px letter spacing.",
    "The score is 2x larger than the heading.",
    "The grade is 1.5rem in the summary card.",
  ])("permits naming a rating surface: %s", (prose) => {
    expect(modelEvaluation(prose)).toBeUndefined();
  });

  test.each([
    ["Overall design score: 7/10.", "Overall design score: 7/10"],
    ["The overall design rating is seven.", "overall design rating is seven"],
    ["Rubric total: 42", "Rubric total: 42"],
    ["I'd give this flow a B+ grade.", "B+ grade"],
    ["The design scores 8 out of 10.", "design scores 8 out of 10"],
    ["I would rate this page a 6.", "rate this page a 6"],
    ["Aggregate rating — 3/5.", "Aggregate rating — 3/5"],
    ["My rating for the layout is 70%.", "My rating"],
    ["This interface earns a 9/10 overall rating.", "9/10 overall rating"],
    ["Design grade: C", "Design grade: C"],
    ["The page gets 8 out of 10.", "gets 8 out of 10"],
    ["This layout earns a B.", "earns a B"],
    [
      "The rating widget is clipped. Overall design score: 7/10.",
      "Overall design score: 7/10",
    ],
  ])("rejects a model evaluation: %s", (prose, offending) => {
    expect(modelEvaluation(prose)).toContain(offending);
  });

  const termFree = [
    "The heading gets 3 weights across the page.",
    "We give the CTA two styles on this screen.",
    "The primary button gets 2 different hover colours on this page.",
    "The layout receives 4 competing accents.",
    "I would give the form one primary action.",
    "The page earns 2 extra scroll lengths from the oversized hero.",
  ];

  test.each(termFree)("permits term-free counts: %s", (prose) => {
    expect(modelEvaluation(prose)).toBeUndefined();
  });

  test("is never stricter than the bare-word guard on term-free prose", () => {
    const bareWord = /\b(?:score|rating|grade|rubric total)\b/i;
    for (const prose of termFree) {
      expect(bareWord.test(prose)).toBe(false);
      expect(modelEvaluation(prose)).toBeUndefined();
    }
  });

  test("caps a long excerpt around the offending words", () => {
    const prose = `${"The hero section stacks too many competing accents and ".repeat(3)}overall design score: 7/10.`;
    const found = modelEvaluation(prose);
    expect(found?.length).toBeLessThanOrEqual(80);
    expect(found).toContain("design score");
  });
});
