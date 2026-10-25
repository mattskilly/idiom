import {
  isVisuallyHidden,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { CheckTuple, DeterministicCheck } from "./types.js";

/** A label a reader cannot decode: nothing, a lone glyph, or two symbols. */
export function isGlyphLabel(text: string): boolean {
  const trimmed = text.replace(/\s+/g, "");
  if (trimmed === "") return true;
  const characters = [...trimmed];
  if (characters.length === 1) return true;
  return characters.length <= 2 && !/[\p{L}\p{N}]{2}/u.test(trimmed);
}

const meaningful = (name: string, visible: string) =>
  name.trim() !== "" &&
  name.trim() !== visible.trim() &&
  /\p{L}{3,}/u.test(name);

/** Hover/focus records for this exact control (same selector and identity). */
function explanationRecords(
  tuple: CheckTuple,
  selector: string,
  controlId: string | undefined,
) {
  const records =
    tuple.observations?.version === 2
      ? (tuple.observations.explanations?.records ?? [])
      : [];
  return records.filter(
    (record) =>
      record.selector === selector &&
      record.controlId !== undefined &&
      record.controlId === controlId,
  );
}

const hasTooltip = (record: { tooltips: Array<{ text: string }> }) =>
  record.tooltips.some((tip) => tip.text.trim() !== "");

export const unexplainedControlCheck: DeterministicCheck = {
  id: "unexplained-control",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const visibleMode = config.explanation === "visible";
    if (
      visibleMode &&
      observed.elements.some(
        (element) =>
          element.interactive &&
          !isVisuallyHidden(element) &&
          element.signals.explanation === undefined,
      )
    )
      return unavailable(
        this.id,
        "Visible explanation evidence is missing; recapture with the current version.",
      );
    const candidates = [];
    for (const element of observed.elements) {
      if (!element.interactive || isVisuallyHidden(element)) continue;
      if (["input", "select", "textarea"].includes(element.tag)) continue;
      const { signals } = element;
      if (
        !["button", "link", ""].includes(signals.role) &&
        element.tag !== "summary"
      )
        continue;
      if (visibleMode && signals.explanation?.inViewport === false) continue;
      const visible = visibleMode
        ? (element.signals.explanation?.visibleText ?? "")
        : element.text;
      if (!isGlyphLabel(visible)) continue;
      if (!visibleMode && visible.trim() === "" && !signals.hasGraphic)
        continue;
      if (visibleMode) {
        const described = signals.explanation?.descriptions.some(
          (description) => description.text.trim() !== "",
        );
        const records = explanationRecords(
          tuple,
          element.selector,
          signals.explanation?.controlId,
        );
        const tooltip = (["hover", "focus"] as const).every((trigger) =>
          records.some(
            (record) =>
              record.trigger === trigger &&
              record.status === "observed" &&
              hasTooltip(record),
          ),
        );
        if (described || tooltip) continue;
        const enabled =
          element.enabled && signals.explanation?.nativeDisabled !== true;
        const label = visible.trim() === "" ? "an icon" : `"${visible.trim()}"`;
        candidates.push({
          category: this.id,
          severity: enabled ? ("major" as const) : ("minor" as const),
          rule: enabled
            ? "idiom:unexplained-control"
            : "idiom:unavailable-control-without-reason",
          selectorHint: element.selector,
          explanation: `${element.selector} shows ${label}${enabled ? "" : " disabled"}, with no visible label, visible description, or tooltip observed on both hover and focus. An accessible name or native title alone does not supply a visible explanation.`,
          acceptance: [
            `${element.selector} has a meaningful visible label, visible aria-describedby text, or a tooltip that appears on both hover and focus${enabled ? "." : " and explains why it is unavailable."}`,
          ],
          verification: verify(this.id, { selector: element.selector }),
        });
        continue;
      }
      const tooltip = signals.title !== undefined || signals.described;
      // A control with no accessible name at all is already an axe
      // button-name / link-name finding (a11y-label); this check is about
      // controls that have *something* but still do not explain themselves.
      if (signals.name.trim() === "" && !tooltip) continue;
      const label = visible.trim() === "" ? "an icon" : `"${visible.trim()}"`;
      if (!element.enabled) {
        if (tooltip || meaningful(signals.name, visible)) continue;
        candidates.push({
          category: this.id,
          severity: "minor" as const,
          rule: "idiom:unavailable-control-without-reason",
          selectorHint: element.selector,
          explanation: `${element.selector} shows ${label} disabled with no tooltip or description saying what it is or why it is unavailable.`,
          acceptance: [
            `${element.selector} explains itself and why it is unavailable (a tooltip, aria-describedby text, or visible copy), or is removed until it works.`,
          ],
          verification: verify(this.id, { selector: element.selector }),
        });
        continue;
      }
      if (tooltip || meaningful(signals.name, visible)) {
        // A painted text glyph ("?") explains nothing on screen, whatever its
        // accessible name or native title says. Report it only when the probe
        // sampled both hover and focus and neither showed a tooltip.
        const painted = signals.explanation?.visibleText;
        if (
          painted === undefined ||
          painted.trim() === "" ||
          !isGlyphLabel(painted) ||
          signals.explanation?.nativeDisabled === true ||
          signals.explanation?.descriptions.some(
            (description) => description.text.trim() !== "",
          )
        )
          continue;
        const records = explanationRecords(
          tuple,
          element.selector,
          signals.explanation?.controlId,
        ).filter((record) => record.status !== "unavailable");
        if (
          records.some(
            (record) => record.status === "observed" && hasTooltip(record),
          ) ||
          !(["hover", "focus"] as const).every((trigger) =>
            records.some((record) => record.trigger === trigger),
          )
        )
          continue;
        const glyph = painted.trim();
        candidates.push({
          category: this.id,
          severity: "minor" as const,
          rule: "idiom:unexplained-control",
          selectorHint: element.selector,
          explanation: `${element.selector} shows "${glyph}" with no painted label and no tooltip observed on hover or focus; its accessible name ${JSON.stringify(signals.name)}${signals.title === undefined ? " is" : " and native title are"} not visible.`,
          acceptance: [
            `${element.selector} has a visible label, painted aria-describedby text, or a tooltip that appears on hover and focus.`,
          ],
          verification: verify(this.id, { selector: element.selector }),
        });
        continue;
      }
      candidates.push({
        category: this.id,
        severity: "major" as const,
        rule: "idiom:unexplained-control",
        selectorHint: element.selector,
        explanation: `${element.selector} is a control labelled only ${label}${signals.name.trim() === "" ? " with no accessible name" : ` whose accessible name is just ${JSON.stringify(signals.name)}`}, and nothing (tooltip, description, visible copy) says what it does.`,
        acceptance: [
          `${element.selector} has a visible tooltip on hover and focus, or visible text, that names what it does.`,
          `${element.selector} has an accessible name describing its action.`,
        ],
        verification: verify(this.id, { selector: element.selector }),
      });
    }
    return ran(this.id, candidates);
  },
};
