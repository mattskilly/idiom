import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import { shellVisibilityCheck } from "../src/checks/shell-visibility.js";
import type { Rect, ShellVisibilityObservation } from "../src/checks/types.js";
import { findingCategories } from "../src/schemas/finding.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const rect: Rect = { x: 0, y: 0, width: 800, height: 600 };
const measured = (): ShellVisibilityObservation => ({
  shell: {
    status: "measured",
    selector: ".shell",
    rect,
    client: rect,
    viewport: rect,
    scrollHeight: 600,
    clientHeight: 600,
    extending: [],
  },
  overlays: [],
});
function run(evidence?: ShellVisibilityObservation, selectors: string[] = []) {
  return shellVisibilityCheck.run({
    tuple: invariantTuple({
      ...invariantObservations(),
      ...(evidence ? { shellVisibility: evidence } : {}),
    }),
    narrowViewport: false,
    config: {
      ...checksConfigFrom(),
      shellVisibility: { floatingOverlays: selectors },
    },
  });
}

test("exact shell equality passes and a one-pixel or large excess yields one finding with culprit", () => {
  expect(run(measured()).candidates).toEqual([]);
  for (const excess of [1, 795]) {
    const evidence = measured();
    if (evidence.shell.status !== "measured") throw Error("fixture");
    evidence.shell.scrollHeight += excess;
    evidence.shell.extending = [
      { selector: "span.context", rect: { ...rect, y: 600, height: excess } },
    ];
    const result = run(evidence);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.explanation).toContain("span.context");
    expect(result.candidates[0]?.verification.params?.shell).toEqual(
      evidence.shell,
    );
  }
});

test("shell viewport escape is caught even when scrollHeight equals clientHeight", () => {
  const evidence = measured();
  if (evidence.shell.status !== "measured") throw Error("fixture");
  evidence.shell.rect = { ...rect, y: 1 };
  expect(run(evidence).candidates[0]?.explanation).toContain(
    "extends past viewport",
  );
  evidence.shell.rect = rect;
  evidence.shell.scrollHeight = 700;
  expect(run(evidence).candidates[0]?.explanation).toContain(
    "attribution unavailable",
  );
});

test.each(["missing", "ambiguous", "invalid"] as const)(
  "required %s shell declaration fails explicitly",
  (status) => {
    const result = run({
      shell: {
        status,
        selector: ".shell",
        count: status === "ambiguous" ? 2 : 0,
      },
      overlays: [],
    });
    expect(result.candidates[0]?.rule).toBe(
      "idiom:shell-visibility-declaration",
    );
    expect(result.candidates[0]?.explanation).toContain(status);
  },
);

function overlays(x = 50): ShellVisibilityObservation {
  const match = (selector: string, x: number) => ({
    selector,
    ancestors: ["body"],
    rect: { x, y: 0, width: 100, height: 40 },
    client: { x, y: 0, width: 100, height: 40 },
    visible: { x, y: 0, width: 100, height: 40 },
    rendered: true,
  });
  return {
    shell: { status: "not-configured" },
    overlays: [
      { selector: "#a", status: "measured", matches: [match("#a", 0)] },
      { selector: "#b", status: "measured", matches: [match("#b", x)] },
    ],
  };
}
test("overlay intersection and canonical identity are stable across declaration order; touching edges pass", () => {
  const a = run(overlays(50.25), ["#a", "#b"]),
    b = run(overlays(50.25), ["#b", "#a"]);
  expect(a.candidates).toEqual(b.candidates);
  expect(a.candidates).toHaveLength(1);
  expect(a.candidates[0]?.explanation).toContain("49.75×40px");
  expect(run(overlays(100), ["#a", "#b"]).candidates).toEqual([]);
});

test("same root, nested wrappers, and unrendered overlays are not peer collisions", () => {
  for (const mode of ["same", "nested", "hidden"]) {
    const evidence = overlays();
    const a = evidence.overlays[0]?.matches[0],
      b = evidence.overlays[1]?.matches[0];
    if (!a || !b) throw Error("fixture");
    if (mode === "same") b.selector = a.selector;
    if (mode === "nested") b.ancestors = [a.selector];
    if (mode === "hidden") b.rendered = false;
    expect(run(evidence, ["#a", "#b"]).candidates).toEqual([]);
  }
});

test("fresh unconfigured evidence skips; legacy and changed declarations request recapture", () => {
  expect(run().coverage.status).toBe("unavailable");
  expect(
    run({ shell: { status: "not-configured" }, overlays: [] }).coverage.status,
  ).toBe("skipped");
  const result = run(overlays(), ["#a", "#b", "#new"]);
  expect(result.coverage).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("#new"),
  });
  expect(result.candidates).toHaveLength(1);
  const evidence = overlays();
  evidence.overlays.push({ selector: "[", status: "invalid", matches: [] });
  expect(run(evidence, ["#a", "#b", "["]).coverage.reason).toContain(
    "invalid CSS selector",
  );
});

test("strict V2 artifact parsing preserves geometry, rejects malformed signals and accepts legacy evidence", () => {
  const observation = {
    ...invariantObservations(),
    shellVisibility: overlays(),
  };
  expect(
    observationArtifactSchema.parse(JSON.parse(JSON.stringify(observation))),
  ).toEqual(observation);
  expect(
    observationArtifactSchema.safeParse({
      ...observation,
      shellVisibility: { ...observation.shellVisibility, extra: true },
    }).success,
  ).toBe(false);
  const bad = structuredClone(observation);
  Object.assign(bad.shellVisibility.overlays[0]?.matches[0] ?? {}, {
    extra: true,
  });
  expect(observationArtifactSchema.safeParse(bad).success).toBe(false);
  const badGeometry = structuredClone(observation);
  Object.assign(
    badGeometry.shellVisibility.overlays[0]?.matches[0]?.rect ?? {},
    { height: -1 },
  );
  expect(observationArtifactSchema.safeParse(badGeometry).success).toBe(false);
  expect(
    observationArtifactSchema.safeParse(invariantObservations()).success,
  ).toBe(true);
  expect(findingCategories).toContain("shell-visibility");
});
