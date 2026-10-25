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

/**
 * Browser-default form controls beside the product's own styled versions of
 * the same control. Judged against the product itself: an app that uses
 * native selects everywhere is consistent and is not reported.
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
    return ran(this.id, candidates);
  },
};
