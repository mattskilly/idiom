import { expect, test } from "vitest";
import type { RepeatedContainerObservation } from "../src/checks/types.js";
import { renderCoverage } from "../src/commands/coverage.js";
import {
  computeEmptyContainerCoverage,
  type EmptyContainerCoverage,
  emptyContainerCoverageLines,
} from "../src/coverage/empty-containers.js";
import {
  type ReportCoverage,
  renderCoverageHtml,
  renderCoverageMarkdown,
} from "../src/report/coverage.js";
import { element, observation, tupleOf } from "./revealed-support.js";

const palette = (items: number): RepeatedContainerObservation => ({
  selector: "#palette",
  kind: "editor",
  name: "Palette",
  items,
});
const fonts = (items: number): RepeatedContainerObservation => ({
  selector: "#fonts",
  kind: "list",
  name: "",
  items,
});

const surface = (
  state: string,
  repeatedContainers: RepeatedContainerObservation[] | undefined,
) =>
  tupleOf(
    observation(
      [element("#a")],
      repeatedContainers === undefined ? {} : { repeatedContainers },
    ),
    state,
  );

test("a container empty in every captured state is listed with its states", () => {
  const coverage = computeEmptyContainerCoverage(
    [
      surface("empty", [palette(0), fonts(0)]),
      surface("filled", [palette(0), fonts(3)]),
      surface("filled.saved", [palette(0)]),
    ],
    { "filled.saved": "saved from filled" },
  );
  expect(coverage).toEqual({
    status: "ran",
    total: 2,
    populated: 1,
    alwaysEmpty: [
      {
        selector: "#palette",
        kind: "editor",
        name: "Palette",
        states: ["empty", "filled", "saved from filled"],
      },
    ],
  });
  expect(emptyContainerCoverageLines(coverage)).toEqual([
    "Repeated content: 1 of 2 containers showed items; empty in every captured state (seed data so the checks see them filled):",
    "- Palette (editor; empty in empty, filled, saved from filled)",
  ]);
});

test("a container populated in any state is not listed", () => {
  const coverage = computeEmptyContainerCoverage([
    surface("empty", [fonts(0)]),
    surface("many", [fonts(4)]),
  ]);
  expect(coverage).toMatchObject({ total: 1, populated: 1, alwaysEmpty: [] });
  expect(emptyContainerCoverageLines(coverage)).toEqual([
    "Repeated content: 1 of 1 containers showed items.",
  ]);
});

test("captures without the inventory, or without surfaces, are unavailable", () => {
  expect(
    computeEmptyContainerCoverage([
      surface("a", [fonts(0)]),
      surface("b", undefined),
    ]),
  ).toEqual({
    status: "unavailable",
    reason: "capture predates the container inventory; recapture",
  });
  expect(computeEmptyContainerCoverage([])).toEqual({
    status: "unavailable",
    reason: "no captured surfaces",
  });
  expect(
    emptyContainerCoverageLines({ status: "unavailable", reason: "x" }),
  ).toEqual(["Repeated content: unavailable (x)."]);
});

test("the list stops at ten and counts the rest; unnamed containers show their selector", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    ...fonts(0),
    selector: `#list-${index}`,
  }));
  const lines = emptyContainerCoverageLines(
    computeEmptyContainerCoverage([surface("empty", many)]),
  );
  expect(lines).toHaveLength(12);
  expect(lines[1]).toBe("- #list-0 (list; empty in empty)");
  expect(lines.at(-1)).toBe("- +2 more");
});

const ran: EmptyContainerCoverage = {
  status: "ran",
  total: 1,
  populated: 0,
  alwaysEmpty: [
    { selector: "#palette", kind: "editor", name: "Palette", states: ["a"] },
  ],
};

test("idiom coverage lists each flow's containers only ever seen empty", () => {
  const text = renderCoverage({
    routes: [],
    unresolvedStates: [],
    discoveredFrom: "test",
    excluded: [],
    disclosures: [],
    emptyContainers: [{ flow: "brand", coverage: ran }],
  });
  expect(text).toContain("Containers only ever seen empty:");
  expect(text).toContain(
    "brand: Repeated content: 0 of 1 containers showed items; empty in every captured state",
  );
  expect(text).toContain("- Palette (editor; empty in a)");
});

test("the report shows an Empty containers section only when it ran", () => {
  const base: ReportCoverage = {
    flow: "brand",
    purpose: "Declared review coverage",
    declaredStateCount: 1,
    states: ["a"],
    viewports: [{ name: "desktop", width: 1440, height: 900 }],
    colorSchemes: ["light"],
    selectedTuples: 1,
    successfulTuples: 1,
    commits: [],
    limitations: [],
  };
  const withSection = { ...base, emptyContainerCoverage: ran };
  expect(renderCoverageMarkdown(withSection)).toContain("### Empty containers");
  expect(renderCoverageMarkdown(withSection)).toContain(
    "Palette (editor; empty in a)",
  );
  expect(renderCoverageHtml(withSection)).toContain(
    "<h3>Empty containers</h3>",
  );
  expect(renderCoverageMarkdown(base)).not.toContain("Empty containers");
  expect(renderCoverageHtml(base)).not.toContain("Empty containers");
});
