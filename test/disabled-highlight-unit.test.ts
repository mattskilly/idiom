import { expect, test } from "vitest";
import { disabledHighlightCheck } from "../src/checks/disabled-highlight.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { MenuRowSample, ProbeResult } from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const config = checksConfigFrom();
const clear = "rgba(0, 0, 0, 0)";
const ink = "rgb(34, 34, 34)";
const grey = "rgb(232, 232, 232)";

const sample = (
  selector: string,
  disabled: boolean,
  hoveredBackground: string,
  rest = clear,
): MenuRowSample => ({
  selector,
  disabled,
  rest: { backgroundColor: rest, color: ink },
  hovered: { backgroundColor: hoveredBackground, color: ink },
});

function edit(
  hover: MenuRowSample[] | undefined,
  overrides: Partial<ProbeResult> = {},
): ProbeResult {
  return {
    selector: "#edit",
    name: "Edit",
    effects: ["dom", "aria"],
    signature: "open:menu:Edit",
    persistent: true,
    menu: {
      trigger: { x: 24, y: 24, width: 40, height: 32 },
      group: "html > body:nth-of-type(1)",
      root: "#edit-menu",
      items: [
        { name: "Copy", disabled: false, selector: "#copy" },
        { name: "Paste", disabled: true, selector: "#paste" },
      ],
      ...(hover === undefined ? {} : { hover }),
    },
    ...overrides,
  };
}

const run = (results?: ProbeResult[]) =>
  disabledHighlightCheck.run({
    tuple: invariantTuple({
      ...invariantObservations(),
      ...(results === undefined
        ? {}
        : { probe: { status: "ran" as const, results } }),
    }),
    narrowViewport: false,
    config,
  });

test("a disabled row that takes the enabled highlight is reported", () => {
  const result = run([
    edit([sample("#paste", true, grey), sample("#copy", false, grey)]),
  ]);
  expect(result.coverage).toEqual({
    check: "disabled-highlight",
    status: "ran",
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    category: "disabled-highlight",
    severity: "minor",
    rule: "idiom:disabled-row-highlight",
    selectorHint: "#paste",
    fingerprintHint: "idiom:disabled-row-highlight|#edit-menu|#paste",
  });
  expect(result.candidates[0]?.explanation).toBe(
    `In the menu "Edit" opens (#edit-menu), the disabled row "Paste" (#paste) takes the same hover highlight as the enabled "Copy" row (background ${grey}), so it reads as available.`,
  );
});

test("a disabled row that does not change on hover is not reported", () => {
  expect(
    run([edit([sample("#paste", true, clear), sample("#copy", false, grey)])])
      .candidates,
  ).toEqual([]);
});

test("a disabled row with a highlight of its own is not reported", () => {
  expect(
    run([
      edit([
        sample("#paste", true, "rgb(245, 245, 245)"),
        sample("#copy", false, grey),
      ]),
    ]).candidates,
  ).toEqual([]);
});

test("no enabled reference, no sample, or a reused result reports nothing", () => {
  expect(run([edit([sample("#paste", true, grey)])]).candidates).toEqual([]);
  expect(run([edit(undefined)]).candidates).toEqual([]);
  expect(
    run([
      edit([sample("#paste", true, grey), sample("#copy", false, grey)], {
        reusedFrom: "earlier",
      }),
    ]).candidates,
  ).toEqual([]);
});

test("rgb and rgba spellings of one colour compare equal", () => {
  expect(
    run([
      edit([
        sample("#paste", true, "rgba(232, 232, 232, 1)"),
        sample("#copy", false, grey),
      ]),
    ]).candidates,
  ).toHaveLength(1);
});

test("is unavailable without the probe", () => {
  expect(run().coverage.status).toBe("unavailable");
});
