import { expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { duplicateEntryCheck } from "../src/checks/duplicate-entry.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { ProbeResult } from "../src/checks/types.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";

const config = checksConfigFrom();
const items = (...names: string[]) =>
  names.map((name, index) => ({
    name,
    disabled: false,
    selector: `#item-${index}`,
  }));

function trigger(
  selector: string,
  x: number,
  overrides: Partial<ProbeResult> & {
    y?: number;
    group?: string;
    names?: string[];
  } = {},
): ProbeResult {
  const { y = 100, group = "#toolbar", names, ...rest } = overrides;
  return {
    selector,
    name: selector.slice(1),
    effects: ["dom", "aria"],
    signature: "open:menu:Block actions",
    persistent: true,
    primary: true,
    region: 'toolbar "Block"',
    menu: {
      trigger: { x, y, width: 32, height: 32 },
      group,
      root: "#block-menu",
      items: items(...(names ?? ["Cut", "Copy", "Paste"])),
    },
    ...rest,
  };
}

const observations = (results: ProbeResult[]) => ({
  ...invariantObservations(),
  probe: { status: "ran" as const, results },
});
const run = (results: ProbeResult[]) =>
  duplicateEntryCheck.run({
    tuple: invariantTuple(observations(results)),
    narrowViewport: false,
    config,
  }).candidates;

test("adjacent triggers that open identical menus are one finding", () => {
  const candidates = run([trigger("#grip", 24), trigger("#more", 60)]);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    category: "duplicate-entry",
    severity: "minor",
    rule: "idiom:redundant-entry-point",
    selectorHint: "#grip",
    fingerprintHint: "idiom:redundant-entry-point|menu|#grip,#more",
    acceptance: [
      "One trigger opens this menu, or the second trigger is recorded as deliberate.",
    ],
    verification: {
      check: "duplicate-entry",
      params: { menu: ["Cut", "Copy", "Paste"], members: ["#grip", "#more"] },
    },
  });
  expect(candidates[0]?.explanation).toContain("Cut, Copy, Paste");
  expect(candidates[0]?.explanation).toContain('toolbar "Block"');
});

test("triggers 40px apart are not reported", () => {
  expect(run([trigger("#grip", 24), trigger("#more", 96)])).toEqual([]);
});

test("adjacent triggers in different regions are not reported", () => {
  expect(
    run([trigger("#grip", 24), trigger("#more", 60, { region: "main" })]),
  ).toEqual([]);
});

test("triggers 8px apart in different rows and groups are not reported", () => {
  expect(
    run([
      trigger("#grip", 24),
      trigger("#more", 64, { y: 140, group: "#other" }),
    ]),
  ).toEqual([]);
});

test("stacked triggers in one column count as adjacent without a shared group", () => {
  expect(
    run([trigger("#grip", 24), trigger("#more", 24, { y: 136, group: "#b" })]),
  ).toHaveLength(1);
});

test("identical items in a different order are not reported", () => {
  expect(
    run([
      trigger("#grip", 24),
      trigger("#more", 60, { names: ["Copy", "Cut", "Paste"] }),
    ]),
  ).toEqual([]);
});

test("a disabled flag does not change the item list", () => {
  const more = trigger("#more", 60);
  const paste = more.menu?.items[2];
  if (paste) paste.disabled = true;
  expect(run([trigger("#grip", 24), more])).toHaveLength(1);
});

test("three adjacent triggers form one cluster", () => {
  const candidates = run([
    trigger("#a", 0),
    trigger("#b", 36),
    trigger("#c", 72),
  ]);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.explanation).toContain("3 controls");
  expect(candidates[0]?.fingerprintHint).toBe(
    "idiom:redundant-entry-point|menu|#a,#b,#c",
  );
});

test("repeated, skipped and one-item triggers are not compared", () => {
  expect(
    run([trigger("#grip", 24), trigger("#more", 60, { repeated: true })]),
  ).toEqual([]);
  expect(
    run([trigger("#grip", 24), trigger("#more", 60, { skipped: "timed out" })]),
  ).toEqual([]);
  expect(
    run([
      trigger("#grip", 24, { names: ["Cut"] }),
      trigger("#more", 60, { names: ["Cut"] }),
    ]),
  ).toEqual([]);
});

test("the same trigger reused in a later state is one control", () => {
  expect(
    run([trigger("#grip", 24), trigger("#grip", 24, { reusedFrom: "s1" })]),
  ).toEqual([]);
});

test("artifacts without menu keep the signature grouping only", () => {
  const legacy = (selector: string): ProbeResult => {
    const { menu: _menu, ...rest } = trigger(selector, 0);
    return { ...rest, signature: "open:dialog:Settings" };
  };
  const candidates = run([legacy("#a"), legacy("#b")]);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.fingerprintHint).toBeUndefined();
  expect(
    run([
      { ...legacy("#a"), signature: "open:menu:Block actions" },
      { ...legacy("#b"), signature: "open:menu:Block actions" },
    ]),
  ).toEqual([]);
});

test("the artifact schema accepts menu and rejects unknown keys in it", () => {
  const artifact = observations([trigger("#grip", 24), trigger("#more", 60)]);
  const withHover = {
    ...artifact,
    probe: {
      ...artifact.probe,
      results: artifact.probe.results.map((result) => ({
        ...result,
        menu: {
          ...result.menu,
          hover: [
            {
              selector: "#item-2",
              disabled: true,
              rest: {
                backgroundColor: "rgba(0, 0, 0, 0)",
                color: "rgb(0, 0, 0)",
              },
              hovered: {
                backgroundColor: "rgb(232, 232, 232)",
                color: "rgb(0, 0, 0)",
              },
            },
          ],
        },
      })),
    },
  };
  expect(observationArtifactSchema.safeParse(withHover).success).toBe(true);
  const extra = {
    ...artifact,
    probe: {
      ...artifact.probe,
      results: artifact.probe.results.map((result) => ({
        ...result,
        menu: { ...result.menu, extra: true },
      })),
    },
  };
  expect(observationArtifactSchema.safeParse(extra).success).toBe(false);
});
