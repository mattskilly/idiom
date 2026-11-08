import { ran, unavailable, verify } from "./shared.js";
import type {
  CheckContext,
  DeterministicCheck,
  DeterministicCheckId,
  DismissalMethod,
  FindingCandidate,
  ProbeDismissal,
  ProbeResult,
} from "./types.js";

const DISMISSAL_RULE = "idiom:popover-not-dismissed";
const FOCUS_RULE = "idiom:focus-not-returned";

/** The probe's dismissal blocks, or why the check cannot read them. */
function dismissals(
  id: DeterministicCheckId,
  tuple: CheckContext["tuple"],
):
  | { results: Array<{ result: ProbeResult; dismissal: ProbeDismissal }> }
  | { unavailable: ReturnType<typeof unavailable> } {
  const observation = tuple.observations;
  if (observation === undefined)
    return { unavailable: unavailable(id, "observations.json is unavailable") };
  if (observation.version !== 2 || observation.probe === undefined)
    return {
      unavailable: unavailable(
        id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      ),
    };
  if (observation.probe.dismissal === undefined)
    return {
      unavailable: unavailable(
        id,
        "the probe did not test dismissal (recapture, or checks.probe.disclosures is off)",
      ),
    };
  return {
    results: observation.probe.results.flatMap((result) =>
      result.dismissal === undefined ||
      result.reusedFrom !== undefined ||
      result.skipped !== undefined
        ? []
        : [{ result, dismissal: result.dismissal }],
    ),
  };
}

const actionOf: Record<DismissalMethod, string> = {
  escape: "pressing Escape",
  outside: "a click on an empty point outside it",
  iframe: "a click inside the iframe",
};

/**
 * An opened popover, menu or dialog that stays open after Escape, a click
 * on an empty point outside it, or a click inside an iframe on the page.
 * Measured by the probe, which tests each overlay it opens.
 */
export const popoverDismissalCheck: DeterministicCheck = {
  id: "popover-dismissal",
  run({ tuple }) {
    const read = dismissals(this.id, tuple);
    if ("unavailable" in read) return read.unavailable;
    const candidates: FindingCandidate[] = [];
    for (const { result, dismissal } of read.results) {
      for (const test of dismissal.tests) {
        if (test.outcome !== "stayed-open") continue;
        const name = result.name || dismissal.trigger;
        const frame =
          test.method === "iframe" && test.iframe
            ? ` ${test.iframe.name ? `"${test.iframe.name}" ` : ""}(${test.iframe.selector})`
            : "";
        const action = `${actionOf[test.method]}${frame}`;
        candidates.push({
          category: this.id,
          severity: "major",
          rule: DISMISSAL_RULE,
          selectorHint: dismissal.trigger,
          fingerprintHint: `${DISMISSAL_RULE}|${dismissal.trigger}|${dismissal.root}|${test.method}${test.iframe ? `|${test.iframe.selector}` : ""}`,
          explanation: `The ${dismissal.role ?? "panel"} "${name}" opens (${dismissal.root}) stayed open after ${action}, so it can only be closed through its own trigger or controls.`,
          acceptance: [
            `After ${action}, ${dismissal.root} is hidden and the trigger's aria-expanded is false.`,
          ],
          verification: verify(this.id, {
            trigger: dismissal.trigger,
            root: dismissal.root,
            method: test.method,
            ...(test.iframe ? { iframe: test.iframe } : {}),
          }),
        });
      }
    }
    return ran(this.id, candidates);
  },
};

/**
 * Escape closed an opened overlay but left focus somewhere other than the
 * control that opened it (often the page body), so keyboard users lose
 * their place.
 */
export const focusReturnCheck: DeterministicCheck = {
  id: "focus-return",
  run({ tuple }) {
    const read = dismissals(this.id, tuple);
    if ("unavailable" in read) return read.unavailable;
    const candidates: FindingCandidate[] = [];
    for (const { result, dismissal } of read.results) {
      const closedByEscape = dismissal.tests.find(
        (test) => test.method === "escape" && test.outcome === "closed",
      );
      const focus = closedByEscape?.focus;
      if (focus === undefined || focus.returned) continue;
      const name = result.name || dismissal.trigger;
      const where =
        focus.active === "body" ? "to the page body" : `to ${focus.active}`;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: FOCUS_RULE,
        selectorHint: dismissal.trigger,
        fingerprintHint: `${FOCUS_RULE}|${dismissal.trigger}|${dismissal.root}`,
        explanation: `Escape closes the ${dismissal.role ?? "panel"} "${name}" opens (${dismissal.root}), but focus goes ${where} instead of back to the control that opened it.`,
        acceptance: [
          `After Escape closes ${dismissal.root}, focus is on ${dismissal.trigger}.`,
        ],
        verification: verify(this.id, {
          trigger: dismissal.trigger,
          root: dismissal.root,
          active: focus.active,
          ...(focus.activeSelector === undefined
            ? {}
            : { activeSelector: focus.activeSelector }),
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
