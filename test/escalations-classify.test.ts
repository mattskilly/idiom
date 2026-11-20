import { expect, test } from "vitest";
import { classifyQuestion } from "../src/learn/harvest-classify.js";

test("control, spacing and wording questions are design questions", () => {
  for (const question of [
    "The status filter has four options; should it be a dropdown or a segmented control?",
    "What spacing should sit between the time picker chips, 8px or 12px?",
    "Which wording should the confirm button use: Reserve or Book?",
    "Should the empty state of the calendar show an illustration?",
  ])
    expect(classifyQuestion(question).design, question).toBe(true);
});

test("lockfile, verify-step and spec-scope questions are not", () => {
  for (const question of [
    "verify fails because bun.lock is stale; should I regenerate the lockfile?",
    "The verify step times out in CI; should I raise the timeout or split the tests?",
    "The spec says to add a schema migration; is that in scope for this ticket or a follow-up?",
  ])
    expect(classifyQuestion(question).design, question).toBe(false);
});

test("code spans, fences and paths never count as UI on their own", () => {
  const question =
    "Should I keep `button.tsx` and `<Modal>` or move them to src/ui/form.ts?";
  const classified = classifyQuestion(question);
  expect(classified.design).toBe(false);
  expect(
    classifyQuestion(
      'Which file wins?\n```\n<button class="card modal">\n```\n',
    ).design,
  ).toBe(false);
});

test("the classification says why: categories and hit counts", () => {
  expect(
    classifyQuestion("Should the footer button label say Confirm?"),
  ).toMatchObject({ design: true, categories: ["copy", "interaction"] });
});
