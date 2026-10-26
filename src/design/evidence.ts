import type { CheckTuple } from "../checks/types.js";
import { contentElements } from "./match.js";
import type { LoadedDesign } from "./types.js";

/** Every loaded design reference of a tuple, in declaration order. */
export function tupleDesigns(tuple: CheckTuple): LoadedDesign[] {
  return tuple.designs ?? (tuple.design ? [tuple.design] : []);
}

/** Shared by review and verification: unavailable comparison cannot mean fixed. */
export function designEvidenceProblem(tuple: CheckTuple): string | undefined {
  const designs = tupleDesigns(tuple);
  if (!designs.length)
    return tuple.designNotApplicable ?? "no design declared at capture";
  if (tuple.failure) return `app capture failed: ${tuple.failure.message}`;
  if (tuple.mismatches.length)
    return "app capture expectations failed; reference comparison is unavailable";
  for (const design of designs) {
    const problem = referenceProblem(tuple, design);
    if (problem)
      return designs.length > 1 && design.descriptor.name
        ? `${design.descriptor.name}: ${problem}`
        : problem;
  }
  return undefined;
}
function referenceProblem(
  tuple: CheckTuple,
  design: LoadedDesign,
): string | undefined {
  if (design.unavailable || design.descriptor.status !== "captured")
    return (
      design.unavailable ?? design.descriptor.failure ?? "design capture failed"
    );
  if (design.descriptor.resolved?.kind === "image") {
    if (tuple.observations?.version !== 2)
      return "design image comparison requires V2 app observations; recapture";
    if (!tuple.screenshotPath || !design.screenshotPath || !design.regions)
      return "design image comparison screenshots or saved regions are unavailable; recapture";
    return undefined;
  }
  if (design.observations?.version !== 2 || tuple.observations?.version !== 2)
    return "design comparison requires V2 observations on both sides; recapture";
  if (!tuple.screenshotPath || !design.screenshotPath || !design.matches)
    return "design comparison screenshots or saved matches are unavailable; recapture";
  if (
    [design.observations, tuple.observations].some((observation) =>
      contentElements(observation).some(
        (element) =>
          (element.tag !== "html" && !element.signals) ||
          [
            element.styles.borderTopStyle,
            element.styles.borderRightStyle,
            element.styles.borderBottomStyle,
            element.styles.borderLeftStyle,
          ].some((value) => value === undefined),
      ),
    )
  )
    return "observations lack design comparison styles or element signals; recapture both sides";
  return undefined;
}
