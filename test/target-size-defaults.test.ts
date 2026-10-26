import { expect, test } from "vitest";
import { checksConfigFrom } from "../src/checks/registry.js";
import { targetSizeCheck } from "../src/checks/target-size.js";
import type {
  CheckTuple,
  ObservationArtifact,
  ObservationArtifactV2,
  ObservedElement,
} from "../src/checks/types.js";
import { findingFingerprint } from "../src/review/fingerprint.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const styles: ObservedElement["styles"] = {
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  borderTopColor: "rgb(0, 0, 0)",
  borderRightColor: "rgb(0, 0, 0)",
  borderBottomColor: "rgb(0, 0, 0)",
  borderLeftColor: "rgb(0, 0, 0)",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  outlineStyle: "none",
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
};

function element(overrides: Partial<ObservedElement>): ObservedElement {
  return {
    selector: "button.action",
    tag: "button",
    text: "Action",
    visible: true,
    interactive: true,
    enabled: true,
    rect: { x: 0, y: 0, width: 44, height: 44 },
    scrollWidth: 44,
    scrollHeight: 44,
    clientWidth: 44,
    clientHeight: 44,
    outOfFlow: false,
    ancestorSelectors: [],
    styles,
    hitTestWith: [],
    ...overrides,
  };
}

function observations(elements: ObservedElement[] = []): ObservationArtifact {
  return {
    version: 1,
    viewport: { width: 320, height: 600 },
    document: {
      scrollWidth: 320,
      scrollHeight: 600,
      clientWidth: 320,
      clientHeight: 600,
    },
    elements,
    headings: [{ selector: "h1", level: 1, text: "Title" }],
    tokens: { status: "not-configured" },
  };
}

function tuple(overrides: Partial<CheckTuple> = {}): CheckTuple {
  return {
    flow: "booking",
    state: "ready",
    viewport: "phone",
    width: 320,
    height: 600,
    metadataPath: "ready/phone/metadata.json",
    artifactPaths: ["ready/phone/metadata.json"],
    commit: "abc123",
    createdAt: "2026-08-14T12:00:00.000Z",
    observations: observations(),
    axe: { violations: [] },
    console: [],
    mismatches: [],
    ...overrides,
  };
}
function targets(
  width: number,
  size = 30,
  options: {
    input?: ObservationArtifactV2["input"];
    narrowViewport?: boolean;
    settings?: { fine: number; coarse: number; narrowBelow: number };
  } = {},
) {
  const observation: ObservationArtifact = observations([
    element({ rect: { x: 0, y: 0, width: size, height: size } }),
  ]);
  const inputObservation =
    options.input === undefined
      ? observation
      : ({
          ...observation,
          version: 2,
          maskMembership: [],
          input: options.input,
        } as ObservationArtifactV2);
  return targetSizeCheck.run({
    tuple: tuple({
      width,
      viewport: width < 768 ? "mobile" : "desktop",
      observations: inputObservation,
    }),
    narrowViewport: options.narrowViewport ?? true,
    config: checksConfigFrom(
      checksConfigSchema.parse(
        options.settings === undefined ? {} : { targetSize: options.settings },
      ),
    ),
  }).candidates;
}

test("default desktop minimum is 24 even for the narrowest or only captured viewport", () => {
  expect(targets(1280)).toEqual([]);
  expect(targets(1280, 24)).toEqual([]);
  expect(targets(1280, 20, { narrowViewport: false })).toHaveLength(1);
  expect(targets(1280, 20)[0]?.explanation).toContain(
    "fine pointer, minimum 24",
  );
  expect(targets(1280, 20)[0]?.verification.params).toMatchObject({
    minimum: 24,
    inputClass: "fine",
  });
});

test("a recorded fine-pointer desktop input applies 24; a 390px viewport applies 44", () => {
  // The input a real desktop capture records (pointer fine, hover, no touch).
  const input = { pointer: "fine", hover: "hover", maxTouchPoints: 0 } as const;
  expect(targets(1440, 23, { input })[0]?.verification.params).toMatchObject({
    minimum: 24,
    inputClass: "fine",
  });
  expect(targets(1440, 24, { input })).toEqual([]);
  expect(targets(390, 43, { input })[0]?.verification.params).toMatchObject({
    minimum: 44,
    inputClass: "narrow",
  });
  expect(targets(390, 44, { input })).toEqual([]);
});

test("default narrow minimum is 44, with an exclusive 768px breakpoint", () => {
  expect(targets(390)[0]?.explanation).toContain(
    "narrower than 768px, minimum 44",
  );
  expect(targets(767)).toHaveLength(1);
  expect(targets(768)).toEqual([]);
});

test.each([
  { pointer: "coarse", hover: "hover", maxTouchPoints: 0 },
  { pointer: "fine", hover: "hover", maxTouchPoints: 1 },
  { pointer: "fine", hover: "none", maxTouchPoints: 0 },
] as const)("default desktop touch minimum is 44: %j", (input) => {
  expect(targets(1280, 30, { input })[0]?.explanation).toContain(
    "touch, minimum 44",
  );
});

test("configured fine, coarse and breakpoint override defaults", () => {
  const settings = { fine: 32, coarse: 48, narrowBelow: 600 };
  expect(targets(1280, 30, { settings })[0]?.verification.params).toMatchObject(
    { minimum: 32, inputClass: "fine" },
  );
  expect(targets(599, 47, { settings })[0]?.verification.params).toMatchObject({
    minimum: 48,
    inputClass: "narrow",
  });
  expect(targets(600, 32, { settings })).toEqual([]);
});

test("threshold changes preserve fingerprints and decision identity", () => {
  const fingerprint = (candidate: ReturnType<typeof targets>[number]) =>
    findingFingerprint({
      category: candidate.category,
      flow: "studio",
      state: "editor",
      rule: candidate.rule,
      selectorHint: candidate.selectorHint ?? "",
    });
  const defaults = targets(1280, 20)[0];
  const override = targets(1280, 20, {
    settings: { fine: 32, coarse: 48, narrowBelow: 600 },
  })[0];
  expect(defaults).toBeDefined();
  expect(override).toBeDefined();
  if (defaults && override)
    expect(fingerprint(defaults)).toBe(fingerprint(override));
});
