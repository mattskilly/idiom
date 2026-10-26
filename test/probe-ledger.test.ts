import { expect, test } from "vitest";
import {
  controlIdentity,
  createProbeLedger,
  identityKeys,
  ORDINARY_PRIORITY,
} from "../src/capture/probe-ledger.js";
import type { ProbeResult } from "../src/checks/types.js";

const parts = {
  role: "button",
  name: "Page settings",
  region: 'toolbar "Editor"',
  signature: "button.icon>div.tools",
};
const result = (overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  selector: "html > body:nth-of-type(1) > button:nth-of-type(1)",
  name: "Page settings",
  effects: ["dom"],
  persistent: true,
  status: "completed",
  ...overrides,
});

test("identity ignores the positional path and keeps role, name, region and signature", () => {
  const key = controlIdentity(parts);
  // The same control at a different nth-of-type path has the same identity.
  expect(controlIdentity({ ...parts })).toBe(key);
  for (const change of [
    { role: "menuitem" },
    { name: "Settings" },
    { region: "banner" },
    { signature: "button.icon>div.panel" },
  ])
    expect(controlIdentity({ ...parts, ...change })).not.toBe(key);
  expect(controlIdentity({ ...parts, region: undefined })).toBe(
    "button|Page settings||button.icon>div.tools",
  );
});

test("ordinals separate repeats inside one enumeration", () => {
  const keys = identityKeys([parts, parts, { ...parts, name: "Other" }, parts]);
  const base = controlIdentity(parts);
  expect(keys).toEqual([
    base,
    `${base}#2`,
    controlIdentity({ ...parts, name: "Other" }),
    `${base}#3`,
  ]);
});

test("the ledger records only completed results, per partition", () => {
  const ledger = createProbeLedger();
  const key = controlIdentity(parts);
  ledger.record(
    "desktop\0light",
    key,
    "a",
    result({ status: "timed-out" }),
    [],
  );
  ledger.record(
    "desktop\0light",
    key,
    "a",
    result({ status: "not-reached" }),
    [],
  );
  expect(ledger.lookup("desktop\0light", key)).toBeUndefined();
  ledger.record("desktop\0light", key, "a", result(), []);
  expect(ledger.lookup("desktop\0light", key)).toMatchObject({
    state: "a",
    result: { effects: ["dom"] },
  });
  // The first completed result wins; a copy is stored, not the original.
  const later = result({ effects: ["navigation"] });
  ledger.record("desktop\0light", key, "b", later, []);
  expect(ledger.lookup("desktop\0light", key)?.state).toBe("a");
  later.effects.push("dom");
  expect(ledger.lookup("desktop\0light", key)?.result.effects).toEqual(["dom"]);
  // Other viewports and schemes are separate partitions.
  expect(ledger.lookup("mobile\0light", key)).toBeUndefined();
  expect(ledger.lookup("desktop\0dark", key)).toBeUndefined();
});

test("enumeratedBefore names identities an earlier state saw first", () => {
  const ledger = createProbeLedger();
  ledger.seen("p", ["one", "two"], "a");
  ledger.seen("p", ["two", "three"], "b");
  expect(ledger.enumeratedBefore("p", "one", "a")).toBe(false);
  expect(ledger.enumeratedBefore("p", "two", "b")).toBe(true);
  expect(ledger.enumeratedBefore("p", "three", "b")).toBe(false);
  expect(ledger.enumeratedBefore("q", "two", "b")).toBe(false);
});

test("flow allocation balances shared work, avoids modals and samples repeated rows", () => {
  const ledger = createProbeLedger();
  const candidate = (name: string, extra: object = {}) => ({
    path: `#${name}`,
    selector: `#${name}`,
    name,
    role: "button",
    signature: `#${name}`,
    repeated: false,
    ...extra,
  });
  const shared = [
    candidate("shared1"),
    candidate("shared2"),
    candidate("shared3"),
  ];
  const rows = ["r1", "r2", "r3", "r4"].map((name) =>
    candidate(name, { repeated: true, repeatedGroup: "swatches" }),
  );
  ledger.plan("p", [
    {
      state: "modal",
      candidates: shared.map((item) => ({
        ...item,
        unavailable: "blocked by modal",
      })),
    },
    { state: "a", candidates: [...shared, ...rows, candidate("own")] },
    { state: "b", candidates: shared },
  ]);
  const key = (name: string) =>
    controlIdentity({ role: "button", name, signature: `#${name}` });
  expect(ledger.allocation("p", key("own"))).toEqual({ own: true, state: "a" });
  expect(
    shared.map((item) => ledger.allocation("p", key(item.name))?.state),
  ).toEqual(["b", "b", "b"]);
  expect(ledger.allocation("p", key("r3"))).toEqual({
    own: true,
    reason: "repeated-row sample",
  });
  expect(ledger.assignedCount("p", "modal")).toBe(0);
  expect(ledger.assignedCount("p", "a")).toBe(3);
  expect(ledger.assignedCount("p", "b")).toBe(3);
  expect(ledger.planned("other")).toBe(false);
});

test("repeated groups sample their first saved rows before balancing unique work", () => {
  const ledger = createProbeLedger();
  const rows = ["first", "second", "third"].map((name) => ({
    path: `#${name}`,
    selector: `#${name}`,
    name,
    role: "button",
    signature: `#${name}`,
    repeated: true,
    repeatedGroup: "rows",
  }));
  ledger.plan("p", [
    { state: "a", candidates: rows },
    { state: "b", candidates: rows.slice(0, 2) },
  ]);
  const allocations = rows.map((candidate) =>
    ledger.allocation("p", controlIdentity({ ...candidate })),
  );
  expect(allocations[0]?.state).toBeDefined();
  expect(allocations[1]?.state).toBeDefined();
  expect(allocations[2]?.reason).toBe("repeated-row sample");
});

test("priority uses other surfaces and text actions, and modal preference precedes load", () => {
  const ledger = createProbeLedger();
  const action = (name: string, signature: string, extra: object = {}) => ({
    path: signature,
    selector: signature,
    name,
    role: "button",
    signature,
    repeated: false,
    textLabel: true,
    ...extra,
  });
  const shared = action("Shared", "#shared");
  const settings = action("Settings", "#settings", { region: "navigation" });
  ledger.plan("p", [
    { state: "plain", candidates: [shared, settings, action("Own", "#own")] },
    {
      state: "modal",
      candidates: [
        { ...shared, modal: true },
        action("Settings", "#other", { region: "menu" }),
      ],
    },
  ]);
  expect(ledger.allocation("p", controlIdentity(shared))?.state).toBe("plain");
  expect(ledger.priority("p", settings)).toBe(0);
  expect(ledger.priority("p", shared)).toBe(2);
  expect(
    ledger.priority("p", action("?", "#glyph", { textLabel: false })),
  ).toBe(1);
  expect(
    ledger.priority("p", action("Row", "#row", { repeatedGroup: "rows" })),
  ).toBe(5);
  expect(
    ledger.priority("p", action("Save", "#submit", { submit: true })),
  ).toBe(ORDINARY_PRIORITY);
  expect(
    ledger.priority(
      "p",
      action("Radio", "#radio", { role: "menuitemradio", region: "menu" }),
    ),
  ).toBe(ORDINARY_PRIORITY);
  ledger.registerNames("p", [action("Shared", "#elsewhere")]);
  expect(ledger.priority("p", shared)).toBe(0);
});

test("steal requeues unfinished work onto another state that shows it, then closes with a final reason", () => {
  const ledger = createProbeLedger();
  const shared = {
    path: "#shared",
    selector: "#shared",
    name: "Shared",
    role: "button",
    signature: "#shared",
    repeated: false,
  };
  const key = controlIdentity(shared);
  ledger.plan("p", [
    { state: "a", candidates: [shared] },
    { state: "b", candidates: [shared] },
  ]);
  const first = ledger.allocation("p", key)?.state;
  const other = first === "a" ? "b" : "a";
  expect(ledger.pending("p", key)).toBe(true);
  // Never attempted: the other state takes it next round.
  expect(ledger.steal("p", new Set(["a", "b"]))).toBe(1);
  expect(ledger.allocation("p", key)?.state).toBe(other);
  expect(ledger.assignedCount("p", other)).toBe(1);
  // Attempted there without finishing: the first state gets one more turn.
  ledger.attempt("p", key, other);
  expect(ledger.steal("p", new Set(["a", "b"]))).toBe(1);
  expect(ledger.allocation("p", key)?.state).toBe(first);
  // Offered twice and still unfinished: nothing left to run it.
  expect(ledger.steal("p", new Set(["a", "b"]))).toBe(0);
  expect(ledger.pending("p", key)).toBe(false);
  expect(ledger.finalReason("p", key)).toMatch(
    /^not completed in any state that shows it \(tried /,
  );
});

test("a timed-out control is final, and starved nested items gain later results", () => {
  const ledger = createProbeLedger();
  const control = (name: string) => ({
    path: `#${name}`,
    selector: `#${name}`,
    name,
    role: "button",
    signature: `#${name}`,
    repeated: false,
  });
  const slow = control("Slow");
  const menu = control("Menu");
  ledger.plan("p", [
    { state: "a", candidates: [slow, menu] },
    { state: "b", candidates: [slow, menu] },
  ]);
  const done: ProbeResult = {
    selector: "#menu",
    name: "Menu",
    persistent: true,
    effects: ["dom"],
    status: "completed",
  };
  const item = (name: string): ProbeResult => ({
    ...done,
    selector: `#${name}`,
    name: `Menu › ${name}`,
  });
  ledger.attempt("p", controlIdentity(slow), "a");
  ledger.fail("p", controlIdentity(slow), "a");
  ledger.attempt("p", controlIdentity(menu), "a");
  ledger.record("p", controlIdentity(menu), "a", done, [], [item("One")], true);
  expect(ledger.steal("p", new Set(["a", "b"]))).toBe(1);
  expect(ledger.allocation("p", controlIdentity(menu))?.state).toBe("b");
  ledger.record(
    "p",
    controlIdentity(menu),
    "b",
    { ...done, selector: "#menu-b" },
    [],
    [{ ...item("One"), reusedFrom: "a" }, item("Two")],
    false,
  );
  const entry = ledger.lookup("p", controlIdentity(menu));
  expect(entry?.state).toBe("a");
  expect(entry?.starved).toBe(false);
  expect(entry?.nested?.map((row) => [row.name, row.reusedFrom])).toEqual([
    ["Menu › One", undefined],
    ["Menu › Two", "b"],
  ]);
  expect(ledger.steal("p", new Set(["a", "b"]))).toBe(0);
  ledger.exhaust("p", "flow probe time exhausted");
  expect(ledger.finalReason("p", controlIdentity(slow))).toBe(
    "timed out at state a",
  );
  expect(ledger.finalReason("p", controlIdentity(menu))).toBeUndefined();
});

test("flow shares give singleton check work more weight than long repeated lists", () => {
  const ledger = createProbeLedger();
  const candidates = Array.from({ length: 52 }, (_, i) => ({
    path: `#action-${i}`,
    selector: `#action-${i}`,
    signature: `#action-${i}`,
    name: `Action ${i}`,
    role: "button",
    textLabel: true,
    repeated: i >= 2,
    ...(i >= 2 ? { repeatedGroup: "list" } : {}),
  }));
  ledger.plan("p", [{ state: "a", candidates }]);
  expect(ledger.assignedCount("p", "a")).toBe(52);
  expect(ledger.assignedWeight("p", "a")).toBe(7);
  expect(ledger.assignedWeight("p", "other")).toBe(0);
  expect(ledger.assignedWeight("other", "a")).toBe(0);
});

test("a declared popup trigger ranks with the glyphs, ahead of plain actions", () => {
  const ledger = createProbeLedger();
  const button = (name: string, extra: Record<string, unknown> = {}) => ({
    path: `#${name}`,
    selector: `#${name}`,
    signature: `#${name}`,
    name,
    role: "button",
    textLabel: true,
    repeated: false,
    ...extra,
  });
  expect(ledger.priority("p", button("save"))).toBe(2);
  expect(ledger.priority("p", button("workspace", { popup: true }))).toBe(1);
  expect(
    ledger.priority("p", button("rows", { popup: true, repeatedGroup: "g" })),
  ).toBe(4);
});
