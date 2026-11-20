import { expect, test } from "vitest";
import {
  type LearnedEntry,
  learnedEntrySchema,
} from "../src/schemas/learned.js";
import {
  contentTokens,
  matchEntry,
  type ProblemOccurrence,
} from "../src/scorecard/match.js";

let next = 0;
function learned(
  overrides: Partial<LearnedEntry> & { observation: string },
): LearnedEntry {
  next += 1;
  return learnedEntrySchema.parse({
    version: 1,
    id: `learned-${next}`,
    recordedAt: "2026-11-10T10:00:00Z",
    flow: "shop",
    state: "cart",
    kind: "observation",
    target: { file: ".idiom/flows/shop.json" },
    entry: {},
    ...overrides,
  });
}

function problem(
  occurrence: Partial<ProblemOccurrence> & { problem: string },
  flow = "shop",
) {
  return {
    flow,
    occurrences: [{ state: "cart", category: "control-gap", ...occurrence }],
  };
}

const gap = problem({
  rule: "idiom:control-gap",
  problem: "Buttons sit 2px apart; adjacent controls need an 8px gap.",
});

test("rule: a learned law's check, an imported row's checks, or target.check", () => {
  const law = learned({
    kind: "law",
    observation: "Cramped buttons",
    target: { file: ".idiom/project.json", check: "control-gap" },
  });
  expect(matchEntry(law, gap)).toEqual({ via: "rule", detail: "control-gap" });

  const imported = learned({
    observation: "Contrast too low on the total",
    import: {
      name: "misses",
      source: "misses.md",
      row: "7",
      line: 9,
      checks: ["contrast"],
    },
  });
  expect(
    matchEntry(
      imported,
      problem({
        category: "contrast",
        rule: "axe:color-contrast",
        problem: "Text contrast is 3.1:1",
      }),
    ),
  ).toEqual({ via: "rule", detail: "contrast" });

  const named = learned({
    observation: "Token off",
    target: { file: "x", check: "axe:color-contrast" },
  });
  expect(
    matchEntry(
      named,
      problem({
        category: "contrast",
        rule: "axe:color-contrast",
        problem: "x",
      }),
    ),
  ).toEqual({ via: "rule", detail: "axe:color-contrast" });
});

test("rule needs the same state", () => {
  const law = learned({
    kind: "law",
    state: "checkout",
    observation: "Cramped buttons",
    target: { file: ".idiom/project.json", check: "control-gap" },
  });
  expect(matchEntry(law, gap)).toBeUndefined();
});

test("selector: in the group key or in the problem text", () => {
  const entry = learned({
    observation: "Remove link is tiny",
    target: { file: "x", selector: "a.remove-item" },
  });
  expect(
    matchEntry(
      entry,
      problem({ groupKey: "a.remove-item", problem: "Too small to tap" }),
    ),
  ).toEqual({ via: "selector", detail: "a.remove-item" });
  expect(
    matchEntry(
      entry,
      problem({ problem: "a.remove-item is 16px tall; tap targets need 24px" }),
    ),
  ).toEqual({ via: "selector", detail: "a.remove-item" });
  const scoped = learned({
    observation: "Spacing in the drawer",
    target: { file: "x", scope: ".cart-drawer" },
  });
  expect(
    matchEntry(
      scoped,
      problem({ groupKey: ".cart-drawer > button", problem: "x" }),
    )?.via,
  ).toBe("selector");
});

test("words: at least two shared content words and 60% of the observation's", () => {
  const entry = learned({
    observation: "The banner colours are off the token scale",
  });
  const match = matchEntry(
    entry,
    problem({
      category: "token-drift",
      rule: "idiom:token-drift",
      problem: "Banner colour is off the token scale.",
    }),
  );
  expect(match).toEqual({
    via: "words",
    detail: "banner, colour, off, token, scale",
  });
  // Plural and singular agree.
  expect(contentTokens("Buttons overlap")).toEqual(["button", "overlap"]);
});

test("words: one shared word, or under 60%, is not a match", () => {
  const one = learned({ observation: "Heavy price" });
  expect(
    matchEntry(one, problem({ category: "x", problem: "The price is fine" })),
  ).toBeUndefined();
  const thin = learned({
    observation: "Price total looks heavy and misaligned beside the coupon",
  });
  expect(
    matchEntry(
      thin,
      problem({
        category: "contrast",
        problem: "Total price text has contrast 3.1:1 against its background",
      }),
    ),
  ).toBeUndefined();
});

test("a different flow never matches", () => {
  const law = learned({
    kind: "law",
    observation: "Cramped buttons",
    target: { file: ".idiom/project.json", check: "control-gap" },
  });
  expect(matchEntry(law, { ...gap, flow: "account" })).toBeUndefined();
});

test("precedence: an entry matching by rule and words reports rule", () => {
  const law = learned({
    kind: "law",
    observation: "Buttons sit 2px apart; controls need gap",
    target: { file: ".idiom/project.json", check: "control-gap" },
  });
  expect(matchEntry(law, gap)?.via).toBe("rule");
});
