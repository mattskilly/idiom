import { expect, test } from "vitest";
import type {
  DisclosureObservation,
  ProbeResult,
} from "../src/checks/types.js";
import {
  computeDisclosureCoverage,
  disclosureCoverageLines,
} from "../src/coverage/disclosures.js";
import { renderStateCoverage } from "../src/coverage/states.js";
import { element, observation, tupleOf } from "./revealed-support.js";

const attach: DisclosureObservation = {
  selector: "#attach",
  path: "html > body:nth-of-type(1) > button:nth-of-type(1)",
  id: "#attach",
  name: "Attach",
  kind: "popup",
  open: false,
};
const tips: DisclosureObservation = {
  selector: "body > details > summary",
  path: "html > body:nth-of-type(1) > details:nth-of-type(1) > summary:nth-of-type(1)",
  name: "Tips",
  kind: "details",
  open: false,
};
const filters: DisclosureObservation = {
  selector: "#filters",
  path: "html > body:nth-of-type(1) > button:nth-of-type(2)",
  id: "#filters",
  name: "Filters",
  kind: "expanded",
  open: false,
};

const click = (
  selector: string,
  extra: Partial<ProbeResult> = {},
): ProbeResult => ({
  selector,
  name: "",
  effects: ["dom"],
  persistent: false,
  status: "completed",
  ...extra,
});

const surface = (
  state: string,
  disclosures: DisclosureObservation[] | undefined,
  results?: ProbeResult[],
) =>
  tupleOf(
    observation([element("#a")], {
      ...(disclosures === undefined ? {} : { disclosures }),
      ...(results === undefined ? {} : { probe: { status: "ran", results } }),
    }),
    state,
  );

test("disclosures opened by id, by path, or shown open elsewhere count as opened", () => {
  const coverage = computeDisclosureCoverage([
    surface(
      "panel",
      [attach, tips, filters],
      [
        click("#attach"),
        click(tips.path),
        click("#filters", {
          status: "not-reached",
          effects: [],
          skipped: "not reached: flow budget share",
        }),
      ],
    ),
    surface("filtered", [{ ...filters, open: true }]),
  ]);
  expect(coverage).toEqual({
    status: "ran",
    total: 4,
    opened: 4,
    unopened: [],
  });
});

test("unopened disclosures say why", () => {
  const coverage = computeDisclosureCoverage(
    [
      surface(
        "panel",
        [attach, tips, filters],
        [
          click("#attach", {
            status: "not-reached",
            effects: [],
            skipped: "not reached: flow budget share",
          }),
          click("#filters", { status: "timed-out", effects: [] }),
        ],
      ),
      surface("empty", [attach]),
    ],
    { empty: "empty from panel" },
  );
  expect(coverage).toEqual({
    status: "ran",
    total: 4,
    opened: 0,
    unopened: [
      {
        state: "panel",
        name: "Attach",
        kind: "popup",
        selector: "#attach",
        reason: "not reached: flow budget share",
      },
      {
        state: "panel",
        name: "Tips",
        kind: "details",
        selector: tips.selector,
        reason: "no probe result for this control",
      },
      {
        state: "panel",
        name: "Filters",
        kind: "expanded",
        selector: "#filters",
        reason: "timed out",
      },
      {
        state: "empty",
        label: "empty from panel",
        name: "Attach",
        kind: "popup",
        selector: "#attach",
        reason: "the probe did not run at this state",
      },
    ],
  });
  expect(disclosureCoverageLines(coverage)).toEqual([
    "Disclosures: 0 of 4 opened; never opened:",
    "- panel › Attach (popup; not reached: flow budget share)",
    "- panel › Tips (details; no probe result for this control)",
    "- panel › Filters (expanded; timed out)",
    "- empty from panel › Attach (popup; the probe did not run at this state)",
  ]);
});

test("long lists are cut at ten with a count of the rest", () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    ...attach,
    id: `#d${index}`,
    selector: `#d${index}`,
    path: `${attach.path}:nth-of-type(${index})`,
    name: `Menu ${index}`,
  }));
  const lines = disclosureCoverageLines(
    computeDisclosureCoverage([surface("panel", many, [])]),
  );
  expect(lines).toHaveLength(12);
  expect(lines.at(-1)).toBe("- +2 more");
});

test("captures without the inventory are unavailable, not silently complete", () => {
  const coverage = computeDisclosureCoverage([
    surface("panel", [attach]),
    surface("older", undefined),
  ]);
  expect(coverage).toEqual({
    status: "unavailable",
    reason: "capture predates the disclosure inventory; recapture",
  });
  expect(disclosureCoverageLines(coverage)).toEqual([
    "Disclosures: unavailable (capture predates the disclosure inventory; recapture).",
  ]);
  expect(computeDisclosureCoverage([])).toEqual({
    status: "unavailable",
    reason: "no captured surfaces",
  });
});

test("the state coverage table prints the disclosure lines", () => {
  const text = renderStateCoverage({
    flows: [
      {
        flow: "assistant",
        captured: true,
        states: [],
        data: [],
        missing: [],
        observed: 0,
        applicable: 0,
        notApplicable: 0,
        percent: null,
        disclosures: computeDisclosureCoverage([
          surface("panel", [attach], []),
        ]),
      },
    ],
  });
  expect(text).toContain(
    "Disclosures: 0 of 1 opened; never opened:\n- panel › Attach (popup; no probe result for this control)",
  );
});
