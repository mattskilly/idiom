import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { dialogShellCheck } from "../src/checks/dialog-shell.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { selectedStateCheck } from "../src/checks/selected-state.js";
import { colorDelta } from "../src/checks/shared.js";
import type {
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const run = (observations: ObservationArtifactV2) =>
  [selectedStateCheck, dialogShellCheck].map((check) =>
    check.run({
      tuple: invariantTuple(observations),
      narrowViewport: false,
      config: checksConfigFrom(),
    }),
  );

test("artifacts without selection or dialog signals report unavailable coverage", () => {
  const [selection, dialog] = run(invariantObservations());
  expect(selection?.coverage).toEqual({
    check: "selected-state",
    status: "unavailable",
    reason: "observations predate selection-group signals (recapture)",
  });
  expect(dialog?.coverage).toEqual({
    check: "dialog-shell",
    status: "unavailable",
    reason: "observations predate dialog signals (recapture)",
  });
});

test("empty selection and dialog arrays mean the checks ran and found nothing", () => {
  const results = run({
    ...invariantObservations(),
    selectionGroups: [],
    dialogs: [],
  });
  expect(results).toEqual([
    { coverage: { check: "selected-state", status: "ran" }, candidates: [] },
    { coverage: { check: "dialog-shell", status: "ran" }, candidates: [] },
  ]);
});

test("colorDelta treats near-transparent colours as equal and alpha shifts as visible", () => {
  expect(colorDelta("rgba(0, 0, 0, 0)", "rgba(255, 255, 255, 0.04)")).toBe(0);
  expect(colorDelta("rgb(255, 255, 255)", "rgb(250, 250, 250)")).toBe(5);
  expect(
    colorDelta("rgba(45, 91, 255, 1)", "rgba(45, 91, 255, 0.8)"),
  ).toBeGreaterThanOrEqual(24);
  expect(colorDelta("rgb(0, 0, 0)", "rgb(0, 0, 0)")).toBe(0);
  expect(colorDelta("color(srgb 1 0 0)", "color(srgb 1 0 0)")).toBe(0);
  expect(colorDelta("color(srgb 1 0 0)", "rgb(255, 0, 0)")).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("the artifact schema accepts the new signals and rejects unknown member keys", () => {
  const observations = {
    ...invariantObservations(),
    selectionGroups: [
      {
        container: "#swatches",
        role: "radiogroup",
        memberRole: "radio",
        single: true,
        members: [
          {
            selector: "#a",
            control: "#a",
            selected: true,
            source: "aria-checked",
            nativeIndicator: false,
            decoration: { "self.bg": "rgb(0, 0, 0)", descendants: "0" },
          },
        ],
      },
    ],
    dialogs: [
      { selector: "#edit", modal: true, labelledBy: ["#t"], submit: [] },
    ],
  };
  expect(observationArtifactSchema.parse(observations)).toEqual(observations);
  const wrong = structuredClone(observations);
  Object.assign(wrong.selectionGroups[0]?.members[0] ?? {}, { extra: 1 });
  expect(observationArtifactSchema.safeParse(wrong).success).toBe(false);
  expect(
    observationArtifactSchema.safeParse(invariantObservations()).success,
  ).toBe(true);
});

// Only the display/state fields consumed by this check are needed here;
// full captured observations are schema-checked in the browser regressions.
const selectionObservation = (
  selected: boolean[],
  cue = "rgb(255, 255, 255)",
  source: "checked" | "aria-checked" = "checked",
): ObservationArtifactV2 => ({
  ...invariantObservations(),
  elements: selected.map(
    (_, index) =>
      ({
        selector: `#c${index}`,
        visible: true,
        outOfFlow: false,
        attributes: { [source]: "" },
      }) as ObservedElementV2,
  ),
  selectionGroups: [
    {
      container: "#checks",
      role: "group",
      memberRole: "checkbox",
      single: false,
      members: selected.map((value, index) => ({
        selector: `#c${index}`,
        control: `#c${index}`,
        selected: value,
        source,
        nativeIndicator: false,
        decoration: {
          "indicator0.self.bg": value ? cue : "rgb(255, 255, 255)",
        },
      })),
    },
  ],
});

test.each(["checked", "aria-checked"] as const)(
  "checkbox %s permits zero or multiple selection",
  (source) => {
    for (const selected of [
      [false, false],
      [true, true],
      [true, true, false],
    ]) {
      const result = run(
        selectionObservation(selected, "rgb(0, 0, 0)", source),
      )[0];
      expect(result?.candidates).toEqual([]);
    }
  },
);

test.each([
  { cue: "rgb(255, 255, 255)", invisible: true },
  { cue: "rgb(250, 250, 250)", invisible: true },
  { cue: "rgb(0, 0, 0)", invisible: false },
])(
  "supplemental indicator colour $cue respects the existing threshold and legacy fallback",
  ({ cue, invisible }) => {
    const observations = selectionObservation([true, false], cue);
    expect(run(observations)[0]?.candidates.map(({ rule }) => rule)).toEqual(
      invisible ? ["idiom:selected-state-invisible"] : [],
    );
    for (const member of observations.selectionGroups?.[0]?.members ?? [])
      member.paintedDecoration = { "indicator0.self.bg": "rgb(255, 255, 255)" };
    expect(run(observations)[0]?.candidates.map(({ rule }) => rule)).toEqual([
      "idiom:selected-state-invisible",
    ]);
  },
);
