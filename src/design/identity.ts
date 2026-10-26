import { createHash } from "node:crypto";
import type { CheckTuple } from "../checks/types.js";
import { designEvidenceProblem, tupleDesigns } from "./evidence.js";
import { contentElements, isFigma, normalizeText } from "./match.js";
import { normalizeColor, normalizeFamily } from "./measure.js";
import type { LoadedDesign } from "./types.js";
/** Intended rendered content, independent of source ports, timestamps and probes. */
export function designIdentity(tuple: CheckTuple): string | undefined {
  const designs = tupleDesigns(tuple);
  if (designEvidenceProblem(tuple) || !designs.length) return undefined;
  const identities: string[] = [];
  for (const design of designs) {
    const identity = referenceIdentity(design);
    if (identity === undefined) return undefined;
    identities.push(identity);
  }
  // One reference hashes exactly as before several were possible.
  return identities.length === 1
    ? identities[0]
    : createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}
function referenceIdentity(design: LoadedDesign): string | undefined {
  const resolved = design.descriptor.resolved;
  if (resolved?.kind === "image")
    return createHash("sha256")
      .update(
        JSON.stringify({
          kind: "image",
          sha256: resolved.sha256,
          viewport: {
            width: design.descriptor.coordinate.width,
            height: design.descriptor.coordinate.height,
          },
          scheme: design.descriptor.coordinate.colorScheme,
        }),
      )
      .digest("hex");
  if (design.observations?.version !== 2) return undefined;
  const elements = contentElements(design.observations).map((e) => ({
    path: e.structuralPath,
    node: e.signals?.nodeId,
    name: e.attributes["data-idiom-name"],
    ...(isFigma(e) ? { figma: e.attributes["data-figma-id"] } : {}),
    role: e.signals?.role,
    accessibleName: normalizeText(e.signals?.name ?? ""),
    text: normalizeText(e.directText),
    rect: e.rect,
    styles: Object.fromEntries(
      Object.entries(e.styles)
        .filter(([key]) =>
          /^(?:border|font|lineHeight|color|backgroundColor|fill|stroke)/.test(
            key,
          ),
        )
        .map(([key, value]) => [
          key,
          /Color$|^(?:color|fill|stroke)$/.test(key)
            ? normalizeColor(value as string)
            : key === "fontFamily"
              ? normalizeFamily(value as string)
              : value,
        ]),
    ),
  }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        viewport: design.observations.viewport,
        scheme: design.descriptor.coordinate.colorScheme,
        ...(design.descriptor.figma
          ? { figmaVersion: design.descriptor.figma.version }
          : {}),
        elements,
      }),
    )
    .digest("hex");
}
