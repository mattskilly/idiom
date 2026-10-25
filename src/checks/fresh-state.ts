import {
  isVisuallyHidden,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  SelectorMarkPurpose,
} from "./types.js";

const historyName = /^(?:undo|redo)\b/i;
const unsavedText = /\bunsaved\b/i;
// "No unsaved changes" is the correct first-load status, not a claim of
// prior work.
const negatedUnsaved =
  /\b(?:no|nothing|zero|0|without)\s+(?:\w+\s+)?unsaved\b/i;
const builtInUnsaved = {
  test: (text: string) => unsavedText.test(text) && !negatedUnsaved.test(text),
};

/**
 * On a state the flow declares fresh (first load, no prior interaction),
 * nothing may claim prior work: undo/redo start disabled and no "unsaved
 * changes" indicator shows. History persisted from an earlier session makes
 * Undo look live on a page nobody has touched.
 */
export const freshStateCheck: DeterministicCheck = {
  id: "fresh-state",
  run({ tuple, config }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2)
      return unavailable(
        this.id,
        "observations predate element signals (recapture)",
      );
    if (observation.fresh !== true)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason:
            'the state is not declared fresh (set "fresh": true on the state)',
        },
        candidates: [],
      };
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const marked = (purpose: SelectorMarkPurpose) =>
      new Set(
        (observation.selectorMarks ?? [])
          .filter((mark) => mark.purpose === purpose)
          .flatMap((mark) => mark.matches),
      );
    const historyMarks = marked("history");
    const unsavedMarks = marked("unsaved");
    const historyPatterns = [
      historyName,
      ...config.freshState.historyNames.map(
        (pattern) => new RegExp(pattern, "i"),
      ),
    ];
    const unsavedPatterns = [
      builtInUnsaved,
      ...config.freshState.unsavedPatterns.map(
        (pattern) => new RegExp(pattern, "i"),
      ),
    ];
    const candidates: FindingCandidate[] = [];

    const reported = new Set<string>();
    for (const element of observed.elements) {
      if (!element.interactive || isVisuallyHidden(element)) continue;
      if (element.ancestorSelectors.some((selector) => reported.has(selector)))
        continue;
      const names = [
        element.signals.name,
        element.signals.title,
        element.attributes["aria-label"],
      ].flatMap((name) =>
        name === undefined || name.trim() === "" ? [] : [name.trim()],
      );
      const history =
        historyMarks.has(element.selector) ||
        names.some((name) =>
          historyPatterns.some((pattern) => pattern.test(name)),
        );
      if (!history || !element.enabled) continue;
      reported.add(element.selector);
      const label = names[0] ?? element.text.trim();
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:fresh-history-enabled",
        selectorHint: element.selector,
        explanation: `${JSON.stringify(label)} (${element.selector}) is enabled on a fresh state; nothing has happened yet that it could undo or redo.`,
        acceptance: [
          `${element.selector} is disabled (or hidden) until there is history from this session.`,
        ],
        verification: verify(this.id, { selector: element.selector }),
      });
    }

    const indicators = new Set<string>();
    for (const element of observed.elements) {
      if (isVisuallyHidden(element)) continue;
      if (
        element.ancestorSelectors.some((selector) => indicators.has(selector))
      )
        continue;
      const texts = [
        element.directText,
        element.signals.title,
        element.attributes["aria-label"],
      ].flatMap((text) =>
        text === undefined || text.trim() === ""
          ? []
          : [text.replace(/\s+/g, " ").trim()],
      );
      const match = texts.find((text) =>
        unsavedPatterns.some((pattern) => pattern.test(text)),
      );
      if (match === undefined && !unsavedMarks.has(element.selector)) continue;
      indicators.add(element.selector);
      const shown = match ?? (element.text.trim() || "an unsaved indicator");
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:fresh-unsaved-indicator",
        selectorHint: element.selector,
        explanation: `${element.selector} shows ${JSON.stringify(shown.slice(0, 120))} on a fresh state; nothing has been edited yet, so nothing can be unsaved.`,
        acceptance: [
          `${element.selector} is absent on first load and appears only after an edit in this session.`,
        ],
        verification: verify(this.id, { selector: element.selector }),
      });
    }
    return ran(this.id, candidates);
  },
};
