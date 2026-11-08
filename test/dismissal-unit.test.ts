import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  focusReturnCheck,
  popoverDismissalCheck,
} from "../src/checks/dismissal.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  DismissalTest,
  ProbeDismissal,
  ProbeResult,
} from "../src/checks/types.js";
import { flowSchema } from "../src/schemas/flow.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const config = checksConfigFrom();

const closed: DismissalTest[] = [
  {
    method: "escape",
    outcome: "closed",
    focus: { returned: true, active: 'button#start "Start from…"' },
  },
  { method: "outside", outcome: "closed", point: { x: 700, y: 500 } },
  {
    method: "iframe",
    outcome: "closed",
    point: { x: 300, y: 400 },
    iframe: { selector: "html > body > main > iframe", name: "Canvas" },
  },
];

function start(
  tests: DismissalTest[],
  overrides: Partial<ProbeResult> = {},
  block: Partial<ProbeDismissal> = {},
): ProbeResult {
  return {
    selector: "#start",
    name: "Start from…",
    effects: ["dom", "aria"],
    persistent: true,
    dismissal: {
      trigger: "html > body > header > button",
      root: "#start-menu",
      kind: "popup",
      role: "menu",
      status: "tested",
      tests,
      ...block,
    },
    ...overrides,
  };
}

const observations = (results?: ProbeResult[], dismissal = true) => ({
  ...invariantObservations(),
  ...(results === undefined
    ? {}
    : {
        probe: {
          status: "ran" as const,
          results,
          ...(dismissal
            ? { dismissal: { tested: 1, notReached: 0, limit: 12 } }
            : {}),
        },
      }),
});

const run = (results?: ProbeResult[], dismissal = true) => {
  const context = {
    tuple: invariantTuple(observations(results, dismissal)),
    narrowViewport: false,
    config,
  };
  return {
    popover: popoverDismissalCheck.run(context),
    focus: focusReturnCheck.run(context),
  };
};

const replace = (
  method: DismissalTest["method"],
  test: Partial<DismissalTest>,
) =>
  closed.map((entry) =>
    entry.method === method ? { ...entry, ...test } : entry,
  );

test.each(["escape", "outside", "iframe"] as const)(
  "a panel that stays open after %s is reported once, as major",
  (method) => {
    const { popover } = run([
      start(replace(method, { outcome: "stayed-open", focus: undefined })),
    ]);
    expect(popover.coverage.status).toBe("ran");
    expect(popover.candidates).toHaveLength(1);
    expect(popover.candidates[0]?.rule).toBe("idiom:popover-not-dismissed");
    expect(popover.candidates[0]?.severity).toBe("major");
    expect(popover.candidates[0]?.selectorHint).toBe(
      "html > body > header > button",
    );
    if (method === "iframe")
      expect(popover.candidates[0]?.explanation).toContain(
        'the iframe "Canvas" (html > body > main > iframe)',
      );
  },
);

test("each method gets its own fingerprint", () => {
  const { popover } = run([
    start(
      closed.map((entry) => ({
        ...entry,
        outcome: "stayed-open",
        focus: undefined,
      })),
    ),
  ]);
  const fingerprints = popover.candidates.map(
    (candidate) => candidate.fingerprintHint,
  );
  expect(fingerprints).toHaveLength(3);
  expect(new Set(fingerprints).size).toBe(3);
});

test("a panel that closes on all three is not reported", () => {
  const { popover, focus } = run([start(closed)]);
  expect(popover.candidates).toEqual([]);
  expect(focus.candidates).toEqual([]);
});

test.each(["not-tested", "not-reached", "inconclusive"] as const)(
  "a %s test is not reported",
  (outcome) => {
    const { popover } = run([
      start(closed.map((entry) => ({ ...entry, outcome, focus: undefined }))),
    ]);
    expect(popover.candidates).toEqual([]);
  },
);

test("Escape that drops focus to the body is reported as minor, naming where focus went", () => {
  const { popover, focus } = run([
    start(replace("escape", { focus: { returned: false, active: "body" } })),
  ]);
  expect(popover.candidates).toEqual([]);
  expect(focus.candidates).toHaveLength(1);
  expect(focus.candidates[0]?.rule).toBe("idiom:focus-not-returned");
  expect(focus.candidates[0]?.severity).toBe("minor");
  expect(focus.candidates[0]?.explanation).toContain("to the page body");
});

test("reused and skipped results are ignored", () => {
  const stuck = closed.map((entry) => ({
    ...entry,
    outcome: "stayed-open" as const,
    focus: undefined,
  }));
  const { popover } = run([
    start(stuck, { reusedFrom: "home" }),
    start(stuck, { skipped: "destructive name" }),
  ]);
  expect(popover.candidates).toEqual([]);
});

test("a probe that did not test dismissal leaves both checks unavailable", () => {
  for (const results of [undefined, [start(closed)]]) {
    const { popover, focus } = run(results, false);
    expect(popover.coverage.status).toBe("unavailable");
    expect(focus.coverage.status).toBe("unavailable");
  }
});

test("dismissal blocks parse, and unknown keys are rejected", () => {
  const artifact = observations([
    start(replace("outside", { outcome: "stayed-open" })),
  ]);
  expect(() => observationArtifactSchema.parse(artifact)).not.toThrow();
  const extra = observations([
    start(closed, {}, { extra: true } as unknown as Partial<ProbeDismissal>),
  ]);
  expect(observationArtifactSchema.safeParse(extra).success).toBe(false);
  const extraTest = observations([
    start([{ ...closed[0], extra: true } as unknown as DismissalTest]),
  ]);
  expect(observationArtifactSchema.safeParse(extraTest).success).toBe(false);
});

test("a flow's explicitDismiss parses, and blank selectors are rejected", () => {
  const base = {
    id: "editor",
    title: "Editor",
    setup: [],
    intent: [],
    states: [{ id: "home", description: "Home", url: "/", expect: {} }],
  };
  expect(
    flowSchema.parse({ ...base, explicitDismiss: ["#confirm-dialog"] })
      .explicitDismiss,
  ).toEqual(["#confirm-dialog"]);
  expect(
    flowSchema.safeParse({ ...base, explicitDismiss: [" "] }).success,
  ).toBe(false);
});
