import { expect, test } from "vitest";
import { ExplorationSession } from "../src/explore/session.js";

const candidates = ["A", "B", "C"].map((label) => ({
  label,
  direction: `Direction ${label}`,
  choiceKey: label,
  rule: label,
  reason: label,
  category: "hierarchy" as const,
  repair: label,
  references: [],
  edits: [{ path: "src/app.tsx", oldText: "old", newText: label }],
}));

test("session supports no choice and exactly one nonblank refinement", () => {
  const session = new ExplorationSession(candidates);
  expect(session.select(undefined)).toBeUndefined();
  expect(session.select("b")?.label).toBe("B");
  expect(session.useRefinement(" tighter ")).toBe("tighter");
  expect(() => session.useRefinement("again")).toThrow(
    "This exploration has already used its one refinement.",
  );
});
