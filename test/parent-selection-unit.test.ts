import { expect, test } from "vitest";
import { parentSelectionCheck } from "../src/checks/parent-selection.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  ProbeArtifact,
  ProbeResult,
  SelectionTrial,
  SelectsAncestor,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const config = checksConfigFrom();
const block = (ancestor = "#nav-block"): SelectsAncestor => ({
  ancestor,
  ancestorName: "Navigation block",
  marker: "aria-selected",
  affordance: "button",
});
const click = (
  selector: string,
  name: string,
  extra: Partial<ProbeResult> = {},
): ProbeResult => ({
  selector,
  name,
  effects: ["dom", "aria"],
  persistent: true,
  status: "completed",
  selectsAncestor: block(),
  ...extra,
});
const trial = (
  selector: string,
  name: string,
  extra: Partial<SelectionTrial> = {},
): SelectionTrial => ({
  selector,
  name,
  affordance: "link",
  status: "completed",
  effects: ["dom", "aria"],
  selectsAncestor: { ...block(), affordance: "link" },
  ...extra,
});
const run = (probe?: ProbeArtifact) =>
  parentSelectionCheck.run({
    tuple: invariantTuple({
      ...invariantObservations(),
      ...(probe === undefined ? {} : { probe }),
    }),
    narrowViewport: false,
    config,
  });

test("is unavailable without the interaction probe", () => {
  expect(run().coverage).toMatchObject({ status: "unavailable" });
});

test("groups every click that selected the same ancestor into one finding", () => {
  const result = run({
    status: "ran",
    results: [
      click("#nav-cta", "Get started"),
      click("#skipped", "Skipped", { skipped: "not clickable: hidden" }),
      click("#tile", "Tile", { selectsAncestor: undefined }),
    ],
    selectionTrials: {
      status: "ran",
      limit: 12,
      candidates: 6,
      trials: [
        trial("#nav-home", "Home"),
        trial("#nav-pricing", "Pricing"),
        trial("#nav-docs", "Docs"),
        trial("#nav-blog", "Blog"),
        trial("#nav-timed", "Timed", { status: "timed-out" }),
        trial("#hero-link", "Hero", {
          selectsAncestor: {
            ...block("#hero"),
            ancestorName: "Hero block",
            affordance: "link",
          },
        }),
      ],
    },
  });
  expect(result.coverage).toEqual({ check: "parent-selection", status: "ran" });
  expect(
    result.candidates.map((candidate) => [
      candidate.rule,
      candidate.severity,
      candidate.selectorHint,
      candidate.fingerprintHint,
    ]),
  ).toEqual([
    [
      "idiom:control-selects-parent",
      "major",
      "#nav-cta",
      "idiom:control-selects-parent|#nav-block",
    ],
    [
      "idiom:control-selects-parent",
      "major",
      "#hero-link",
      "idiom:control-selects-parent|#hero",
    ],
  ]);
  expect(result.candidates[0]?.explanation).toBe(
    "Clicking “Get started” (#nav-cta), which looks like a button, selected its ancestor Navigation block (#nav-block, aria-selected) instead of the control itself; focus and selection did not move to “Get started”. Also: “Home”, “Pricing”, “Docs” and 1 more.",
  );
  expect(result.candidates[0]?.acceptance).toEqual([
    "Clicking “Get started” selects or activates “Get started” itself (or moves focus to its editor), not #nav-block.",
  ]);
  expect(result.candidates[1]?.explanation).toContain("looks like a link");
});

test("a pointer-only affordance reads as a clickable control", () => {
  const result = run({
    status: "ran",
    results: [
      click("#card", "", {
        selectsAncestor: { ...block(), affordance: "pointer" },
      }),
    ],
  });
  expect(result.candidates[0]?.explanation).toMatch(
    /^Clicking #card \(#card\), which looks like a clickable control,/,
  );
});

test("coverage names an incomplete probe or selection pass", () => {
  const result = run({
    status: "partial",
    reason: "controls not reached: state budget",
    results: [],
    selectionTrials: {
      status: "partial",
      reason: "#nav-home timed-out (selection)",
      limit: 12,
      candidates: 1,
      trials: [],
    },
  });
  expect(result.coverage).toEqual({
    check: "parent-selection",
    status: "ran",
    reason:
      "controls not reached: state budget; #nav-home timed-out (selection)",
  });
});
