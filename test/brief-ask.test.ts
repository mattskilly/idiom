import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { briefAsk, renderAsk } from "../src/brief/ask.js";
import { type StoredBrief, storedBriefSchema } from "../src/schemas/brief.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);

function stored(overrides: Record<string, unknown> = {}): StoredBrief {
  return storedBriefSchema.parse({
    version: 1,
    ...fixture,
    slug: "pinned-group",
    rubricVersion: 1,
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  });
}

test("the recommended option comes first, labelled (Recommended)", () => {
  const ask = briefAsk(stored());
  expect(ask?.options.map((option) => option.id)).toEqual([
    "corner-pin",
    "sibling-button",
    "context-menu",
    "dont-build",
  ]);
  expect(ask?.options[0]?.label).toBe(
    "A small corner pin icon inside the tile (Recommended)",
  );
  expect(ask?.options[3]?.label).toBe("Don't build it");
  expect(ask?.options[0]?.description).toBe(
    "An outline pin in the tile corner on hover and focus, always visible on touch, filled when pinned. — Established pattern, no added height, works on touch and keyboard.",
  );
  expect(ask?.options[1]?.description).toMatch(
    / — it doubles the drawer's height for a secondary action$/,
  );
  for (const option of ask?.options ?? [])
    expect(option.description).not.toMatch(/\n/);
});

test("it maps onto AskUserQuestion: one question, short header, 2–4 options, previews from sketches", () => {
  const sketch = "+------+\n| tile |\n|   📌 |\n+------+";
  const options = fixture.options.map((option: Record<string, unknown>) =>
    option.id === "corner-pin"
      ? { ...option, label: "Corner pin", sketch }
      : option,
  );
  const ask = briefAsk(stored({ options, decision: "Where does the pin go" }));
  const question = ask?.askUserQuestion.questions[0];
  expect(ask?.askUserQuestion.questions).toHaveLength(1);
  expect(question?.question).toBe("Where does the pin go?");
  expect(question?.header.length).toBeLessThanOrEqual(12);
  expect(question?.multiSelect).toBe(false);
  expect(question?.options.length).toBeGreaterThanOrEqual(2);
  expect(question?.options.length).toBeLessThanOrEqual(4);
  expect(question?.options[0]).toEqual({
    label: "Corner pin (Recommended)",
    description: expect.any(String),
    preview: sketch,
  });
  expect(question?.options[1]).not.toHaveProperty("preview");
  expect(ask?.text).toContain("1. Corner pin (Recommended): ");
  expect(renderAsk(ask as NonNullable<typeof ask>, "pinned-group")).toContain(
    "   | tile |",
  );
});

test("proceeding without asking needs low stakes, reversibility, no override and no dont-build", () => {
  // The fixture's recommendation overrides the requester's own idea.
  expect(
    briefAsk(stored({ stakes: "low", reversible: true }))?.proceed,
  ).toEqual({
    allowed: false,
    reason: "must ask: the recommendation overrides the requester's own idea",
  });
  const own = {
    recommendation: {
      option: "sibling-button",
      reason: "the requester's idea fits",
    },
    options: fixture.options.map((option: Record<string, unknown>) =>
      option.id === "sibling-button"
        ? { ...option, rejectedBecause: undefined }
        : option.id === "corner-pin"
          ? { ...option, rejectedBecause: "smaller target" }
          : option,
    ),
  };
  expect(briefAsk(stored(own))?.proceed).toEqual({
    allowed: false,
    reason: "must ask: high stakes (default)",
  });
  expect(briefAsk(stored({ ...own, stakes: "low" }))?.proceed.reason).toBe(
    "must ask: not marked reversible (default)",
  );
  const allowed = briefAsk(stored({ ...own, stakes: "low", reversible: true }));
  expect(allowed?.proceed.allowed).toBe(true);
  expect(allowed?.proceed.reason).toMatch(
    /^may proceed: low-stakes and reversible/,
  );
  const dontBuild = {
    requestNamedIdea: false,
    recommendation: { option: "dont-build", reason: "not worth it" },
    options: fixture.options
      .filter((option: Record<string, unknown>) => option.kind !== "requester")
      .map((option: Record<string, unknown>) =>
        option.id === "dont-build"
          ? { ...option, rejectedBecause: undefined }
          : { ...option, rejectedBecause: "not needed" },
      ),
    stakes: "low",
    reversible: true,
  };
  expect(briefAsk(stored(dontBuild))?.proceed).toEqual({
    allowed: false,
    reason: "must ask: the recommendation is not to build it",
  });
});

test("a decided or superseded brief has nothing to ask", () => {
  expect(
    briefAsk(stored({ status: "decided", decidedBy: "a designer" })),
  ).toBeUndefined();
  expect(
    briefAsk(stored({ status: "superseded", supersededBy: "pinned-group-v2" })),
  ).toBeUndefined();
});
