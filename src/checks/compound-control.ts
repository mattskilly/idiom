import {
  interactiveAncestry,
  isVisuallyHidden,
  px,
  ran,
  relation,
  round,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate, Rect } from "./types.js";

const nonTextInputs = new Set([
  "checkbox",
  "radio",
  "range",
  "button",
  "submit",
  "reset",
  "color",
  "file",
  "hidden",
  "image",
]);

function isInputLike(element: SignalledElement): boolean {
  if (element.tag === "input")
    return !nonTextInputs.has(
      (element.attributes.type ?? "text").toLowerCase(),
    );
  return (
    element.tag === "textarea" ||
    element.signals.role === "textbox" ||
    element.signals.role === "spinbutton"
  );
}

function isSelectLike(element: SignalledElement): boolean {
  if (element.tag === "select" || element.signals.role === "combobox")
    return true;
  return (
    element.signals.role === "button" &&
    ["listbox", "menu", "true"].includes(
      (element.signals.haspopup ?? "").toLowerCase(),
    )
  );
}

function contains(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height
  );
}

type Adornment = {
  element: SignalledElement;
  input: SignalledElement;
  text: string;
  rect: Rect;
  side: "prefix" | "suffix";
};

/**
 * Compound controls (dogfooding request #70): a unit select beside an input
 * that already shows the same unit, and short adornments (units, prefixes)
 * painted over an input without keeping its padding.
 */
export const compoundControlCheck: DeterministicCheck = {
  id: "compound-control",
  run({ tuple, config }) {
    const settings = config.compoundControls;
    if (settings === undefined)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "checks.compoundControls is not configured",
        },
        candidates: [],
      };
    const signalled = signalledElements(tuple);
    if ("reason" in signalled) return unavailable(this.id, signalled.reason);
    const { elements } = signalled;
    const { tokenMax, minInset } = settings;
    const inInteractive = interactiveAncestry(elements);
    const inputs = elements.filter(isInputLike);
    const fieldGroups =
      tuple.observations?.version === 2
        ? (tuple.observations.fieldGroups ?? [])
        : [];
    const bySelector = new Map(
      elements.map((element) => [element.selector, element]),
    );
    const nameOf = (input: SignalledElement): string => {
      const group = fieldGroups.find((entry) =>
        entry.members.some(
          (member) =>
            member.role === "control" && member.selector === input.selector,
        ),
      );
      const label = group?.members.find((member) => member.role === "label");
      const element =
        label === undefined ? undefined : bySelector.get(label.selector);
      return (
        (element?.directText || element?.text || "").trim() ||
        input.signals.name ||
        input.selector
      );
    };

    const adornments: Adornment[] = elements.flatMap((element) => {
      if (inInteractive(element) || isVisuallyHidden(element)) return [];
      const text = element.directText.trim();
      if (
        text.length === 0 ||
        text.length > tokenMax ||
        /\s/.test(text) ||
        element.text.trim() !== text
      )
        return [];
      const rect = element.signals.textRect ?? element.rect;
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const input = inputs
        .filter(
          (candidate) =>
            candidate.selector !== element.selector &&
            !element.ancestorSelectors.includes(candidate.selector) &&
            !candidate.ancestorSelectors.includes(element.selector) &&
            contains(candidate.rect, x, y),
        )
        .sort(
          (a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height,
        )[0];
      if (input === undefined) return [];
      const side: Adornment["side"] =
        x > input.rect.x + input.rect.width / 2 ? "suffix" : "prefix";
      return [{ element, input, text, rect, side }];
    });

    const candidates: FindingCandidate[] = [];
    for (const adornment of adornments) {
      const { element, input, rect, side } = adornment;
      const styles = input.styles;
      const innerLeft = input.rect.x + px(styles.borderLeftWidth);
      const innerRight =
        input.rect.x + input.rect.width - px(styles.borderRightWidth);
      const suffix = side === "suffix";
      const gap = round(
        suffix ? innerRight - (rect.x + rect.width) : rect.x - innerLeft,
      );
      const required = Math.max(
        minInset,
        px(suffix ? styles.paddingLeft : styles.paddingRight),
      );
      const content = input.signals.contentBox;
      const contentOverlap = round(
        Math.min(content.x + content.width, rect.x + rect.width) -
          Math.max(content.x, rect.x),
      );
      const crosses = gap < 0;
      // A 1px allowance: offsets measured from the outer edge are common.
      const tight = gap < required - 1;
      const covers = contentOverlap > 0.5;
      if (!crosses && !tight && !covers) continue;
      const name = nameOf(input);
      const problem = crosses
        ? `crosses the input's border by ${round(-gap)}px`
        : tight
          ? `sits ${gap}px from the input's inner edge, closer than the ${required}px the input keeps around its own value`
          : `lies over the input's content box by ${contentOverlap}px, so typed text runs under it`;
      candidates.push({
        category: this.id,
        severity: crosses ? "major" : "minor",
        rule: "idiom:compound-control-adornment-inset",
        selectorHint: element.selector,
        fingerprintHint: `${input.selector} | ${element.selector}`,
        explanation: `The "${name}" field's "${adornment.text}" ${side} (${element.selector}) ${problem}.`,
        acceptance: [
          `The "${adornment.text}" ${side} sits at least ${required}px inside the input's border, and the input's ${suffix ? "right" : "left"} padding clears it.`,
        ],
        verification: verify(this.id, {
          input: input.selector,
          adornment: element.selector,
          side,
          gap,
          required,
          contentOverlap,
        }),
      });
    }

    const groupOf = new Map<string, number>();
    for (const [index, group] of fieldGroups.entries())
      for (const member of group.members)
        if (member.role === "control") groupOf.set(member.selector, index);
    const adjacent = (select: SignalledElement, input: SignalledElement) => {
      const shared = groupOf.get(select.selector);
      if (shared !== undefined && shared === groupOf.get(input.selector))
        return true;
      const near = input.ancestorSelectors.slice(0, 2);
      if (!select.ancestorSelectors.slice(0, 2).some((s) => near.includes(s)))
        return false;
      const facing = relation(input.rect, select.rect);
      return facing !== undefined && facing.gap <= 24;
    };
    const notes: string[] = [];
    for (const select of elements.filter(isSelectLike)) {
      if (select.signals.value === undefined && select.tag === "select") {
        notes.push(select.selector);
        continue;
      }
      const token = (select.signals.value ?? select.text).trim().toLowerCase();
      if (token.length === 0 || token.length > tokenMax || /\s/.test(token))
        continue;
      for (const adornment of adornments) {
        if (adornment.text.toLowerCase() !== token) continue;
        if (!adjacent(select, adornment.input)) continue;
        const name = nameOf(adornment.input);
        candidates.push({
          category: this.id,
          severity: "minor",
          rule: "idiom:compound-control-duplicate-token",
          selectorHint: select.selector,
          fingerprintHint: `${select.selector} | ${adornment.element.selector}`,
          explanation: `The "${name}" field shows "${adornment.text}" twice: in the unit select ${select.selector} and as a ${adornment.side} inside ${adornment.input.selector}; keep one.`,
          acceptance: [
            `The "${name}" field shows "${adornment.text}" once, either in the select or inside the input.`,
          ],
          verification: verify(this.id, {
            select: select.selector,
            input: adornment.input.selector,
            adornment: adornment.element.selector,
            token,
          }),
        });
      }
    }
    if (notes.length > 0)
      return {
        coverage: {
          check: this.id,
          status: "unavailable",
          reason: `recapture to read select values (${notes.join(", ")})`,
        },
        candidates,
      };
    return ran(this.id, candidates);
  },
};
