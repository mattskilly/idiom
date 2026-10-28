import type { FindingCandidate } from "../../../src/checks/types.js";

export type MutationOperator = {
  id: string;
  category: string;
  check: FindingCandidate["category"];
  rule: string;
  target: "text" | "button" | "icon" | "pair" | "capability";
  styles?: Record<string, string>;
  lockBox?: boolean;
  attributes?: string[];
  setAttributes?: Record<string, string>;
  text?: string;
  capability?: string;
  probe?: boolean;
  axe?: boolean;
  narrow?: boolean;
  property?: string;
  value?: string;
  request?: string;
};

export const operators: MutationOperator[] = [
  {
    id: "low-contrast",
    category: "contrast",
    check: "contrast",
    rule: "axe:color-contrast",
    target: "text",
    styles: { color: "#bbbbbb", "background-color": "#ffffff" },
    axe: true,
  },
  {
    id: "small-target",
    category: "tap-target size",
    check: "target-size",
    rule: "idiom:minimum-target-size",
    target: "button",
    styles: {
      width: "20px",
      height: "20px",
      "min-width": "0",
      "min-height": "0",
      padding: "0",
      "font-size": "8px",
    },
    narrow: true,
  },
  {
    id: "off-scale-spacing",
    category: "spacing off scale",
    check: "scale-conformance",
    rule: "idiom:off-scale-spacing",
    target: "button",
    styles: { "padding-left": "37px" },
    property: "spacing",
    value: "37px",
  },
  {
    id: "off-scale-radius",
    category: "corner radius off scale",
    check: "scale-conformance",
    rule: "idiom:off-scale-radius",
    target: "button",
    styles: { "border-radius": "19px" },
    property: "radius",
    value: "19px",
  },
  {
    id: "off-centre-label",
    category: "text centring",
    check: "text-centering",
    rule: "idiom:label-off-centre",
    target: "button",
    lockBox: true,
    styles: {
      "padding-top": "22px",
      "padding-bottom": "0",
      "align-items": "center",
    },
  },
  {
    id: "touching-controls",
    category: "adjacent gap",
    check: "adjacent-gap",
    rule: "idiom:adjacent-elements-touch",
    target: "pair",
    styles: { gap: "0" },
  },
  {
    id: "unexplained-icon",
    category: "unexplained icon control",
    check: "unexplained-control",
    rule: "idiom:unexplained-control",
    target: "icon",
    // A nameless control is axe button-name's finding, not this rule's; leave
    // a glyph-only name so the seed is an icon that names but never explains.
    attributes: ["aria-describedby", "title", "data-tooltip", "data-state"],
    setAttributes: { "aria-label": "i" },
  },
  {
    id: "dead-button",
    category: "dead control",
    check: "dead-control",
    rule: "idiom:control-does-nothing",
    target: "capability",
    capability: "dead",
    probe: true,
  },
  {
    id: "retired-copy",
    category: "copy-lint",
    check: "copy-lint",
    rule: "idiom:retired-term",
    target: "text",
    text: "Style guide",
  },
  {
    id: "unreserved-load",
    category: "layout shift on load",
    check: "layout-shift",
    rule: "idiom:layout-shift",
    target: "capability",
    capability: "load",
    styles: { "min-height": "0" },
  },
  {
    id: "unreserved-interaction",
    category: "interaction shift",
    check: "interaction-shift",
    rule: "idiom:interaction-shift",
    target: "capability",
    capability: "interaction",
    probe: true,
    styles: { position: "static" },
  },
  {
    id: "missing-pending",
    category: "missing loading state",
    check: "loading-state-missing",
    rule: "idiom:loading-state-missing",
    target: "capability",
    capability: "loading",
    styles: { display: "none" },
    probe: true,
    request: "GET /api/items",
  },
  {
    id: "snapping-content",
    category: "motion snap",
    check: "motion",
    rule: "idiom:motion-snap",
    target: "capability",
    capability: "motion",
    styles: { transition: "none", animation: "none" },
    probe: true,
  },
  {
    id: "clipped-copy",
    category: "clipped text",
    check: "clipped-text",
    rule: "idiom:text-clipped",
    target: "text",
    styles: {
      width: "65px",
      "white-space": "nowrap",
      overflow: "hidden",
      "text-overflow": "clip",
    },
  },
];

/** Capabilities are fixture behavior contracts, never inferred from findings. */
export function capabilityFor(
  page: string,
  capability: string,
): string | undefined {
  const filename = page.split("/").at(-1);
  if (page.includes("/mutations/clean/")) {
    return (
      {
        "static.html": { dead: "#action" },
        "load.html": { load: "#promo-slot" },
        "interaction.html": { interaction: ".notice" },
        "loading.html": { loading: "#pending" },
        "motion.html": { motion: "#details" },
      } as Record<string, Record<string, string>>
    )[filename ?? ""]?.[capability];
  }
  if (
    page.endsWith("layout-shift-late-content/after.html") &&
    capability === "load"
  )
    return "#promo-slot";
  if (
    page.endsWith("interaction-shift-push/after.html") &&
    capability === "interaction"
  )
    return ".notice";
  if (page.endsWith("motion-accordion/after.html") && capability === "motion")
    return "#details";
  return undefined;
}

export type ExpectedIdentity = {
  check: MutationOperator["check"];
  rule: string;
  selectors: string[];
  property?: string;
  value?: string;
  request?: string;
  targetProperty?: string;
  actionName?: string;
  kind?: string;
};

/** Exact target plus aggregated property/request/surface, before fingerprinting. */
export function matchesExpected(
  candidate: FindingCandidate,
  expected: ExpectedIdentity,
  causeSelector?: string,
): boolean {
  if (candidate.category !== expected.check || candidate.rule !== expected.rule)
    return false;
  const params = candidate.verification.params ?? {};
  const targets = [
    causeSelector ?? candidate.selectorHint,
    params.selector,
    params.neighbour,
    params.surface,
    ...(Array.isArray(params.targets)
      ? params.targets.map(
          (target) => (target as { selector?: string }).selector,
        )
      : []),
  ];
  if (!expected.selectors.some((selector) => targets.includes(selector)))
    return false;
  if (
    expected.check === "adjacent-gap" &&
    !expected.selectors.every((selector) =>
      [params.selector, params.neighbour].includes(selector),
    )
  )
    return false;
  if (
    expected.property !== undefined &&
    (params.property !== expected.property ||
      String(params.value) !== expected.value)
  )
    return false;
  if (
    expected.targetProperty !== undefined &&
    (!Array.isArray(params.targets) ||
      !params.targets.some(
        (target) =>
          expected.selectors.includes(target.selector) &&
          target.property === expected.targetProperty,
      ))
  )
    return false;
  if (
    expected.actionName !== undefined &&
    (!Array.isArray(params.actions) ||
      !params.actions.some((action) => action.name === expected.actionName))
  )
    return false;
  if (expected.kind !== undefined && params.kind !== expected.kind)
    return false;
  if (
    expected.request !== undefined &&
    (!Array.isArray(params.requests) ||
      !params.requests.includes(expected.request))
  )
    return false;
  if (expected.check === "motion" && params.surface !== expected.selectors[0])
    return false;
  return true;
}

export type MutationAudit = {
  applicable: boolean;
  reason: string;
  selectors: string[];
  locus: string;
  pure: boolean;
  before: string;
  after: string;
};

/** Serializable DOM-only program. Runs before fixture load listeners on every replay. */
export function mutationProgram(input: {
  operator: MutationOperator;
  capability?: string | undefined;
  apply: boolean;
}): MutationAudit {
  const { operator, capability, apply } = input;
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth &&
      style.visibility === "visible" &&
      style.display !== "none"
    );
  };
  // Stable IDs make selection and the production selector agree across restores.
  const identified = [...document.querySelectorAll<HTMLElement>("[id]")].filter(
    (element) =>
      document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1 &&
      visible(element),
  );
  const buttons = identified.filter(
    (element) =>
      element.tagName === "BUTTON" &&
      !element.hasAttribute("disabled") &&
      element.children.length === 0 &&
      (element.textContent ?? "").trim() &&
      !element.hasAttribute("aria-expanded") &&
      (!operator.lockBox ||
        (getComputedStyle(element).transform === "none" &&
          getComputedStyle(element).translate === "none")) &&
      element.getBoundingClientRect().height >= 44 &&
      element.getBoundingClientRect().width >= 44,
  );
  let element: HTMLElement | undefined;
  let selectors: string[] = [];
  if (operator.target === "text")
    element = identified.find(
      (element) =>
        ["P", "H1", "H2", "SPAN"].includes(element.tagName) &&
        element.children.length === 0 &&
        (element.textContent ?? "").trim().length > 18,
    );
  if (operator.target === "button") element = buttons[0];
  if (operator.target === "icon")
    element = identified.find(
      (element) =>
        element.tagName === "BUTTON" &&
        !element.textContent?.trim() &&
        element.querySelector("svg") &&
        element.hasAttribute("aria-label") &&
        !element.hasAttribute("aria-labelledby"),
    );
  if (operator.target === "pair")
    element = identified.find((element) => {
      const children = [...element.children];
      const style = getComputedStyle(element);
      return (
        style.display === "flex" &&
        Number.parseFloat(style.gap) >= 8 &&
        children.length === 2 &&
        children.every(
          (child) =>
            child.id &&
            ["INPUT", "BUTTON"].includes(child.tagName) &&
            visible(child),
        )
      );
    });
  if (operator.target === "capability" && capability) {
    const matches = document.querySelectorAll<HTMLElement>(capability);
    if (matches.length === 1) element = matches[0];
    // An inserted notice has a future scoped locus; its handler is already present.
    if (
      operator.capability === "interaction" &&
      matches.length === 0 &&
      document.querySelector("#show")
    )
      element = document.body;
  }
  const before = document.documentElement.outerHTML;
  if (!element)
    return {
      applicable: false,
      reason:
        "No unique visible target satisfying the structural/behavior capability contract",
      selectors,
      locus: capability ?? operator.target,
      pure: true,
      before,
      after: before,
    };
  const locus = capability ?? `#${CSS.escape(element.id)}`;
  selectors =
    operator.target === "pair"
      ? [...element.children].map((child) => `#${CSS.escape(child.id)}`)
      : [locus];
  if (operator.capability === "load") selectors = ["aside.promo"];
  if (operator.capability === "interaction") selectors = ['div[role="status"]'];
  if (operator.capability === "loading") selectors = ["#load"];
  let pure = true;
  if (apply) {
    const original = element.cloneNode(true) as HTMLElement;
    const box = element.getBoundingClientRect();
    const styles: Record<string, string> = {
      ...operator.styles,
      ...(operator.lockBox
        ? {
            "box-sizing": "border-box",
            width: `${box.width}px`,
            height: `${box.height}px`,
          }
        : {}),
    };
    if (operator.capability === "interaction") {
      const style = document.createElement("style");
      style.textContent = `${locus}{position:static!important}`;
      document.head.append(style);
      const after = document.documentElement.outerHTML;
      style.remove();
      pure = before === document.documentElement.outerHTML;
      document.head.append(style);
      return {
        applicable: true,
        reason: "",
        selectors,
        locus,
        pure,
        before,
        after,
      };
    }
    for (const [property, value] of Object.entries(styles))
      element.style.setProperty(property, value, "important");
    if (operator.lockBox) {
      const changed = element.getBoundingClientRect();
      // Inline controls can move when their text baseline changes. Preserve
      // the measured hit box while changing only the label's inset.
      styles.translate = `${box.x - changed.x}px ${box.y - changed.y}px`;
      element.style.setProperty("translate", styles.translate, "important");
    }
    for (const attribute of operator.attributes ?? [])
      element.removeAttribute(attribute);
    for (const [attribute, value] of Object.entries(
      operator.setAttributes ?? {},
    ))
      element.setAttribute(attribute, value);
    if (operator.text !== undefined) element.textContent = operator.text;
    if (operator.capability === "dead") {
      const replacement = element.cloneNode(true) as HTMLElement;
      // Only addEventListener-owned, non-delegated clean-fixture controls qualify.
      element.replaceWith(replacement);
      element = replacement;
    }
    const after = document.documentElement.outerHTML;
    // Restore just the declared locus on a detached document to prove isolation.
    const copy = document.documentElement.cloneNode(true) as HTMLElement;
    copy.querySelector(locus)?.replaceWith(original);
    const permitted = original.cloneNode(true) as HTMLElement;
    for (const [property, value] of Object.entries(styles))
      permitted.style.setProperty(property, value, "important");
    for (const attribute of operator.attributes ?? [])
      permitted.removeAttribute(attribute);
    for (const [attribute, value] of Object.entries(
      operator.setAttributes ?? {},
    ))
      permitted.setAttribute(attribute, value);
    if (operator.text !== undefined) permitted.textContent = operator.text;
    pure =
      copy.outerHTML === before && permitted.outerHTML === element.outerHTML;
    return {
      applicable: true,
      reason: "",
      selectors,
      locus,
      pure,
      before,
      after,
    };
  }
  return {
    applicable: true,
    reason: "",
    selectors,
    locus,
    pure,
    before,
    after: before,
  };
}
