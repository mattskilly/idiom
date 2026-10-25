import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { dialogShellCheck } from "../src/checks/dialog-shell.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { selectedStateCheck } from "../src/checks/selected-state.js";
import { colorDelta } from "../src/checks/shared.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
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
