import { relativeLuminance, round, unavailable, verify } from "./shared.js";
import type {
  CheckResult,
  DeterministicCheck,
  FindingCandidate,
  FrameEdgeSample,
  RGB,
} from "./types.js";

type Measured = Extract<FrameEdgeSample, { status: "measured" }>;

function mix(top: RGB, alpha: number, below: RGB): RGB {
  return {
    r: top.r * alpha + below.r * (1 - alpha),
    g: top.g * alpha + below.g * (1 - alpha),
    b: top.b * alpha + below.b * (1 - alpha),
  };
}

const delta = (a: RGB, b: RGB) =>
  Math.abs(relativeLuminance(a) - relativeLuminance(b));

export type EdgeCues = {
  fill: number;
  border: number | undefined;
  shadow: number | undefined;
  borderUnavailable?: string | undefined;
  /** Shadow layers this edge could not judge. */
  shadowUnavailable?: string | undefined;
};

/**
 * Luminance separation one sampled edge shows by fill, border and shadow.
 * A cue is absent (undefined) when its paint cannot reach the boundary.
 */
export function edgeCues(sample: Measured): EdgeCues {
  const inside = sample.inside.color;
  const surround = sample.surround.color;
  const { border } = sample;
  const borderPaints =
    border.status !== "unavailable" &&
    border.width > 0 &&
    !["none", "hidden"].includes(border.style) &&
    border.alpha > 0;
  const shadows =
    sample.shadows.status === "measured" ? sample.shadows.layers : [];
  const missingShadowComposition =
    sample.shadows.status === "measured" &&
    sample.shadows.samples === undefined &&
    shadows.length > 1;
  const shadow = missingShadowComposition
    ? []
    : sample.shadows.status === "measured" &&
        sample.shadows.samples !== undefined
      ? sample.shadows.samples.map((paint) =>
          delta(paint.color, paint.backdrop),
        )
      : shadows
          .filter(
            (layer) => layer.extent > 0 && layer.alpha > 0 && !layer.clipped,
          )
          .map((layer) => {
            const backdrop = layer.inset ? inside : surround;
            return delta(
              layer.paint?.color ?? mix(layer.color, layer.alpha, backdrop),
              backdrop,
            );
          });
  return {
    fill: delta(inside, surround),
    border: borderPaints
      ? Math.max(
          delta(
            border.paint?.color ?? mix(border.color, border.alpha, inside),
            inside,
          ),
          delta(
            border.paint?.color ?? mix(border.color, border.alpha, surround),
            surround,
          ),
        )
      : undefined,
    shadow: shadow.length === 0 ? undefined : Math.max(...shadow),
    ...(border.status === "unavailable"
      ? { borderUnavailable: border.reason }
      : {}),
    ...(sample.shadows.status === "unavailable"
      ? { shadowUnavailable: sample.shadows.reason }
      : missingShadowComposition
        ? {
            shadowUnavailable:
              "multiple shadow layers lack composited samples (recapture)",
          }
        : {}),
  };
}

export type FrameVerdict =
  | { status: "visible"; side: FrameEdgeSample["side"]; cue: string }
  | {
      status: "invisible";
      samples: Array<{ sample: Measured; cues: EdgeCues }>;
    }
  | { status: "unknown"; reason: string };

/** Whether any exposed edge separates the frame from its surround. */
export function judgeFrame(
  edges: readonly FrameEdgeSample[],
  minDelta: number,
): FrameVerdict {
  const measured: Array<{ sample: Measured; cues: EdgeCues }> = [];
  const unknown: string[] = [];
  for (const sample of edges) {
    if (sample.status === "offscreen") continue;
    if (sample.status === "unavailable") {
      unknown.push(
        `${sample.side}: ${sample.reason}${sample.occluder === undefined ? "" : ` (${sample.occluder})`}`,
      );
      continue;
    }
    const cues = edgeCues(sample);
    const cue =
      cues.fill >= minDelta
        ? "fill"
        : (cues.border ?? 0) >= minDelta
          ? "border"
          : (cues.shadow ?? 0) >= minDelta
            ? "shadow"
            : undefined;
    if (cue !== undefined) return { status: "visible", side: sample.side, cue };
    if (cues.borderUnavailable !== undefined)
      unknown.push(`${sample.side}: ${cues.borderUnavailable}`);
    if (cues.shadowUnavailable !== undefined)
      unknown.push(`${sample.side}: ${cues.shadowUnavailable}`);
    measured.push({ sample, cues });
  }
  // An unmeasured edge could hold the only cue; do not assert its absence.
  if (unknown.length > 0)
    return {
      status: "unknown",
      reason: [...new Set(unknown)].slice(0, 3).join("; "),
    };
  if (measured.length === 0)
    return {
      status: "unknown",
      reason: "no frame edge is inside the viewport",
    };
  return { status: "invisible", samples: measured };
}

/**
 * The configured primary frame (checks.frame.selector) must stand apart from
 * what surrounds it: a fill luminance step, a painted border or a shadow.
 */
export const frameCheck: DeterministicCheck = {
  id: "frame",
  run({ tuple, config }): CheckResult {
    const selector = config.frame.selector;
    if (selector === undefined)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "checks.frame.selector is not configured",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2)
      return unavailable(
        this.id,
        "observations predate element signals (recapture)",
      );
    const mark = (observation.selectorMarks ?? []).find(
      (candidate) =>
        candidate.purpose === "frame" && candidate.selector === selector,
    );
    if (mark === undefined)
      return unavailable(
        this.id,
        `${selector} was not resolved at capture (recapture after setting checks.frame)`,
      );
    if (mark.invalid === true)
      return unavailable(this.id, `${selector} is not a valid CSS selector`);
    if (mark.matches.length === 0)
      return unavailable(this.id, `${selector} matches no rendered element`);
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const minDelta = config.frame.minLuminanceDelta;
    const notes: string[] = [];
    const candidates: FindingCandidate[] = [];
    let judged = 0;
    for (const match of [...new Set(mark.matches)].sort()) {
      const edges = bySelector.get(match)?.signals?.frameEdges;
      if (edges === undefined) {
        notes.push(`${match}: frame edges were not sampled (recapture)`);
        continue;
      }
      const verdict = judgeFrame(edges, minDelta);
      if (verdict.status === "unknown") {
        notes.push(`${match}: ${verdict.reason}`);
        continue;
      }
      judged += 1;
      if (verdict.status === "visible") continue;
      const bySide = new Map<string, (typeof verdict.samples)[number]>();
      for (const entry of verdict.samples)
        if (!bySide.has(entry.sample.side))
          bySide.set(entry.sample.side, entry);
      const lum = (color: RGB) => round(relativeLuminance(color), 3);
      const sides = [...bySide.values()].map(({ sample, cues }) => ({
        side: sample.side,
        inside: lum(sample.inside.color),
        surround: lum(sample.surround.color),
        delta: round(cues.fill, 3),
        surroundSources: sample.surround.sources,
        border: sample.border,
        shadows:
          sample.shadows.status === "measured" ? sample.shadows.layers : [],
        ...(sample.shadows.status === "measured" &&
        sample.shadows.samples !== undefined
          ? { shadowSamples: sample.shadows.samples }
          : {}),
      }));
      const first = sides[0];
      candidates.push({
        category: this.id,
        severity: "major",
        rule: "idiom:frame-separation",
        selectorHint: match,
        fingerprintHint: `frame:${selector}:${match}`,
        explanation: `frame ${match} does not stand apart from its surround on any visible edge: ${sides
          .map(
            (side) =>
              `${side.side} ${side.inside} inside vs ${side.surround} outside (Δ ${side.delta})`,
          )
          .join(
            ", ",
          )}${first === undefined ? "" : `, surround painted by ${first.surroundSources.join(", ")}`}; no border or shadow reaches Δ ${minDelta}.`,
        acceptance: [
          `${match} differs from its surround by luminance Δ ≥ ${minDelta}, or carries a visible border or shadow on at least one edge.`,
        ],
        verification: verify(this.id, {
          selector,
          match,
          minLuminanceDelta: minDelta,
          sides,
        }),
      });
    }
    const reason =
      notes.length === 0 ? undefined : notes.slice(0, 4).join("; ");
    return {
      coverage: {
        check: this.id,
        status: judged === 0 ? "unavailable" : "ran",
        ...(reason === undefined ? {} : { reason }),
      },
      candidates,
    };
  },
};
