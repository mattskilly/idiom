import {
  isVisuallyHidden,
  ran,
  signalledElements,
  unavailable,
  verify,
} from "./shared.js";
import type {
  ChecksConfig,
  CheckTuple,
  DeterministicCheck,
  FindingCandidate,
  ProbeArtifact,
  ProbeResult,
  Rect,
} from "./types.js";

export type NavigationMatch = "pathname" | "query" | "full";

/**
 * The grouping key of a destination: its pathname with any trailing slash
 * dropped (except on the root), plus the query with sorted parameters, plus
 * the hash, as configured.
 */
export function navigationKey(url: URL, match: NavigationMatch): string {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (match === "pathname") return path;
  const params = [...url.searchParams.entries()].sort(([a, x], [b, y]) =>
    a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
  );
  const search =
    params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
  return match === "query" ? `${path}${search}` : `${path}${search}${url.hash}`;
}

/** One way to reach a destination from this state. */
export type NavigationEntry = {
  selector: string;
  name: string;
  /** Where it sits, for the explanation. */
  location: string;
  /** Distinct places: a persistent control, one menu, or the palette. */
  place: string;
  persistent: boolean;
  key: string;
};

const normaliseName = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

function parseUrl(value: string, base?: string): URL | undefined {
  try {
    const url = base === undefined ? new URL(value) : new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** The document's own URL, used to resolve links and drop in-page anchors. */
function documentOf(tuple: CheckTuple): URL | undefined {
  const raw =
    tuple.documentUrl ??
    tuple.documentResponse?.finalUrl ??
    tuple.documentResponse?.url;
  return raw === undefined ? undefined : parseUrl(raw);
}

/**
 * Every way this state offers to reach a destination: links on the page,
 * clicked controls that navigated, link rows of opened menus, and command
 * palette entries. Grouped by the destination key, origin included.
 */
export function navigationEntries(
  tuple: CheckTuple,
  probe: ProbeArtifact,
  match: NavigationMatch,
): { entries: NavigationEntry[]; notes: string[] } {
  const notes: string[] = [];
  const entries: NavigationEntry[] = [];
  const page = documentOf(tuple);
  const keyOf = (url: URL) =>
    page !== undefined && url.origin === page.origin
      ? navigationKey(url, match)
      : `${url.origin}${navigationKey(url, match)}`;
  /** Absolute URL, or undefined for a pure in-page anchor or a non-web URL. */
  const destination = (raw: string): URL | undefined => {
    const url = parseUrl(raw, page?.href);
    if (url === undefined) return undefined;
    if (
      page !== undefined &&
      url.origin === page.origin &&
      url.pathname === page.pathname &&
      url.search === page.search &&
      url.hash !== ""
    )
      return undefined;
    return url;
  };
  for (const result of probe.results) {
    if (result.skipped !== undefined || result.repeated === true) continue;
    const signature = result.signature;
    if (signature?.startsWith("navigate:")) {
      const url =
        result.destination === undefined
          ? undefined
          : parseUrl(result.destination);
      const key =
        url === undefined
          ? navigationKey(
              new URL(signature.slice("navigate:".length), "http://x"),
              "pathname",
            )
          : keyOf(url);
      // A menu item's name is its path from the top trigger: "Project › Leads".
      const path = result.name.split(" › ");
      const own = path.at(-1) ?? result.name;
      entries.push(
        result.persistent
          ? {
              selector: result.selector,
              name: result.name,
              location: `${result.selector}${result.region === undefined ? "" : `, in ${result.region}`}`,
              place: `control:${result.selector}`,
              persistent: true,
              key,
            }
          : {
              selector: result.selector,
              name: own,
              location: `in the "${path.slice(0, -1).join(" › ") || result.name}" menu`,
              place: `menu:${path[0] ?? result.name}`,
              persistent: false,
              key,
            },
      );
    }
    const menu = result.menu;
    if (menu === undefined) continue;
    for (const item of menu.items) {
      if (item.disabled || item.href === undefined) continue;
      const url = destination(item.href);
      if (url === undefined) continue;
      entries.push({
        selector: item.selector,
        name: item.name,
        location: `in the "${result.name || result.selector}" menu`,
        place: `menu:${result.name.split(" › ")[0] ?? result.name}`,
        persistent: false,
        key: keyOf(url),
      });
    }
  }
  const linkNames = new Map<string, Set<string>>();
  const signalled = page === undefined ? undefined : signalledElements(tuple);
  if (signalled === undefined)
    notes.push(
      "page links were not compared: the capture recorded no document URL (recapture)",
    );
  else if ("reason" in signalled) notes.push(`page links: ${signalled.reason}`);
  else
    for (const element of signalled.elements) {
      const href = element.signals.href;
      if (
        element.signals.role !== "link" ||
        href === undefined ||
        isVisuallyHidden(element) ||
        element.rect.width <= 0 ||
        element.rect.height <= 0
      )
        continue;
      const url = destination(href);
      if (url === undefined || url.origin !== page?.origin) continue;
      const name = (
        element.signals.name ||
        element.signals.title ||
        element.attributes["aria-label"] ||
        element.text
      ).trim();
      const key = keyOf(url);
      entries.push({
        selector: element.selector,
        name,
        location: element.selector,
        place: `control:${element.selector}`,
        persistent: true,
        key,
      });
      if (name !== "") {
        const keys = linkNames.get(normaliseName(name)) ?? new Set();
        keys.add(key);
        linkNames.set(normaliseName(name), keys);
      }
    }
  const palette = probe.palette;
  if (palette !== undefined) {
    if (palette.status !== "opened")
      notes.push(
        `command palette (${palette.shortcut}) ${palette.status}${palette.reason === undefined ? "" : `: ${palette.reason}`}`,
      );
    else
      for (const entry of palette.entries) {
        let key: string | undefined;
        if (entry.href !== undefined) {
          const url = destination(entry.href);
          if (url !== undefined) key = keyOf(url);
        } else {
          // A script-routed entry joins only an unambiguous same-name link.
          const keys = linkNames.get(normaliseName(entry.name));
          if (keys?.size === 1) key = [...keys][0];
        }
        if (key === undefined) continue;
        entries.push({
          selector: entry.selector,
          name: entry.name,
          location: `in the command palette (${palette.shortcut})`,
          place: "palette",
          persistent: false,
          key,
        });
      }
  }
  return { entries, notes };
}

/**
 * Destinations reached from at least two places, at least one of them a
 * menu item or palette entry. Two persistent links to one route (a header
 * and a footer link, or the logo and "Home") are ordinary and never count.
 */
export function navigationGroups(
  entries: NavigationEntry[],
): Array<{ key: string; members: NavigationEntry[] }> {
  const byKey = new Map<string, NavigationEntry[]>();
  for (const entry of entries)
    byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  const groups: Array<{ key: string; members: NavigationEntry[] }> = [];
  for (const [key, all] of byKey) {
    const members: NavigationEntry[] = [];
    const selectors = new Set<string>();
    const names = new Set<string>();
    for (const entry of all) {
      if (selectors.has(entry.selector)) continue;
      selectors.add(entry.selector);
      if (!entry.persistent) {
        const name = `${entry.place}\u0000${normaliseName(entry.name)}`;
        if (names.has(name)) continue;
        names.add(name);
      }
      members.push(entry);
    }
    if (
      new Set(members.map((member) => member.place)).size >= 2 &&
      members.some((member) => !member.persistent)
    )
      groups.push({ key, members });
  }
  return groups;
}

function navigationCandidates(
  tuple: CheckTuple,
  probe: ProbeArtifact,
  config: ChecksConfig,
): { candidates: FindingCandidate[]; notes: string[] } {
  // Hand-built contexts may omit the config entirely.
  const match = config?.duplicateEntry?.navigation ?? "pathname";
  const { entries, notes } = navigationEntries(tuple, probe, match);
  const candidates = navigationGroups(entries).map(
    ({ key, members }): FindingCandidate => {
      const anchor = members.find((member) => member.persistent) ?? members[0];
      const locations = members
        .map(
          (member) =>
            `"${member.name || member.selector}" (${member.persistent ? member.location : `${member.location}, ${member.selector}`})`,
        )
        .join("; ");
      return {
        category: "duplicate-entry",
        severity: "minor",
        rule: "idiom:redundant-entry-point",
        selectorHint: anchor?.selector ?? "html",
        fingerprintHint: `idiom:redundant-entry-point|navigate|${key}`,
        explanation: `${members.length} entry points in this view each go to ${key}: ${locations}. A menu item that repeats a destination the page already links to adds a second way to the same place; choose the canonical entry point.`,
        acceptance: [
          `One entry point goes to ${key}, or the others are recorded as deliberate (for example a command palette shortcut).`,
        ],
        verification: verify("duplicate-entry", {
          destination: key,
          match,
          members: members.map((member) => ({
            selector: member.selector,
            name: member.name,
            persistent: member.persistent,
          })),
        }),
      };
    },
  );
  return { candidates, notes };
}

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
  if (signature.startsWith("navigate:"))
    return `goes to ${signature.slice("navigate:".length)}`;
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
  run({ tuple, config }) {
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
    const navigation = navigationCandidates(tuple, observation.probe, config);
    candidates.push(...navigation.candidates);
    return navigation.notes.length === 0
      ? ran(this.id, candidates)
      : {
          coverage: {
            check: this.id,
            status: "ran",
            reason: navigation.notes.join("; "),
          },
          candidates,
        };
  },
};
