import type {
  CheckTuple,
  ElementSignals,
  ExpandedObservedStyles,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";

export const styles: ExpandedObservedStyles = {
  color: "rgb(29, 35, 48)",
  backgroundColor: "rgb(255, 255, 255)",
  borderTopColor: "rgb(201, 206, 216)",
  borderRightColor: "rgb(201, 206, 216)",
  borderBottomColor: "rgb(201, 206, 216)",
  borderLeftColor: "rgb(201, 206, 216)",
  borderTopWidth: "1px",
  borderRightWidth: "1px",
  borderBottomWidth: "1px",
  borderLeftWidth: "1px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  fill: "none",
  stroke: "none",
  borderTopLeftRadius: "6px",
  borderTopRightRadius: "6px",
  borderBottomRightRadius: "6px",
  borderBottomLeftRadius: "6px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
  display: "block",
  visibility: "visible",
  opacity: "1",
  fontFamily: "sans-serif",
  fontSize: "15px",
  fontWeight: "400",
  lineHeight: "normal",
  letterSpacing: "normal",
  textAlign: "left",
  textDecorationLine: "none",
  textTransform: "none",
  whiteSpace: "normal",
  wordBreak: "normal",
  paddingTop: "8px",
  paddingRight: "12px",
  paddingBottom: "8px",
  paddingLeft: "12px",
  marginTop: "0px",
  marginRight: "0px",
  marginBottom: "0px",
  marginLeft: "0px",
  gap: "normal",
  flexDirection: "row",
  justifyContent: "normal",
  alignItems: "normal",
  gridTemplateColumns: "none",
  boxShadow: "none",
  transform: "none",
  zIndex: "auto",
};

export function signals(
  overrides: Partial<ElementSignals> = {},
): ElementSignals {
  return {
    role: "button",
    name: "",
    described: false,
    appearance: "auto",
    cursor: "default",
    hasGraphic: false,
    lineCount: 1,
    contentBox: { x: 0, y: 0, width: 0, height: 0 },
    transition: "all 0s",
    animation: "none 0s",
    focused: false,
    repeatedItem: false,
    ...overrides,
  };
}

export function element(
  selector: string,
  overrides: Partial<Omit<ObservedElementV2, "signals">> & {
    signals?: Partial<ElementSignals>;
  } = {},
): ObservedElementV2 {
  const rect = overrides.rect ?? { x: 0, y: 0, width: 200, height: 32 };
  const { signals: signalOverrides, ...rest } = overrides;
  return {
    selector,
    tag: "input",
    text: "",
    visible: true,
    interactive: true,
    enabled: true,
    scrollWidth: rect.width,
    scrollHeight: rect.height,
    clientWidth: rect.width,
    clientHeight: rect.height,
    outOfFlow: false,
    ancestorSelectors: [],
    hitTestWith: [],
    structuralPath: `html[0]/body[0]/${selector}`,
    directText: "",
    attributes: {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: rect,
    styles,
    ...rest,
    rect,
    signals: signals(signalOverrides),
  };
}

export function observation(
  elements: ObservedElementV2[],
  extra: Partial<ObservationArtifactV2> = {},
): ObservationArtifactV2 {
  return {
    version: 2,
    viewport: { width: 1440, height: 900 },
    document: {
      scrollWidth: 1440,
      scrollHeight: 900,
      clientWidth: 1440,
      clientHeight: 900,
    },
    elements,
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
    overlaps: [],
    ...extra,
  };
}

export function tupleOf(
  observations: ObservationArtifactV2,
  state = "panel",
): CheckTuple {
  return {
    flow: "assistant",
    state,
    viewport: "desktop",
    width: 1440,
    height: 900,
    metadataPath: `${state}/desktop/metadata.json`,
    artifactPaths: [],
    commit: "abc123",
    createdAt: "2026-10-30T00:00:00.000Z",
    observations,
    console: [],
    mismatches: [],
  };
}
