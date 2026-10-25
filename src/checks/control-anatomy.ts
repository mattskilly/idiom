import {
  isVisuallyHidden,
  px,
  round,
  type SignalledElement,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  CheckCoverage,
  DeterministicCheck,
  FindingCandidate,
  Rect,
} from "./types.js";

/** The spec's tolerance: an icon more than 1px off its reference is reported. */
const ANATOMY_TOLERANCE = 1;

const chevronGlyphs = new Set(["▾", "▼", "⌄", "˅", "∨"]);

type Kind = "select" | "icon-button" | "segment";

type Mark = {
  /** Vertical centre of the icon/chevron. */
  centre: number;
  /** Measured size; absent when a glyph lacks captured text geometry. */
  rect?: Rect | undefined;
  source: "element" | "glyph" | "background";
};

export function isSelectLike(element: SignalledElement): boolean {
  if (element.tag === "select" || element.signals.role === "combobox")
    return true;
  const button = element.tag === "button" || element.signals.role === "button";
  return (
    button &&
    ["listbox", "menu", "true"].includes(
      (element.signals.haspopup ?? "").toLowerCase(),
    )
  );
}

function isGraphic(element: SignalledElement): boolean {
  const classes = (element.attributes.class ?? "").toLowerCase();
  return (
    ["svg", "img", "i"].includes(element.tag) ||
    classes.includes("icon") ||
    "data-icon" in element.attributes
  );
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

/**
 * Painted icon elements inside a control: svg roots, images, icon-font
 * glyphs and elements classed or marked as icons, 4–48px and within the
 * control's box. A wrapper that contains another graphic yields to it.
 */
function graphicsIn(
  control: SignalledElement,
  elements: readonly SignalledElement[],
): SignalledElement[] {
  const descendants = elements.filter(
    (element) =>
      element !== control &&
      element.ancestorSelectors.includes(control.selector),
  );
  const svgs = new Set(
    descendants
      .filter((element) => element.tag === "svg")
      .map((element) => element.selector),
  );
  const candidates = descendants.filter((element) => {
    if (isVisuallyHidden(element) || !isGraphic(element)) return false;
    const within = element.ancestorSelectors.slice(
      0,
      element.ancestorSelectors.indexOf(control.selector),
    );
    if (within.some((selector) => svgs.has(selector))) return false;
    const { width, height } = element.rect;
    if (width < 4 || height < 4 || width > 48 || height > 48) return false;
    return inside(element.rect, control.rect);
  });
  const selectors = new Set(candidates.map((element) => element.selector));
  return candidates.filter(
    (element) =>
      !candidates.some(
        (other) =>
          other !== element &&
          selectors.has(other.selector) &&
          other.ancestorSelectors.includes(element.selector),
      ),
  );
}

function nativeChevron(control: SignalledElement): boolean {
  return control.tag === "select" && control.signals.appearance !== "none";
}

/** Glyphs painted by an icon are graphics, rather than a control label. */
function hasVisibleLabel(
  control: SignalledElement,
  elements: readonly SignalledElement[],
): boolean {
  const content = control.signals.renderedContent;
  if (content?.text === false) return false;
  if (content?.directText === true) return true;
  const graphics = graphicsIn(control, elements);
  if (
    !graphics.some(
      (graphic) =>
        graphic.signals.renderedContent?.text ?? graphic.text.trim() !== "",
    )
  )
    return content?.text ?? control.text.trim() !== "";
  return elements.some(
    (element) =>
      element.ancestorSelectors.includes(control.selector) &&
      !isVisuallyHidden(element) &&
      (element.signals.renderedContent?.directText ??
        element.directText.trim() !== "") &&
      !graphics.some(
        (graphic) =>
          graphic === element ||
          element.ancestorSelectors.includes(graphic.selector),
      ),
  );
}

function chevronOf(
  control: SignalledElement,
  elements: readonly SignalledElement[],
): Mark | undefined {
  const candidates: Array<{ mark: Mark; right: number }> = graphicsIn(
    control,
    elements,
  ).map((graphic) => ({
    mark: {
      centre: graphic.rect.y + graphic.rect.height / 2,
      rect: graphic.rect,
      source: "element",
    },
    right: graphic.rect.x + graphic.rect.width,
  }));
  const glyphs = elements.filter(
    (element) =>
      element.ancestorSelectors.includes(control.selector) &&
      !isVisuallyHidden(element) &&
      inside(element.rect, control.rect) &&
      chevronGlyphs.has(element.directText.trim()) &&
      element.text.trim() === element.directText.trim(),
  );
  for (const glyph of glyphs) {
    const centre =
      glyph.signals.inkCenterY ??
      (glyph.signals.textRect === undefined
        ? undefined
        : glyph.signals.textRect.y + glyph.signals.textRect.height / 2);
    if (centre !== undefined) {
      const rect = glyph.signals.textRect ?? glyph.rect;
      candidates.push({
        mark: { centre, rect: glyph.signals.textRect, source: "glyph" },
        right: rect.x + rect.width,
      });
    }
  }
  const adornment = control.signals.adornment;
  if (adornment?.status === "measured")
    candidates.push({
      mark: {
        centre: adornment.rect.y + adornment.rect.height / 2,
        rect: adornment.rect,
        source: "background",
      },
      right: adornment.rect.x + adornment.rect.width,
    });
  // A leading icon can accompany a trailing DOM, glyph or painted chevron.
  return candidates.sort((left, right) => right.right - left.right)[0]?.mark;
}

function reference(
  control: SignalledElement,
  elements: readonly SignalledElement[],
  hasLabel: boolean,
): {
  centre: number;
  against: string;
} {
  const descendants = elements.filter((element) =>
    element.ancestorSelectors.includes(control.selector),
  );
  // Aggregate text geometry can follow a leading icon glyph or a clipped
  // screen-reader label. Use a label subtree whose geometry excludes both.
  const nonLabelText = descendants.filter(
    (element) =>
      (isGraphic(element) ||
        chevronGlyphs.has(element.directText.trim()) ||
        isVisuallyHidden(element)) &&
      (element.signals.renderedContent?.text || element.text.trim() !== ""),
  );
  const label = hasLabel
    ? [control, ...descendants].find(
        (element) =>
          !isVisuallyHidden(element) &&
          (element.signals.renderedContent?.text ??
            element.text.trim() !== "") &&
          !nonLabelText.some(
            (other) =>
              other === element ||
              other.ancestorSelectors.includes(element.selector) ||
              element.ancestorSelectors.includes(other.selector),
          ),
      )
    : undefined;
  const text = label?.text.trim().replace(/\s+/g, " ") ?? "";
  if (label?.signals.lineCount === 1 && label.signals.inkCenterY !== undefined)
    return {
      centre: label.signals.inkCenterY,
      against:
        text === "" || text.length > 40
          ? "label's ink centre"
          : `"${text}" label's ink centre`,
    };
  return {
    centre: control.rect.y + control.rect.height / 2,
    against: `vertical centre of its ${Math.round(control.rect.height)}px box`,
  };
}

type Offset = {
  control: SignalledElement;
  kind: Kind;
  offset: number;
  against: string;
};

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Each cluster's full spread is at most `tolerance`. */
function clusters<T>(
  members: T[],
  value: (member: T) => number,
  tolerance: number,
): T[][] {
  const sorted = [...members].sort((left, right) => value(left) - value(right));
  const result: T[][] = [];
  for (const member of sorted) {
    const last = result.at(-1);
    const minimum = last?.[0];
    if (
      last !== undefined &&
      minimum !== undefined &&
      value(member) - value(minimum) <= tolerance
    )
      last.push(member);
    else result.push([member]);
  }
  return result;
}

/**
 * Select chevrons, icon-button icons and segmented-control icons sit on the
 * control's label (its text ink centre) or, without a label, on the box's
 * vertical centre; sibling selects share inner padding and chevron size.
 */
export const controlAnatomyCheck: DeterministicCheck = {
  id: "control-anatomy",
  run({ tuple }) {
    const observed = signalledElements(tuple);
    if ("reason" in observed) return unavailable(this.id, observed.reason);
    const observation = tuple.observations;
    const elements = observed.elements;
    const bySelector = new Map(
      elements.map((element) => [element.selector, element]),
    );
    const visible = (element: SignalledElement) =>
      !isVisuallyHidden(element) &&
      element.rect.width > 0 &&
      element.rect.height > 0;
    const selects = elements.filter(
      (element) => visible(element) && isSelectLike(element),
    );
    if (
      selects.length > 0 &&
      selects.every(
        (element) =>
          element.signals.adornment === undefined &&
          graphicsIn(element, elements).length === 0,
      )
    )
      return unavailable(
        this.id,
        "observations predate the select chevron signal (recapture)",
      );
    const segmentSelectors = new Set(
      observation?.version === 2
        ? (observation.selectionGroups ?? []).flatMap((group) =>
            group.members.map((member) => member.selector),
          )
        : [],
    );
    const targets: Array<{ control: SignalledElement; kind: Kind }> = [];
    for (const element of elements) {
      if (!visible(element)) continue;
      if (isSelectLike(element)) {
        targets.push({ control: element, kind: "select" });
        continue;
      }
      const parent = bySelector.get(element.ancestorSelectors[0] ?? "");
      const segment =
        segmentSelectors.has(element.selector) ||
        (parent?.signals.role === "group" &&
          (element.tag === "button" ||
            ["radio", "tab"].includes(element.signals.role)));
      if (segment) {
        targets.push({ control: element, kind: "segment" });
        continue;
      }
      const content = element.signals.renderedContent;
      if (
        element.interactive &&
        content?.graphic === true &&
        !hasVisibleLabel(element, elements)
      )
        targets.push({ control: element, kind: "icon-button" });
    }

    let unmeasured = 0;
    const offsets: Offset[] = [];
    const chevrons = new Map<SignalledElement, Mark>();
    for (const { control, kind } of targets) {
      let mark: Mark | undefined;
      if (kind === "select") {
        if (nativeChevron(control)) continue;
        mark = chevronOf(control, elements);
        if (mark === undefined) {
          if (control.signals.adornment?.status === "unmeasured")
            unmeasured += 1;
          continue;
        }
        chevrons.set(control, mark);
      } else {
        const graphics = graphicsIn(control, elements);
        const [only] = graphics;
        if (graphics.length !== 1 || only === undefined) continue;
        mark = {
          centre: only.rect.y + only.rect.height / 2,
          rect: only.rect,
          source: "element",
        };
      }
      const { centre, against } = reference(
        control,
        elements,
        kind !== "icon-button" && hasVisibleLabel(control, elements),
      );
      const offset = mark.centre - centre;
      if (Math.abs(offset) > ANATOMY_TOLERANCE)
        offsets.push({ control, kind, offset, against });
    }

    const candidates: FindingCandidate[] = [];
    const groups = new Map<string, Offset[]>();
    for (const entry of offsets) {
      const key = [
        entry.kind,
        entry.control.tag,
        Math.round(entry.control.rect.height),
        Math.round(entry.offset * 2) / 2,
        entry.against,
      ].join("|");
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      const [first] = group;
      if (first === undefined) continue;
      const selectors = group.map(({ control }) => control.selector);
      const direction = first.offset > 0 ? "below" : "above";
      const what = first.kind === "select" ? "chevron" : "icon";
      const more =
        group.length > 1
          ? ` (${group.length} elements share this geometry: ${selectors.slice(0, 4).join(", ")}${selectors.length > 4 ? ", …" : ""})`
          : "";
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:icon-off-centre",
        selectorHint: first.control.selector,
        explanation: `The ${what} in ${first.control.selector} sits ${round(Math.abs(first.offset))}px ${direction} the ${first.against} (tolerance ${ANATOMY_TOLERANCE}px)${more}.`,
        acceptance: [
          `The ${what}'s vertical centre in ${first.control.selector} is within ${ANATOMY_TOLERANCE}px of the ${first.against}.`,
        ],
        verification: verify(this.id, {
          selector: first.control.selector,
          tolerance: ANATOMY_TOLERANCE,
        }),
      });
    }

    // Sibling selects: same parent (or, for singletons, same grandparent),
    // same height band.
    const byParent = new Map<string, SignalledElement[]>();
    for (const select of selects) {
      const key = select.ancestorSelectors[0] ?? "";
      byParent.set(key, [...(byParent.get(key) ?? []), select]);
    }
    const siblingGroups: Array<{
      container: string;
      members: SignalledElement[];
    }> = [];
    const byGrandparent = new Map<string, SignalledElement[]>();
    for (const [container, members] of byParent) {
      if (members.length > 1) {
        siblingGroups.push({ container, members });
        continue;
      }
      const [only] = members;
      const grandparent = only?.ancestorSelectors[1];
      if (only === undefined || grandparent === undefined) continue;
      byGrandparent.set(grandparent, [
        ...(byGrandparent.get(grandparent) ?? []),
        only,
      ]);
    }
    for (const [container, members] of byGrandparent)
      if (members.length > 1) siblingGroups.push({ container, members });
    const domOrder = (left: SignalledElement, right: SignalledElement) =>
      left.structuralPath.localeCompare(right.structuralPath);
    for (const { container, members: all } of siblingGroups) {
      const middle = median(all.map((member) => member.rect.height));
      const members = all
        .filter((member) => Math.abs(member.rect.height - middle) <= 2)
        .sort(domOrder);
      if (members.length < 2) continue;
      // Right padding depends on how the chevron is built: a child element
      // sits in the content box, a background in the padding. Measured
      // chevron dimensions are comparable across constructions.
      const construction = (member: SignalledElement) =>
        nativeChevron(member)
          ? "native"
          : (chevrons.get(member)?.source ?? "unmeasured");
      const properties: Array<{
        property: string;
        css: string;
        tolerance: number;
        sameConstruction: boolean;
        value: (member: SignalledElement) => number | undefined;
      }> = [
        {
          property: "paddingLeft",
          css: "padding-left",
          tolerance: 0.5,
          sameConstruction: false,
          value: (member) => px(member.styles.paddingLeft),
        },
        {
          property: "paddingRight",
          css: "padding-right",
          tolerance: 0.5,
          sameConstruction: true,
          value: (member) => px(member.styles.paddingRight),
        },
        {
          property: "chevronWidth",
          css: "chevron width",
          tolerance: 1,
          sameConstruction: false,
          value: (member) => chevrons.get(member)?.rect?.width,
        },
        {
          property: "chevronHeight",
          css: "chevron height",
          tolerance: 1,
          sameConstruction: false,
          value: (member) => chevrons.get(member)?.rect?.height,
        },
      ];
      const comparisons = properties.flatMap((entry) => {
        const measured = members.filter(
          (member) => entry.value(member) !== undefined,
        );
        if (!entry.sameConstruction) return [{ ...entry, measured }];
        const byConstruction = new Map<string, SignalledElement[]>();
        for (const member of measured)
          byConstruction.set(construction(member), [
            ...(byConstruction.get(construction(member)) ?? []),
            member,
          ]);
        return [...byConstruction.values()].map((group) => ({
          ...entry,
          measured: group,
        }));
      });
      for (const {
        property,
        css,
        tolerance,
        value,
        measured: measuredMembers,
      } of comparisons) {
        if (measuredMembers.length < 2) continue;
        const numberOf = (member: SignalledElement) => value(member) as number;
        const split = clusters(measuredMembers, numberOf, tolerance);
        if (split.length < 2) continue;
        const minority = [...split].sort(
          (left, right) =>
            left.length - right.length ||
            domOrder(
              [...right].sort(domOrder)[0] as SignalledElement,
              [...left].sort(domOrder)[0] as SignalledElement,
            ),
        )[0];
        const hint =
          minority === undefined ? undefined : [...minority].sort(domOrder)[0];
        if (hint === undefined) continue;
        const listing = split
          .map(
            (cluster) =>
              `${round(numberOf(cluster[0] as SignalledElement))}px (${[
                ...cluster,
              ]
                .sort(domOrder)
                .map((member) => member.selector)
                .join(", ")})`,
          )
          .join(", ");
        const selectors = measuredMembers
          .map((member) => member.selector)
          .sort();
        candidates.push({
          category: this.id,
          severity: "minor",
          rule: "idiom:sibling-select-inconsistent",
          selectorHint: hint.selector,
          fingerprintHint: `anatomy:${property}:${selectors.join(",")}`,
          explanation: `Sibling selects in ${container || "the page"} differ in ${css}: ${listing}.`,
          acceptance: [
            `Sibling selects in ${container || "the page"} share one ${css} (within ${tolerance}px).`,
          ],
          verification: verify(this.id, {
            property,
            selectors,
            tolerance,
          }),
        });
      }
    }

    const coverage: CheckCoverage = {
      check: this.id,
      status: "ran",
      ...(unmeasured === 0
        ? {}
        : {
            reason: `${unmeasured} select ${unmeasured === 1 ? "chevron" : "chevrons"} could not be measured (pseudo-element or unparsed background)`,
          }),
    };
    return { coverage, candidates };
  },
};
