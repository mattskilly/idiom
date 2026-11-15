import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { pressKey } from "../src/capture/web-steps.js";
import { initProject } from "../src/commands/init.js";
import {
  flowSchema,
  heldDragIssues,
  selectorImbalance,
  type WebStep,
  webStepSchema,
} from "../src/schemas/flow.js";
import { validateProject } from "../src/validation.js";

function flow(states: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "gestures",
    title: "Gestures",
    intent: [],
    setup: [],
    states,
    ...extra,
  };
}
const state = (id: string, steps: unknown[], more = {}) => ({
  id,
  description: id,
  url: "/",
  steps,
  expect: {},
  ...more,
});

/** Every issue of a web flow with these steps, as `path: message`. */
function issuesFor(steps: unknown[]): string[] {
  const result = flowSchema.safeParse(flow([state("s", steps)]));
  if (result.success) return [];
  return webIssues(result.error.issues);
}
function webIssues(
  issues: ReadonlyArray<{
    code: string;
    path: PropertyKey[];
    message: string;
    errors?: unknown;
  }>,
): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === "invalid_union") {
      const branches = (issue.errors as (typeof issues)[]).map(webIssues);
      // The web flow branch: the one that does not complain about `target`.
      const web = branches.find(
        (branch) => !branch.some((line) => line.startsWith("target")),
      );
      return (web ?? branches[0] ?? []).map((line) =>
        issue.path.length === 0 ? line : `${issue.path.join(".")}.${line}`,
      );
    }
    return [`${issue.path.join(".")}: ${issue.message}`];
  });
}

test("every documented gesture step parses", () => {
  const examples = [
    { action: "hover", selector: ".tile:nth-child(2)" },
    { action: "dblclick", selector: "[data-block=heading] h2" },
    { action: "dblclick", selector: "h2", modifiers: ["Alt"] },
    { action: "click", selector: "[data-block=image]", modifiers: ["Shift"] },
    {
      action: "click",
      selector: "[data-block=image]",
      modifiers: ["Meta", "Shift"],
      longRunning: true,
    },
    {
      action: "press",
      selector: "[data-block=button]",
      key: "ArrowUp",
      count: 18,
    },
    {
      action: "press",
      selector: "[data-block=button]",
      key: "ArrowLeft",
      count: 6,
      modifiers: ["Shift"],
    },
    {
      action: "drag",
      selector: "[data-block=image]",
      target: ".column:last-child",
      hold: true,
    },
    { action: "drag", selector: ".handle", offset: { x: 120, y: 0 } },
    { action: "hover", selector: 'text="Save (draft)"' },
    { action: "hover", selector: "[aria-label='a [b]']" },
    { action: "hover", selector: ".a\\[b" },
  ];
  for (const example of examples)
    expect(webStepSchema.parse(example)).toEqual(example);
});

test("existing step shapes parse exactly as before", () => {
  const cases: Array<[unknown, unknown]> = [
    [
      { action: "click", selector: " #new " },
      { action: "click", selector: "#new" },
    ],
    [
      { action: "press", selector: "#q", key: "ControlOrMeta+k" },
      { action: "press", selector: "#q", key: "ControlOrMeta+k" },
    ],
    [
      { action: "select", selector: "#t", label: "Basic" },
      { action: "select", selector: "#t", label: "Basic" },
    ],
    [
      { action: "waitFor", selector: "#x" },
      { action: "waitFor", selector: "#x", state: "visible" },
    ],
    [
      { expectVisible: { selector: "#x", within: "main" } },
      { action: "expectVisible", selector: "#x", within: "main" },
    ],
    // Existing selectors keep plain nonblank: no balance check.
    [
      { action: "click", selector: "[unclosed" },
      { action: "click", selector: "[unclosed" },
    ],
  ];
  for (const [input, parsed] of cases)
    expect(webStepSchema.parse(input)).toStrictEqual(parsed);
});

test("bad modifiers, counts, selectors and drags name the field and the fix", () => {
  const press = { action: "press", selector: "#b", key: "ArrowUp" };
  const expectations: Array<[unknown, string]> = [
    [
      { action: "click", selector: "#b", modifiers: ["Cmd"] },
      'states.0.steps.0.modifiers.0: use "Meta" for Cmd',
    ],
    [
      { action: "click", selector: "#b", modifiers: ["command"] },
      'states.0.steps.0.modifiers.0: use "Meta" for Cmd',
    ],
    [
      { action: "dblclick", selector: "#b", modifiers: ["Super"] },
      "states.0.steps.0.modifiers.0: must be one of Alt, Control, ControlOrMeta, Meta, Shift",
    ],
    [
      { ...press, modifiers: ["Shift", "Shift"] },
      'states.0.steps.0.modifiers.1: duplicate modifier "Shift"',
    ],
    [
      { ...press, modifiers: [] },
      "states.0.steps.0.modifiers: must list at least one modifier",
    ],
    [
      { ...press, count: 0 },
      "states.0.steps.0.count: must be a whole number from 1 to 200",
    ],
    [
      { ...press, count: 1.5 },
      "states.0.steps.0.count: must be a whole number from 1 to 200",
    ],
    [
      { ...press, count: 201 },
      "states.0.steps.0.count: must be a whole number from 1 to 200",
    ],
    [
      { ...press, count: "18" },
      "states.0.steps.0.count: must be a whole number from 1 to 200",
    ],
    [
      { ...press, key: "Shift+ArrowUp", modifiers: ["Alt"] },
      "states.0.steps.0.modifiers: put modifiers in either key or modifiers, not both",
    ],
    [
      { action: "hover", selector: "  " },
      "states.0.steps.0.selector: must be a nonblank selector",
    ],
    [
      { action: "hover", selector: "[data-block=button" },
      'states.0.steps.0.selector: is not a valid selector: unclosed or unmatched "["',
    ],
    [
      { action: "dblclick", selector: ".a:not(.b" },
      'states.0.steps.0.selector: is not a valid selector: unclosed or unmatched "("',
    ],
    [
      { action: "drag", selector: "[title='x]", offset: { x: 1, y: 0 } },
      `states.0.steps.0.selector: is not a valid selector: unclosed or unmatched "'"`,
    ],
    [
      { action: "drag", selector: ".h", target: ".zone)" },
      'states.0.steps.0.target: is not a valid selector: unclosed or unmatched ")"',
    ],
    [
      { action: "drag", selector: ".h" },
      "states.0.steps.0: must provide exactly one of target and offset",
    ],
    [
      { action: "drag", selector: ".h", target: ".z", offset: { x: 1, y: 1 } },
      "states.0.steps.0: must provide exactly one of target and offset",
    ],
    [
      { action: "drag", selector: ".h", offset: { x: 0, y: 0 } },
      "states.0.steps.0.offset: must move: x and y cannot both be 0",
    ],
    [
      { action: "drag", selector: ".h", offset: { x: 20000, y: 0 } },
      "states.0.steps.0.offset.x: must be within 10000 pixels",
    ],
  ];
  for (const [step, message] of expectations)
    expect(issuesFor([step]), JSON.stringify(step)).toContain(message);
});

test("keys without modifiers inside them combine with modifiers", () => {
  expect(
    issuesFor([
      { action: "press", selector: "#b", key: "+", modifiers: ["Shift"] },
      { action: "press", selector: "#b", key: "a", modifiers: ["Control"] },
    ]),
  ).toEqual([]);
});

test("the selector scan skips quoted and escaped characters", () => {
  expect(selectorImbalance("[title=']'] > a")).toBeUndefined();
  expect(selectorImbalance('text="("')).toBeUndefined();
  expect(selectorImbalance(".a\\(")).toBeUndefined();
  expect(selectorImbalance("div >> nth=0")).toBeUndefined();
  expect(selectorImbalance(":is(a, [b])")).toBeUndefined();
  expect(selectorImbalance("[a)")).toBe(")");
  expect(selectorImbalance('"open')).toBe('"');
});

test("press keys join their modifiers", () => {
  expect(
    pressKey({
      action: "press",
      selector: "#b",
      key: "ArrowUp",
      modifiers: ["Shift"],
    }),
  ).toBe("Shift+ArrowUp");
  expect(pressKey({ action: "press", selector: "#b", key: "Tab" })).toBe("Tab");
});

const held = {
  action: "drag",
  selector: ".h",
  target: ".z",
  hold: true,
} as const;
const readiness = [
  { action: "waitFor", selector: "#p" },
  { action: "expectText", text: "Moving" },
  { action: "expectVisible", selector: "#p" },
  { action: "expectUrl", path: "/" },
];

test("only readiness steps may follow a held drag", () => {
  expect(issuesFor([held, ...readiness])).toEqual([]);
  expect(
    issuesFor([
      held,
      { action: "waitFor", selector: "#p" },
      { action: "click", selector: "#x" },
      held,
    ]),
  ).toEqual([
    "states.0.steps.2: cannot follow a held drag (step 1); only waitFor, expectText, expectVisible and expectUrl may run while the pointer is held",
    "states.0.steps.3: cannot follow a held drag (step 1); only waitFor, expectText, expectVisible and expectUrl may run while the pointer is held",
  ]);
  // An unheld drag is an ordinary step.
  expect(
    issuesFor([
      { ...held, hold: false },
      { action: "click", selector: "#x" },
    ]),
  ).toEqual([]);
});

test("a state reached from a held drag may only wait and assert", () => {
  const result = flowSchema.safeParse(
    flow([
      state("dragging", [held]),
      { ...state("chained", [...readiness]), url: undefined, from: "dragging" },
      {
        ...state("grandchild", [{ action: "click", selector: "#x" }]),
        url: undefined,
        from: "chained",
      },
    ]),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(webIssues(result.error.issues)).toEqual([
    'states.2.steps.0: cannot follow the drag "dragging" holds; only waitFor, expectText, expectVisible and expectUrl may run while the pointer is held',
  ]);
});

test("toggles cannot hold a drag, nor combine with a state that holds one", () => {
  const toggles = {
    panel: {
      open: [{ action: "click", selector: "#open" }],
      dragged: [held],
    },
  };
  const result = flowSchema.safeParse(
    flow([state("dragging", [held]), state("resting", [])], { toggles }),
  );
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(webIssues(result.error.issues)).toEqual([
    "toggles.panel.dragged.0.hold: toggle options cannot hold a drag",
    'toggles: cannot combine with "dragging", which holds a drag; list other states in toggleStates',
  ]);
  expect(
    flowSchema.safeParse(
      flow([state("dragging", [held]), state("resting", [])], {
        toggles: { panel: { open: toggles.panel.open } },
        toggleStates: ["resting"],
      }),
    ).success,
  ).toBe(true);
});

test("heldDragIssues stops on from cycles and unknown ids", () => {
  const steps: WebStep[] = [{ action: "click", selector: "#x" }];
  expect(
    heldDragIssues({
      states: [
        { id: "a", from: "b", steps },
        { id: "b", from: "a", steps },
        { id: "c", from: "missing", steps },
      ],
    }),
  ).toEqual([]);
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("idiom validate renders gesture step messages at their exact path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-gestures-"));
  temporary.push(directory);
  await initProject({ project: directory, yes: true });
  const write = (steps: unknown[]) =>
    writeFile(
      join(directory, ".idiom", "flows", "gestures.json"),
      JSON.stringify(flow([state("s", steps)])),
    );
  await write([
    { action: "click", selector: "#a" },
    { action: "press", selector: "#a", key: "ArrowUp", count: 18 },
    { action: "click", selector: "#b", modifiers: ["Cmd"] },
  ]);
  await expect(
    validateProject({ project: directory, flow: "gestures" }),
  ).rejects.toThrow(
    '.idiom/flows/gestures.json: states[0].steps[2].modifiers[0]: use "Meta" for Cmd',
  );
  await write([{ action: "press", selector: "#a", key: "ArrowUp", count: 0 }]);
  await expect(
    validateProject({ project: directory, flow: "gestures" }),
  ).rejects.toThrow(
    ".idiom/flows/gestures.json: states[0].steps[0].count: must be a whole number from 1 to 200",
  );
  await write([held, { action: "fill", selector: "#a", value: "x" }]);
  await expect(
    validateProject({ project: directory, flow: "gestures" }),
  ).rejects.toThrow(
    ".idiom/flows/gestures.json: states[0].steps[1]: cannot follow a held drag (step 1)",
  );
  await write([{ action: "hover", selector: ".tile[" }]);
  await expect(
    validateProject({ project: directory, flow: "gestures" }),
  ).rejects.toThrow(
    '.idiom/flows/gestures.json: states[0].steps[0].selector: is not a valid selector: unclosed or unmatched "["',
  );
});
