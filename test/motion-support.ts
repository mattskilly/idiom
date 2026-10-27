import type {
  ActionTimeline,
  CheckTuple,
  ObservationArtifactV2,
  VisibleChange,
} from "../src/checks/types.js";
export const emptyObservation: ObservationArtifactV2 = {
  version: 2,
  viewport: { width: 800, height: 600 },
  document: {
    scrollWidth: 800,
    scrollHeight: 600,
    clientWidth: 800,
    clientHeight: 600,
  },
  elements: [],
  headings: [],
  tokens: { status: "not-configured" },
  maskMembership: [],
};
export function tupleFor(observations: ObservationArtifactV2): CheckTuple {
  return {
    flow: "motion",
    state: "closed",
    viewport: "desktop",
    width: 800,
    height: 600,
    metadataPath: "closed/desktop/metadata.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-10-23T00:00:00.000Z",
    console: [],
    mismatches: [],
    observations,
  };
}

export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("missing fixture value");
  return value;
}

export const swap: VisibleChange = {
  selector: "#panel-2",
  container: "#panels",
  containerName: "Project panels",
  kind: "content-swap",
  key: "content-swap|#panels",
  direction: "in",
  before: null,
  after: { x: 0, y: 100, width: 600, height: 200 },
  extent: 200,
  textOnly: false,
  animations: [],
  progressive: false,
};
export type Animation = ActionTimeline["animations"][number];
export const fade: Animation = {
  target: "#panel-2",
  kind: "animation",
  properties: ["opacity"],
  durationMs: 150,
  delayMs: 0,
  iterations: 1,
  startTime: 10,
  endTime: 160,
};
