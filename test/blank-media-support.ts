import type {
  LoadingStuckEvidence,
  VisualBlankEvidence,
  VisualBlankRecord,
} from "../src/checks/blank-schema.js";
import type { CheckTuple } from "../src/checks/types.js";
import { emptyObservation, tupleFor } from "./motion-support.js";

export function mediaRecord(
  changes: Partial<VisualBlankRecord> = {},
): VisualBlankRecord {
  return {
    selector: "#media",
    kind: "img",
    rect: { x: 0, y: 0, width: 204, height: 104 },
    interior: { x: 0, y: 0, width: 204, height: 104 },
    visible: { x: 0, y: 0, width: 204, height: 104 },
    scroll: { x: 0, y: 0 },
    opacity: 1,
    masked: false,
    overlay: { alpha: 0, coverage: 0 },
    ...changes,
  };
}
export function blankEvidence(records = [mediaRecord()]): VisualBlankEvidence {
  return {
    status: "ran",
    algorithm: "rgb16-v1",
    dominantThreshold: 0.995,
    opacityThreshold: 0.01,
    overlayAlphaThreshold: 0.98,
    bucketSize: 16,
    edgeInset: 2,
    swatchSelectors: [],
    records,
  };
}
export function loadingEvidence(
  changes: Partial<LoadingStuckEvidence> = {},
): LoadingStuckEvidence {
  return {
    status: "ran",
    windowMs: 5000,
    observedMs: 5000,
    intentional: false,
    records: [
      {
        selector: "#loading",
        identity: 0,
        kind: "spinner",
        ageMs: 5000,
        active: true,
        masked: false,
      },
    ],
    ...changes,
  };
}
export function evidenceTuple(
  evidence: {
    visualBlank?: VisualBlankEvidence;
    loadingStuck?: LoadingStuckEvidence;
  } = {},
): CheckTuple {
  return {
    ...tupleFor({ ...emptyObservation, ...evidence }),
    flow: "blank",
    state: "normal",
    platform: {
      platform: "test",
      architecture: "test",
      release: "test",
      browserVersion: "test",
    },
  };
}
