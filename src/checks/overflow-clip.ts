import { isElementPainted, paintedGate } from "./painted.js";
import { isVisuallyHidden, ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, ObservedElement } from "./types.js";

const mediaTags = new Set(["iframe", "img", "video", "canvas"]);

/** Own text: V2 records it directly; V1 only has the subtree's text. */
function ownText(element: ObservedElement): string {
  return (
    "directText" in element && typeof element.directText === "string"
      ? element.directText
      : element.text
  ).trim();
}

/** Visible children, by structural path or (V1) nearest ancestor selector. */
function childrenOf(
  parent: ObservedElement,
  elements: readonly ObservedElement[],
): ObservedElement[] {
  const path =
    "structuralPath" in parent && typeof parent.structuralPath === "string"
      ? parent.structuralPath
      : undefined;
  return elements.filter((element) => {
    if (!element.visible) return false;
    if (path !== undefined && "structuralPath" in element) {
      const child = String(element.structuralPath);
      return (
        child.startsWith(`${path}/`) &&
        !child.slice(path.length + 1).includes("/")
      );
    }
    return element.ancestorSelectors[0] === parent.selector;
  });
}

/** A replaced element, or a textless wrapper whose only child is one. */
function isMediaContent(
  element: ObservedElement,
  elements: readonly ObservedElement[],
): boolean {
  if (mediaTags.has(element.tag)) return true;
  if (ownText(element) !== "") return false;
  const children = childrenOf(element, elements);
  return children.length === 1 && mediaTags.has(children[0]?.tag ?? "");
}

export const overflowClipCheck: DeterministicCheck = {
  id: "overflow-clip",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    const gate = paintedGate(tuple, ["idiom:element-content-clipped"]);
    const candidates = [];
    const documentHorizontallyOverflows =
      observation.document.scrollWidth > observation.document.clientWidth + 1;
    if (documentHorizontallyOverflows) {
      candidates.push({
        category: this.id,
        severity: "major" as const,
        rule: "idiom:document-horizontal-overflow",
        documentScope: true,
        selectorHint: "document",
        explanation: `The document is ${observation.document.scrollWidth}px wide inside a ${observation.document.clientWidth}px viewport.`,
        acceptance: [
          "The document scroll width does not exceed its viewport width.",
        ],
        verification: verify(this.id, { selector: "document" }),
      });
    }
    for (const element of observation.elements) {
      if (!element.visible || isVisuallyHidden(element)) continue;
      const documentRoot = ["html", "body"].includes(element.selector);
      const overflowX = element.scrollWidth - element.clientWidth;
      const overflowY = element.scrollHeight - element.clientHeight;
      const horizontal =
        !(documentHorizontallyOverflows && documentRoot) &&
        overflowX > 1 &&
        ["hidden", "clip"].includes(element.styles.overflowX) &&
        (element.styles.textOverflow === undefined ||
          element.styles.textOverflow === "clip");
      // A single-line box with overflow hidden routinely measures 1–2px of
      // line-box overhang below the glyphs; that is not clipped content.
      const singleLine =
        "signals" in element && element.signals !== undefined
          ? element.signals.lineCount <= 1
          : "whiteSpace" in element.styles &&
            element.styles.whiteSpace === "nowrap";
      const vertical =
        overflowY > (singleLine ? 2 : 1) &&
        ["hidden", "clip"].includes(element.styles.overflowY);
      if (!horizontal && !vertical) continue;
      const measured = `${horizontal ? `${overflowX}px wider` : ""}${horizontal && vertical ? ", " : ""}${vertical ? `${overflowY}px taller` : ""}`;
      // Text fields scroll their value by design. Their overflow is reported
      // only as a minor truncated-value finding, never as clipped layout.
      if (["input", "textarea", "select"].includes(element.tag)) {
        if (!horizontal || element.tag === "select") continue;
        candidates.push({
          category: this.id,
          severity: "minor" as const,
          rule: "idiom:input-value-truncated",
          selectorHint: element.selector,
          explanation: `${element.selector} shows a value ${overflowX}px wider than its ${element.clientWidth}px field, so part of the value is hidden until the field scrolls.`,
          acceptance: [
            `${element.selector} is wide enough for its expected values, or shows them in full elsewhere.`,
          ],
          verification: verify(this.id, { selector: element.selector }),
        });
        continue;
      }
      const ownerPainted = gate.allows(
        "idiom:element-content-clipped",
        element,
      );
      if (element.paintedContent !== undefined) {
        // Count each rejected contributor even when none survives.
        let hiddenContributor = false;
        for (const selector of element.paintedContent.selectors)
          if (!gate.allows("idiom:element-content-clipped", selector))
            hiddenContributor = true;
        const size = element.paintedContent;
        if (
          hiddenContributor &&
          !(horizontal && size.width > element.clientWidth + 1) &&
          !(
            vertical &&
            size.height > element.clientHeight + (singleLine ? 2 : 1)
          )
        )
          continue;
      }
      if (!ownerPainted) continue;
      // Crop-to-fit media (thumbnails, avatars, canvases) is the design, as is
      // a box marked data-idiom-crop. Text inside either is still judged by
      // clipped-text.
      if (ownText(element) === "") {
        const crop =
          "attributes" in element &&
          element.attributes["data-idiom-crop"] !== undefined;
        const children = childrenOf(
          element,
          observation.elements.filter(isElementPainted),
        );
        if (
          crop ||
          (children.length > 0 &&
            children.every((child) =>
              isMediaContent(
                child,
                observation.elements.filter(isElementPainted),
              ),
            ))
        )
          continue;
      }
      // Newer captures say what is cut off. Only decoration (a glow, a bleed,
      // an illustration, a marquee track) is the design, not lost content.
      const clipped = element.paintedContent?.clipped;
      if (
        clipped !== undefined &&
        clipped.text.length === 0 &&
        clipped.interactive.length === 0
      )
        continue;
      const cutText = clipped?.text[0];
      const cutControl = clipped?.interactive[0];
      const cut =
        cutText !== undefined
          ? `, cutting off text in ${cutText}`
          : cutControl !== undefined
            ? `, cutting off ${cutControl}`
            : "";
      candidates.push({
        category: this.id,
        severity: "major" as const,
        rule: "idiom:element-content-clipped",
        selectorHint: element.selector,
        explanation: `${element.selector} clips ${horizontal ? "horizontal" : "vertical"} content by ${measured} (${element.scrollWidth}×${element.scrollHeight}px content in ${element.clientWidth}×${element.clientHeight}px)${cut}.`,
        acceptance: [
          `${element.selector} exposes all of its rendered content without clipping.`,
        ],
        verification: verify(this.id, { selector: element.selector }),
      });
    }
    return gate.result(ran(this.id, candidates));
  },
};
