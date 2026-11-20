import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  moduleClassMatches,
  type RenderedSurface,
  type SurfaceMatchToken,
} from "../capture/rendered-surface.js";
import { loadRunRecord, type RunRecord } from "../capture/run-record.js";
import { storedRunsNewestFirst } from "../review/artifacts.js";

/** Runs scanned for evidence before a state is called `unknown`. */
export const EVIDENCE_RUN_LIMIT = 20;

/** What a state's newest stored capture rendered. */
export type StateEvidence = {
  runId: string;
  surface: RenderedSurface;
  /** Derived from older observation fields; no `rendered` inventory. */
  derived: boolean;
  /** Interactive elements and classes, for scoping the probe estimate. */
  elements: EvidenceElement[];
};

export type EvidenceElement = {
  classes: string[];
  id?: string | undefined;
  testId?: string | undefined;
  interactive: boolean;
  rect?: { x: number; y: number; width: number; height: number } | undefined;
  selector: string;
  ancestors: string[];
};

type StoredObservation = {
  rendered?: RenderedSurface;
  elements?: Array<{
    selector?: string;
    interactive?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
    attributes?: Record<string, string>;
    ancestorSelectors?: string[];
    styleSources?: Record<string, { sheet?: string }>;
  }>;
};

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

const idPattern = /#([A-Za-z][\w-]*)/g;

/** An inventory from fields every v2 observation already carries. */
export function deriveRenderedSurface(
  observation: StoredObservation,
): RenderedSurface {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const testIds = new Set<string>();
  const sheets = new Set<string>();
  for (const element of observation.elements ?? []) {
    for (const name of (element.attributes?.class ?? "").split(/\s+/))
      if (name) classes.add(name);
    if (element.attributes?.id) ids.add(element.attributes.id);
    for (const key of ["data-testid", "data-test-id", "data-component"]) {
      const value = element.attributes?.[key];
      if (value) testIds.add(value);
    }
    for (const selector of [
      element.selector ?? "",
      ...(element.ancestorSelectors ?? []),
    ])
      for (const match of selector.matchAll(idPattern))
        ids.add(match[1] as string);
    for (const source of Object.values(element.styleSources ?? {}))
      if (source?.sheet && !/^(?:<style>|adopted|inline)/.test(source.sheet))
        sheets.add(source.sheet);
  }
  return {
    version: 1,
    classes: [...classes].sort(),
    ids: [...ids].sort(),
    testIds: [...testIds].sort(),
    components: [],
    sheets: [...sheets].sort(),
  };
}

function evidenceElements(observation: StoredObservation): EvidenceElement[] {
  return (observation.elements ?? []).map((element) => ({
    classes: (element.attributes?.class ?? "").split(/\s+/).filter(Boolean),
    ...(element.attributes?.id ? { id: element.attributes.id } : {}),
    ...(element.attributes?.["data-testid"]
      ? { testId: element.attributes["data-testid"] }
      : {}),
    interactive: element.interactive === true,
    ...(element.rect ? { rect: element.rect } : {}),
    selector: element.selector ?? "",
    ancestors: element.ancestorSelectors ?? [],
  }));
}

/**
 * Each state's newest stored rendering, any run of the flow: it predicts
 * where a component is shown, not what the base looked like. Prefers the
 * default viewport and scheme, then any tuple the run captured.
 */
export async function loadRenderedEvidence(
  projectDirectory: string,
  flow: string,
  states: string[],
  defaults: { viewport?: string | undefined; scheme?: string | undefined },
): Promise<Map<string, StateEvidence>> {
  const found = new Map<string, StateEvidence>();
  const reports = resolve(projectDirectory, ".idiom", "reports");
  let scanned = 0;
  for (const runId of await storedRunsNewestFirst(reports)) {
    if (found.size >= states.length || scanned >= EVIDENCE_RUN_LIMIT) break;
    const directory = join(reports, runId);
    let record: RunRecord | undefined;
    try {
      record = await loadRunRecord(directory);
    } catch {
      continue;
    }
    if (record?.flow !== flow) continue;
    scanned++;
    const schemes = new Set(record.selected.map((tuple) => tuple.colorScheme));
    for (const state of states) {
      if (found.has(state)) continue;
      const tuples = record.selected
        .filter((tuple) => tuple.state === state)
        .sort(
          (a, b) =>
            Number(b.viewport === defaults.viewport) -
              Number(a.viewport === defaults.viewport) ||
            Number(b.colorScheme === defaults.scheme) -
              Number(a.colorScheme === defaults.scheme),
        );
      for (const tuple of tuples) {
        const candidates = [
          join(
            directory,
            state,
            tuple.viewport,
            tuple.colorScheme,
            "observations.json",
          ),
          ...(schemes.size <= 1
            ? [join(directory, state, tuple.viewport, "observations.json")]
            : []),
        ];
        let observation: StoredObservation | undefined;
        for (const path of candidates) {
          observation = (await readJson(path)) as StoredObservation | undefined;
          if (observation) break;
        }
        if (!observation) continue;
        const rendered = observation.rendered;
        found.set(state, {
          runId,
          surface: rendered ?? deriveRenderedSurface(observation),
          derived: rendered === undefined,
          elements: evidenceElements(observation),
        });
        break;
      }
    }
  }
  return found;
}

const elementMatches = (
  element: Pick<EvidenceElement, "classes" | "id" | "testId">,
  tokens: SurfaceMatchToken[],
) =>
  tokens.some((token) => {
    switch (token.kind) {
      case "class":
        return element.classes.includes(token.value);
      case "module":
        return element.classes.some((name) =>
          moduleClassMatches(name, token.value),
        );
      case "id":
        return element.id === token.value;
      case "testId":
        return element.testId === token.value;
      default:
        return false;
    }
  });

/**
 * Interactive elements the scoped probe would click: inside a surface
 * element, or within `nearPx` of one. Undefined when the evidence shows no
 * surface element by class, id or test id (component-only matches), so the
 * caller keeps its own estimate.
 */
export function controlsNearSurface(
  elements: EvidenceElement[],
  tokens: SurfaceMatchToken[],
  nearPx: number,
): number | undefined {
  const surface = elements.filter((element) => elementMatches(element, tokens));
  if (!surface.length) return undefined;
  const selectors = new Set(surface.map((element) => element.selector));
  const rects = surface.flatMap((element) =>
    element.rect ? [element.rect] : [],
  );
  return elements.filter((element) => {
    if (!element.interactive) return false;
    if (selectors.has(element.selector)) return true;
    if (element.ancestors.some((ancestor) => selectors.has(ancestor)))
      return true;
    const rect = element.rect;
    if (!rect) return false;
    return rects.some((area) => {
      const dx = Math.max(
        area.x - (rect.x + rect.width),
        rect.x - (area.x + area.width),
        0,
      );
      const dy = Math.max(
        area.y - (rect.y + rect.height),
        rect.y - (area.y + area.height),
        0,
      );
      return Math.hypot(dx, dy) <= nearPx;
    });
  }).length;
}
