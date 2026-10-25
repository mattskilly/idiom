import { isVisuallyHidden, unavailable, verify } from "./shared.js";
import type {
  CheckCoverage,
  DeterministicCheck,
  FindingCandidate,
  ObservedElementV2,
} from "./types.js";

const separators = /^[\s›>»/|·•]+|[\s›>»/|·•]+$/gu;

/** Collapse whitespace and trim breadcrumb separators; "" when nothing is left. */
export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, " ").replace(separators, "").trim();
}

const nodeIdOf = (element: ObservedElementV2) => element.signals?.nodeId;

/**
 * The label a surface shows for a node: its aria-label, else the text it
 * owns — its direct text plus that of descendants whose nearest node-id
 * owner is this element, so a tree row does not absorb its children.
 * Visually hidden elements and aria-hidden subtrees are skipped.
 */
export function ownLabel(
  owner: ObservedElementV2,
  elements: readonly ObservedElementV2[],
  bySelector: ReadonlyMap<string, ObservedElementV2>,
): string {
  const ariaLabel = owner.attributes["aria-label"]?.trim();
  if (ariaLabel) return normalizeLabel(ariaLabel);
  const hidden = (element: ObservedElementV2) =>
    !element.visible ||
    isVisuallyHidden(element) ||
    element.attributes["aria-hidden"] === "true";
  const parts = [owner.directText];
  for (const element of elements) {
    const index = element.ancestorSelectors.indexOf(owner.selector);
    if (index < 0 || hidden(element) || nodeIdOf(element) !== undefined)
      continue;
    const between = element.ancestorSelectors
      .slice(0, index)
      .map((selector) => bySelector.get(selector));
    if (
      between.some(
        (ancestor) =>
          ancestor !== undefined &&
          (nodeIdOf(ancestor) !== undefined ||
            ancestor.attributes["aria-hidden"] === "true"),
      )
    )
      continue;
    parts.push(element.directText);
  }
  return normalizeLabel(parts.filter((part) => part.trim() !== "").join(" "));
}

/**
 * One node (data-node-id) named the same on every declared surface: the
 * tree, breadcrumb, selection chip and toolbar label all say "Heading", not
 * "Heading", "Heading 1" and "Stack". Surfaces are declared in
 * checks.naming.surfaces and resolved at capture into selector marks.
 */
export const crossSurfaceNamingCheck: DeterministicCheck = {
  id: "cross-surface-naming",
  run({ tuple, config }) {
    const surfaces = Object.entries(config.naming.surfaces);
    const coverage = (
      status: CheckCoverage["status"],
      reason: string,
    ): CheckCoverage => ({ check: this.id, status, reason });
    if (surfaces.length < 2)
      return {
        coverage: coverage(
          "skipped",
          "no naming surfaces configured (checks.naming.surfaces)",
        ),
        candidates: [],
      };
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2)
      return unavailable(
        this.id,
        "observations predate element signals (recapture)",
      );
    const marks = new Map(
      (observation.selectorMarks ?? [])
        .filter((mark) => mark.purpose === "naming")
        .map((mark) => [mark.selector, mark.matches]),
    );
    const unresolved = surfaces.filter(([, selector]) => !marks.has(selector));
    if (unresolved.length === surfaces.length)
      return unavailable(
        this.id,
        "naming surfaces were not resolved at capture (recapture after adding checks.naming.surfaces)",
      );
    const elements = observation.elements;
    const bySelector = new Map(
      elements.map((element) => [element.selector, element]),
    );

    // surface → nodeId → { label, selector }, first non-empty label wins.
    const labels = new Map<
      string,
      Map<string, { label: string; selector: string }>
    >();
    const empty: string[] = [];
    for (const [surface, selector] of surfaces) {
      const roots = new Set(marks.get(selector) ?? []);
      const named = new Map<string, { label: string; selector: string }>();
      if (roots.size > 0)
        for (const element of elements) {
          const nodeId = nodeIdOf(element);
          if (
            nodeId === undefined ||
            !element.visible ||
            named.has(nodeId) ||
            !(
              roots.has(element.selector) ||
              element.ancestorSelectors.some((ancestor) => roots.has(ancestor))
            )
          )
            continue;
          const label = ownLabel(element, elements, bySelector);
          if (label !== "")
            named.set(nodeId, { label, selector: element.selector });
        }
      if (named.size === 0) empty.push(surface);
      else labels.set(surface, named);
    }

    const notes = [
      ...unresolved.map(
        ([surface, selector]) =>
          `${surface} (${selector}) was not resolved at capture (recapture)`,
      ),
      ...empty
        .filter((surface) => !unresolved.some(([name]) => name === surface))
        .map((surface) => `${surface} shows no labelled data-node-id elements`),
    ];
    if (labels.size < 2)
      return {
        coverage: coverage(
          "ran",
          ["fewer than two naming surfaces resolved", ...notes].join("; "),
        ),
        candidates: [],
      };

    const nodeIds = new Set(
      [...labels.values()].flatMap((named) => [...named.keys()]),
    );
    const candidates: FindingCandidate[] = [];
    for (const nodeId of nodeIds) {
      const shown = surfaces.flatMap(([surface]) => {
        const entry = labels.get(surface)?.get(nodeId);
        return entry === undefined ? [] : [{ surface, ...entry }];
      });
      const distinct = new Set(shown.map(({ label }) => label.toLowerCase()));
      const first = shown[0];
      if (distinct.size < 2 || first === undefined) continue;
      const listed = shown
        .map(({ surface, label }) => `${surface} "${label}"`)
        .join(", ");
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:cross-surface-name",
        selectorHint: first.selector,
        fingerprintHint: `naming:${nodeId}`,
        explanation: `Node ${nodeId} is named differently across surfaces: ${listed}.`,
        acceptance: [
          `Every surface (${shown.map(({ surface }) => surface).join(", ")}) shows node ${nodeId} under one name.`,
        ],
        verification: verify(this.id, {
          nodeId,
          labels: Object.fromEntries(
            shown.map(({ surface, label }) => [surface, label]),
          ),
        }),
      });
    }
    return {
      coverage:
        notes.length === 0
          ? { check: this.id, status: "ran" }
          : coverage("ran", notes.join("; ")),
      candidates,
    };
  },
};
