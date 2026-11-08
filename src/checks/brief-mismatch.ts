import {
  type BriefCheck,
  briefAssertionIdentity,
  briefAssertionsFor,
} from "../brief/assertions.js";
import {
  type BriefAssertion,
  type BriefAssertionForm,
  briefAssertionForm,
} from "../schemas/brief.js";
import {
  contrastRatio,
  effectiveBackground,
  notApplicable,
  parseColor,
  ran,
  round,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import { contains, displacements } from "./timeline.js";
import type {
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
  Rect,
} from "./types.js";

/** One element that breaks an assertion, with what was measured. */
export type BriefFailure = {
  /** The observed element, or the authored selector when nothing matched. */
  selector: string;
  detail: string;
  measured: unknown;
};

/**
 * One assertion judged on one tuple. `not-applicable` is a tuple the form
 * never measures (a desktop viewport for a touch assertion).
 */
export type BriefAssertionResult = {
  brief: BriefCheck;
  criterion: BriefCheck["criteria"][number];
  assertionIndex: number;
  assertion: BriefAssertion;
  form: BriefAssertionForm;
  outcome: "pass" | "mismatch" | "unmeasured" | "not-applicable";
  /**
   * On `unmeasured`, why. On `pass` or `mismatch`, an optional note about
   * matches that were not measured.
   */
  reason?: string | undefined;
  failures: BriefFailure[];
};

/** What judging an assertion reads from a tuple. */
export type BriefTuple = Pick<
  CheckTuple,
  "flow" | "state" | "viewport" | "observations" | "timelines"
>;

// Keep comparison geometry unrounded; preserve fractional CSS pixels in diagnostics.
const number = (value: number) => String(Number(value.toFixed(6)));

type Resolved =
  | { status: "ok"; elements: ObservedElementV2[] }
  | { status: "missing" }
  | { status: "unmeasured"; reason: string };

const sideWords = {
  top: "above",
  right: "right of",
  bottom: "below",
  left: "left of",
} as const;

/** How far `inner` extends past each side of `outer`, beyond the tolerance. */
function overflow(
  outer: Rect,
  inner: Rect,
  tolerance: number,
): Array<[keyof typeof sideWords, number]> {
  const sides: Array<[keyof typeof sideWords, number]> = [
    ["top", outer.y - inner.y],
    ["right", inner.x + inner.width - (outer.x + outer.width)],
    ["bottom", inner.y + inner.height - (outer.y + outer.height)],
    ["left", outer.x - inner.x],
  ];
  return sides.filter(([, distance]) => distance > tolerance);
}

function isTouch(tuple: BriefTuple): boolean {
  const input = v2Observations(tuple)?.input;
  return input?.hover === "none" || input?.pointer === "coarse";
}

/** Why an element is not visible at rest, or undefined when it is. */
function hiddenReason(
  element: ObservedElementV2,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
): string | undefined {
  for (const candidate of [
    element,
    ...element.ancestorSelectors.flatMap((selector) => {
      const ancestor = bySelector.get(selector);
      return ancestor === undefined ? [] : [ancestor];
    }),
  ]) {
    if (Number.parseFloat(candidate.styles.opacity) === 0)
      return candidate === element
        ? "opacity 0"
        : `opacity 0 on ${candidate.selector}`;
    if (candidate === element && candidate.styles.visibility === "hidden")
      return "visibility hidden";
    if (candidate.styles.display === "none")
      return candidate === element
        ? "display none"
        : `display none on ${candidate.selector}`;
  }
  if (element.rect.width <= 0 || element.rect.height <= 0) return "zero size";
  if (!element.visible) return "not rendered";
  return undefined;
}

function isSvg(
  element: ObservedElementV2,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
): boolean {
  return (
    element.tag === "svg" ||
    element.ancestorSelectors.some(
      (selector) => bySelector.get(selector)?.tag === "svg",
    )
  );
}

/** The painted foreground: an icon's stroke, else its fill, else the text colour. */
function foreground(
  element: ObservedElementV2,
  bySelector: ReadonlyMap<string, ObservedElementV2>,
) {
  const sources = isSvg(element, bySelector)
    ? [element.styles.stroke, element.styles.fill, element.styles.color]
    : [element.styles.color];
  for (const value of sources) {
    const color = parseColor(value);
    if (color !== undefined && color.a > 0.05) return color;
  }
  return undefined;
}

/**
 * Judge every eligible brief assertion that targets this tuple's flow and
 * state. Pure, so coverage can aggregate the same results across tuples.
 */
export function evaluateBriefAssertions(
  tuple: BriefTuple,
  briefs: readonly BriefCheck[],
): BriefAssertionResult[] {
  const targeted = briefAssertionsFor(briefs, tuple.flow, tuple.state);
  if (targeted.length === 0) return [];
  const observations = v2Observations(tuple);
  const bySelector = new Map(
    (observations?.elements ?? []).map((element) => [
      element.selector,
      element,
    ]),
  );
  const marks = (observations?.selectorMarks ?? []).filter(
    (mark) => mark.purpose === "brief",
  );
  const resolve = (selector: string): Resolved => {
    const mark = marks.find((entry) => entry.selector === selector);
    if (mark === undefined)
      return {
        status: "unmeasured",
        reason: `the capture predates the brief and did not measure ${selector}; recapture`,
      };
    if (mark.invalid === true)
      return { status: "unmeasured", reason: `invalid selector ${selector}` };
    if (mark.matches.length === 0) return { status: "missing" };
    const elements = mark.matches.map((match) => bySelector.get(match));
    if (elements.some((element) => element === undefined))
      return {
        status: "unmeasured",
        reason: `${selector} matched an element the capture did not observe`,
      };
    return { status: "ok", elements: elements as ObservedElementV2[] };
  };

  return targeted.map(({ brief, criterion, index, assertion }) => {
    const form = briefAssertionForm(assertion);
    const base = {
      brief,
      criterion,
      assertionIndex: index,
      assertion,
      form,
    };
    const unmeasured = (reason: string): BriefAssertionResult => ({
      ...base,
      outcome: "unmeasured",
      reason,
      failures: [],
    });
    const judged = (
      failures: BriefFailure[],
      reason?: string,
    ): BriefAssertionResult => ({
      ...base,
      outcome: failures.length === 0 ? "pass" : "mismatch",
      ...(reason === undefined ? {} : { reason }),
      failures,
    });
    const missing = (selector: string) =>
      judged([
        {
          selector,
          detail: `${selector} matched no elements`,
          measured: { matches: 0 },
        },
      ]);
    if (observations === undefined)
      return unmeasured(
        "the capture predates v2 observations; recapture to measure it",
      );
    if (form === "visibleWithoutHover" && !isTouch(tuple))
      return { ...base, outcome: "not-applicable", failures: [] };
    const subject = resolve(assertion.selector);
    if (subject.status === "unmeasured") return unmeasured(subject.reason);
    if (subject.status === "missing") return missing(assertion.selector);
    const tolerance = assertion.tolerance;
    const failures: BriefFailure[] = [];

    if ("sameSizeAs" in assertion) {
      const reference = resolve(assertion.sameSizeAs);
      if (reference.status === "unmeasured")
        return unmeasured(reference.reason);
      if (reference.status === "missing") return missing(assertion.sameSizeAs);
      const target = reference.elements[0] as ObservedElementV2;
      const axes =
        assertion.axis === "both"
          ? (["width", "height"] as const)
          : ([assertion.axis] as const);
      for (const element of subject.elements)
        for (const axis of axes) {
          const actual = element.rect[axis];
          const expected = target.rect[axis];
          if (Math.abs(actual - expected) <= tolerance) continue;
          failures.push({
            selector: element.selector,
            detail: `${assertion.selector} ${axis} ${number(actual)}, expected ${number(expected)} like ${assertion.sameSizeAs} (tolerance ${number(tolerance)})`,
            measured: { axis, actual, expected, reference: target.selector },
          });
        }
      return judged(failures);
    }

    if ("within" in assertion) {
      const container = resolve(assertion.within);
      if (container.status === "unmeasured")
        return unmeasured(container.reason);
      if (container.status === "missing") return missing(assertion.within);
      for (const element of subject.elements) {
        const candidates = container.elements.filter(
          (candidate) => candidate.selector !== element.selector,
        );
        // The nearest enclosing container when the subject sits inside one;
        // otherwise any container the subject fits within passes.
        const nearest = element.ancestorSelectors
          .map((selector) =>
            candidates.find((candidate) => candidate.selector === selector),
          )
          .find((candidate) => candidate !== undefined);
        const pool = nearest === undefined ? candidates : [nearest];
        if (
          pool.some((candidate) =>
            contains(candidate.rect, element.rect, tolerance),
          )
        )
          continue;
        // Report against the container closest in the tree (the tile in the
        // subject's own cell), then the one it overflows least.
        const kinship = (candidate: ObservedElementV2) => {
          const index = element.ancestorSelectors.findIndex((ancestor) =>
            candidate.ancestorSelectors.includes(ancestor),
          );
          return index === -1 ? Number.POSITIVE_INFINITY : index;
        };
        const spill = (sides: Array<[string, number]>) =>
          sides.reduce((sum, [, distance]) => sum + distance, 0);
        const closest = [...pool]
          .map((candidate) => ({
            candidate,
            kin: kinship(candidate),
            sides: overflow(candidate.rect, element.rect, tolerance),
          }))
          .sort(
            (left, right) =>
              left.kin - right.kin || spill(left.sides) - spill(right.sides),
          )[0];
        const sides = closest?.sides ?? [];
        failures.push({
          selector: element.selector,
          detail:
            sides.length === 0
              ? `${assertion.selector} is not inside ${assertion.within}`
              : `${assertion.selector} extends ${sides
                  .map(
                    ([side, distance]) =>
                      `${number(distance)}px ${sideWords[side]}`,
                  )
                  .join(" and ")} ${assertion.within}`,
          measured: {
            rect: element.rect,
            container: closest?.candidate.selector ?? null,
            containerRect: closest?.candidate.rect ?? null,
            overflow: Object.fromEntries(sides),
          },
        });
      }
      return judged(failures);
    }

    if ("visibleWithoutHover" in assertion) {
      for (const element of subject.elements) {
        const reason = hiddenReason(element, bySelector);
        if (reason === undefined) continue;
        failures.push({
          selector: element.selector,
          detail: `${assertion.selector} is hidden at rest on touch viewport ${tuple.viewport} (${reason})`,
          measured: { reason, viewport: tuple.viewport },
        });
      }
      return judged(failures);
    }

    if ("stableOnHover" in assertion) {
      const timelines = tuple.timelines;
      if (timelines === undefined || timelines.status === "unavailable")
        return unmeasured(
          `no hover probe reached ${assertion.selector}: action timelines are unavailable`,
        );
      const inside = (selector: string, root: string) =>
        selector === root ||
        bySelector.get(selector)?.ancestorSelectors.includes(root) === true;
      let reached = 0;
      for (const element of subject.elements)
        for (const action of timelines.actions) {
          if (action.source !== "probe-hover" || action.selector === undefined)
            continue;
          if (!inside(action.selector, element.selector)) continue;
          reached += 1;
          for (const moved of displacements(action)) {
            if (!moved.baseline || inside(moved.selector, element.selector))
              continue;
            if (moved.peak <= tolerance) continue;
            failures.push({
              selector: element.selector,
              detail: `hovering ${assertion.selector} moved ${moved.selector} ${number(moved.peak)}px`,
              measured: {
                hovered: action.selector,
                moved: moved.selector,
                peak: moved.peak,
              },
            });
          }
        }
      if (reached === 0)
        return unmeasured(`no hover probe reached ${assertion.selector}`);
      return judged(failures);
    }

    if ("minContrast" in assertion) {
      const skipped: string[] = [];
      for (const element of subject.elements) {
        const color = foreground(element, bySelector);
        if (color === undefined) {
          skipped.push(element.selector);
          continue;
        }
        const background = effectiveBackground(element, bySelector);
        const blend = (channel: "r" | "g" | "b") =>
          color[channel] * color.a + background[channel] * (1 - color.a);
        const ratio = contrastRatio(
          { r: blend("r"), g: blend("g"), b: blend("b") },
          background,
        );
        if (ratio >= assertion.minContrast) continue;
        failures.push({
          selector: element.selector,
          detail: `${assertion.selector} contrast ${number(round(ratio, 2))}:1, expected at least ${number(assertion.minContrast)}:1`,
          measured: { ratio, foreground: color, background },
        });
      }
      if (skipped.length === subject.elements.length)
        return unmeasured(`${assertion.selector} has no painted foreground`);
      return judged(
        failures,
        skipped.length === 0
          ? undefined
          : `${skipped.length} of ${subject.elements.length} ${assertion.selector} matches had no painted foreground and were not measured: ${skipped.join(", ")}`,
      );
    }

    for (const element of subject.elements)
      for (const axis of ["width", "height"] as const) {
        const expected = assertion[axis];
        if (expected === undefined) continue;
        const min = typeof expected === "number" ? expected : expected.min;
        const max = typeof expected === "number" ? expected : expected.max;
        const actual = element.rect[axis];
        if (actual >= min - tolerance && actual <= max + tolerance) continue;
        failures.push({
          selector: element.selector,
          detail: `${assertion.selector} ${axis} ${number(actual)}, expected ${typeof expected === "number" ? number(expected) : `${number(min)}–${number(max)}`} (tolerance ${number(tolerance)})`,
          measured: { axis, actual, expected },
        });
      }
    return judged(failures);
  });
}

/** The finding rule id for one brief assertion; the design asset lists the same ids. */
export function briefMismatchRuleId(
  slug: string,
  criterion: number,
  assertionIndex: number,
  assertion: BriefAssertion,
): string {
  return `idiom:brief-mismatch:${slug}:c${criterion}:a${assertionIndex}:${briefAssertionForm(assertion)}:${briefAssertionIdentity(assertion)}`;
}

/** Names the brief, and the design asset it came from when it did. */
export function briefLabel(brief: BriefCheck): string {
  return brief.source === undefined
    ? `Brief "${brief.title}" (${brief.slug})`
    : `Brief "${brief.title}" (${brief.slug}, design asset ${brief.source.name})`;
}

export const briefMismatchCheck: DeterministicCheck = {
  id: "brief-mismatch",
  run({ tuple, config }) {
    const briefs = config.briefs ?? [];
    if (briefAssertionsFor(briefs, tuple.flow, tuple.state).length === 0)
      return notApplicable(
        this.id,
        "no decided brief has an assertion for this state",
      );
    if (v2Observations(tuple) === undefined)
      return unavailable(
        this.id,
        "brief assertions need v2 observations; recapture to measure them",
      );
    const candidates: FindingCandidate[] = [];
    for (const result of evaluateBriefAssertions(tuple, briefs)) {
      const { brief, criterion, assertionIndex } = result;
      const identity = briefAssertionIdentity(result.assertion);
      for (const failure of result.failures)
        candidates.push({
          category: this.id,
          severity: "major",
          rule: briefMismatchRuleId(
            brief.slug,
            criterion.index,
            assertionIndex,
            result.assertion,
          ),
          selectorHint: failure.selector,
          explanation: `${briefLabel(brief)}, criterion "${criterion.statement}": ${failure.detail}`,
          acceptance: [`${criterion.statement} (brief ${brief.slug})`],
          verification: verify(this.id, {
            brief: brief.slug,
            criterion: criterion.index,
            assertion: assertionIndex,
            assertionIdentity: identity,
            selector: failure.selector,
            measured: failure.measured,
          }),
        });
    }
    return ran(this.id, candidates);
  },
};
