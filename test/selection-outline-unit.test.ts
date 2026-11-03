import { expect, test } from "vitest";
import { checksConfigFrom } from "../src/checks/registry.js";
import { selectionOutlineCheck } from "../src/checks/selection-outline.js";
import type {
  GeometryScan,
  SelectionOutlineObservation,
} from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const config = checksConfigFrom();
const record: SelectionOutlineObservation = {
  owner: "#block",
  ownerName: "Navigation block",
  ownerState: "selected",
  painter: "#frame",
  kind: "outline",
  ring: { x: 38, y: 38, width: 604, height: 68 },
  popover: "#menu",
  popoverRole: "listbox",
  popoverRect: { x: 140, y: 80, width: 200, height: 160 },
  crossing: { x: 144, y: 104, width: 192, height: 2 },
  stacking: "stack-order",
};
const run = (scan?: GeometryScan<SelectionOutlineObservation>) =>
  selectionOutlineCheck.run({
    tuple: invariantTuple({
      ...invariantObservations(),
      ...(scan === undefined ? {} : { selectionOutlines: scan }),
    }),
    narrowViewport: false,
    config,
  });

test("is unavailable in captures without the scan", () => {
  expect(run().coverage).toEqual({
    check: "selection-outline",
    status: "unavailable",
    reason: "selection outline evidence requires a recapture",
  });
});

test("reports one finding per frame and popover", () => {
  const result = run({
    status: "ran",
    records: [record, { ...record, kind: "box-shadow" }],
  });
  expect(result.coverage).toEqual({
    check: "selection-outline",
    status: "ran",
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    category: "selection-outline",
    severity: "major",
    rule: "idiom:selection-outline-crosses-popover",
    selectorHint: "#block",
    fingerprintHint: "idiom:selection-outline-crosses-popover|#block|#menu",
    explanation:
      "The selected outline of Navigation block (#block), drawn by #frame as outline, runs across the open listbox #menu for 192×2px at (144, 104) even though the listbox is above it.",
    acceptance: [
      "With #menu open, the selection outline of #block is hidden beneath it or clipped around it; no outline line crosses the listbox's content.",
    ],
  });
});

test("a partial scan still reports its records and names the gap", () => {
  const result = run({
    status: "partial",
    reason: "Stacking of the frame #frame is unknown",
    records: [record],
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.coverage).toEqual({
    check: "selection-outline",
    status: "unavailable",
    reason: "Stacking of the frame #frame is unknown",
  });
});
