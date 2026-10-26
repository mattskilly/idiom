import { createHash } from "node:crypto";
import { isVisuallyHidden } from "../checks/shared.js";
import type {
  ObservationArtifactV2,
  ObservedElementV2,
} from "../checks/types.js";
import type { DesignMatches, DesignPair, MatchMethod } from "./types.js";

export const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();
export function contentElements(
  observation: ObservationArtifactV2,
): ObservedElementV2[] {
  return observation.elements.filter(
    (e) =>
      e.visible &&
      !isVisuallyHidden(e) &&
      e.rect.width > 0 &&
      e.rect.height > 0 &&
      e.styles.display !== "none" &&
      e.styles.visibility !== "hidden" &&
      Number(e.styles.opacity) !== 0 &&
      ![
        "head",
        "script",
        "style",
        "link",
        "meta",
        "title",
        "noscript",
      ].includes(e.tag),
  );
}
export function isAncestor(
  element: ObservedElementV2,
  candidate: ObservedElementV2,
): boolean {
  return (
    element.ancestorSelectors.includes(candidate.selector) ||
    element.structuralPath.startsWith(`${candidate.structuralPath}/`)
  );
}
export function parentOf(
  element: ObservedElementV2,
  elements: ObservedElementV2[],
): ObservedElementV2 | undefined {
  // ancestorSelectors is nearest-first in current observations; prefer the deepest
  // observed ancestor so historical ordering is harmless.
  const ancestors = elements.filter((e) => isAncestor(element, e));
  return ancestors.sort(
    (a, b) =>
      b.structuralPath.split("/").length - a.structuralPath.split("/").length,
  )[0];
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
export const isFigma = (e: ObservedElementV2) =>
  e.attributes["data-idiom-source"] === "figma";
const FIGMA_ID = /^I?\d+:\d+(?:;\d+:\d+)*$/;
/** A Figma element is keyed by its Figma node id, anything else by data-node-id. */
export const nodeKey = (e: ObservedElementV2) =>
  isFigma(e) ? e.attributes["data-figma-id"] : e.signals?.nodeId;
/**
 * A Figma id is a positive match key only: an app's own `data-node-id`
 * vocabulary (`card`, `main`) never blocks a Figma element, while an app id
 * shaped like a Figma id pins to that node.
 */
function nodeConflict(x: ObservedElementV2, y: ObservedElementV2): boolean {
  const fx = isFigma(x),
    fy = isFigma(y);
  if (!fx && !fy)
    return Boolean(
      x.signals?.nodeId &&
        y.signals?.nodeId &&
        x.signals.nodeId !== y.signals.nodeId,
    );
  if (fx && fy) {
    const a = nodeKey(x),
      b = nodeKey(y);
    return Boolean(a && b && a !== b);
  }
  const [f, o] = fx ? [x, y] : [y, x];
  const id = o.signals?.nodeId;
  return Boolean(
    id && FIGMA_ID.test(id) && id !== f.attributes["data-figma-id"],
  );
}
const kindOf = (e: ObservedElementV2) =>
  e.signals?.role ||
  (["img", "svg", "canvas", "video"].includes(e.tag) ? "graphic" : e.tag);
function compatible(a: ObservedElementV2, d: ObservedElementV2): boolean {
  if (nodeConflict(a, d)) return false;
  const an = a.attributes["data-idiom-name"],
    dn = d.attributes["data-idiom-name"];
  if (an && dn && an !== dn) return false;
  // Figma layers have no DOM kinds; only an inferred interactive role binds.
  const figma = isFigma(a) ? a : isFigma(d) ? d : undefined;
  if (figma) {
    const other = figma === a ? d : a;
    return !figma.interactive || other.interactive;
  }
  if (a.interactive !== d.interactive) return false;
  return kindOf(a) === kindOf(d) || (a.tag === d.tag && !a.interactive);
}

type Tree = {
  elements: ObservedElementV2[];
  bySelector: Map<string, ObservedElementV2>;
  order: Map<string, number>;
  parent: Map<string, ObservedElementV2 | undefined>;
  children: Map<string | undefined, ObservedElementV2[]>;
  /** Children before parents: decreasing tree depth. */
  bottomUp: ObservedElementV2[];
  /** Depth-first entry/exit times give constant-time ancestry. */
  enter: Map<string, number>;
  exit: Map<string, number>;
};
function tree(elements: ObservedElementV2[]): Tree {
  const bySelector = new Map<string, ObservedElementV2>(),
    byPath = new Map<string, ObservedElementV2>(),
    order = new Map<string, number>(),
    segments = new Map<ObservedElementV2, number>();
  for (const [i, e] of elements.entries()) {
    if (!bySelector.has(e.selector)) bySelector.set(e.selector, e);
    if (!byPath.has(e.structuralPath)) byPath.set(e.structuralPath, e);
    order.set(e.selector, i);
    segments.set(e, e.structuralPath.split("/").length);
  }
  const parent = new Map<string, ObservedElementV2 | undefined>(),
    children = new Map<string | undefined, ObservedElementV2[]>();
  for (const e of elements) {
    // Same choice as parentOf: the deepest observed ancestor, first in order on ties.
    const candidates = new Set<ObservedElementV2>();
    for (const selector of e.ancestorSelectors) {
      const c = bySelector.get(selector);
      if (c && c !== e) candidates.add(c);
    }
    let prefix = "";
    for (const part of e.structuralPath.split("/").slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const c = byPath.get(prefix);
      if (c && c !== e) candidates.add(c);
    }
    let best: ObservedElementV2 | undefined;
    for (const c of candidates) {
      const cs = segments.get(c) ?? 0,
        bs = best ? (segments.get(best) ?? 0) : -1;
      if (
        cs > bs ||
        (best &&
          cs === bs &&
          (order.get(c.selector) ?? 0) < (order.get(best.selector) ?? 0))
      )
        best = c;
    }
    parent.set(e.selector, best);
    const list = children.get(best?.selector);
    if (list) list.push(e);
    else children.set(best?.selector, [e]);
  }
  const enter = new Map<string, number>(),
    exit = new Map<string, number>(),
    depth = new Map<ObservedElementV2, number>();
  let clock = 0;
  const stack: Array<[ObservedElementV2, number, boolean]> = (
    children.get(undefined) ?? []
  )
    .map((e): [ObservedElementV2, number, boolean] => [e, 0, false])
    .reverse();
  while (stack.length) {
    const [e, level, done] = stack.pop() as [
      ObservedElementV2,
      number,
      boolean,
    ];
    if (done) {
      exit.set(e.selector, clock++);
      continue;
    }
    if (enter.has(e.selector)) continue;
    enter.set(e.selector, clock++);
    depth.set(e, level);
    stack.push([e, level, true]);
    const kids = children.get(e.selector) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid) stack.push([kid, level + 1, false]);
    }
  }
  const bottomUp = [...elements].sort(
    (x, y) => (depth.get(y) ?? 0) - (depth.get(x) ?? 0),
  );
  return {
    elements,
    bySelector,
    order,
    parent,
    children,
    bottomUp,
    enter,
    exit,
  };
}
/** Strict ancestry within one observed tree. */
const within = (t: Tree, element: string, ancestor: string) => {
  const ei = t.enter.get(element),
    ai = t.enter.get(ancestor),
    eo = t.exit.get(element),
    ao = t.exit.get(ancestor);
  return (
    ei !== undefined &&
    ai !== undefined &&
    eo !== undefined &&
    ao !== undefined &&
    ai < ei &&
    eo < ao
  );
};
function* subtree(t: Tree, root: ObservedElementV2) {
  const stack = [...(t.children.get(root.selector) ?? [])];
  while (stack.length) {
    const e = stack.pop() as ObservedElementV2;
    yield e;
    stack.push(...(t.children.get(e.selector) ?? []));
  }
}

const tierMethods = [
  "data-node-id",
  "data-idiom-name",
  "role-name",
  "text",
] as const;
type TierMethod = (typeof tierMethods)[number];
const keyFor = (
  e: ObservedElementV2,
  method: TierMethod,
  figmaDesign: boolean,
): string => {
  if (method === "data-node-id") return nodeKey(e) ?? "";
  if (method === "data-idiom-name")
    return (
      (isFigma(e)
        ? e.attributes["data-figma-name"]
        : e.attributes["data-idiom-name"]) ?? ""
    );
  // A Figma layer has no accessible role, so names meet without one.
  if (method === "role-name")
    return figmaDesign
      ? normalizeText(e.signals?.name ?? "").toLowerCase()
      : e.signals?.role && normalizeText(e.signals.name)
        ? `${e.signals.role}\0${normalizeText(e.signals.name)}`
        : "";
  return normalizeText(e.directText);
};
/** Unmatched elements grouped by tier key, kept current as pairs land. */
type KeyIndex = {
  key: Map<string, string>;
  members: Map<string, ObservedElementV2[]>;
  left: Map<string, number>;
};
const keyIndex = (
  t: Tree,
  method: TierMethod,
  figmaDesign: boolean,
): KeyIndex => {
  const index: KeyIndex = {
    key: new Map(),
    members: new Map(),
    left: new Map(),
  };
  for (const e of t.elements) {
    const k = keyFor(e, method, figmaDesign);
    if (!k) continue;
    index.key.set(e.selector, k);
    const list = index.members.get(k);
    if (list) list.push(e);
    else index.members.set(k, [e]);
    index.left.set(k, (index.left.get(k) ?? 0) + 1);
  }
  return index;
};

/**
 * Strong tiers finish before weaker tiers; containers are then anchored by the
 * matched content they hold, and positional fallback aligns between anchors.
 */
export function matchElements(
  design: ObservationArtifactV2,
  app: ObservationArtifactV2,
): DesignMatches {
  const D = tree(contentElements(design)),
    A = tree(contentElements(app));
  const ds = D.elements,
    as = A.elements;
  const pairs: DesignPair[] = [];
  const byDesign = new Map<string, DesignPair>(),
    byApp = new Map<string, DesignPair>(),
    rank = new Map<DesignPair, number>();
  // Work queues: a tier rescans a scope only after its unmatched children
  // change, the global scope only reconsiders keys whose counts moved, and
  // positional fallback reruns a parent only after something near it matched.
  const scopeDirty = new Map(
      tierMethods.map((m) => [m, new Set<DesignPair>()]),
    ),
    globalDirty = new Map(tierMethods.map((m) => [m, new Set<string>()])),
    fallbackDirty = new Set<DesignPair>();
  const figmaDesign = ds.some(isFigma);
  const dIndex = new Map(
      tierMethods.map((m) => [m, keyIndex(D, m, figmaDesign)]),
    ),
    aIndex = new Map(tierMethods.map((m) => [m, keyIndex(A, m, figmaDesign)]));
  for (const m of tierMethods)
    for (const k of dIndex.get(m)?.members.keys() ?? [])
      globalDirty.get(m)?.add(k);
  const count = (key: (e: ObservedElementV2) => string | undefined) => {
    const counts = new Map<string, number>();
    for (const e of ds) {
      const k = key(e);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };
  const nodeIds = count(nodeKey),
    names = count((e) => e.attributes["data-idiom-name"]),
    paths = count((e) => e.structuralPath);
  const add = (
    d: ObservedElementV2,
    a: ObservedElementV2,
    method: MatchMethod,
  ) => {
    const nodeId = nodeKey(d),
      name = d.attributes["data-idiom-name"];
    const idKey = nodeId
      ? `node:${nodeId}`
      : name
        ? `name:${name}`
        : d.structuralPath;
    const unique =
      (nodeId
        ? nodeIds.get(nodeId)
        : name
          ? names.get(name)
          : paths.get(d.structuralPath)) === 1;
    const pair: DesignPair = {
      id: hash(unique ? idKey : `${idKey}\0${d.structuralPath}`),
      design: d.selector,
      app: a.selector,
      method,
      parent: null,
    };
    rank.set(pair, pairs.length);
    pairs.push(pair);
    byDesign.set(d.selector, pair);
    byApp.set(a.selector, pair);
    for (const m of tierMethods) {
      scopeDirty.get(m)?.add(pair);
      for (const [index, e] of [
        [dIndex.get(m), d],
        [aIndex.get(m), a],
      ] as const) {
        const k = index?.key.get(e.selector);
        if (!index || !k) continue;
        index.left.set(k, (index.left.get(k) ?? 1) - 1);
        globalDirty.get(m)?.add(k);
      }
    }
    fallbackDirty.add(pair);
    for (const [t, e, index] of [
      [D, d, byDesign],
      [A, a, byApp],
    ] as const) {
      // Positional fallback sees through at most three wrapper levels.
      let p = t.parent.get(e.selector);
      for (let level = 0; p && level < 4; level++) {
        const owner = index.get(p.selector);
        if (owner) {
          if (level === 0)
            for (const m of tierMethods) scopeDirty.get(m)?.add(owner);
          fallbackDirty.add(owner);
        }
        p = t.parent.get(p.selector);
      }
    }
  };
  const dh = ds.find((e) => e.tag === "html"),
    ah = as.find((e) => e.tag === "html");
  if (dh && ah) add(dh, ah, "root");
  const dr = ds.find((e) => e.tag === "body") ?? ds[0];
  const ar = as.find((e) => e.tag === "body") ?? as[0];
  if (
    dr &&
    ar &&
    dr.tag === ar.tag &&
    !byDesign.has(dr.selector) &&
    !byApp.has(ar.selector)
  )
    add(dr, ar, "root");

  const eligible = (
    d: ObservedElementV2,
    a: ObservedElementV2,
    method: TierMethod,
  ) =>
    !(method === "data-idiom-name" && nodeConflict(d, a)) &&
    ((method !== "role-name" && method !== "text") || compatible(a, d));
  const scanScope = (scope: DesignPair, method: TierMethod) => {
    const groups = (
      elements: ObservedElementV2[],
      used: Map<string, DesignPair>,
      index: KeyIndex | undefined,
    ) => {
      const result = new Map<string, ObservedElementV2[]>();
      for (const e of elements) {
        if (used.has(e.selector)) continue;
        const key = index?.key.get(e.selector);
        if (!key) continue;
        const list = result.get(key);
        if (list) list.push(e);
        else result.set(key, [e]);
      }
      return result;
    };
    const dg = groups(
        D.children.get(scope.design) ?? [],
        byDesign,
        dIndex.get(method),
      ),
      ag = groups(A.children.get(scope.app) ?? [], byApp, aIndex.get(method));
    let added = 0;
    // Keys are disjoint within a scope, so every unique pairing can land at once.
    for (const [key, nodes] of dg) {
      const d = nodes[0],
        candidates = ag.get(key),
        a = candidates?.[0];
      if (nodes.length !== 1 || candidates?.length !== 1 || !d || !a) continue;
      if (!eligible(d, a, method)) continue;
      add(d, a, method);
      added++;
    }
    return added;
  };
  const scanGlobal = (method: TierMethod) => {
    const dirty = globalDirty.get(method),
      di = dIndex.get(method),
      ai = aIndex.get(method);
    if (!dirty || !di || !ai) return 0;
    const keys = [...dirty];
    dirty.clear();
    let added = 0;
    for (const key of keys) {
      if (di.left.get(key) !== 1 || ai.left.get(key) !== 1) continue;
      const d = di.members.get(key)?.find((e) => !byDesign.has(e.selector)),
        a = ai.members.get(key)?.find((e) => !byApp.has(e.selector));
      if (!d || !a || !eligible(d, a, method)) continue;
      add(d, a, method);
      added++;
    }
    return added;
  };
  const first = (set: Set<DesignPair>) => {
    let best: DesignPair | undefined;
    for (const p of set)
      if (!best || (rank.get(p) ?? 0) < (rank.get(best) ?? 0)) best = p;
    return best;
  };
  const tiers = () => {
    // Restart at the strongest tier whenever new pairs unlock scoped anchors;
    // a matched parent's scope precedes the whole page.
    restart: for (;;) {
      for (const method of tierMethods) {
        const queue = scopeDirty.get(method);
        for (let scope = queue && first(queue); queue && scope; ) {
          queue.delete(scope);
          if (scanScope(scope, method)) continue restart;
          scope = first(queue);
        }
        if (scanGlobal(method)) continue restart;
      }
      return;
    }
  };

  /** Matched descendants on both sides must correspond inside the candidate pair. */
  const consistent = (d: ObservedElementV2, a: ObservedElementV2) => {
    for (const e of subtree(D, d)) {
      const p = byDesign.get(e.selector);
      if (p && !within(A, p.app, a.selector)) return false;
    }
    for (const e of subtree(A, a)) {
      const p = byApp.get(e.selector);
      if (p && !within(D, p.design, d.selector)) return false;
    }
    return true;
  };
  const scopeOf = (e: ObservedElementV2) => {
    for (let p = D.parent.get(e.selector); p; p = D.parent.get(p.selector)) {
      const pair = byDesign.get(p.selector);
      if (pair) return pair;
    }
    return undefined;
  };
  const lca = (x: ObservedElementV2 | undefined, y: ObservedElementV2) => {
    let c = x;
    while (c && c.selector !== y.selector && !within(A, y.selector, c.selector))
      c = A.parent.get(c.selector);
    return c;
  };
  // An unmatched container whose content matched elsewhere pairs with the
  // nearest compatible app element holding that content (a wrapper look-through).
  // Bottom-up, so each container sees the app span of its matched content.
  const anchor = () => {
    let added = 0;
    const span = new Map<string, ObservedElementV2 | null | undefined>();
    for (const d of D.bottomUp) {
      let common: ObservedElementV2 | undefined,
        any = false,
        split = false;
      for (const c of D.children.get(d.selector) ?? []) {
        const p = byDesign.get(c.selector);
        const target = p ? A.bySelector.get(p.app) : span.get(c.selector);
        if (target === null) split = true;
        if (!target) continue;
        common = any ? lca(common, target) : target;
        any = true;
        if (!common) split = true;
      }
      span.set(d.selector, split ? null : common);
      if (split || !common || byDesign.has(d.selector)) continue;
      const scope = scopeOf(d)?.app;
      let candidate: ObservedElementV2 | undefined = common;
      while (
        candidate &&
        candidate.selector !== scope &&
        (byApp.has(candidate.selector) || !compatible(candidate, d))
      )
        candidate = A.parent.get(candidate.selector);
      if (
        !candidate ||
        candidate.selector === scope ||
        (scope && !within(A, candidate.selector, scope)) ||
        !consistent(d, candidate)
      )
        continue;
      add(d, candidate, "descendants");
      added++;
    }
    return added;
  };

  const positional = (parent: DesignPair) => {
    const dRaw = D.children.get(parent.design) ?? [],
      aRaw = A.children.get(parent.app) ?? [];
    // Look through an unmatched wrapper that has no counterpart among the other
    // side's children but holds one beneath it.
    const expand = (
      t: Tree,
      index: Map<string, DesignPair>,
      others: ObservedElementV2[],
      otherIndex: Map<string, DesignPair>,
    ) => {
      const byKind = new Map<string, ObservedElementV2[]>(),
        byTag = new Map<string, ObservedElementV2[]>();
      for (const o of others) {
        if (otherIndex.has(o.selector)) continue;
        for (const [map, key] of [
          [byKind, kindOf(o)],
          [byTag, o.tag],
        ] as const) {
          const list = map.get(key);
          if (list) list.push(o);
          else map.set(key, [o]);
        }
      }
      const counterpart = (e: ObservedElementV2) =>
        [...(byKind.get(kindOf(e)) ?? []), ...(byTag.get(e.tag) ?? [])].some(
          (o) => compatible(o, e),
        );
      const hides = (e: ObservedElementV2, depth: number): boolean =>
        depth > 0 &&
        (t.children.get(e.selector) ?? []).some(
          (c) =>
            counterpart(c) ||
            (!c.interactive && !index.has(c.selector) && hides(c, depth - 1)),
        );
      const visit = (
        e: ObservedElementV2,
        depth: number,
      ): ObservedElementV2[] =>
        depth > 0 &&
        !index.has(e.selector) &&
        !e.interactive &&
        !counterpart(e) &&
        hides(e, 3)
          ? (t.children.get(e.selector) ?? []).flatMap((c) =>
              visit(c, depth - 1),
            )
          : [e];
      return (list: ObservedElementV2[]) => list.flatMap((e) => visit(e, 3));
    };
    const dc = expand(D, byDesign, aRaw, byApp)(dRaw),
      ac = expand(A, byApp, dRaw, byDesign)(aRaw);
    // Only pair nodes in the same interval between established sibling anchors.
    const intervals = (
      list: ObservedElementV2[],
      index: Map<string, DesignPair>,
    ) => {
      const before: string[] = [],
        after: string[] = [];
      let last = "start";
      for (const e of list) {
        before.push(last);
        last = index.get(e.selector)?.id ?? last;
      }
      last = "end";
      for (let i = list.length - 1; i >= 0; i--) {
        after[i] = last;
        const e = list[i];
        last = (e && index.get(e.selector)?.id) ?? last;
      }
      return list.map((_, i) => `${before[i]}/${after[i]}`);
    };
    const di = intervals(dc, byDesign),
      ai = intervals(ac, byApp);
    const open = new Map<string, ObservedElementV2[]>();
    for (const [i, a] of ac.entries()) {
      if (byApp.has(a.selector)) continue;
      const key = ai[i] ?? "";
      const list = open.get(key);
      if (list) list.push(a);
      else open.set(key, [a]);
    }
    // A new pair splits its interval, so later design nodes may only take app
    // nodes after the previous positional pick.
    const cursor = new Map<string, number>();
    let added = 0;
    for (const [i, d] of dc.entries()) {
      if (byDesign.has(d.selector)) continue;
      const key = di[i] ?? "",
        list = open.get(key) ?? [];
      for (let j = cursor.get(key) ?? 0; j < list.length; j++) {
        const a = list[j];
        if (!a || byApp.has(a.selector) || !compatible(a, d)) continue;
        if (!consistent(d, a)) continue;
        add(d, a, "parent-position");
        cursor.set(key, j + 1);
        added++;
        break;
      }
    }
    return added;
  };
  const fallback = () => {
    let added = 0;
    for (
      let parent = first(fallbackDirty);
      parent;
      parent = first(fallbackDirty)
    ) {
      fallbackDirty.delete(parent);
      const n = positional(parent);
      if (n) {
        added += n;
        tiers();
      }
    }
    return added;
  };

  tiers();
  while (anchor() + fallback()) tiers();

  for (const pair of pairs) {
    // Nearest corresponding matched ancestor, even across an unmatched wrapper.
    const d = D.bySelector.get(pair.design);
    for (
      let p = d && D.parent.get(d.selector);
      p;
      p = D.parent.get(p.selector)
    ) {
      const owner = byDesign.get(p.selector);
      if (owner && within(A, pair.app, owner.app)) {
        pair.parent = owner.id;
        break;
      }
    }
  }
  const position = (p: DesignPair) => D.order.get(p.design) ?? 0;
  return {
    version: 1,
    pairs: pairs.sort((x, y) => position(x) - position(y)),
    unmatchedDesign: ds
      .filter((e) => !byDesign.has(e.selector))
      .map((e) => e.selector),
    unmatchedApp: as
      .filter((e) => !byApp.has(e.selector))
      .map((e) => e.selector),
  };
}
