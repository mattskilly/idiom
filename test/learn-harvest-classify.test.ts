import { expect, test } from "vitest";
import {
  classifyCorrection,
  classifySentence,
  sentences,
} from "../src/learn/harvest-classify.js";
import { PROCESS_ANSWER } from "./harvest-support.js";

test.each([
  ["The time chips feel cramped; add more space between them.", "spacing"],
  ['The button should say "Book", not "Reserve".', "copy"],
  ["The modal shouldn't close when I click outside it.", "interaction"],
  ["Header text is too light against the background.", "visual"],
  ["Align the price with the title.", "layout"],
  ["The card padding should be 16px on mobile.", "spacing"],
  ["The modal’s title must use sentence case.", "copy"],
])("a UI correction is caught: %s", (text, category) => {
  const result = classifyCorrection(text);
  expect(result.ui).toBe(true);
  expect(result.categories).toContain(category);
  expect(result.sentences).toEqual([text]);
});

test.each([
  ["the real answer to a build-process escalation", PROCESS_ANSWER],
  ["a rebase instruction", "Rebase onto main and rerun typecheck."],
  ["a bare retry", "Retry."],
  ["a spec complaint", "The spec is wrong; escalate."],
  ["a code fence", "```ts\nconst button = 'should be bigger and darker';\n```"],
  ["a quoted line", "> The button should be bigger.\n\nAgreed, merge it."],
  ["praise", "Looks good, merge after CI passes."],
  [
    "talk about a check",
    "The check should skip the fixture files and the test should pass.",
  ],
])("non-UI text is ignored: %s", (_label, text) => {
  expect(classifyCorrection(text)).toEqual({
    ui: false,
    categories: [],
    sentences: [],
  });
});

test("mixed text keeps only the UI sentences, verbatim", () => {
  const text =
    "Tests pass now, thanks.\n\n- Also the card padding is too tight on mobile — use 16px.\n- Then merge.\n\nAnd the `Save` button must not wrap onto two lines!";
  const result = classifyCorrection(text);
  expect(result.ui).toBe(true);
  expect(result.sentences).toEqual([
    "Also the card padding is too tight on mobile — use 16px.",
    "And the `Save` button must not wrap onto two lines!",
  ]);
  for (const sentence of result.sentences) expect(text).toContain(sentence);
  expect(result.categories).toEqual(["layout", "spacing", "visual"]);
});

test("sentences are exact substrings with list markers trimmed", () => {
  const text =
    "1. First point here. Second one!\n* Third\n\n```\ncode. More.\n```";
  expect(sentences(text).map((item) => item.text)).toEqual([
    "First point here.",
    "Second one!",
    "Third",
  ]);
});

test("a correction needs a signal, a category, and more UI than process words", () => {
  expect(classifySentence("The header.").ui).toBe(false);
  expect(classifySentence("Make the build faster.").ui).toBe(false);
  expect(classifySentence("Make the header bigger.").ui).toBe(true);
  expect(
    classifySentence("Move the test fixture for the header spec into src/a.ts.")
      .ui,
  ).toBe(false);
});
