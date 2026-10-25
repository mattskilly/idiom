import {
  colorDelta,
  isVisuallyHidden,
  ran,
  unavailable,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
  SelectionMember,
} from "./types.js";

type Value = string | undefined;

function stroke(value: string): { width: number; color: string } | undefined {
  if (value === "none") return undefined;
  const match = value.match(/^([\d.]+)px (.+)$/);
  return match === null
    ? { width: 0, color: value }
    : { width: Number(match[1]), color: match[2] ?? "" };
}

/** Whether two values of one decoration key look different to a reader. */
function differs(key: string, a: Value, b: Value, threshold: number): boolean {
  if (a === undefined || b === undefined) return a !== b;
  if (a === b) return false;
  const family = key.split(".").at(-1);
  switch (family) {
    case "bg":
    case "color":
    case "fill":
      return colorDelta(a, b) >= threshold;
    case "border":
    case "outline":
    case "stroke": {
      const left = stroke(a);
      const right = stroke(b);
      if (left === undefined || right === undefined) return left !== right;
      return (
        Math.abs(left.width - right.width) >= 1 ||
        colorDelta(left.color, right.color) >= threshold
      );
    }
    case "opacity":
      return Math.abs(Number(a) - Number(b)) >= 0.2;
    case "weight":
      return Math.abs(Number(a) - Number(b)) >= 200;
    default:
      return true;
  }
}

const families: Record<string, string> = {
  bg: "background",
  bgImage: "background",
  border: "border",
  outline: "outline",
  shadow: "box-shadow",
  color: "text colour",
  fill: "SVG fill",
  stroke: "SVG stroke",
  weight: "font weight",
  underline: "underline",
  opacity: "opacity",
  descendants: "indicator",
};

export const selectedStateCheck: DeterministicCheck = {
  id: "selected-state",
  run({ tuple, config }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2)
      return unavailable(
        this.id,
        "observations predate element signals (recapture)",
      );
    if (observation.selectionGroups === undefined)
      return unavailable(
        this.id,
        "observations predate selection-group signals (recapture)",
      );
    const threshold = config.selectedState.minColorDelta;
    const elements = new Map<string, ObservedElementV2>(
      observation.elements.map((element) => [element.selector, element]),
    );
    const shown = (member: SelectionMember) => {
      const element = elements.get(member.selector);
      return element?.visible === true && !isVisuallyHidden(element);
    };
    const nameOf = (member: SelectionMember) => {
      const name =
        elements.get(member.control)?.signals?.name ||
        elements.get(member.selector)?.signals?.name ||
        "";
      return name === "" ? member.selector : JSON.stringify(name.slice(0, 40));
    };
    const candidates: FindingCandidate[] = [];
    for (const group of observation.selectionGroups) {
      const members = group.members.filter(shown);
      if (members.length < 2) continue;
      const selected = members.filter((member) => member.selected);
      const unselected = members.filter((member) => !member.selected);
      const native = members.every((member) => member.source === "checked");
      const label = `${group.container} (${members
        .slice(0, 4)
        .map(nameOf)
        .join(", ")}${members.length > 4 ? ", …" : ""})`;
      const emit = (
        suffix: "none" | "multiple" | "invisible",
        severity: FindingCandidate["severity"],
        selectorHint: string,
        explanation: string,
        acceptance: string,
      ) =>
        candidates.push({
          category: this.id,
          severity,
          rule: `idiom:selected-state-${suffix}`,
          selectorHint,
          explanation,
          acceptance: [acceptance],
          verification: verify(this.id, {
            container: group.container,
            rule: suffix,
          }),
        });
      if (selected.length === 0) {
        // An empty listbox selection is valid; toolbars hold formatting toggles.
        const selectable =
          native ||
          (!["listbox", "toolbar"].includes(group.role) &&
            (["tablist", "radiogroup"].includes(group.role) ||
              (["", "group"].includes(group.role) &&
                members.every((member) =>
                  Object.hasOwn(
                    elements.get(member.control)?.attributes ?? {},
                    member.source,
                  ),
                ))));
        if (selectable)
          emit(
            "none",
            "minor",
            group.container,
            `none of the ${members.length} options in ${label} is marked selected.`,
            "One option in the group is marked selected (aria-selected, aria-checked, aria-pressed or checked) so the current value is shown.",
          );
        continue;
      }
      if (group.single && selected.length > 1) {
        emit(
          "multiple",
          "major",
          group.container,
          `${selected.length} of the ${members.length} options in single-select ${label} are marked selected: ${selected.map(nameOf).join(", ")}.`,
          "Exactly one option in a single-select group is marked selected.",
        );
        continue;
      }
      if (unselected.length === 0) continue;
      const keys = new Set(
        members.flatMap((member) => Object.keys(member.decoration)),
      );
      const compared = new Set<string>();
      const invisible = selected.find((member) => {
        if (member.nativeIndicator) return false;
        for (const key of keys) {
          const baseline = unselected[0]?.decoration[key];
          if (
            unselected.some((other) =>
              differs(key, baseline, other.decoration[key], threshold),
            )
          )
            continue;
          compared.add(families[key.split(".").at(-1) ?? key] ?? key);
          if (differs(key, member.decoration[key], baseline, threshold))
            return false;
        }
        return true;
      });
      if (invisible !== undefined)
        emit(
          "invisible",
          "major",
          invisible.selector,
          `the selected option ${nameOf(invisible)} in ${label} looks the same as the other ${unselected.length} of ${members.length} options; compared ${[...compared].sort().join(", ") || "no shared properties"}.`,
          "The selected option differs visibly from its siblings (border, background, outline, box-shadow, or an indicator), not only by ARIA state.",
        );
    }
    return ran(this.id, candidates);
  },
};
