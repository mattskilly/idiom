import { isDeepStrictEqual } from "node:util";
import { IdiomError } from "../errors.js";
import { defaultChecksSettings } from "../schemas/project.js";
import { appendJsonArrayItem, setJsonValue } from "./json-edit.js";

/**
 * Measurable laws a director states, compiled to configuration for the
 * deterministic check that already measures them. Pure and deterministic:
 * the same words always compile to the same configuration, because the human
 * confirms the exact diff.
 */

/** The surface a law is scoped to; `selector` is absent when the noun is outside the vocabulary. */
export type LawScope = { surface: string; selector?: string | undefined };

export type ShareSubject =
  | "buttons"
  | "children"
  | "fields"
  | "menu items"
  | "tabs";

export type CompiledLaw =
  | {
      family: "min-gap";
      check: "control-gap";
      min: number;
      scope?: LawScope | undefined;
    }
  | {
      family: "banned-css";
      check: "negative-spacing";
      property: "word-spacing" | "letter-spacing" | "both";
      reach: "interface" | "all";
      scope?: LawScope | undefined;
    }
  | {
      family: "centring";
      check: "text-centering";
      tolerance: number;
      scope?: LawScope | undefined;
    }
  | {
      family: "one-row";
      check: "toolbar-layout";
      scope?: LawScope | undefined;
    }
  | {
      family: "toolbar-centring";
      check: "toolbar-layout";
      tolerance: number;
      scope?: LawScope | undefined;
    }
  | {
      family: "share";
      check: "layout-invariants";
      share: "top" | "height" | "width";
      subject: ShareSubject;
      tolerance: number;
      scope?: LawScope | undefined;
    };

export type LawCompilation =
  | { law: CompiledLaw }
  | { notCompiled: string }
  | undefined;

/** The largest gap the control-gap scan records; a stricter law cannot be measured. */
export const CONTROL_GAP_CEILING = 12;
/** text-centering never measures tighter than this (font-metric rounding). */
export const CENTRING_FLOOR = 1.5;

/** Surface nouns learn knows, each with the selector it always compiles to. */
const SURFACES: ReadonlyArray<{
  name: string;
  pattern: string;
  selector: string;
}> = [
  { name: "toolbar", pattern: "tool ?bars?", selector: '[role="toolbar"]' },
  {
    name: "field group",
    pattern: "field ?groups?|fieldsets?",
    selector: 'fieldset, [role="group"]',
  },
  {
    name: "tab list",
    pattern: "tab ?(?:lists?|bars?|strips?)",
    selector: '[role="tablist"]',
  },
  {
    name: "menu",
    pattern: "menu ?bars?|menus?",
    selector: '[role="menu"], [role="menubar"]',
  },
  { name: "form", pattern: "forms?", selector: "form" },
  {
    name: "dialog",
    pattern: "dialogs?|modals?",
    selector: 'dialog, [role="dialog"]',
  },
  {
    name: "navigation",
    pattern: "nav(?:igation)?(?: ?bars?)?",
    selector: 'nav, [role="navigation"]',
  },
];

const surfaceAlternation = SURFACES.map(({ pattern }) => pattern).join("|");

function knownSurface(noun: string): LawScope | undefined {
  const found = SURFACES.find(({ pattern }) =>
    new RegExp(`^(?:${pattern})$`).test(noun),
  );
  return found === undefined
    ? undefined
    : { surface: found.name, selector: found.selector };
}

/** The vocabulary, for docs and messages: surface name → selector. */
export const lawSurfaces: ReadonlyArray<{ name: string; selector: string }> =
  SURFACES.map(({ name, selector }) => ({ name, selector }));

const NUMBER = String.raw`(\d+(?:\.\d+)?)\s*px\b`;
const UNKNOWN_SURFACE_STOP = new Set([
  "same",
  "other",
  "one",
  "whole",
  "middle",
  "centre",
  "center",
  "row",
  "line",
  "box",
  "way",
  "text",
  "copy",
  "page",
  "screen",
  "app",
  "site",
  "product",
  "interface",
  "ui",
  "chrome",
]);

/**
 * The surface a law names: "in a toolbar", "inside every menu", "toolbar
 * buttons…". An unknown noun after an article ("in the inspector") is kept
 * without a selector so the caller can resolve it or say why it cannot.
 */
function scopeOf(text: string): LawScope | undefined {
  const known = new RegExp(
    String.raw`\b(?:in|inside|within|on|across|of)\s+(?:a|an|the|any|every|each|all)?\s*(${surfaceAlternation})\b`,
  ).exec(text);
  if (known?.[1] !== undefined) return knownSurface(known[1]);
  const leading = new RegExp(
    String.raw`^(?:the\s+|all\s+|every\s+|each\s+)?(${surfaceAlternation})\s+(?:buttons?|items?|controls?|fields?|inputs?|labels?|tabs?|chips?|children|entries)\b`,
  ).exec(text);
  if (leading?.[1] !== undefined) return knownSurface(leading[1]);
  // The surface as the sentence's subject: "the toolbar is…", "the selection toolbar never…".
  const verb = String.raw`(?:is|are|stays?|remains?|keeps?|fits?|must|should|never|always|sits?|wraps?|does(?:n't|\s+not)?|do(?:n't|\s+not)?)\b`;
  const subject = new RegExp(
    String.raw`^(?:(?:the|a|an|any|every|each|all)\s+)?(?:([a-z][a-z-]*)\s+)?(${surfaceAlternation})\s+${verb}`,
  ).exec(text);
  if (subject?.[2] !== undefined) {
    const modifier = subject[1];
    if (modifier === undefined) return knownSurface(subject[2]);
    const whole = `${modifier} ${subject[2]}`;
    return knownSurface(whole) ?? { surface: whole };
  }
  const unknown =
    /\b(?:in|inside|within|on|across)\s+(?:a|an|the|any|every|each)\s+([a-z][a-z-]*(?:\s+(?:panel|bar|pane|area|sidebar|header|footer|card|list|section|drawer|popover|sheet|rail|toolbars?))?)\b/.exec(
      text,
    );
  const noun = unknown?.[1];
  if (noun === undefined || UNKNOWN_SURFACE_STOP.has(noun)) return undefined;
  return { surface: noun };
}

const numberFrom = (match: RegExpExecArray | null) =>
  match?.[1] === undefined ? undefined : Number(match[1]);

function minGap(text: string): number | undefined {
  for (const pattern of [
    String.raw`\b(?:closer|nearer)\s+than\s+${NUMBER}`,
    String.raw`\bat\s+least\s+${NUMBER}\s+(?:apart|between|of\s+(?:space|gap|spacing))`,
    String.raw`\b(?:minimum|min)\s+(?:gap|space|spacing)\s+(?:of\s+)?${NUMBER}`,
    String.raw`\b(?:gaps?|space|spacing)\s+(?:of\s+)?(?:at\s+least|no\s+less\s+than)\s+${NUMBER}`,
  ]) {
    const value = numberFrom(new RegExp(pattern).exec(text));
    if (value !== undefined) return value;
  }
  return undefined;
}

function bannedSpacing(
  text: string,
): Omit<Extract<CompiledLaw, { family: "banned-css" }>, "scope"> | undefined {
  if (
    !/\b(?:never|no|don't|do not|dont|avoid|ban|banned|without|forbid|forbidden)\b/.test(
      text,
    ) ||
    !/\bnegative\b/.test(text)
  )
    return undefined;
  const after = text.slice(text.indexOf("negative"));
  const word = /\bword[- ]?(?:spacing)?\b/.test(after);
  const letter = /\b(?:letter[- ]?(?:spacing)?|tracking)\b/.test(after);
  if (!/(?:spacing|tracking)/.test(after) || (!word && !letter))
    return undefined;
  return {
    family: "banned-css",
    check: "negative-spacing",
    property:
      word && letter ? "both" : word ? "word-spacing" : "letter-spacing",
    reach: /\b(?:any|all|every)\s+text\b|\banywhere\b|\beverywhere\b/.test(text)
      ? "all"
      : "interface",
  };
}

function shareOf(text: string): "top" | "height" | "width" | undefined {
  const shared =
    /\bshare\s+(?:a|one|the\s+same)\s+(top\s+edge|top|height|width)\b/.exec(
      text,
    ) ??
    /\b(?:the\s+same|same|equal|matching)\s+(top\s+edges?|tops|heights?|widths?)\b/.exec(
      text,
    );
  const word = shared?.[1];
  if (word === undefined) return undefined;
  if (word.startsWith("top")) return "top";
  return word.startsWith("height") ? "height" : "width";
}

/** "one row", "a single line", "never wraps", "doesn't wrap". */
const ONE_ROW =
  /\b(?:one|a single|single|1)\s+(?:row|line)\b|\bnever\s+wraps?\b|\b(?:does|do|must|should)\s*(?:n't|not)\s+wrap\b/;
/** Words about text, whose wrapping and centring are not a toolbar's. */
const TEXT_WORDS =
  /\b(?:labels?|text|copy|titles?|headings?|words?|names?|captions?)\b/;
const CENTRED = /\b(?:centred|centered|centre|center)\b/;
const TOOLBAR_PARTS = /\b(?:controls?|buttons?|items?|icons?)\b/;

/**
 * A scope toolbar-layout can measure: the vocabulary's toolbar, or a surface
 * outside it whose phrase ends in toolbar or bar ("selection toolbar",
 * "format bar"). Anything else would be measured as a toolbar it is not.
 */
const toolbarScope = (scope: LawScope | undefined): boolean =>
  scope !== undefined &&
  (scope.surface === "toolbar" ||
    (scope.selector === undefined &&
      /(?:^|\s)(?:tool ?bars?|bars?)$/.test(scope.surface)));

function subjectOf(text: string): ShareSubject {
  if (/\bmenu\s*items?\b/.test(text)) return "menu items";
  if (/\b(?:fields?|inputs?)\b/.test(text)) return "fields";
  if (/\btabs\b|\btab\b(?!\s*(?:lists?|bars?|strips?))/.test(text))
    return "tabs";
  if (/\bbuttons?\b/.test(text)) return "buttons";
  return "children";
}

/**
 * Compile a director's words to a measurable law, or undefined when they
 * state none. `notCompiled` says why words that clearly state one of the
 * families still cannot configure its check.
 */
export function compileLaw(text: string): LawCompilation {
  const words = text.trim().replace(/\s+/g, " ").toLowerCase();
  const scope = scopeOf(words);
  const withScope = <T extends object>(law: T) =>
    scope === undefined ? law : { ...law, scope };

  const banned = bannedSpacing(words);
  if (banned !== undefined) return { law: withScope(banned) };

  const within = numberFrom(
    new RegExp(String.raw`\bwithin\s+${NUMBER}`).exec(words),
  );
  // Controls (not labels) vertically centred in a toolbar: before
  // text-centering, which keeps label sentences and every other surface.
  if (
    toolbarScope(scope) &&
    CENTRED.test(words) &&
    TOOLBAR_PARTS.test(words) &&
    !TEXT_WORDS.test(words) &&
    !/\bhorizontally\b/.test(words)
  ) {
    const tolerance = within ?? 1;
    if (tolerance <= 0)
      return { notCompiled: "a centring tolerance must be above 0px" };
    return {
      law: {
        family: "toolbar-centring",
        check: "toolbar-layout",
        tolerance,
        scope,
      },
    };
  }
  if (
    /\b(?:centred|centered|centre|center)\b/.test(words) &&
    within !== undefined
  ) {
    if (within <= 0)
      return {
        notCompiled: "a centring tolerance must be above 0px",
      };
    return {
      law: withScope({
        family: "centring",
        check: "text-centering",
        tolerance: within,
      } as const),
    };
  }

  const share = shareOf(words);
  if (
    ONE_ROW.test(words) &&
    !TEXT_WORDS.test(words) &&
    share === undefined &&
    minGap(words) === undefined
  ) {
    if (scope === undefined)
      return { notCompiled: "name the toolbar that stays on one row" };
    if (!toolbarScope(scope))
      return {
        notCompiled: `toolbar-layout keeps toolbars on one row, and the ${scope.surface} is not one; name the toolbar`,
      };
    return { law: { family: "one-row", check: "toolbar-layout", scope } };
  }
  if (share !== undefined) {
    const subject = subjectOf(words);
    const implied =
      scope ??
      (subject === "menu items"
        ? knownSurface("menu")
        : subject === "tabs"
          ? knownSurface("tab list")
          : subject === "fields"
            ? knownSurface("form")
            : undefined);
    if (implied === undefined)
      return {
        notCompiled: `name the surface the ${subject} share it in (toolbar, menu, field group…)`,
      };
    return {
      law: {
        family: "share",
        check: "layout-invariants",
        share,
        subject,
        tolerance: within ?? 1,
        scope: implied,
      },
    };
  }

  const min = minGap(words);
  if (min !== undefined) {
    if (min > CONTROL_GAP_CEILING)
      return {
        notCompiled: `control-gap measures gaps up to ${CONTROL_GAP_CEILING}px, so a ${min}px minimum cannot be enforced`,
      };
    return {
      law: withScope({ family: "min-gap", check: "control-gap", min } as const),
    };
  }
  return undefined;
}

const FIELDS =
  "input:not([type=checkbox],[type=radio],[type=hidden],[type=button],[type=submit],[type=reset],[type=range],[type=color],[type=file],[type=image]), select, textarea";
const SUBJECT_SELECTORS: Record<Exclude<ShareSubject, "children">, string> = {
  buttons: 'button, [role="button"]',
  fields: FIELDS,
  "menu items": '[role^="menuitem"]',
  tabs: '[role="tab"]',
};

/** The members a share law compares, inside the scope's selector. */
export function shareSelector(subject: ShareSubject, scope: string): string {
  return subject === "children"
    ? `:is(${scope}) > *`
    : `:is(${scope}) :is(${SUBJECT_SELECTORS[subject]})`;
}

const describeScope = (law: CompiledLaw, selector: string | undefined) =>
  law.scope === undefined
    ? undefined
    : `the ${law.scope.surface}${selector === undefined ? "" : ` (${selector})`}`;

/**
 * The one-line header learn shows above the diff: the check the law
 * configures and the scope it applies to.
 */
export function lawSummary(law: CompiledLaw, selector?: string): string {
  const scope = describeScope(law, selector ?? law.scope?.selector);
  const scoped = scope === undefined ? ", everywhere" : `, scoped to ${scope}`;
  switch (law.family) {
    case "min-gap":
      return `Compiles to control-gap: parts inside a control keep at least ${law.min}px apart${scoped}.`;
    case "banned-css": {
      const property =
        law.property === "both"
          ? "letter- or word-spacing"
          : law.property === "word-spacing"
            ? "word-spacing"
            : "letter-spacing";
      return `Compiles to negative-spacing: no negative ${property} on ${law.reach === "all" && scope === undefined ? "any painted text" : "interface text"}${scoped}.`;
    }
    case "centring":
      return `Compiles to text-centering: single-line labels sit within ${law.tolerance}px of their box's vertical centre${scoped}.${law.tolerance < CENTRING_FLOOR ? ` Measured at the ${CENTRING_FLOOR}px font-metric floor.` : ""}`;
    case "one-row":
      return `Compiles to toolbar-layout: every control sits on one row inside ${scope ?? "the toolbar"}.`;
    case "toolbar-centring":
      return `Compiles to toolbar-layout: controls' vertical centres sit within ${law.tolerance}px of each other inside ${scope ?? "the toolbar"}.`;
    case "share": {
      const what =
        law.share === "top"
          ? "a top edge"
          : law.share === "height"
            ? "a height"
            : "a width";
      return `Compiles to layout-invariants: ${law.subject} share ${what} within ${law.tolerance}px inside each ${scope ?? "surface"}.`;
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function child(parent: Record<string, unknown>, key: string) {
  const current = parent[key];
  if (
    current !== null &&
    typeof current === "object" &&
    !Array.isArray(current)
  )
    return current as Record<string, unknown>;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function list(parent: Record<string, unknown>, key: string): unknown[] {
  const current = parent[key];
  if (Array.isArray(current)) return current;
  const created: unknown[] = [];
  parent[key] = created;
  return created;
}

/** How the project file changes: an array append or a value set, at a path under the root. */
export type LawEdit =
  | { kind: "append"; path: string[]; item: unknown }
  | { kind: "set"; path: string[]; value: unknown };

export type LawConfigEdit = {
  /** Undefined when the project already enforces the law as stated. */
  edit?: LawEdit | undefined;
  /** What the law configured, for the learned record. */
  entry: unknown;
  /** The check the law configures. */
  check: CompiledLaw["check"];
  /** The scope selector, when the law has one. */
  scope?: string | undefined;
};

/**
 * Apply a compiled law to a parsed `.idiom/project.json` value, in place.
 * `selector` is the scope's resolved selector (required when the law has a
 * scope). Refuses a second law for a surface that already has one.
 */
export function lawConfigEdit(
  projectValue: Record<string, unknown>,
  law: CompiledLaw,
  name: string,
  selector?: string | undefined,
): LawConfigEdit {
  // Edit a copy so a law the project already enforces leaves it untouched.
  const draft = structuredClone(projectValue);
  const result = applyLaw(draft, law, name, selector);
  if (result.edit !== undefined) Object.assign(projectValue, draft);
  return result;
}

function applyLaw(
  projectValue: Record<string, unknown>,
  law: CompiledLaw,
  name: string,
  selector: string | undefined,
): LawConfigEdit {
  if (law.scope !== undefined && selector === undefined)
    throw new IdiomError(
      `no selector for "${law.scope.surface}"; pass --selector to compile the law`,
    );
  const checks = child(projectValue, "checks");
  const scoped = law.scope === undefined ? undefined : selector;
  const base = {
    check: law.check,
    ...(scoped === undefined ? {} : { scope: scoped }),
  };
  const refuse = (path: string, existing: Record<string, unknown>) => {
    throw new IdiomError(
      `${path} already has ${String(existing.selector)} (${JSON.stringify(existing.name)}); edit it in .idiom/project.json`,
    );
  };
  switch (law.family) {
    case "min-gap": {
      const controlGap = child(checks, "controlGap");
      if (scoped === undefined) {
        if (
          controlGap.min === law.min ||
          (controlGap.min === undefined &&
            law.min === defaultChecksSettings.controlGap.min)
        )
          return { ...base, entry: { min: law.min } };
        controlGap.min = law.min;
        return {
          ...base,
          entry: { min: law.min },
          edit: {
            kind: "set",
            path: ["checks", "controlGap", "min"],
            value: law.min,
          },
        };
      }
      const scopes = list(controlGap, "scopes");
      const existing = scopes
        .map(record)
        .find((item) => item.selector === scoped);
      if (existing !== undefined) refuse("checks.controlGap.scopes", existing);
      const item = { name, selector: scoped, min: law.min };
      scopes.push(item);
      return {
        ...base,
        entry: item,
        edit: {
          kind: "append",
          path: ["checks", "controlGap", "scopes"],
          item,
        },
      };
    }
    case "banned-css": {
      const spacing = child(checks, "negativeSpacing");
      const enable = spacing.enabled === false;
      if (enable) spacing.enabled = true;
      if (scoped !== undefined) {
        const include = list(spacing, "include");
        if (include.includes(scoped))
          throw new IdiomError(
            `checks.negativeSpacing.include already has ${scoped}; edit it in .idiom/project.json`,
          );
        include.push(scoped);
        return {
          ...base,
          entry: { include: scoped },
          edit: enable
            ? {
                kind: "set",
                path: ["checks", "negativeSpacing"],
                value: spacing,
              }
            : {
                kind: "append",
                path: ["checks", "negativeSpacing", "include"],
                item: scoped,
              },
        };
      }
      const widen = law.reach === "all" && spacing.scope !== "all";
      if (widen) spacing.scope = "all";
      const entry = { enabled: true, scope: law.reach };
      if (!enable && !widen) return { ...base, entry };
      return {
        ...base,
        entry,
        edit: {
          kind: "set",
          path: ["checks", "negativeSpacing"],
          value: spacing,
        },
      };
    }
    case "centring": {
      if (scoped === undefined) {
        if (
          checks.centeringTolerance === law.tolerance ||
          (checks.centeringTolerance === undefined &&
            law.tolerance === defaultChecksSettings.centeringTolerance)
        )
          return { ...base, entry: { centeringTolerance: law.tolerance } };
        checks.centeringTolerance = law.tolerance;
        return {
          ...base,
          entry: { centeringTolerance: law.tolerance },
          edit: {
            kind: "set",
            path: ["checks", "centeringTolerance"],
            value: law.tolerance,
          },
        };
      }
      const scopes = list(child(checks, "textCentering"), "scopes");
      const existing = scopes
        .map(record)
        .find((item) => item.selector === scoped);
      if (existing !== undefined)
        refuse("checks.textCentering.scopes", existing);
      const item = { name, selector: scoped, tolerance: law.tolerance };
      scopes.push(item);
      return {
        ...base,
        entry: item,
        edit: {
          kind: "append",
          path: ["checks", "textCentering", "scopes"],
          item,
        },
      };
    }
    case "one-row":
    case "toolbar-centring": {
      if (scoped === undefined)
        throw new IdiomError(
          "unreachable: a toolbar-layout law always has a scope",
        );
      const toolbarLayout = child(checks, "toolbarLayout");
      const kind = law.family === "one-row" ? "one-row" : "centred";
      const enable = toolbarLayout.enabled === false;
      if (enable) toolbarLayout.enabled = true;
      const scopes = list(toolbarLayout, "scopes");
      const existing = scopes
        .map(record)
        .find((item) => item.selector === scoped && item.law === kind);
      if (existing !== undefined)
        throw new IdiomError(
          `checks.toolbarLayout.scopes already has ${scoped} (${kind}, ${JSON.stringify(existing.name)}); edit it in .idiom/project.json`,
        );
      const item =
        law.family === "one-row"
          ? { name, selector: scoped, law: kind }
          : { name, selector: scoped, law: kind, tolerance: law.tolerance };
      scopes.push(item);
      return {
        ...base,
        entry: item,
        edit: enable
          ? {
              kind: "set",
              path: ["checks", "toolbarLayout"],
              value: toolbarLayout,
            }
          : {
              kind: "append",
              path: ["checks", "toolbarLayout", "scopes"],
              item,
            },
      };
    }
    case "share": {
      if (scoped === undefined)
        throw new IdiomError("unreachable: a share law always has a scope");
      const member = shareSelector(law.subject, scoped);
      const invariants = list(checks, "invariants");
      const existing = invariants
        .map(record)
        .find(
          (item) =>
            item.share === law.share &&
            item.selector === member &&
            item.within === scoped,
        );
      if (existing !== undefined)
        throw new IdiomError(
          `checks.invariants already has ${JSON.stringify(existing.name ?? member)}; edit it in .idiom/project.json`,
        );
      const item = {
        name,
        optional: true,
        tolerance: law.tolerance,
        share: law.share,
        selector: member,
        within: scoped,
      };
      invariants.push(item);
      return {
        ...base,
        entry: item,
        edit: { kind: "append", path: ["checks", "invariants"], item },
      };
    }
  }
}

/**
 * The project file after a law's edit: a targeted append or set that leaves
 * the rest of the file as written when possible, else `value` re-serialised.
 */
export function lawEditText(
  before: string,
  edit: LawEdit,
  value: unknown,
): string {
  const inPlace =
    edit.kind === "append"
      ? appendJsonArrayItem(before, edit.path, edit.item)
      : setJsonValue(before, edit.path, edit.value);
  return inPlace !== undefined && isDeepStrictEqual(JSON.parse(inPlace), value)
    ? inPlace
    : `${JSON.stringify(value, null, 2)}\n`;
}
