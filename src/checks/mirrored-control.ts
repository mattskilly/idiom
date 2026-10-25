import { px, round, signalledElements, unavailable, verify } from "./shared.js";
import type {
  CheckCoverage,
  DeterministicCheck,
  FindingCandidate,
  MirroredPair,
  ObservedElementV2,
  Rect,
} from "./types.js";

type Lookup = ReadonlyMap<string, ObservedElementV2>;

/** Along the mirror axis: x for a vertical mirror line, y for a horizontal one. */
type Span = { start: number; end: number; center: number };

function span(rect: Rect, axis: MirroredPair["axis"]): Span {
  const [start, size] =
    axis === "vertical" ? [rect.x, rect.width] : [rect.y, rect.height];
  return { start, end: start + size, center: start + size / 2 };
}

/**
 * The control's own panel: the outermost ancestor in the contiguous chain
 * that stays on the control's side of the midline between the two controls
 * and does not also contain the other control. A wrapper that spans the
 * canvas crosses the midline and ends the walk.
 */
function panelOf(
  control: ObservedElementV2,
  other: ObservedElementV2,
  side: "start" | "end",
  midline: number,
  axis: MirroredPair["axis"],
  bySelector: Lookup,
): ObservedElementV2 | undefined {
  const shared = new Set(other.ancestorSelectors);
  let panel: ObservedElementV2 | undefined;
  for (const selector of control.ancestorSelectors) {
    if (selector === other.selector || shared.has(selector)) break;
    const ancestor = bySelector.get(selector);
    if (
      ancestor === undefined ||
      ancestor.rect.width <= 0 ||
      ancestor.rect.height <= 0
    )
      continue;
    const extent = span(ancestor.rect, axis);
    const onSide =
      side === "start"
        ? extent.end <= midline + 0.5
        : extent.start >= midline - 0.5;
    if (!onSide) break;
    panel = ancestor;
  }
  return panel;
}

/**
 * Where the mirror line sits when a control has no panel of its own: the
 * centre of the two controls' nearest shared ancestor, else the viewport's.
 */
function mirrorAxis(
  a: ObservedElementV2,
  b: ObservedElementV2,
  axis: MirroredPair["axis"],
  bySelector: Lookup,
  viewport: { width: number; height: number },
): number {
  const shared = new Set(b.ancestorSelectors);
  for (const selector of a.ancestorSelectors) {
    if (!shared.has(selector)) continue;
    const ancestor = bySelector.get(selector);
    if (
      ancestor === undefined ||
      ancestor.rect.width <= 0 ||
      ancestor.rect.height <= 0
    )
      continue;
    return span(ancestor.rect, axis).center;
  }
  return (axis === "vertical" ? viewport.width : viewport.height) / 2;
}

type Kind = "icon" | "text glyph" | "icon + text" | "empty";

function kindOf(element: ObservedElementV2): Kind {
  const graphic = element.signals?.renderedContent?.graphic === true;
  const text = element.signals?.renderedContent?.text === true;
  if (graphic && text) return "icon + text";
  if (graphic) return "icon";
  return text ? "text glyph" : "empty";
}

function fontWeightNumber(value: string): number {
  if (value === "normal") return 400;
  if (value === "bold") return 700;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 400;
}

const size = (rect: Rect) => `${round(rect.width)}×${round(rect.height)}px`;

/**
 * Pairs the project declares as mirror images (a left drawer's « and an
 * inspector's ») render the same: same size, same kind of element, same
 * type, and each the same distance from the canvas-facing edge of its own
 * panel. Selectors are resolved at capture into selector marks.
 */
export const mirroredControlCheck: DeterministicCheck = {
  id: "mirrored-control",
  run({ tuple, config }) {
    const skipped = (reason: string) => ({
      coverage: { check: this.id, status: "skipped" as const, reason },
      candidates: [],
    });
    if (config.mirrored.length === 0)
      return skipped("no mirrored pairs configured (checks.mirrored)");
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2)
      return unavailable(
        this.id,
        "observations predate element signals (recapture)",
      );
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const marks = new Map(
      (observation.selectorMarks ?? [])
        .filter((mark) => mark.purpose === "mirrored")
        .map((mark) => [mark.selector, mark.matches]),
    );
    const notes: string[] = [];
    const unavailablePairs: string[] = [];
    const candidates: FindingCandidate[] = [];
    let compared = 0;

    const resolve = (
      pair: MirroredPair,
      selector: string,
    ): ObservedElementV2 | undefined => {
      const matches = marks.get(selector);
      if (matches === undefined) {
        notes.push(
          `"${pair.name}": ${selector} was not resolved at capture (recapture after adding checks.mirrored)`,
        );
        return undefined;
      }
      const element =
        matches[0] === undefined ? undefined : bySelector.get(matches[0]);
      if (element === undefined)
        notes.push(`"${pair.name}": ${selector} matches nothing`);
      return element;
    };

    for (const pair of config.mirrored) {
      const a = resolve(pair, pair.a);
      const b = resolve(pair, pair.b);
      if (a === undefined || b === undefined) continue;
      const pairUnavailable = (reason: string) => {
        unavailablePairs.push(`"${pair.name}": ${reason}`);
      };
      if (a.signals === undefined || b.signals === undefined) {
        pairUnavailable("mirrored controls lack element signals (recapture)");
        continue;
      }
      if (
        a.signals.renderedContent === undefined ||
        b.signals.renderedContent === undefined
      ) {
        pairUnavailable(
          "mirrored controls lack rendered-content signals (recapture)",
        );
        continue;
      }
      const textA = a.signals.renderedContent.textEvidence;
      const textB = b.signals.renderedContent.textEvidence;
      if (textA === undefined || textB === undefined) {
        pairUnavailable(
          "mirrored controls lack DOM/generated text font evidence (recapture)",
        );
        continue;
      }
      if (textA.status === "unavailable" || textB.status === "unavailable") {
        pairUnavailable(
          [textA, textB]
            .flatMap((evidence) =>
              evidence.status === "unavailable" ? [evidence.reason] : [],
            )
            .join("; "),
        );
        continue;
      }
      const spanA = span(a.rect, pair.axis);
      const spanB = span(b.rect, pair.axis);
      if (Math.abs(spanA.center - spanB.center) <= 1) {
        notes.push(`"${pair.name}": controls overlap on the mirror axis`);
        continue;
      }
      compared += 1;
      const aIsStart = spanA.center < spanB.center;
      const [start, end] = aIsStart ? [a, b] : [b, a];
      const [startSpan, endSpan] = aIsStart ? [spanA, spanB] : [spanB, spanA];
      const midline = (startSpan.center + endSpan.center) / 2;
      const startPanel = panelOf(
        start,
        end,
        "start",
        midline,
        pair.axis,
        bySelector,
      );
      const endPanel = panelOf(
        end,
        start,
        "end",
        midline,
        pair.axis,
        bySelector,
      );
      let startDistance: number;
      let endDistance: number;
      let reference: string;
      if (startPanel !== undefined && endPanel !== undefined) {
        startDistance = span(startPanel.rect, pair.axis).end - startSpan.end;
        endDistance = endSpan.start - span(endPanel.rect, pair.axis).start;
        reference = "its panel's canvas-facing edge";
      } else {
        const line = mirrorAxis(
          a,
          b,
          pair.axis,
          bySelector,
          observation.viewport,
        );
        startDistance = line - startSpan.end;
        endDistance = endSpan.start - line;
        reference = "the mirror axis";
      }
      const [distanceA, distanceB] = aIsStart
        ? [startDistance, endDistance]
        : [endDistance, startDistance];

      const differences: string[] = [];
      const details: string[] = [];
      if (
        Math.abs(a.rect.width - b.rect.width) > 1 ||
        Math.abs(a.rect.height - b.rect.height) > 1
      ) {
        differences.push("size");
        details.push(`${size(a.rect)} vs ${size(b.rect)}`);
      }
      const kindA = kindOf(a);
      const kindB = kindOf(b);
      if (kindA !== kindB) {
        differences.push("kind");
        details.push(`${kindA} vs ${kindB}`);
      }
      if (textA.font !== null && textB.font !== null) {
        const sizeA = px(textA.font.fontSize);
        const sizeB = px(textB.font.fontSize);
        const weightA = fontWeightNumber(textA.font.fontWeight);
        const weightB = fontWeightNumber(textB.font.fontWeight);
        if (Math.abs(sizeA - sizeB) > 0.5 || weightA !== weightB) {
          differences.push("font");
          details.push(
            `type ${round(sizeA)}px/${weightA} vs ${round(sizeB)}px/${weightB}`,
          );
        }
      }
      if (Math.abs(distanceA - distanceB) > 2) {
        differences.push("placement");
        details.push(
          `${round(distanceA)}px from ${reference} vs ${round(distanceB)}px`,
        );
      }
      if (differences.length === 0) continue;
      const panels =
        startPanel !== undefined && endPanel !== undefined
          ? aIsStart
            ? [startPanel.selector, endPanel.selector]
            : [endPanel.selector, startPanel.selector]
          : undefined;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:mirrored-asymmetry",
        selectorHint: b.selector,
        fingerprintHint: [...[pair.a, pair.b].sort(), pair.axis].join(" | "),
        explanation: `"${pair.name}" is declared mirrored, but ${pair.a} and ${pair.b} differ: ${details.join("; ")}.`,
        acceptance: [
          `"${pair.name}": ${pair.a} and ${pair.b} render at the same size, as the same kind of element, with the same type, each the same distance (±2px) from the canvas-facing edge of its own panel.`,
        ],
        verification: verify(this.id, {
          pair: pair.name,
          a: pair.a,
          b: pair.b,
          differences,
          distances: [round(distanceA), round(distanceB)],
          ...(panels === undefined ? {} : { panels }),
        }),
      });
    }

    const reason = [
      ...(notes.length === 0 ? [] : [`skipped: ${notes.join("; ")}`]),
      ...(unavailablePairs.length === 0
        ? []
        : [`unavailable: ${unavailablePairs.join("; ")}`]),
    ].join("; ");
    if (compared === 0) {
      if (unavailablePairs.length > 0) return unavailable(this.id, reason);
      return skipped(notes.join("; "));
    }
    const coverage: CheckCoverage = {
      check: this.id,
      status: "ran",
      ...(reason === "" ? {} : { reason }),
    };
    return { coverage, candidates };
  },
};
