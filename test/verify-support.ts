import { createServer } from "node:net";
import { PNG } from "pngjs";
import type {
  ObservationArtifact,
  ObservedElement,
  ObservedElementV2,
  ObservedStyles,
} from "../src/checks/types.js";

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error === undefined ? accept() : reject(error))),
  );
  return address.port;
}

export function png(width = 2, height = 2, value = 255): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(value);
  return PNG.sync.write(image);
}

const styles: ObservedStyles = {
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgb(255, 255, 255)",
  borderTopColor: "rgb(0, 0, 0)",
  borderRightColor: "rgb(0, 0, 0)",
  borderBottomColor: "rgb(0, 0, 0)",
  borderLeftColor: "rgb(0, 0, 0)",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  outlineColor: "rgb(0, 0, 0)",
  outlineWidth: "0px",
  outlineStyle: "none",
  textOverflow: "clip",
  fill: "rgb(0, 0, 0)",
  stroke: "none",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  overflowX: "visible",
  overflowY: "visible",
  position: "static",
};

export function legacyElement(options: {
  selector: string;
  tag: string;
  text?: string;
  visible?: boolean;
  ancestors?: string[];
  y?: number;
  height?: number;
}): ObservedElement {
  return {
    selector: options.selector,
    tag: options.tag,
    text: options.text ?? "",
    visible: options.visible ?? true,
    interactive: false,
    enabled: true,
    rect: {
      x: 0,
      y: options.y ?? 0,
      width: 100,
      height: options.height ?? 20,
    },
    scrollWidth: 100,
    scrollHeight: 20,
    clientWidth: 100,
    clientHeight: 20,
    outOfFlow: false,
    ancestorSelectors: options.ancestors ?? [],
    authoredProperties: [],
    styles,
    hitTestWith: [],
  };
}

function expandedStyles(): ObservedElementV2["styles"] {
  return {
    ...styles,
    display: "block",
    visibility: "visible",
    opacity: "1",
    fontFamily: "system-ui",
    fontSize: "16px",
    fontWeight: "400",
    lineHeight: "24px",
    letterSpacing: "normal",
    textAlign: "start",
    textDecorationLine: "none",
    textTransform: "none",
    whiteSpace: "normal",
    wordBreak: "normal",
    paddingTop: "0px",
    paddingRight: "0px",
    paddingBottom: "0px",
    paddingLeft: "0px",
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
}

export function v2Element(options: {
  selector: string;
  tag: string;
  path: string;
  text?: string;
  visible?: boolean;
  attributes?: Record<string, string>;
  y?: number;
}): ObservedElementV2 {
  const base = legacyElement({
    selector: options.selector,
    tag: options.tag,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.visible === undefined ? {} : { visible: options.visible }),
    ...(options.y === undefined ? {} : { y: options.y }),
  });
  return {
    ...base,
    structuralPath: options.path,
    ...(base.visible ? { legacyRenderedPath: options.path } : {}),
    directText: options.text ?? "",
    attributes: options.attributes ?? {},
    temporal: false,
    stableIslandPath: "html[0]/body[0]",
    relativeRect: base.rect,
    styles: expandedStyles(),
  };
}

export function artifactV2(
  text: string,
  extras: ObservedElementV2[] = [],
): ObservationArtifact {
  return {
    version: 2,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [
      v2Element({ selector: "html", tag: "html", path: "html[0]" }),
      v2Element({ selector: "body", tag: "body", path: "html[0]/body[0]" }),
      v2Element({
        selector: "main",
        tag: "main",
        path: "html[0]/body[0]/main[0]",
        text,
        attributes: { class: "surface" },
      }),
      ...extras,
    ],
    headings: [],
    tokens: { status: "not-configured" },
    maskMembership: [],
  };
}
