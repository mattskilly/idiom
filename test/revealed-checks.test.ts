import { describe, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { elementOverlapCheck } from "../src/checks/element-overlap.js";
import { nativeControlCheck } from "../src/checks/native-control.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  ObservedElementV2,
  PopoverCoverObservation,
  ProbeResult,
  RevealedState,
} from "../src/checks/types.js";
import { element, observation, styles, tupleOf } from "./revealed-support.js";

const config = checksConfigFrom();
const run = (check: typeof nativeControlCheck, tuple: CheckTuple) =>
  check.run({ tuple, narrowViewport: false, config });

const native = (
  selector: string,
  type: "file" | "date" | "color" | "range",
  defaultStyled = true,
  overrides: Partial<Omit<ObservedElementV2, "signals">> = {},
) =>
  element(selector, {
    ...overrides,
    signals: { role: "textbox", nativeControl: { type, defaultStyled } },
  });

describe("idiom:native-control-unstyled", () => {
  const unstyled = (elements: ObservedElementV2[]) =>
    run(nativeControlCheck, tupleOf(observation(elements))).candidates.filter(
      (candidate) => candidate.rule === "idiom:native-control-unstyled",
    );

  test("a default file input is major; default date, color and range are minor", () => {
    const found = unstyled([
      native("#file", "file"),
      native("#date", "date"),
      native("#color", "color"),
      native("#range", "range"),
    ]);
    expect(
      found.map((candidate) => [candidate.selectorHint, candidate.severity]),
    ).toEqual([
      ["#file", "major"],
      ["#date", "minor"],
      ["#color", "minor"],
      ["#range", "minor"],
    ]);
    expect(found[0]?.explanation).toContain("Choose file");
  });

  test("styled, transparent, tiny, visually hidden and unpainted inputs are quiet", () => {
    expect(
      unstyled([
        native("#styled", "file", false),
        native("#transparent", "file", true, {
          styles: { ...styles, opacity: "0" },
        }),
        native("#tiny", "file", true, {
          rect: { x: 0, y: 0, width: 4, height: 4 },
        }),
        native("#sr", "date", true, {
          outOfFlow: true,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          styles: { ...styles, overflowX: "hidden", overflowY: "hidden" },
        }),
        native("#unpainted", "file", true, {
          painted: { value: false, reason: "css-hidden" },
        }),
      ]),
    ).toEqual([]);
  });

  test("native selects beside styled ones are still reported by the older rule", () => {
    const found = run(
      nativeControlCheck,
      tupleOf(
        observation([
          element("#native", { tag: "select", signals: { role: "combobox" } }),
          element("#custom", {
            tag: "button",
            attributes: { role: "combobox" },
            signals: { role: "combobox", haspopup: "listbox" },
          }),
        ]),
      ),
    ).candidates;
    expect(found.map((candidate) => candidate.rule)).toEqual([
      "idiom:native-control-beside-custom",
    ]);
  });
});

const cover = (
  extra: Partial<PopoverCoverObservation> = {},
): PopoverCoverObservation => ({
  overlay: "#menu",
  target: "#url",
  targetRole: "field",
  rect: { x: 0, y: 40, width: 200, height: 32 },
  samples: 9,
  hits: 9,
  partial: [],
  ...extra,
});

describe("idiom:popover-covers-control", () => {
  const popoverFindings = (
    popoverCovers: PopoverCoverObservation[] | undefined,
    elements = [element("#menu", { tag: "div" }), element("#url")],
  ) =>
    run(
      elementOverlapCheck,
      tupleOf(
        observation(
          elements,
          popoverCovers === undefined ? {} : { popoverCovers },
        ),
      ),
    ).candidates.filter(
      (candidate) => candidate.rule === "idiom:popover-covers-control",
    );

  test("a covered field is major; the trigger and geometry-only covers are minor", () => {
    const found = popoverFindings([
      cover(),
      cover({ target: "#attach", targetRole: "trigger" }),
      cover({ target: "#below", samples: 0, hits: 0 }),
    ]);
    expect(
      found.map((candidate) => [candidate.fingerprintHint, candidate.severity]),
    ).toEqual([
      ["#menu | #url", "major"],
      ["#menu | #attach", "minor"],
      ["#menu | #below", "minor"],
    ]);
    expect(found[2]?.explanation).toContain("geometry only");
  });

  test("an unpainted participant is gated and counted", () => {
    const result = elementOverlapCheck.run({
      tuple: tupleOf(
        observation(
          [
            element("#menu", { tag: "div" }),
            element("#url", {
              painted: { value: false, reason: "css-hidden" },
            }),
          ],
          { popoverCovers: [cover()] },
        ),
      ),
      narrowViewport: false,
      config,
    });
    expect(result.candidates).toEqual([]);
    expect(result.coverage.paintedSkipped).toMatchObject({
      "idiom:popover-covers-control": 1,
    });
  });

  test("captures without popover covers report nothing new", () => {
    expect(popoverFindings(undefined)).toEqual([]);
    expect(popoverFindings([])).toEqual([]);
  });
});

/** A revealed Attach menu: a default file input and a covered field. */
function revealedObservation(
  extra: Partial<ObservationArtifactV2> = {},
): ObservationArtifactV2 {
  return observation(
    [
      element("#attach", { tag: "button" }),
      element("#menu", { tag: "div", interactive: false }),
      native("#file", "file"),
      element("#url"),
    ],
    extra,
  );
}

function probed(
  base: ObservationArtifactV2,
  revealed: Array<Partial<RevealedState> & { name: string }>,
  extraResults: ProbeResult[] = [],
): CheckTuple {
  return tupleOf({
    ...base,
    probe: {
      status: "ran",
      results: [
        ...revealed.map(
          (state): ProbeResult => ({
            selector: "#attach",
            name: state.name,
            effects: ["dom", "aria"],
            persistent: false,
            status: "completed",
            revealed: {
              kind: "popup",
              trigger: "html > body:nth-of-type(1) > button:nth-of-type(1)",
              status: "observed",
              ...state,
            },
          }),
        ),
        ...extraResults,
      ],
    },
  });
}

const revealedOnly = (tuple: CheckTuple) =>
  runDeterministicChecks([tuple]).candidates.filter(
    ({ candidate }) => candidate.verification.params?.revealed !== undefined,
  );

describe("revealed-state checks", () => {
  test("revealed defects are attributed to the parent tuple as state › disclosure", () => {
    const tuple = probed(observation([element("#attach", { tag: "button" })]), [
      { name: "Attach", observations: revealedObservation() },
    ]);
    const found = revealedOnly(tuple);
    expect(found.map(({ candidate }) => candidate.rule)).toEqual([
      "idiom:native-control-unstyled",
    ]);
    const [entry] = found;
    expect(entry?.tuple).toBe(tuple);
    expect(entry?.candidate.explanation).toMatch(/^panel › Attach: #file/);
    expect(entry?.candidate.fingerprintHint).toBe("revealed Attach | #file");
    expect(entry?.candidate.verification.params?.revealed).toEqual({
      state: "panel",
      disclosure: "Attach",
      kind: "popup",
    });
  });

  test("a defect the page already had is not reported again for the reveal", () => {
    const tuple = probed(
      observation([
        element("#attach", { tag: "button" }),
        native("#file", "file"),
      ]),
      [{ name: "Attach", observations: revealedObservation() }],
    );
    expect(revealedOnly(tuple)).toEqual([]);
    expect(
      runDeterministicChecks([tuple]).candidates.filter(
        ({ candidate }) => candidate.rule === "idiom:native-control-unstyled",
      ),
    ).toHaveLength(1);
  });

  test("a mode switch reports only what its parent disclosure did not", () => {
    const tuple = probed(observation([element("#attach", { tag: "button" })]), [
      { name: "Attach", observations: revealedObservation() },
      {
        name: "Attach › Link",
        kind: "mode",
        observations: revealedObservation({ popoverCovers: [cover()] }),
      },
    ]);
    expect(
      revealedOnly(tuple).map(({ candidate }) => [
        candidate.rule,
        (
          candidate.verification.params?.revealed as
            | { disclosure?: string }
            | undefined
        )?.disclosure,
      ]),
    ).toEqual([
      ["idiom:native-control-unstyled", "Attach"],
      ["idiom:popover-covers-control", "Attach › Link"],
    ]);
  });

  test("unavailable and reused revealed states are not checked", () => {
    const tuple = probed(observation([element("#attach", { tag: "button" })]), [
      {
        name: "Attach",
        status: "unavailable",
        reason: "revealed-state limit (checks.probe.maxRevealed)",
      },
    ]);
    expect(revealedOnly(tuple)).toEqual([]);
    const reused = probed(
      observation([element("#attach", { tag: "button" })]),
      [],
    );
    if (reused.observations?.version !== 2 || !reused.observations.probe)
      throw new Error("fixture");
    reused.observations.probe.results.push({
      selector: "#attach",
      name: "Attach",
      effects: ["dom"],
      persistent: false,
      reusedFrom: "earlier",
      revealed: {
        name: "Attach",
        kind: "popup",
        trigger: "#attach",
        status: "observed",
        observations: revealedObservation(),
      },
    });
    expect(revealedOnly(reused)).toEqual([]);
  });

  test("the parent's own candidates and coverage are unchanged", () => {
    const base = observation([element("#attach", { tag: "button" })]);
    const plain = runDeterministicChecks([tupleOf(base)]);
    const withReveal = runDeterministicChecks([
      probed(base, [{ name: "Attach", observations: revealedObservation() }]),
    ]);
    expect(withReveal.coverage).toHaveLength(plain.coverage.length);
    expect(
      withReveal.candidates
        .filter(({ candidate }) => !candidate.verification.params?.revealed)
        .map(({ candidate }) => candidate.rule),
    ).toEqual(plain.candidates.map(({ candidate }) => candidate.rule));
  });
});

describe("artifact schema", () => {
  test("revealed states, disclosures, popover covers and native signals parse", () => {
    const tuple = probed(
      observation([native("#file", "file")], {
        disclosures: [
          {
            selector: "#attach",
            path: "html > body:nth-of-type(1) > button:nth-of-type(1)",
            id: "#attach",
            name: "Attach",
            kind: "popup",
            open: false,
          },
        ],
        popoverCovers: [cover()],
      }),
      [{ name: "Attach", observations: revealedObservation() }],
    );
    expect(
      observationArtifactSchema.safeParse(tuple.observations).success,
    ).toBe(true);
    expect(
      observationArtifactSchema.safeParse(observation([element("#a")])).success,
    ).toBe(true);
  });

  test("a revealed observation may not carry its own probe", () => {
    const tuple = probed(observation([]), [
      {
        name: "Attach",
        observations: {
          ...revealedObservation(),
          probe: { status: "ran", results: [] },
        },
      },
    ]);
    expect(
      observationArtifactSchema.safeParse(tuple.observations).success,
    ).toBe(false);
  });
});
