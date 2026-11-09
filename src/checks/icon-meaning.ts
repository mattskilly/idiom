import { ran, unavailable, verify } from "./shared.js";
import type {
  CheckTuple,
  DeterministicCheck,
  IconControlObservation,
  ObservationArtifactV2,
  ProbeEffect,
} from "./types.js";

const RULE = "idiom:icon-meaning";
const MAX_STATES_LISTED = 6;

const stopwords = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "this",
  "that",
  "your",
  "my",
  "our",
  "and",
  "or",
  "in",
  "on",
  "at",
  "with",
  "from",
  "by",
  "all",
  "item",
  "button",
  "icon",
  "link",
]);

/** Words that name one meaning, folded onto one key. Our own table. */
const synonymGroups: Record<string, string[]> = {
  close: ["close", "dismiss", "cancel", "exit", "remove", "clear", "x"],
  toggle: ["toggle", "collapse", "expand", "show", "hide"],
  delete: ["delete", "trash", "discard"],
  add: ["add", "new", "create", "plus"],
  edit: ["edit", "rename", "modify"],
  search: ["search", "find"],
  more: ["more", "options", "option", "actions", "action", "menu", "overflow"],
  settings: ["settings", "setting", "preferences", "preference", "configure"],
  back: ["back", "previous", "prev"],
  forward: ["next", "forward"],
  copy: ["copy", "duplicate", "clone"],
  favorite: ["star", "favorite", "favourite"],
  refresh: ["refresh", "reload", "sync"],
  help: ["help", "info", "information"],
  account: ["account", "profile", "user"],
};
const synonymOf = new Map<string, string>(
  Object.entries(synonymGroups).flatMap(([key, words]) =>
    words.map((word) => [word, key] as const),
  ),
);

/** The words a control's name means, after stopwords, plurals and synonyms. */
export function meaningWords(name: string): Set<string> {
  const words = new Set<string>();
  for (const raw of name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw === "" || /^\p{N}+$/u.test(raw)) continue;
    const direct = synonymOf.get(raw);
    if (direct !== undefined) {
      words.add(direct);
      continue;
    }
    const singular =
      raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (stopwords.has(raw) || stopwords.has(singular)) continue;
    words.add(synonymOf.get(singular) ?? singular);
  }
  return words;
}

/** Coarse effect classes: a probe's DOM and ARIA changes are one effect. */
const effectClass: Record<ProbeEffect, string | undefined> = {
  dom: "change",
  aria: "change",
  focus: undefined,
  network: undefined,
  navigation: "navigate",
  dialog: "dialog",
  popup: "window",
  clipboard: "clipboard",
  filechooser: "picker",
  picker: "picker",
  print: "print",
  download: "download",
};

export type IconMember = {
  /** The tuple's state: where a finding is emitted. */
  state: string;
  /** The state as listed: a revealed state reads `state › trigger`. */
  label: string;
  selector: string;
  name: string;
  words: Set<string>;
  /** Effect classes of the matching probe click; undefined without evidence. */
  effects?: Set<string> | undefined;
};

export type IconMeaning = { members: IconMember[] };

const intersects = (left: Set<string>, right: Set<string>) => {
  for (const value of left) if (right.has(value)) return true;
  return false;
};

/**
 * Group one icon's members into meanings: names that share a meaning word
 * are one meaning, then split where both sides have click evidence and the
 * effects share nothing. Members without evidence join the first meaning
 * of their name group.
 */
export function iconMeanings(members: IconMember[]): IconMeaning[] {
  const parent = members.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[index] = root;
    return root;
  };
  for (let left = 0; left < members.length; left += 1)
    for (let right = left + 1; right < members.length; right += 1) {
      const a = members[left];
      const b = members[right];
      if (a && b && intersects(a.words, b.words))
        parent[find(right)] = find(left);
    }
  const clusters = new Map<number, IconMember[]>();
  members.forEach((member, index) => {
    const root = find(index);
    clusters.set(root, [...(clusters.get(root) ?? []), member]);
  });
  const meanings: IconMeaning[] = [];
  for (const cluster of clusters.values()) {
    const split: Array<{ effects: Set<string>; members: IconMember[] }> = [];
    const unproven: IconMember[] = [];
    for (const member of cluster) {
      const effects = member.effects;
      if (effects === undefined || effects.size === 0) {
        unproven.push(member);
        continue;
      }
      // The same control in another viewport is the same meaning.
      const match = split.find(
        (group) =>
          intersects(group.effects, effects) ||
          group.members.some(
            (other) =>
              other.selector === member.selector && other.name === member.name,
          ),
      );
      if (match === undefined)
        split.push({ effects: new Set(effects), members: [member] });
      else {
        for (const effect of effects) match.effects.add(effect);
        match.members.push(member);
      }
    }
    const first = split[0];
    if (first === undefined) meanings.push({ members: unproven });
    else {
      first.members.push(...unproven);
      for (const group of split) meanings.push({ members: group.members });
    }
  }
  return meanings;
}

type Analysis = {
  /** Fingerprints that carry two or more meanings, with their home state. */
  reported: Map<string, { home: string; meanings: IconMeaning[] }>;
};

const analyses = new WeakMap<readonly CheckTuple[], Map<string, Analysis>>();

const eligible = (control: IconControlObservation) =>
  (control.placement === "only" ||
    (control.placement === "leading" && !control.disclosure)) &&
  meaningWords(control.name).size > 0;

function effectsOf(
  observation: ObservationArtifactV2,
  control: IconControlObservation,
): Set<string> | undefined {
  const result = observation.probe?.results.find(
    (candidate) =>
      (candidate.selector === control.path ||
        candidate.selector === control.id) &&
      candidate.skipped === undefined &&
      candidate.status !== "not-reached" &&
      candidate.status !== "timed-out" &&
      candidate.primary !== false,
  );
  if (result === undefined) return undefined;
  const classes = new Set<string>();
  for (const effect of result.effects) {
    const value = effectClass[effect];
    if (value !== undefined) classes.add(value);
  }
  return classes.size === 0 ? undefined : classes;
}

function analyse(tuples: readonly CheckTuple[], flow: string): Analysis {
  const byFingerprint = new Map<string, IconMember[]>();
  const add = (fingerprint: string, member: IconMember) => {
    byFingerprint.set(fingerprint, [
      ...(byFingerprint.get(fingerprint) ?? []),
      member,
    ]);
  };
  for (const tuple of tuples) {
    if (tuple.flow !== flow || tuple.failure !== undefined) continue;
    const observation = tuple.observations;
    if (observation?.version !== 2) continue;
    const sources: Array<{
      label: string;
      controls: IconControlObservation[] | undefined;
    }> = [{ label: tuple.state, controls: observation.iconControls }];
    for (const result of observation.probe?.results ?? []) {
      const revealed = result.revealed?.observations;
      if (revealed?.version !== 2 || result.revealed === undefined) continue;
      sources.push({
        label: `${tuple.state} › ${result.revealed.name}`,
        controls: revealed.iconControls,
      });
    }
    for (const source of sources)
      for (const control of source.controls ?? []) {
        if (!eligible(control)) continue;
        add(control.fingerprint, {
          state: tuple.state,
          label: source.label,
          selector: control.selector,
          name: control.name,
          words: meaningWords(control.name),
          effects: effectsOf(observation, control),
        });
      }
  }
  const reported: Analysis["reported"] = new Map();
  for (const [fingerprint, members] of byFingerprint) {
    const meanings = iconMeanings(members);
    const home = members[0]?.state;
    if (meanings.length >= 2 && home !== undefined)
      reported.set(fingerprint, { home, meanings });
  }
  return { reported };
}

function analysisFor(tuples: readonly CheckTuple[], flow: string): Analysis {
  let flows = analyses.get(tuples);
  if (flows === undefined) {
    flows = new Map();
    analyses.set(tuples, flows);
  }
  let analysis = flows.get(flow);
  if (analysis === undefined) {
    analysis = analyse(tuples, flow);
    flows.set(flow, analysis);
  }
  return analysis;
}

const unique = <T>(values: T[]) => [...new Set(values)];

function describe(meaning: IconMeaning): string {
  const name = meaning.members[0]?.name ?? "";
  const states = unique(meaning.members.map((member) => member.label));
  const shown = states.slice(0, MAX_STATES_LISTED).join(", ");
  const more =
    states.length > MAX_STATES_LISTED
      ? ` and ${states.length - MAX_STATES_LISTED} more`
      : "";
  return `"${name}" (${shown}${more})`;
}

/**
 * One icon standing for two or more different things across a flow's
 * states: the same SVG geometry or font glyph on controls whose names
 * share no meaning, or whose clicks do unrelated things. Reported once per
 * icon, at the first state carrying it.
 */
export const iconMeaningCheck: DeterministicCheck = {
  id: "icon-meaning",
  run({ tuple, tuples }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.iconControls === undefined)
      return unavailable(
        this.id,
        "capture predates icon fingerprints; recapture",
      );
    const analysis = analysisFor(tuples ?? [tuple], tuple.flow);
    const local = new Set(
      [
        ...observation.iconControls,
        ...(observation.probe?.results ?? []).flatMap((result) =>
          result.revealed?.observations?.version === 2
            ? (result.revealed.observations.iconControls ?? [])
            : [],
        ),
      ]
        .filter(eligible)
        .map((control) => control.fingerprint),
    );
    const candidates = [];
    for (const [fingerprint, { home, meanings }] of analysis.reported) {
      if (home !== tuple.state || !local.has(fingerprint)) continue;
      const homeMember =
        meanings
          .flatMap((meaning) => meaning.members)
          .find((member) => member.state === home) ?? meanings[0]?.members[0];
      if (homeMember === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "minor" as const,
        rule: RULE,
        selectorHint: homeMember.selector,
        fingerprintHint: `${RULE}|${fingerprint}`,
        explanation: `One icon stands for ${meanings.length} different things in this flow: ${meanings.map(describe).join(", ")}.`,
        acceptance: [
          "Each meaning listed uses its own icon, or the controls sharing this icon share one name and effect.",
        ],
        verification: verify(this.id, {
          fingerprint,
          meanings: meanings.map((meaning) => ({
            names: unique(meaning.members.map((member) => member.name)),
            states: unique(meaning.members.map((member) => member.label)),
            selectors: unique(meaning.members.map((member) => member.selector)),
          })),
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
