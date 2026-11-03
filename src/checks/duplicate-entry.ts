import { ran, unavailable, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ProbeResult,
  Rect,
} from "./types.js";

/** Adjacent triggers sit within this edge gap of each other. */
const ADJACENT_PX = 16;

/** Edge-to-edge gap between two boxes; overlapping boxes are 0 apart. */
function gap(a: Rect, b: Rect): number {
  const horizontal = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const vertical = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.max(horizontal, vertical);
}

function overlap(
  start: number,
  size: number,
  otherStart: number,
  otherSize: number,
) {
  return Math.max(
    0,
    Math.min(start + size, otherStart + otherSize) -
      Math.max(start, otherStart),
  );
}

/** Side by side in one row, or stacked in one column. */
function aligned(a: Rect, b: Rect): boolean {
  const shorter = Math.min(a.height, b.height);
  const narrower = Math.min(a.width, b.width);
  return (
    (shorter > 0 && overlap(a.y, a.height, b.y, b.height) >= shorter / 2) ||
    (narrower > 0 && overlap(a.x, a.width, b.x, b.width) >= narrower / 2)
  );
}

type MenuTrigger = ProbeResult & { menu: NonNullable<ProbeResult["menu"]> };

/** Adjacent triggers in one group whose menus list identical items. */
function adjacentMenuClusters(results: ProbeResult[]): MenuTrigger[][] {
  const byItems = new Map<string, Map<string, MenuTrigger>>();
  for (const result of results) {
    const menu = result.menu;
    if (
      menu === undefined ||
      menu.items.length < 2 ||
      result.repeated === true ||
      result.skipped !== undefined
    )
      continue;
    const key = menu.items.map((item) => item.name).join("\u0000");
    const members = byItems.get(key) ?? new Map<string, MenuTrigger>();
    const identity = `${result.selector}\u0000${result.region ?? ""}`;
    if (!members.has(identity))
      members.set(identity, { ...result, menu } as MenuTrigger);
    byItems.set(key, members);
  }
  const clusters: MenuTrigger[][] = [];
  for (const group of byItems.values()) {
    const members = [...group.values()];
    if (members.length < 2) continue;
    const parent = members.map((_, index) => index);
    const find = (index: number): number => {
      let root = index;
      while (parent[root] !== root) root = parent[root] ?? root;
      return root;
    };
    for (let i = 0; i < members.length; i += 1)
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        if (a === undefined || b === undefined) continue;
        if (a.selector === b.selector) continue;
        if ((a.region ?? "") !== (b.region ?? "")) continue;
        if (gap(a.menu.trigger, b.menu.trigger) > ADJACENT_PX) continue;
        if (
          a.menu.group !== b.menu.group &&
          !aligned(a.menu.trigger, b.menu.trigger)
        )
          continue;
        parent[find(j)] = find(i);
      }
    const byRoot = new Map<number, MenuTrigger[]>();
    members.forEach((member, index) => {
      const root = find(index);
      byRoot.set(root, [...(byRoot.get(root) ?? []), member]);
    });
    for (const cluster of byRoot.values())
      if (cluster.length >= 2) clusters.push(cluster);
  }
  return clusters;
}

function describe(signature: string): string {
  if (signature.startsWith("open:"))
    return `opens ${signature
      .slice("open:".length)
      .split("|")
      .map((region) => {
        const [role, ...name] = region.split(":");
        const label = name.join(":").trim();
        return label === "" ? `a ${role}` : `the "${label}" ${role}`;
      })
      .join(" and ")}`;
  if (signature.startsWith("focus:"))
    return `moves focus to ${signature.slice("focus:".length).split(":").slice(1).join(":") || "the same field"}`;
  return signature;
}

/**
 * Two or more persistent controls in one view that lead to the same place.
 * Idiom does not pick the survivor: it lists every location so a human can
 * record which entry point is canonical (as a rule override or decision).
 * A control is identified by its location (selector and region), not its
 * accessible name, so two "Page settings" gears in different places are two
 * entry points. Moving focus counts as a destination only when it is each
 * control's sole effect; focus that follows another effect is a side effect.
 * Menus are not destinations, but two adjacent triggers in one toolbar or
 * row whose menus list identical items are one menu reached twice.
 */
export const duplicateEntryCheck: DeterministicCheck = {
  id: "duplicate-entry",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.probe === undefined)
      return unavailable(
        this.id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      );
    const groups = new Map<string, typeof observation.probe.results>();
    for (const result of observation.probe.results) {
      const signature = result.signature;
      if (signature === undefined || result.skipped !== undefined) continue;
      // Per-row actions ("Edit" on every card) are a pattern, not entry points.
      if (result.repeated === true) continue;
      if (!signature.startsWith("open:") && !signature.startsWith("focus:"))
        continue;
      // Older artifacts carry no `primary`; they keep the legacy grouping.
      if (signature.startsWith("focus:") && result.primary === true) continue;
      if (/(?:^|\|)(?:tooltip|menu|listbox):/.test(signature.slice(5)))
        continue;
      groups.set(signature, [...(groups.get(signature) ?? []), result]);
    }
    const candidates: FindingCandidate[] = [];
    for (const [signature, members] of groups) {
      const distinct = [
        ...new Map(
          members.map((member) => [
            `${member.selector}\u0000${member.region ?? ""}`,
            member,
          ]),
        ).values(),
      ];
      if (distinct.length < 2) continue;
      const locations = distinct
        .map(
          (member) =>
            `"${member.name || member.selector}" (${member.selector}${member.region === undefined ? "" : `, in ${member.region}`}${member.persistent ? "" : ", in a menu"})`,
        )
        .join("; ");
      const first = distinct[0];
      if (first === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:redundant-entry-point",
        selectorHint: first.selector,
        explanation: `${distinct.length} controls in this view each ${describe(signature)}: ${locations}. Choose the canonical entry point; the others compete for attention or disguise themselves.`,
        acceptance: [
          `One persistent control ${describe(signature)}, or the extra entry points are recorded as deliberate (for example a shortcut).`,
        ],
        verification: verify(this.id, { signature }),
      });
    }
    for (const cluster of adjacentMenuClusters(observation.probe.results)) {
      const first = cluster[0];
      if (first === undefined) continue;
      const names = first.menu.items.map((item) => item.name || "(unnamed)");
      const preview = `${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}`;
      const locations = cluster
        .map(
          (member) =>
            `"${member.name || member.selector}" (${member.selector}${member.region === undefined ? "" : `, in ${member.region}`})`,
        )
        .join("; ");
      const selectors = cluster.map((member) => member.selector);
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:redundant-entry-point",
        selectorHint: first.selector,
        fingerprintHint: `idiom:redundant-entry-point|menu|${[...selectors].sort().join(",")}`,
        explanation: `${cluster.length} controls sit side by side and open the same menu (${preview}): ${locations}. One trigger is enough; the second competes for attention and reads as a different action.`,
        acceptance: [
          "One trigger opens this menu, or the second trigger is recorded as deliberate.",
        ],
        verification: verify(this.id, {
          menu: first.menu.items.map((item) => item.name),
          members: selectors,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
