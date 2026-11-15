import { posix, win32 } from "node:path";
import { z } from "zod";
import { designDeclarationSchema } from "./design.js";
import { invariantSchema } from "./invariant.js";
import { colorSchemeSchema } from "./project.js";
import { referenceNameSchema } from "./reference.js";

function countCapturingGroups(pattern: string): number {
  let count = 0;
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[" && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (character !== "(" || inCharacterClass) continue;

    if (pattern[index + 1] !== "?") {
      count += 1;
      continue;
    }

    // Named groups capture; lookarounds and all other (?...) forms do not.
    if (
      pattern[index + 2] === "<" &&
      !["=", "!"].includes(pattern[index + 3] ?? "")
    ) {
      count += 1;
    }
  }
  return count;
}

const patternSchema = z.string().superRefine((pattern, context) => {
  try {
    new RegExp(pattern);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: `must be a valid JavaScript regular expression: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const groups = countCapturingGroups(pattern);
  if (groups !== 1) {
    context.addIssue({
      code: "custom",
      message: `must contain exactly one capturing group (found ${groups})`,
    });
  }
});

const setupSchema = z
  .object({
    run: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    captureStdout: z.boolean().default(false),
  })
  .strict();

const urlFromSchema = z
  .object({
    source: z.literal("setup-stdout"),
    pattern: patternSchema,
    append: z.string().optional(),
  })
  .strict();

const sharedExpectationSchema = z
  .object({
    textPresent: z.array(z.string()).default([]),
    selectorPresent: z.array(z.string()).default([]),
    selectorAbsent: z.array(z.string()).default([]),
  })
  .strict();

const nonblank = z.string().trim().min(1);
const regexpSchema = nonblank.superRefine((source, context) => {
  try {
    new RegExp(source);
  } catch {
    context.addIssue({
      code: "custom",
      message: "must be a valid JavaScript regular expression",
    });
  }
});

export const projectLogPathSchema = nonblank.refine((path) => {
  const portable = path.replaceAll("\\", "/");
  const normalized = posix.normalize(portable);
  return (
    !posix.isAbsolute(portable) &&
    !win32.isAbsolute(path) &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}, "must be a project-relative path that does not escape the project");

const allowSchema = z
  .object({
    urls: z.array(regexpSchema).default([]),
    console: z.array(regexpSchema).default([]),
  })
  .strict();
const stateHealthSchema = z
  .object({ allow: allowSchema.prefault({}) })
  .strict();
const flowHealthSchema = stateHealthSchema.extend({
  serverLog: projectLogPathSchema.optional(),
  serverErrorPatterns: z.array(regexpSchema).optional(),
});

/** Playwright's modifier names; a flow step's `modifiers` lists these. */
export const modifierNames = [
  "Alt",
  "Control",
  "ControlOrMeta",
  "Meta",
  "Shift",
] as const;
const modifiersSchema = z
  .array(z.string())
  .superRefine((modifiers, context) => {
    if (modifiers.length === 0) {
      context.addIssue({
        code: "custom",
        message: "must list at least one modifier",
      });
      return;
    }
    const seen = new Set<string>();
    for (const [index, modifier] of modifiers.entries()) {
      if (/^(?:cmd|command)$/i.test(modifier))
        context.addIssue({
          code: "custom",
          path: [index],
          message: 'use "Meta" for Cmd',
        });
      else if (!modifierNames.some((name) => name === modifier))
        context.addIssue({
          code: "custom",
          path: [index],
          message: `must be one of ${modifierNames.join(", ")}`,
        });
      else if (seen.has(modifier))
        context.addIssue({
          code: "custom",
          path: [index],
          message: `duplicate modifier ${JSON.stringify(modifier)}`,
        });
      seen.add(modifier);
    }
  })
  .transform((modifiers) => modifiers as Array<(typeof modifierNames)[number]>);

/** The first unbalanced bracket, parenthesis or quote in a selector. */
export function selectorImbalance(selector: string): string | undefined {
  const closers: Record<string, string> = { "[": "]", "(": ")" };
  const open: string[] = [];
  let quote: string | undefined;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] as string;
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character in closers) open.push(character);
    else if (character === "]" || character === ")") {
      const last = open.pop();
      if (last === undefined || closers[last] !== character) return character;
    }
  }
  return quote ?? open.at(-1);
}
const selectorSchema = z
  .string()
  .trim()
  .min(1, "must be a nonblank selector")
  .superRefine((selector, context) => {
    const character = selectorImbalance(selector);
    if (character !== undefined)
      context.addIssue({
        code: "custom",
        message: `is not a valid selector: unclosed or unmatched ${JSON.stringify(character)}`,
      });
  });
const offsetAxis = z
  .number("must be a number of pixels")
  .finite("must be a finite number of pixels")
  .min(-10_000, "must be within 10000 pixels")
  .max(10_000, "must be within 10000 pixels");
const offsetSchema = z
  .object({ x: offsetAxis, y: offsetAxis })
  .strict()
  .refine(
    (offset) => offset.x !== 0 || offset.y !== 0,
    "must move: x and y cannot both be 0",
  );
/** A counted press repeats at most this many times. */
export const maxPressCount = 200;
const countMessage = `must be a whole number from 1 to ${maxPressCount}`;

const actionWebStepSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("click"),
      selector: nonblank,
      modifiers: modifiersSchema.optional(),
      longRunning: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("fill"),
      selector: nonblank,
      value: z.string(),
      longRunning: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      selector: nonblank,
      key: nonblank,
      count: z
        .number(countMessage)
        .int(countMessage)
        .min(1, countMessage)
        .max(maxPressCount, countMessage)
        .optional(),
      modifiers: modifiersSchema.optional(),
      longRunning: z.boolean().optional(),
    })
    .strict()
    .superRefine((step, context) => {
      if (step.modifiers === undefined) return;
      const parts = step.key.split("+").slice(0, -1);
      if (parts.some((part) => modifierNames.some((name) => name === part)))
        context.addIssue({
          code: "custom",
          path: ["modifiers"],
          message: "put modifiers in either key or modifiers, not both",
        });
    }),
  z.object({ action: z.literal("hover"), selector: selectorSchema }).strict(),
  z
    .object({
      action: z.literal("dblclick"),
      selector: selectorSchema,
      modifiers: modifiersSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("drag"),
      selector: selectorSchema,
      target: selectorSchema.optional(),
      offset: offsetSchema.optional(),
      hold: z.boolean().optional(),
    })
    .strict()
    .refine(
      (step) => (step.target === undefined) !== (step.offset === undefined),
      "must provide exactly one of target and offset",
    ),
  z
    .object({
      action: z.literal("select"),
      selector: nonblank,
      value: z.string().optional(),
      label: nonblank.optional(),
      longRunning: z.boolean().optional(),
    })
    .strict()
    .refine(
      (step) => (step.value === undefined) !== (step.label === undefined),
      "must provide exactly one of value and label",
    ),
  z
    .object({
      action: z.literal("waitFor"),
      selector: nonblank,
      state: z.enum(["visible", "hidden"]).default("visible"),
    })
    .strict(),
  z
    .object({
      action: z.literal("expectUrl"),
      path: nonblank
        .regex(/^\/[^\s?#]*$/, "must be a concrete pathname starting with /")
        .optional(),
      pattern: regexpSchema.optional(),
    })
    .strict()
    .refine(
      (step) => (step.path === undefined) !== (step.pattern === undefined),
      "must provide exactly one of path and pattern",
    ),
  z.object({ action: z.literal("expectText"), text: nonblank }).strict(),
  z.object({ action: z.literal("focus"), selector: nonblank }).strict(),
  z
    .object({
      action: z.literal("expectVisible"),
      selector: nonblank,
      within: nonblank.optional(),
    })
    .strict(),
]);
export const webStepSchema = z.union([
  actionWebStepSchema,
  z
    .object({
      expectVisible: z
        .object({ selector: nonblank, within: nonblank.optional() })
        .strict(),
    })
    .strict()
    .transform(({ expectVisible }) => ({
      action: "expectVisible" as const,
      ...expectVisible,
    })),
]);
export type WebStep = z.infer<typeof webStepSchema>;

/** Steps that only wait or assert, and so may run while a drag is held. */
export const readinessActions = [
  "waitFor",
  "expectUrl",
  "expectText",
  "expectVisible",
] as const;
export function isReadinessStep(step: WebStep): boolean {
  return readinessActions.some((action) => action === step.action);
}
/** A drag step that keeps the pointer down through the state's capture. */
export function holdsPointer(step: WebStep): boolean {
  return step.action === "drag" && step.hold === true;
}
export type WebHealth = z.infer<typeof flowHealthSchema>;
export type WebHealthAllow = z.infer<typeof allowSchema>;

function siblingIssue(
  state: { siblingGroup?: string | undefined; group?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (state.siblingGroup !== undefined && state.group !== undefined)
    context.addIssue({
      code: "custom",
      path: ["group"],
      message: "declare siblingGroup or group, not both",
    });
}

/** The data condition a state declares it shows, for state coverage. */
export const dataStateSchema = z.enum(["empty", "one", "many", "error"]);
export type DataState = z.infer<typeof dataStateSchema>;

export const webStateSchema = z
  .object({
    design: designDeclarationSchema.optional(),
    id: z.string(),
    description: z.string(),
    screenshotTimeoutMs: z.number().int().positive().optional(),
    url: z.string().optional(),
    // Another state in this flow to load (its URL and steps) before `steps`.
    from: nonblank.optional(),
    steps: z.array(webStepSchema).default([]),
    health: stateHealthSchema.prefault({}),
    urlFrom: urlFromSchema.optional(),
    expect: sharedExpectationSchema.extend({
      status: z.number().default(200),
      path: z
        .string()
        .regex(/^\/[^\s?#]*$/, "must be a concrete pathname starting with /")
        .optional(),
    }),
    mask: z.array(z.string()).default([]),
    settleMs: z.number().optional(),
    loading: z.boolean().optional(),
    loadingSettleMs: z.number().int().positive().optional(),
    viewports: z.array(z.string()).min(1).optional(),
    focus: z.string().trim().min(1).optional(),
    probe: z.boolean().optional(),
    fresh: z.boolean().optional(),
    // Boxes this state shows empty on purpose (a drop zone before a drop);
    // the empty-frame check skips them and their descendants.
    intentionallyEmpty: z.array(nonblank).optional(),
    // Content this state keeps hidden on purpose (a collapsed panel faded to
    // opacity 0); the hidden-at-rest check skips it and its descendants.
    intentionallyHidden: z.array(nonblank).optional(),
    // Elements this state moves or resizes on purpose relative to the state
    // it is linked to (its `from` source, or its toggle base and sibling
    // combinations); state-jump skips them and their descendants.
    intendedChanges: z.array(nonblank).optional(),
    data: dataStateSchema.optional(),
    invariants: z.array(invariantSchema).optional(),
    // Declared siblings for sibling-chrome: run-wide, or within this flow.
    siblingGroup: nonblank.optional(),
    group: nonblank.optional(),
  })
  .strict()
  .superRefine((state, context) => {
    siblingIssue(state, context);
    const sources = (["url", "urlFrom", "from"] as const).filter(
      (field) => state[field] !== undefined,
    );
    if (sources.length !== 1) {
      context.addIssue({
        code: "custom",
        path: [sources[1] ?? "url"],
        message: "must provide exactly one of url, urlFrom, and from",
      });
    }
  });

/** How a state declared with `from` was reached: self first, root last. */
export type ReachedFrom = {
  chain: string[];
  /** The id of the state that declared each flattened step, in order. */
  stepStates: string[];
};

/**
 * `versions` reached from `empty` → `"versions from empty"`. Headed by the
 * state's own id so a toggle combination of a chained state, which inherits
 * its base's chain, still names itself (`versions.search-focused from empty`).
 */
export function stateChainLabel(state: {
  id: string;
  reachedFrom?: ReachedFrom | undefined;
}): string {
  return state.reachedFrom === undefined
    ? state.id
    : [state.id, ...state.reachedFrom.chain.slice(1)].join(" from ");
}

type FromIssue = { index: number; message: string };

/** Unknown `from` ids and `from` cycles among a flow's declared states. */
export function fromChainIssues(
  states: ReadonlyArray<{ id: string; from?: string | undefined }>,
): FromIssue[] {
  const byId = new Map(states.map((state) => [state.id, state]));
  const issues: FromIssue[] = [];
  for (const [index, state] of states.entries()) {
    if (state.from === undefined) continue;
    if (!byId.has(state.from)) {
      issues.push({
        index,
        message: `unknown state ${JSON.stringify(state.from)}`,
      });
      continue;
    }
    const visited = [state.id];
    let current = byId.get(state.from);
    while (current !== undefined) {
      if (current.id === state.id) {
        issues.push({
          index,
          message: `cycle: ${[...visited, current.id].join(" from ")}`,
        });
        break;
      }
      // A cycle further up the chain is reported on the states that form it.
      if (visited.includes(current.id)) break;
      visited.push(current.id);
      current = current.from === undefined ? undefined : byId.get(current.from);
    }
  }
  return issues;
}

type ParsedWebState = z.infer<typeof webStateSchema>;

type HeldDragIssue = { path: Array<string | number>; message: string };

const heldDragFollowers =
  "only waitFor, expectText, expectVisible and expectUrl may run while the pointer is held";

/**
 * A held drag keeps the pointer down through the state's capture, so only
 * readiness steps may follow it: in its own state, in any state reached
 * from it, and never in a toggle option or a toggle base.
 */
export function heldDragIssues(flow: {
  states: ReadonlyArray<{
    id: string;
    from?: string | undefined;
    steps: WebStep[];
  }>;
  toggles?: Record<string, Record<string, WebStep[]>> | undefined;
  toggleStates?: string[] | undefined;
}): HeldDragIssue[] {
  const issues: HeldDragIssue[] = [];
  const byId = new Map(flow.states.map((state) => [state.id, state]));
  const ownHolds = (state: { steps: WebStep[] }) =>
    state.steps.some(holdsPointer);
  /** The nearest ancestor whose own steps hold a drag. */
  const holdingAncestor = (state: {
    id: string;
    from?: string | undefined;
  }): string | undefined => {
    const visited = new Set([state.id]);
    let current = state.from === undefined ? undefined : byId.get(state.from);
    while (current !== undefined && !visited.has(current.id)) {
      if (ownHolds(current)) return current.id;
      visited.add(current.id);
      current = current.from === undefined ? undefined : byId.get(current.from);
    }
    return undefined;
  };
  for (const [index, state] of flow.states.entries()) {
    const ancestor = holdingAncestor(state);
    let held: number | undefined;
    for (const [stepIndex, step] of state.steps.entries()) {
      if (ancestor !== undefined && !isReadinessStep(step))
        issues.push({
          path: ["states", index, "steps", stepIndex],
          message: `cannot follow the drag ${JSON.stringify(ancestor)} holds; ${heldDragFollowers}`,
        });
      else if (held !== undefined && !isReadinessStep(step))
        issues.push({
          path: ["states", index, "steps", stepIndex],
          message: `cannot follow a held drag (step ${held + 1}); ${heldDragFollowers}`,
        });
      if (held === undefined && holdsPointer(step)) held = stepIndex;
    }
  }
  if (flow.toggles === undefined) return issues;
  for (const [toggle, options] of Object.entries(flow.toggles))
    for (const [option, steps] of Object.entries(options))
      for (const [stepIndex, step] of steps.entries())
        if (holdsPointer(step))
          issues.push({
            path: ["toggles", toggle, option, stepIndex, "hold"],
            message: "toggle options cannot hold a drag",
          });
  for (const state of flow.states) {
    if (
      flow.toggleStates !== undefined &&
      !flow.toggleStates.includes(state.id)
    )
      continue;
    if (ownHolds(state) || holdingAncestor(state) !== undefined)
      issues.push({
        path: ["toggles"],
        message: `cannot combine with ${JSON.stringify(state.id)}, which holds a drag; list other states in toggleStates`,
      });
  }
  return issues;
}

/**
 * Flatten every `from` state into one that carries its root's URL source,
 * every ancestor's steps (root first) then its own, and the ancestors'
 * health allow rules. Unknown ids and cycles are left unflattened; the
 * flow's validation has already reported them.
 */
function resolveFromStates(
  states: ParsedWebState[],
): Array<ParsedWebState & { reachedFrom?: ReachedFrom }> {
  const byId = new Map(states.map((state) => [state.id, state]));
  const resolved = new Map<
    string,
    ParsedWebState & { reachedFrom?: ReachedFrom }
  >();
  const resolve = (
    state: ParsedWebState,
    visiting: Set<string>,
  ): ParsedWebState & { reachedFrom?: ReachedFrom } => {
    const done = resolved.get(state.id);
    if (done !== undefined) return done;
    const parent = state.from === undefined ? undefined : byId.get(state.from);
    if (parent === undefined || visiting.has(parent.id)) return state;
    visiting.add(state.id);
    const base = resolve(parent, visiting);
    visiting.delete(state.id);
    if (base.url === undefined && base.urlFrom === undefined) return state;
    const { url: _url, urlFrom: _urlFrom, ...own } = state;
    const flattened = {
      ...own,
      ...(base.url === undefined ? {} : { url: base.url }),
      ...(base.urlFrom === undefined ? {} : { urlFrom: base.urlFrom }),
      steps: [...base.steps, ...state.steps],
      health: {
        allow: {
          urls: [...base.health.allow.urls, ...state.health.allow.urls],
          console: [
            ...base.health.allow.console,
            ...state.health.allow.console,
          ],
        },
      },
      reachedFrom: {
        chain: [state.id, ...(base.reachedFrom?.chain ?? [base.id])],
        stepStates: [
          ...(base.reachedFrom?.stepStates ?? base.steps.map(() => base.id)),
          ...state.steps.map(() => state.id),
        ],
      },
    };
    resolved.set(state.id, flattened);
    return flattened;
  };
  return states.map((state) => resolve(state, new Set()));
}

const electronStepSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("click"), selector: z.string().trim().min(1) })
    .strict(),
  z
    .object({
      action: z.literal("fill"),
      selector: z.string().trim().min(1),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      selector: z.string().trim().min(1),
      key: z.string().trim().min(1),
    })
    .strict(),
]);

export const electronStateSchema = z
  .object({
    design: designDeclarationSchema.optional(),
    id: z.string(),
    description: z.string(),
    screenshotTimeoutMs: z.number().int().positive().optional(),
    steps: z.array(electronStepSchema).default([]),
    expect: sharedExpectationSchema,
    mask: z.array(z.string()).default([]),
    settleMs: z.number().optional(),
    loading: z.boolean().optional(),
    loadingSettleMs: z.number().int().positive().optional(),
    viewports: z.array(z.string()).min(1).optional(),
    focus: z.string().trim().min(1).optional(),
    probe: z.boolean().optional(),
    fresh: z.boolean().optional(),
    // Boxes this state shows empty on purpose (a drop zone before a drop);
    // the empty-frame check skips them and their descendants.
    intentionallyEmpty: z.array(nonblank).optional(),
    // Content this state keeps hidden on purpose (a collapsed panel faded to
    // opacity 0); the hidden-at-rest check skips it and its descendants.
    intentionallyHidden: z.array(nonblank).optional(),
    // Elements this state moves or resizes on purpose relative to the state
    // it is linked to (its `from` source, or its toggle base and sibling
    // combinations); state-jump skips them and their descendants.
    intendedChanges: z.array(nonblank).optional(),
    data: dataStateSchema.optional(),
    invariants: z.array(invariantSchema).optional(),
    siblingGroup: nonblank.optional(),
    group: nonblank.optional(),
  })
  .strict()
  .superRefine(siblingIssue);

const webTargetSchema = z.object({ kind: z.literal("web") }).strict();
const electronTargetSchema = z
  .object({
    kind: z.literal("electron"),
    launch: z
      .object({
        executablePath: z.string().trim().min(1),
        args: z.array(z.string()).default([]),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).default({}),
        timeoutMs: z.number().positive().default(30_000),
      })
      .strict(),
    window: z
      .object({
        title: z.string().trim().min(1),
        timeoutMs: z.number().positive().default(10_000),
      })
      .strict(),
  })
  .strict();

const flowFields = {
  shell: nonblank.optional(),
  invariants: z.array(invariantSchema).optional(),
  id: z.string(),
  surface: z.string().trim().min(1).optional(),
  title: z.string(),
  intent: z.array(z.string()),
  setup: z.array(setupSchema),
  viewports: z.array(z.string()).optional(),
  colorSchemes: z
    .array(colorSchemeSchema)
    .min(1, "must contain at least one color scheme")
    .superRefine((schemes, context) => {
      const seen = new Set<string>();
      for (const [index, scheme] of schemes.entries()) {
        if (seen.has(scheme)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `duplicate color scheme ${JSON.stringify(scheme)}`,
          });
        }
        seen.add(scheme);
      }
    })
    .optional(),
  /**
   * Make navigator.webdriver read false during this flow's capture, for apps
   * that turn motion off under automation. Overrides capture.hideWebdriver.
   */
  hideWebdriver: z.boolean().optional(),
  /**
   * Selectors of modal dialogs that intentionally need an explicit action:
   * the dismissal probe does not click outside them (Escape is still tested).
   */
  explicitDismiss: z.array(nonblank).optional(),
};

const routeSchema = z
  .string()
  .trim()
  .regex(/^\/[^\s?#]*$/, "must be a concrete path starting with /");

/** "/" → "route-root", "/leads/new" → "route-leads-new". */
export function routeStateId(route: string): string {
  const slug = route
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `route-${slug === "" ? "root" : slug}`;
}

/** "/" → "page-root", "/p/abc" → "page-p-abc". */
export function pageStateId(path: string): string {
  return `page-${routeStateId(path).slice("route-".length)}`;
}

/** Published flows capture these widths when they name no viewports. */
export const publishedDefaultViewports = [1280, 768, 375] as const;

/** A numeric published viewport's height: desktop, tablet, or phone. */
export function publishedViewportHeight(width: number): number {
  if (width >= 1024) return 800;
  if (width >= 600) return 1024;
  return 812;
}

export type FlowViewportSize = { width: number; height: number };

const toggleNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "must start with a letter or number and contain only letters, numbers, underscore, or dash",
  );
const togglesSchema = z
  .record(
    toggleNameSchema,
    z
      .record(toggleNameSchema, z.array(webStepSchema))
      .refine(
        (options) => Object.keys(options).length > 0,
        "must declare at least one option",
      ),
  )
  .refine(
    (toggles) => Object.keys(toggles).length > 0,
    "must declare at least one toggle",
  );
const combinationsSchema = z.union([
  z.literal("all"),
  z.array(z.record(toggleNameSchema, toggleNameSchema)).min(1),
]);
export type FlowToggles = z.infer<typeof togglesSchema>;
export type FlowCombinations = z.infer<typeof combinationsSchema>;

/** One chosen option per toggle, in toggle declaration order. */
export type ToggleOptions = Record<string, string>;
export type StateCombination = {
  base: string;
  label: string;
  options: ToggleOptions;
};
export type ToggleCap = { combined: string[]; held: string[] };

/** More toggles than this under `"all"` are held at their first option. */
export const toggleCombinationCap = 3;

/** `{ drawer: "480", inspector: "open" }` → `"drawer=480, inspector=open"`. */
export function combinationLabel(options: ToggleOptions): string {
  return Object.entries(options)
    .map(([toggle, option]) => `${toggle}=${option}`)
    .join(", ");
}

/** `editor` + `{ drawer: "480" }` → `editor.drawer-480`. */
export function combinationStateId(
  baseId: string,
  options: ToggleOptions,
): string {
  return [
    baseId,
    ...Object.entries(options).map(([toggle, option]) => `${toggle}-${option}`),
  ].join(".");
}

function defaultedCombination(
  toggles: FlowToggles,
  chosen: ToggleOptions,
): ToggleOptions {
  return Object.fromEntries(
    Object.entries(toggles).map(([toggle, options]) => [
      toggle,
      Object.hasOwn(chosen, toggle)
        ? (chosen[toggle] as string)
        : (Object.keys(options)[0] as string),
    ]),
  );
}

/**
 * The combinations a flow's toggles expand to. `"all"` is the cross product
 * of the first three toggles (the rest held at their first option); an
 * explicit list is taken as written, with omitted toggles at their first
 * option.
 */
export function expandToggleCombinations(
  toggles: FlowToggles,
  combinations: FlowCombinations = "all",
): { combos: ToggleOptions[]; cap?: ToggleCap } {
  if (combinations !== "all") {
    return {
      combos: combinations.map((chosen) =>
        defaultedCombination(toggles, chosen),
      ),
    };
  }
  const names = Object.keys(toggles);
  const combined = names.slice(0, toggleCombinationCap);
  const held = names.slice(toggleCombinationCap);
  let partials: ToggleOptions[] = [{}];
  for (const toggle of combined) {
    const options = Object.keys(toggles[toggle] ?? {});
    partials = partials.flatMap((partial) =>
      options.map((option) => ({ ...partial, [toggle]: option })),
    );
  }
  return {
    combos: partials.map((partial) => defaultedCombination(toggles, partial)),
    ...(held.length === 0 ? {} : { cap: { combined, held } }),
  };
}

/** One pattern or template an advisory design-intent review judges. */
const contentPatternSchema = z
  .object({
    id: referenceNameSchema,
    path: routeSchema.optional(),
    state: nonblank.optional(),
    intent: nonblank,
    reference: nonblank.optional(),
  })
  .strict();

export type ContentPattern = z.infer<typeof contentPatternSchema>;

/** The captured state a content pattern is reviewed in. */
export function contentPatternStateId(pattern: ContentPattern): string {
  return pattern.state ?? `pattern-${pattern.id}`;
}

function contentIssues(
  flow: {
    states: Array<{ id: string }>;
    routes?: string[] | undefined;
    pages?: string[] | undefined;
    content?: { patterns: ContentPattern[] } | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (flow.content === undefined) return;
  const declared = new Set(flow.states.map((state) => state.id));
  const generated = new Set([
    ...(flow.routes ?? []).map(routeStateId),
    ...(flow.pages ?? []).map(pageStateId),
  ]);
  const ids = new Set<string>();
  for (const [index, pattern] of flow.content.patterns.entries()) {
    const path = ["content", "patterns", index];
    if (ids.has(pattern.id))
      context.addIssue({
        code: "custom",
        path: [...path, "id"],
        message: `duplicate pattern ${JSON.stringify(pattern.id)}`,
      });
    ids.add(pattern.id);
    if ((pattern.path === undefined) === (pattern.state === undefined)) {
      context.addIssue({
        code: "custom",
        path,
        message: "a pattern needs exactly one of path or state",
      });
      continue;
    }
    if (pattern.state !== undefined) {
      if (!declared.has(pattern.state))
        context.addIssue({
          code: "custom",
          path: [...path, "state"],
          message: `unknown state ${JSON.stringify(pattern.state)}`,
        });
      continue;
    }
    const id = contentPatternStateId(pattern);
    if (declared.has(id) || generated.has(id))
      context.addIssue({
        code: "custom",
        path: [...path, "id"],
        message: `generated state ${JSON.stringify(id)} collides with an existing state`,
      });
  }
}

const webFlowSchema = z
  .object({
    ...flowFields,
    // Published flows may also name a viewport by its width in pixels.
    viewports: z
      .array(z.union([z.string(), z.number().int().positive()]))
      .optional(),
    // "published" marks rendered pages held to a hard budget.
    kind: z.enum(["app", "published"]).optional(),
    pages: z.array(routeSchema).min(1).optional(),
    budget: z
      .object({ maxDiffRatio: z.number().min(0).max(1) })
      .strict()
      .optional(),
    server: z.literal("production").optional(),
    target: webTargetSchema.default({ kind: "web" }),
    health: flowHealthSchema.prefault({}),
    states: z.array(webStateSchema).default([]),
    // Plain routes captured as states without hand-writing each one.
    routes: z.array(routeSchema).optional(),
    // Named UI switches whose combinations are captured as generated states.
    toggles: togglesSchema.optional(),
    combinations: combinationsSchema.optional(),
    toggleStates: z.array(nonblank).min(1).optional(),
    toggleRegions: z.array(nonblank).optional(),
    // Patterns and templates the advisory design-intent review judges.
    content: z
      .object({ patterns: z.array(contentPatternSchema).min(1) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((flow, context) => {
    contentIssues(flow, context);
    const published = flow.kind === "published";
    for (const field of ["pages", "budget"] as const) {
      if (flow[field] !== undefined && !published)
        context.addIssue({
          code: "custom",
          path: [field],
          message: 'requires kind: "published"',
        });
    }
    if (published && flow.pages === undefined)
      context.addIssue({
        code: "custom",
        path: ["pages"],
        message: 'required when kind is "published"',
      });
    for (const [index, viewport] of (flow.viewports ?? []).entries()) {
      if (typeof viewport === "number" && !published)
        context.addIssue({
          code: "custom",
          path: ["viewports", index],
          message: 'numeric viewports require kind: "published"',
        });
    }
    const pages = new Set<string>();
    for (const [index, page] of (flow.pages ?? []).entries()) {
      if (pages.has(page))
        context.addIssue({
          code: "custom",
          path: ["pages", index],
          message: `duplicate page ${JSON.stringify(page)}`,
        });
      pages.add(page);
    }
    for (const issue of fromChainIssues(flow.states))
      context.addIssue({
        code: "custom",
        path: ["states", issue.index, "from"],
        message: issue.message,
      });
    for (const issue of heldDragIssues(flow))
      context.addIssue({ code: "custom", ...issue });
    const toggles = flow.toggles;
    if (toggles === undefined) {
      for (const field of [
        "combinations",
        "toggleStates",
        "toggleRegions",
      ] as const) {
        if (flow[field] !== undefined)
          context.addIssue({
            code: "custom",
            path: [field],
            message: "requires toggles",
          });
      }
      return;
    }
    const declared = new Set(flow.states.map((state) => state.id));
    for (const [index, id] of (flow.toggleStates ?? []).entries()) {
      if (!declared.has(id))
        context.addIssue({
          code: "custom",
          path: ["toggleStates", index],
          message: `unknown state ${JSON.stringify(id)}`,
        });
    }
    if (flow.combinations === undefined || flow.combinations === "all") return;
    const seen = new Set<string>();
    for (const [index, chosen] of flow.combinations.entries()) {
      let valid = true;
      for (const [toggle, option] of Object.entries(chosen)) {
        const options = toggles[toggle];
        if (!Object.hasOwn(toggles, toggle) || options === undefined) {
          valid = false;
          context.addIssue({
            code: "custom",
            path: ["combinations", index, toggle],
            message: `unknown toggle ${JSON.stringify(toggle)}`,
          });
        } else if (!Object.hasOwn(options, option)) {
          valid = false;
          context.addIssue({
            code: "custom",
            path: ["combinations", index, toggle],
            message: `unknown option ${JSON.stringify(option)} for toggle ${JSON.stringify(toggle)}`,
          });
        }
      }
      if (!valid) continue;
      const label = combinationLabel(defaultedCombination(toggles, chosen));
      if (seen.has(label))
        context.addIssue({
          code: "custom",
          path: ["combinations", index],
          message: `duplicate combination ${JSON.stringify(label)}`,
        });
      seen.add(label);
    }
  })
  .transform((flow) => {
    const states: WebFlowState[] = resolveFromStates(flow.states);
    const expanded =
      flow.toggles === undefined
        ? undefined
        : expandToggleCombinations(flow.toggles, flow.combinations);
    const toggles = flow.toggles ?? {};
    const bases =
      flow.toggleStates === undefined
        ? states
        : states.filter((state) => flow.toggleStates?.includes(state.id));
    const generated: WebFlowState[] = bases.flatMap((base) =>
      (expanded?.combos ?? []).map((options) => {
        const label = combinationLabel(options);
        return {
          ...base,
          id: combinationStateId(base.id, options),
          description: `${base.description} (${label})`,
          steps: [
            ...base.steps,
            ...Object.entries(options).flatMap(
              ([toggle, option]) => toggles[toggle]?.[option] ?? [],
            ),
          ],
          // The base state is already probed; probing every combination is
          // the expensive path, so it is opt-in through the base's `probe`.
          probe: base.probe ?? false,
          combination: { base: base.id, label, options },
        };
      }),
    );
    const pathState = (id: string, description: string, url: string) => ({
      id,
      description,
      steps: [],
      health: { allow: { urls: [], console: [] } },
      url,
      expect: {
        status: 200,
        textPresent: [],
        selectorPresent: [],
        selectorAbsent: [],
      },
      mask: [],
    });
    const { viewports: declaredViewports, ...rest } = flow;
    const viewportSizes: Record<string, FlowViewportSize> = {};
    const rawViewports =
      declaredViewports ??
      (flow.kind === "published" ? [...publishedDefaultViewports] : undefined);
    const viewports = rawViewports?.map((viewport) => {
      if (typeof viewport === "string") return viewport;
      const name = String(viewport);
      viewportSizes[name] = {
        width: viewport,
        height: publishedViewportHeight(viewport),
      };
      return name;
    });
    return {
      ...rest,
      ...(viewports === undefined ? {} : { viewports }),
      ...(Object.keys(viewportSizes).length === 0 ? {} : { viewportSizes }),
      states: [
        ...states,
        ...(flow.routes ?? []).map((route) =>
          pathState(routeStateId(route), `Route ${route}`, route),
        ),
        ...(flow.pages ?? []).map((page) =>
          pathState(pageStateId(page), `Published page ${page}`, page),
        ),
        ...(flow.content?.patterns ?? []).flatMap((pattern) =>
          pattern.path === undefined
            ? []
            : [
                pathState(
                  contentPatternStateId(pattern),
                  `Pattern ${pattern.id}`,
                  pattern.path,
                ),
              ],
        ),
        ...generated,
      ],
      ...(expanded?.cap === undefined ? {} : { toggleCap: expanded.cap }),
    };
  });

const electronFlowSchema = z
  .object({
    ...flowFields,
    target: electronTargetSchema,
    states: z.array(electronStateSchema),
  })
  .strict();

export type WebFlowState = z.infer<typeof webStateSchema> & {
  /** Present on states generated from the flow's toggles. */
  combination?: StateCombination | undefined;
  /** Present on states declared with `from`, flattened at parse time. */
  reachedFrom?: ReachedFrom | undefined;
};
type ParsedElectronFlowState = z.infer<typeof electronStateSchema>;
export type ElectronFlowState = Omit<ParsedElectronFlowState, "expect"> & {
  url?: undefined;
  urlFrom?: undefined;
  expect: ParsedElectronFlowState["expect"] & { status?: undefined };
};
export type WebFlow = Omit<
  z.infer<typeof webFlowSchema>,
  "states" | "toggleCap" | "viewports" | "viewportSizes"
> & {
  states: WebFlowState[];
  toggleCap?: ToggleCap | undefined;
  viewports?: string[] | undefined;
  /** Sizes of viewports a published flow names by width (`"1280"`). */
  viewportSizes?: Record<string, FlowViewportSize> | undefined;
};
export type ElectronFlow = Omit<
  z.infer<typeof electronFlowSchema>,
  "states"
> & {
  states: ElectronFlowState[];
};
export type Flow = WebFlow | ElectronFlow;

export const flowSchema = z.union([
  electronFlowSchema,
  webFlowSchema,
]) as z.ZodType<Flow>;

export function isWebFlow(flow: Flow): flow is WebFlow {
  return flow.target.kind === "web";
}

export function isPublishedFlow(
  flow: Flow,
): flow is WebFlow & { kind: "published"; pages: string[] } {
  return isWebFlow(flow) && flow.kind === "published";
}

export function isElectronFlow(flow: Flow): flow is ElectronFlow {
  return flow.target.kind === "electron";
}
