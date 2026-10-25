import { verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  MediaBand,
  MediaBands,
  MediaFrameObservation,
  RGB,
} from "./types.js";

type Edge = "top" | "bottom" | "left" | "right";
export type MediaDefect =
  | { kind: "blank"; color: RGB | undefined }
  | { kind: "letterbox"; edges: [Edge, Edge]; depth: number; color: RGB }
  | { kind: `band:${Edge}`; edge: Edge; depth: number; color: RGB };

const opposite: Array<[Edge, Edge]> = [
  ["top", "bottom"],
  ["left", "right"],
];
const edges: Edge[] = ["top", "bottom", "left", "right"];

function hex({ r, g, b }: RGB): string {
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function near(a: RGB, b: RGB, tolerance: number): boolean {
  return (
    Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) <=
    tolerance
  );
}

/** Classify one frame's measured bands against the configured threshold. */
export function classifyFrame(
  bands: MediaBands,
  bandThreshold: number,
  tolerance: number,
  backdrop?: RGB[],
): MediaDefect | undefined {
  // Only the backdrop showing through is a gap; content's own margins are not.
  const gap = (band: MediaBand | null): MediaBand | null =>
    band === null ||
    backdrop === undefined ||
    backdrop.some((color) => near(color, band.color, tolerance))
      ? band
      : null;
  bands = {
    ...bands,
    top: gap(bands.top),
    bottom: gap(bands.bottom),
    left: gap(bands.left),
    right: gap(bands.right),
    blank: bands.blank && gap(bands.top) !== null,
  };
  if (bands.blank) return { kind: "blank", color: bands.top?.color };
  for (const [a, b] of opposite) {
    const first = bands[a];
    const second = bands[b];
    if (
      first &&
      second &&
      first.depth >= bandThreshold / 2 &&
      second.depth >= bandThreshold / 2 &&
      near(first.color, second.color, tolerance)
    )
      return {
        kind: "letterbox",
        edges: [a, b],
        depth: Math.min(first.depth, second.depth),
        color: first.color,
      };
  }
  let deepest: { edge: Edge; band: MediaBand } | undefined;
  for (const edge of edges) {
    const band = bands[edge];
    if (
      band &&
      band.depth >= bandThreshold &&
      band.depth > (deepest?.band.depth ?? -1)
    )
      deepest = { edge, band };
  }
  return deepest === undefined
    ? undefined
    : {
        kind: `band:${deepest.edge}`,
        edge: deepest.edge,
        depth: deepest.band.depth,
        color: deepest.band.color,
      };
}

function describe(defect: MediaDefect): string {
  if (defect.kind === "blank")
    return `are a single solid ${defect.color ? hex(defect.color) : "colour"}: the frame shows no content`;
  if (defect.kind === "letterbox")
    return `are letterboxed with solid ${hex(defect.color)} bands at least ${Math.round(defect.depth * 100)}% deep at the ${defect.edges.join(" and ")}: the image does not fill its frame`;
  return `show a solid ${hex(defect.color)} band ${Math.round(defect.depth * 100)}% deep at the ${defect.edge}: the image does not fill its frame`;
}

export const mediaFillCheck: DeterministicCheck = {
  id: "media-fill",
  run({ tuple, config }) {
    const settings = config.mediaFill;
    if (!settings.auto)
      return {
        coverage: {
          check: this.id,
          status: "skipped",
          reason: "checks.mediaFill.auto is false",
        },
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation?.version !== 2 || observation.mediaFrames === undefined)
      return {
        coverage: {
          check: this.id,
          status: "unavailable",
          reason: "observations predate media frame sampling (recapture)",
        },
        candidates: [],
      };
    const tolerance = observation.mediaFill?.tolerance ?? settings.tolerance;
    const ignored = (frame: MediaFrameObservation) =>
      settings.ignore.some((selector) => frame.selector === selector);
    const notes: string[] = [];
    let unloaded = 0;
    let unmeasured = 0;
    const groups = new Map<
      string,
      {
        examined: number;
        defects: Array<{ frame: MediaFrameObservation; defect: MediaDefect }>;
      }
    >();
    for (const frame of observation.mediaFrames) {
      if (ignored(frame)) continue;
      if (!frame.loaded) {
        unloaded += 1;
        continue;
      }
      if (frame.bands === undefined || frame.bands.status !== "measured") {
        unmeasured += 1;
        continue;
      }
      const group = groups.get(frame.group) ?? { examined: 0, defects: [] };
      group.examined += 1;
      const defect = classifyFrame(
        frame.bands,
        settings.bandThreshold,
        tolerance,
        frame.backdrop,
      );
      if (defect) group.defects.push({ frame, defect });
      groups.set(frame.group, group);
    }
    if (unloaded > 0) notes.push(`${unloaded} images not loaded at capture`);
    if (unmeasured > 0)
      notes.push(`${unmeasured} frames not measured in the screenshot`);
    const candidates: FindingCandidate[] = [];
    let examined = 0;
    for (const [group, { examined: count, defects }] of groups) {
      examined += count;
      if (count < 3 || defects.length === 0) continue;
      // The commonest defect kind in the gallery speaks for it.
      const kinds = new Map<string, typeof defects>();
      for (const entry of defects)
        kinds.set(entry.defect.kind, [
          ...(kinds.get(entry.defect.kind) ?? []),
          entry,
        ]);
      const [kind, affected] = [...kinds].sort(
        (a, b) => b[1].length - a[1].length,
      )[0] as [string, typeof defects];
      const first = affected[0] as (typeof defects)[number];
      const systematic = affected.length >= 3 && affected.length * 2 >= count;
      candidates.push({
        category: this.id,
        severity: systematic ? "major" : "minor",
        rule: "idiom:media-fill",
        selectorHint: first.frame.selector,
        fingerprintHint: `media-fill:${group}:${kind}`,
        explanation: `${affected.length} of ${count} thumbnails in ${group} ${describe(first.defect)}.`,
        acceptance: [
          `Each thumbnail in ${group} fills its frame: no solid band ${Math.round(settings.bandThreshold * 100)}% or more deep at any edge, and no letterboxing.`,
        ],
        verification: verify(this.id, {
          group,
          selector: first.frame.selector,
          bandThreshold: settings.bandThreshold,
          tolerance,
          frames: affected.map(({ frame, defect }) => ({
            selector: frame.selector,
            frame: frame.frame,
            kind: defect.kind,
            ...("depth" in defect ? { depth: defect.depth } : {}),
          })),
        }),
      });
    }
    return {
      coverage: {
        check: this.id,
        status: "ran",
        reason: [
          `${examined} frames in ${groups.size} galleries examined`,
          ...notes,
        ].join("; "),
      },
      candidates,
    };
  },
};
