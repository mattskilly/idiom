import { paintedGate } from "./painted.js";
import {
  isVisuallyHidden,
  ran,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

type Family = "select" | "checkbox" | "radio";

function nativeFamily(element: SignalledElement): Family | undefined {
  if (element.signals.appearance === "none") return undefined;
  if (element.tag === "select") return "select";
  if (element.tag !== "input") return undefined;
  const role = element.signals.role;
  if (role === "checkbox" || role === "radio") return role;
  return undefined;
}

function customFamily(element: SignalledElement): Family | undefined {
  const role = element.attributes.role ?? "";
  if (element.tag === "select" || element.tag === "input") {
    if (element.signals.appearance !== "none") return undefined;
    if (element.tag === "select") return "select";
    return element.signals.role === "radio"
      ? "radio"
      : element.signals.role === "checkbox"
        ? "checkbox"
        : undefined;
  }
  if (role === "combobox" || element.signals.haspopup === "listbox")
    return "select";
  if (role === "checkbox" || role === "switch") return "checkbox";
  if (role === "radio") return "radio";
  return undefined;
}

const label: Record<Family, string> = {
  select: "select menus",
  checkbox: "checkboxes",
  radio: "radio buttons",
};

const unstyledLabel: Record<string, string> = {
  file: 'file input shows the browser\'s own "Choose file" button and file-name label',
  date: "date input renders with the browser's default field and picker chrome",
  color: "colour input renders as the browser's default swatch button",
  range: "range input renders with the browser's default track and thumb",
};

/**
 * Two rules. `idiom:native-control-beside-custom`: browser-default form
 * controls beside the product's own styled versions of the same control,
 * judged against the product itself (an app that uses native selects
 * everywhere is consistent and is not reported). `idiom:native-control-unstyled`:
 * a `file`, `date`, `color` or `range` input painting the browser's default
 * chrome inside the product, with no styled replacement; an input hidden
 * behind a styled label is not painted and is not reported.
 *
 * The second rule exists because the first could never see an AI panel's
 * Attach menu with a raw "Choose file / No file chosen" control: it knew only
 * select, checkbox and radio families and fired only beside a styled sibling
 * of the same family, which a lone file input never has. The menu was also
 * never opened; revealed states now reach this check.
 */
export const nativeControlCheck: DeterministicCheck = {
  id: "native-control",
  run({ tuple }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const natives = new Map<Family, SignalledElement[]>();
    const customs = new Map<Family, number>();
    for (const element of observed.elements) {
      if (isVisuallyHidden(element)) continue;
      const native = nativeFamily(element);
      if (native !== undefined)
        natives.set(native, [...(natives.get(native) ?? []), element]);
      const custom = customFamily(element);
      if (custom !== undefined)
        customs.set(custom, (customs.get(custom) ?? 0) + 1);
    }
    const candidates: FindingCandidate[] = [];
    const gate = paintedGate(tuple, ["idiom:native-control-unstyled"]);
    for (const element of observed.elements) {
      const native = element.signals.nativeControl;
      if (native?.defaultStyled !== true) continue;
      if (isVisuallyHidden(element)) continue;
      if (!gate.allows("idiom:native-control-unstyled", element)) continue;
      if (Number(element.styles.opacity) <= 0.05) continue;
      if (element.rect.width < 8 || element.rect.height < 8) continue;
      candidates.push({
        category: this.id,
        severity: native.type === "file" ? "major" : "minor",
        rule: "idiom:native-control-unstyled",
        selectorHint: element.selector,
        explanation: `${element.selector}: a ${unstyledLabel[native.type]}, painted in the product's own chrome with no styled replacement.`,
        acceptance: [
          `${element.selector} is replaced with the product's styled control, or the input is hidden behind a styled label.`,
        ],
        verification: verify(this.id, {
          selector: element.selector,
          type: native.type,
        }),
      });
    }
    for (const [family, elements] of natives) {
      const styled = customs.get(family) ?? 0;
      if (styled === 0) continue;
      const first = elements[0];
      if (first === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:native-control-beside-custom",
        selectorHint: first.selector,
        explanation: `${elements.length} ${label[family]} render with the browser's default appearance (${elements
          .slice(0, 4)
          .map((element) => element.selector)
          .join(
            ", ",
          )}${elements.length > 4 ? ", …" : ""}) while ${styled} elsewhere in this view use the product's own styling.`,
        acceptance: [
          `Every ${label[family].replace(/s$/, "")} in this view uses the product's styled control, or the native ones are recorded as deliberate.`,
        ],
        verification: verify(this.id, { family }),
      });
    }
    return gate.result(ran(this.id, candidates));
  },
};
