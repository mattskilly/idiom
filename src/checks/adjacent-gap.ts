import {
  type Facing,
  isBounded,
  isVisuallyHidden,
  px,
  ran,
  relation,
  round,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type { DeterministicCheck, FindingCandidate, Rect } from "./types.js";

const excludedTags = new Set([
  "html",
  "body",
  "tr",
  "td",
  "th",
  "tbody",
  "thead",
  "tfoot",
  "table",
  "option",
  "label",
  "svg",
  "path",
  "img",
]);

const ringAllowance = 2;

function focusable(element: SignalledElement): boolean {
  return (
    element.interactive &&
    ["input", "textarea", "select", "button"].includes(element.tag)
  );
}

/** The box a viewer sees, including a focus ring when the element has one. */
function visibleBox(element: SignalledElement): Rect {
  let ring = 0;
  if (element.signals.focused) {
    // The ring is drawn outlineOffset beyond the border; older captures
    // lack the offset and measure the width alone.
    const outline =
      element.styles.outlineStyle !== undefined &&
      element.styles.outlineStyle !== "none"
        ? Math.max(
            0,
            px(element.styles.outlineWidth) + px(element.styles.outlineOffset),
          )
        : 0;
    const spread = element.styles.boxShadow.match(
      /(-?\d+(?:\.\d+)?)px\s*(?:inset)?\s*$/,
    );
    ring = Math.max(
      outline,
      element.styles.boxShadow !== "none" && spread ? Number(spread[1]) : 0,
      ringAllowance,
    );
  }
  return {
    x: element.rect.x - ring,
    y: element.rect.y - ring,
    width: element.rect.width + ring * 2,
    height: element.rect.height + ring * 2,
  };
}

function radius(value: string): number {
  return px(value.split(" ")[0]);
}

/** Joined groups (segmented controls, input groups) square their facing corners. */
function joined(
  first: SignalledElement,
  second: SignalledElement,
  axis: Facing,
): boolean {
  const [leading, trailing] =
    axis === "horizontal"
      ? first.rect.x <= second.rect.x
        ? [first, second]
        : [second, first]
      : first.rect.y <= second.rect.y
        ? [first, second]
        : [second, first];
  const leadingCorners =
    axis === "horizontal"
      ? [
          leading.styles.borderTopRightRadius,
          leading.styles.borderBottomRightRadius,
        ]
      : [
          leading.styles.borderBottomLeftRadius,
          leading.styles.borderBottomRightRadius,
        ];
  const trailingCorners =
    axis === "horizontal"
      ? [
          trailing.styles.borderTopLeftRadius,
          trailing.styles.borderBottomLeftRadius,
        ]
      : [
          trailing.styles.borderTopLeftRadius,
          trailing.styles.borderTopRightRadius,
        ];
  return [...leadingCorners, ...trailingCorners].every(
    (corner) => radius(corner) < 2,
  );
}

const regionTags = new Set([
  "nav",
  "main",
  "aside",
  "header",
  "footer",
  "section",
  "article",
  "form",
  "dialog",
]);

const regionRoles = new Set([
  "navigation",
  "main",
  "complementary",
  "banner",
  "contentinfo",
  "region",
  "dialog",
  "alertdialog",
  "tabpanel",
  "form",
  "search",
]);

const dialogRoles = new Set(["dialog", "alertdialog"]);

/**
 * Layout regions: landmarks, dialogs and their sections, and panels of
 * grouped fields (a box holding a heading, or a bounded group that itself
 * holds a control). They are laid flush by design, so they are never
 * compared; a control inside one is still measured through it.
 */
function regionTest(
  elements: readonly SignalledElement[],
  marked: ReadonlySet<string>,
): (element: SignalledElement) => boolean {
  const bySelector = new Map(
    elements.map((element) => [element.selector, element]),
  );
  const holdsHeading = new Set<string>();
  const holdsControl = new Set<string>();
  for (const element of elements) {
    const heading =
      element.headingLevel !== undefined ||
      element.attributes.role === "heading";
    if (!heading && !element.interactive) continue;
    for (const ancestor of element.ancestorSelectors) {
      if (heading) holdsHeading.add(ancestor);
      if (element.interactive) holdsControl.add(ancestor);
    }
  }
  // Bounded, non-interactive boxes holding a control: a group within a panel.
  const groups = new Set(
    [...holdsControl].filter((selector) => {
      const group = bySelector.get(selector);
      return group !== undefined && !group.interactive && isBounded(group);
    }),
  );
  const holdsGroup = new Set<string>();
  for (const selector of groups)
    for (const ancestor of bySelector.get(selector)?.ancestorSelectors ?? [])
      holdsGroup.add(ancestor);
  return (element) => {
    if (marked.has(element.selector)) return true;
    const role = element.attributes.role ?? "";
    if (regionTags.has(element.tag) || regionRoles.has(role)) return true;
    if (element.interactive) return false;
    const parent = bySelector.get(element.ancestorSelectors[0] ?? "");
    if (
      parent !== undefined &&
      (parent.tag === "dialog" || dialogRoles.has(parent.attributes.role ?? ""))
    )
      return true;
    return (
      holdsHeading.has(element.selector) || holdsGroup.has(element.selector)
    );
  };
}

/** The nearest element both sit inside. */
function sharedParent(first: SignalledElement, second: SignalledElement) {
  return (
    first.ancestorSelectors.find((selector) =>
      second.ancestorSelectors.includes(selector),
    ) ?? "body"
  );
}

/**
 * Two neighbouring controls or bordered shapes need air between them. A
 * focused field's ring counts as part of its box, because a ring that runs
 * into the send button is exactly what a person sees.
 *
 * Interactive controls are compared with each other wherever they sit. A
 * bordered shape is compared only within its own parent group or row, so
 * unrelated subtrees that happen to meet are not. Layout regions and small
 * non-interactive indicators (dots, badges) are never compared.
 */
export const adjacentGapCheck: DeterministicCheck = {
  id: "adjacent-gap",
  run({ tuple, config }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const observation = tuple.observations;
    const viewportArea =
      (observation?.viewport.width ?? 1) * (observation?.viewport.height ?? 1);
    const boxes = observed.elements.filter((element) => {
      if (isVisuallyHidden(element) || excludedTags.has(element.tag))
        return false;
      if (
        element.styles.display === "inline" ||
        element.styles.display === "contents"
      )
        return false;
      if (element.rect.width < 8 || element.rect.height < 8) return false;
      if (element.interactive) return true;
      return (
        isBounded(element) &&
        element.rect.width * element.rect.height < viewportArea * 0.25
      );
    });
    const selectors = new Set(boxes.map((box) => box.selector));
    const isRegion = regionTest(
      observed.elements,
      new Set(
        (observation?.version === 2 ? (observation.selectorMarks ?? []) : [])
          .filter((mark) => mark.purpose === "adjacent-region")
          .flatMap((mark) => mark.matches),
      ),
    );
    const { indicatorMax } = config.adjacentGap;
    const members = boxes.filter(
      (box) =>
        !isRegion(box) &&
        (box.interactive ||
          box.rect.width > indicatorMax ||
          box.rect.height > indicatorMax),
    );
    const candidates: FindingCandidate[] = [];
    const seen = new Set<string>();
    for (let left = 0; left < members.length; left += 1) {
      const first = members[left] as SignalledElement;
      for (let right = left + 1; right < members.length; right += 1) {
        const second = members[right] as SignalledElement;
        if (
          first.ancestorSelectors.includes(second.selector) ||
          second.ancestorSelectors.includes(first.selector)
        )
          continue;
        // Compare siblings at one level: a control inside a bounded wrapper
        // is measured through the wrapper, not twice.
        const firstWrapped = first.ancestorSelectors.some(
          (selector) =>
            selectors.has(selector) &&
            !second.ancestorSelectors.includes(selector),
        );
        const secondWrapped = second.ancestorSelectors.some(
          (selector) =>
            selectors.has(selector) &&
            !first.ancestorSelectors.includes(selector),
        );
        if (firstWrapped || secondWrapped) continue;
        // A shape is only compared within its own parent group or row.
        if (
          (!first.interactive || !second.interactive) &&
          first.ancestorSelectors[0] !== second.ancestorSelectors[0]
        )
          continue;
        if (
          !first.interactive &&
          !second.interactive &&
          !(isBounded(first) && isBounded(second))
        )
          continue;
        const firstBox = visibleBox(first);
        const secondBox = visibleBox(second);
        const related = relation(firstBox, secondBox);
        if (related === undefined) continue;
        const rest = relation(first.rect, second.rect);
        const ringed = first.signals.focused || second.signals.focused;
        const gap = related.gap;
        if (gap >= config.minGap || gap < -1.5) continue;
        if (
          !ringed &&
          (rest?.gap ?? gap) <= 2 &&
          joined(first, second, related.axis)
        )
          continue;
        // At rest a gap is only visible between two drawn edges, or between
        // a text field and a drawn neighbour its ring will meet on focus.
        const field = (element: SignalledElement) =>
          focusable(element) && ["input", "textarea"].includes(element.tag);
        if (
          !ringed &&
          !(isBounded(first) && isBounded(second)) &&
          !(field(first) && isBounded(second)) &&
          !(field(second) && isBounded(first))
        )
          continue;
        const key = [first.selector, second.selector].sort().join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        const measured = round(Math.max(0, gap));
        const parent = sharedParent(first, second);
        candidates.push({
          category: this.id,
          severity: gap <= 0.5 ? "major" : "minor",
          rule: ringed
            ? "idiom:focus-ring-collision"
            : "idiom:adjacent-elements-touch",
          selectorHint: first.selector,
          explanation: ringed
            ? `With focus, the ring of ${first.signals.focused ? first.selector : second.selector} comes within ${measured}px of ${first.signals.focused ? second.selector : first.selector} in ${parent} (minimum ${config.minGap}px).`
            : `${first.selector} and ${second.selector} sit ${measured}px apart ${related.axis === "horizontal" ? "side by side" : "stacked"} in ${parent}; neighbouring controls need at least ${config.minGap}px between them.`,
          acceptance: [
            `${first.selector} and ${second.selector} are separated by at least ${config.minGap}px, including any focus ring.`,
          ],
          verification: verify(this.id, {
            selector: first.selector,
            neighbour: second.selector,
            minimum: config.minGap,
            parent,
          }),
        });
      }
    }
    return ran(this.id, candidates);
  },
};
