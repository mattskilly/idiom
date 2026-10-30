import { createHash } from "node:crypto";
import type { ObservedElement } from "../checks/types.js";
import type { Finding } from "../schemas/finding.js";
import { isComponentBoundary, isComponentShell } from "../tickets/cluster.js";
import { generatedClass } from "./fingerprint.js";
import { type CheckIssue, collapseIssues } from "./issues.js";
import {
  affectedCounts,
  comparePriority,
  type IssueRankingContext,
  type IssueRankingTuple,
  type RankingElement,
  rootCauseBreadth,
  ruleFamily,
  scoreGroup,
} from "./ranking.js";
import type { CheckGroup } from "./summary.js";

/**
 * Root causes: groups from different rules that share one source collapse
 * into one issue. Presentation only — findings, ids, fingerprints, groups,
 * decisions and gating are untouched; every symptom keeps its own group.
 */

export type RootCauseKind = "token" | "component" | "style-rule" | "region";

export type RootCauseSymptom = {
  group: string;
  category: string;
  rule?: string | undefined;
  selector?: string | undefined;
  measurement: string;
  findings: Array<{
    id: string;
    basis?: Finding["basis"] | undefined;
    basisDetails?: Finding["basisDetails"] | undefined;
    acceptance?: Finding["acceptance"] | undefined;
    fingerprint: string;
    status: Finding["status"];
    deferred?: true | undefined;
  }>;
};

export type RootCause = {
  id: string;
  kind: RootCauseKind;
  key: string;
  cause: string;
  confidence: number;
  evidence: string[];
  fix?: string | undefined;
  symptoms: RootCauseSymptom[];
  counts: { symptoms: number; findings: number };
};

/** Fixed per kind; the cascade and class heuristics are approximations. */
export const rootCauseConfidence = {
  tokenUnresolved: 0.9,
  tokenResolved: 0.8,
  component: 0.7,
  "style-rule": 0.6,
  region: 0.4,
} as const;

const severityOrder = { blocker: 0, major: 1, minor: 2 } as const;

const expandProperty: Record<string, string[]> = {
  borderRadius: [
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomRightRadius",
    "borderBottomLeftRadius",
  ],
  borderColor: [
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
  ],
};

type Target = { selector: string; properties: string[] };

/** The elements, and the measured properties, a symptom is about. */
export function symptomTargets(
  findings: readonly Finding[],
  group: Pick<CheckGroup, "selector">,
): Target[] {
  const targets = new Map<string, Set<string>>();
  const add = (selector: string, properties: string[]) => {
    const set = targets.get(selector) ?? new Set<string>();
    for (const property of properties) set.add(property);
    targets.set(selector, set);
  };
  for (const finding of findings) {
    const params = finding.verification.params ?? {};
    if (Array.isArray(params.targets)) {
      for (const target of params.targets as unknown[]) {
        const { selector, property } = (target ?? {}) as {
          selector?: unknown;
          property?: unknown;
        };
        if (typeof selector !== "string") continue;
        add(
          selector,
          typeof property === "string"
            ? (expandProperty[property] ?? [property])
            : [],
        );
      }
      continue;
    }
    if (typeof params.selector === "string") {
      add(
        params.selector,
        finding.category === "token-drift" &&
          typeof params.property === "string"
          ? (expandProperty[params.property] ?? [params.property])
          : [],
      );
      continue;
    }
    if (group.selector !== undefined) add(group.selector, []);
  }
  if (targets.size === 0 && group.selector !== undefined)
    add(group.selector, []);
  return [...targets].map(([selector, properties]) => ({
    selector,
    properties: [...properties],
  }));
}

type Resolved = {
  target: Target;
  element: RankingElement;
  tuple: IssueRankingTuple;
};

type Candidate = {
  kind: RootCauseKind;
  key: string;
  confidence: number;
  unresolved?: boolean;
  label?: string;
};

type Symptom = {
  group: CheckGroup;
  findings: Finding[];
  family: string;
  resolved: Resolved[];
  targets: Target[];
  candidates: Candidate[];
};

function resolveTargets(
  group: CheckGroup,
  targets: Target[],
  context: IssueRankingContext,
): Resolved[] {
  const resolved: Resolved[] = [];
  for (const target of targets)
    for (const coordinate of group.coordinates) {
      const tuple = context.get(coordinate);
      const element = tuple?.elements.get(target.selector);
      if (tuple === undefined || element === undefined) continue;
      resolved.push({ target, element, tuple });
      break;
    }
  return resolved;
}

const majority = (count: number, total: number) =>
  total > 0 && count * 2 >= total;

function stableClasses(element: RankingElement): string[] {
  return (element.attributes?.class ?? "")
    .split(/\s+/)
    .filter((name) => name !== "" && !generatedClass(name))
    .sort();
}

function classSignature(element: RankingElement): string | undefined {
  const classes = stableClasses(element);
  if (element.tag === undefined || classes.length === 0) return undefined;
  return `${element.tag}|${classes.join(" ")}`;
}

const signatureCounts = new WeakMap<IssueRankingTuple, Map<string, number>>();
function signatureCount(tuple: IssueRankingTuple, signature: string): number {
  let counts = signatureCounts.get(tuple);
  if (counts === undefined) {
    counts = new Map();
    for (const element of tuple.elements.values()) {
      const key = classSignature(element);
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    signatureCounts.set(tuple, counts);
  }
  return counts.get(signature) ?? 0;
}

function componentKey(
  resolved: Resolved,
): { key: string; label: string } | undefined {
  const { element, tuple } = resolved;
  const declared = tuple.components?.get(element.selector);
  if (declared !== undefined)
    return { key: `component:${declared}`, label: declared };
  for (const selector of [element.selector, ...element.ancestorSelectors]) {
    const candidate =
      selector === element.selector ? element : tuple.elements.get(selector);
    if (candidate === undefined) break;
    if (candidate.tag !== undefined && isComponentShell(asObserved(candidate)))
      break;
    const name = candidate.attributes?.["data-idiom-name"];
    if (name !== undefined && name !== "")
      return { key: `idiom-name:${name}`, label: name };
  }
  const signature = classSignature(element);
  if (signature !== undefined && signatureCount(tuple, signature) >= 2) {
    const [tag, classes = ""] = signature.split("|");
    return {
      key: `class:${signature}`,
      label: `${tag}.${classes.split(" ").join(".")}`,
    };
  }
  return undefined;
}

function asObserved(element: RankingElement): ObservedElement {
  return {
    ...element,
    tag: element.tag ?? "",
  } as unknown as ObservedElement;
}

function regionKey(resolved: Resolved): string | undefined {
  const { element, tuple } = resolved;
  for (const selector of element.ancestorSelectors) {
    const ancestor = tuple.elements.get(selector);
    if (ancestor === undefined || ancestor.tag === undefined) continue;
    const observed = asObserved(ancestor);
    if (isComponentShell(observed)) return undefined;
    if (isComponentBoundary(observed)) return selector;
  }
  return undefined;
}

function candidatesFor(resolved: Resolved[], targets: Target[]): Candidate[] {
  const candidates: Candidate[] = [];
  const measured = resolved.filter(({ target }) => target.properties.length);
  const measuredTotal = targets.filter(
    (target) => target.properties.length,
  ).length;
  // Token: a custom property behind an offending value on most targets.
  const tokens = new Map<string, { count: number; unresolved: boolean }>();
  for (const { target, element } of measured) {
    const seen = new Map<string, boolean>();
    for (const property of target.properties) {
      const source = element.styleSources?.[property];
      for (const name of source?.tokens ?? [])
        seen.set(
          name,
          (seen.get(name) ?? true) && (source?.unresolved ?? []).includes(name),
        );
    }
    for (const [name, unresolved] of seen) {
      const entry = tokens.get(name) ?? { count: 0, unresolved: true };
      entry.count += 1;
      entry.unresolved &&= unresolved;
      tokens.set(name, entry);
    }
  }
  for (const [name, { count, unresolved }] of tokens)
    if (majority(count, measuredTotal))
      candidates.push({
        kind: "token",
        key: name,
        confidence: unresolved
          ? rootCauseConfidence.tokenUnresolved
          : rootCauseConfidence.tokenResolved,
        unresolved,
      });
  // Component: a declared name, a data-idiom-name, or a shared class signature.
  const components = new Map<string, { count: number; label: string }>();
  for (const entry of resolved) {
    const component = componentKey(entry);
    if (component === undefined) continue;
    const current = components.get(component.key) ?? {
      count: 0,
      label: component.label,
    };
    current.count += 1;
    components.set(component.key, current);
  }
  for (const [key, { count, label }] of components)
    if (majority(count, targets.length))
      candidates.push({
        kind: "component",
        key,
        confidence: rootCauseConfidence.component,
        label,
      });
  // Style rule: the winning authored declaration for an offending property.
  const rules = new Map<string, number>();
  for (const { target, element } of measured) {
    const seen = new Set<string>();
    for (const property of target.properties) {
      const source = element.styleSources?.[property];
      if (source === undefined || source.sheet === "inline") continue;
      seen.add(`${source.sheet}\0${source.selector}`);
    }
    for (const key of seen) rules.set(key, (rules.get(key) ?? 0) + 1);
  }
  for (const [key, count] of rules)
    if (majority(count, measuredTotal))
      candidates.push({
        kind: "style-rule",
        key,
        confidence: rootCauseConfidence["style-rule"],
      });
  // Region: the nearest non-shell component boundary.
  const regions = new Map<string, number>();
  for (const entry of resolved) {
    const region = regionKey(entry);
    if (region !== undefined)
      regions.set(region, (regions.get(region) ?? 0) + 1);
  }
  for (const [key, count] of regions)
    if (majority(count, targets.length))
      candidates.push({
        kind: "region",
        key,
        confidence: rootCauseConfidence.region,
      });
  return candidates;
}

const tiers: Array<{
  kind: RootCauseKind;
  accepts: (symptoms: Symptom[]) => boolean;
}> = [
  { kind: "token", accepts: (symptoms) => symptoms.length >= 2 },
  {
    kind: "component",
    accepts: (symptoms) =>
      new Set(symptoms.map((symptom) => symptom.family)).size >= 2,
  },
  { kind: "style-rule", accepts: (symptoms) => symptoms.length >= 2 },
  {
    kind: "region",
    accepts: (symptoms) =>
      new Set(symptoms.map((symptom) => symptom.family)).size >= 3,
  },
];

type Assignment = { candidate: Candidate; symptoms: Symptom[] };

export type AggregateCauseOptions = {
  /** Aggregate group id → owning flow. Enables same-rule declared components only. */
  groupFlows: ReadonlyMap<string, string>;
};

function assign(
  symptoms: Symptom[],
  aggregate?: AggregateCauseOptions,
): {
  causes: Assignment[];
  rest: Symptom[];
} {
  const assigned = new Set<Symptom>();
  const causes: Assignment[] = [];
  for (const tier of tiers) {
    const buckets = new Map<
      string,
      { candidate: Candidate; symptoms: Symptom[] }
    >();
    for (const symptom of symptoms) {
      if (assigned.has(symptom)) continue;
      for (const candidate of symptom.candidates) {
        if (candidate.kind !== tier.kind) continue;
        const bucket = buckets.get(candidate.key) ?? {
          candidate: { ...candidate },
          symptoms: [],
        };
        bucket.symptoms.push(symptom);
        if (candidate.kind === "token")
          bucket.candidate.unresolved =
            (bucket.candidate.unresolved ?? true) &&
            candidate.unresolved === true;
        buckets.set(candidate.key, bucket);
      }
    }
    for (const bucket of buckets.values())
      if (bucket.candidate.kind === "token")
        bucket.candidate.confidence = bucket.candidate.unresolved
          ? rootCauseConfidence.tokenUnresolved
          : rootCauseConfidence.tokenResolved;
    const ordered = [...buckets.values()].sort(
      (left, right) =>
        right.symptoms.length - left.symptoms.length ||
        right.candidate.confidence - left.candidate.confidence ||
        (left.candidate.key < right.candidate.key ? -1 : 1),
    );
    for (const bucket of ordered) {
      const remaining = bucket.symptoms.filter(
        (symptom) => !assigned.has(symptom),
      );
      const repeatedComponent =
        aggregate !== undefined &&
        tier.kind === "component" &&
        /^(component:|idiom-name:)/.test(bucket.candidate.key) &&
        new Set(remaining.map((s) => aggregate.groupFlows.get(s.group.id)))
          .size >= 2;
      if (!tier.accepts(remaining) && !repeatedComponent) continue;
      for (const symptom of remaining) assigned.add(symptom);
      causes.push({ candidate: bucket.candidate, symptoms: remaining });
    }
  }
  return {
    causes,
    rest: symptoms.filter((symptom) => !assigned.has(symptom)),
  };
}

const propertyNoun: Array<[RegExp, string]> = [
  [/Radius$/, "radius"],
  [/^padding/, "padding"],
  [/^margin/, "margin"],
  [/Gap$/, "gap"],
  [/^boxShadow$/, "shadow"],
  [/^border.*Color$/, "border"],
  [/^backgroundColor$/, "background"],
  [/^color$/, "colour"],
  [/^(?:min)?[hH]eight$/, "height"],
];

function nounFor(property: string): string {
  return (
    propertyNoun.find(([pattern]) => pattern.test(property))?.[1] ?? property
  );
}

function list(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

const code = (value: string) => `\`${value}\``;

function sheetSelector(key: string): { sheet: string; selector: string } {
  const [sheet = "", selector = ""] = key.split("\0");
  return { sheet, selector };
}

function firstSentence(text: string): string {
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text.trim();
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

function ruleLabel(group: CheckGroup): string {
  return group.rule?.replace(/^idiom:/, "") ?? group.category;
}

function describe(
  assignment: Assignment,
): Pick<RootCause, "cause" | "evidence" | "fix"> {
  const { candidate, symptoms } = assignment;
  const elements = new Map<string, RankingElement>();
  for (const symptom of symptoms)
    for (const { element } of symptom.resolved)
      elements.set(element.selector, element);
  const selectors = new Set(
    symptoms.flatMap((symptom) =>
      symptom.targets.length
        ? symptom.targets.map((target) => target.selector)
        : symptom.group.selector === undefined
          ? []
          : [symptom.group.selector],
    ),
  );
  const count = selectors.size;
  const resolvedAll = symptoms.flatMap((symptom) => symptom.resolved);
  const interactive =
    resolvedAll.length > 0 &&
    resolvedAll.every(({ element }) => element.interactive === true);
  const things = `${count} ${interactive ? (count === 1 ? "control" : "controls") : count === 1 ? "element" : "elements"}`;
  const rules = [
    ...new Set(symptoms.map((symptom) => ruleLabel(symptom.group))),
  ];
  const rulesLine = `${rules.length} ${rules.length === 1 ? "rule" : "rules"}: ${rules.join(", ")}`;
  if (candidate.kind === "token") {
    const name = candidate.key;
    // Each offending property behind the token, with its rendered value.
    const rendered = new Map<string, { value: string; against?: string }>();
    let fromToken = 0;
    let measured = 0;
    const sources = new Set<string>();
    for (const symptom of symptoms) {
      const finding = symptom.findings[0];
      const prevailing = finding?.verification.params?.prevailing;
      for (const { target, element } of symptom.resolved)
        for (const property of target.properties) {
          measured += 1;
          const source = element.styleSources?.[property];
          if (!source?.tokens?.includes(name)) continue;
          fromToken += 1;
          if (source.sheet !== "inline")
            sources.add(`${code(source.sheet)} ${code(source.selector)}`);
          const noun = nounFor(property);
          if (rendered.has(noun)) continue;
          const value = (
            element.styles as Record<string, string> | undefined
          )?.[property];
          if (value === undefined || value === "") continue;
          rendered.set(noun, {
            value: value.replace(/\s+/g, " "),
            ...(typeof prevailing === "string" ? { against: prevailing } : {}),
          });
        }
    }
    const declared = resolvedAll
      .map(({ tuple }) => tuple.tokens?.[name])
      .find((value) => value !== undefined);
    const evidence = [
      `${fromToken} of ${measured} measured values come from ${code(`var(${name})`)}; ${candidate.unresolved ? "unresolved on every element" : "resolves on every element"}`,
      ...(sources.size === 1 ? [`authored in ${[...sources][0]}`] : []),
      rulesLine,
    ];
    if (candidate.unresolved) {
      const entries = [...rendered];
      const [only] = entries;
      const cause =
        entries.length === 1 && only !== undefined
          ? `${code(name)} is not applied: ${things} render ${only[1].value}${
              declared !== undefined
                ? ` against ${declared}`
                : only[1].against !== undefined
                  ? ` against ${only[1].against}`
                  : ""
            }`
          : `${code(name)} is not applied: ${things} fall back on ${list(
              entries.map(([noun, { value }]) => `${noun} ${value}`),
            )}${declared === undefined ? " instead of its declared value" : ` (declared ${declared})`}`;
      return {
        cause,
        evidence,
        fix: `Define ${code(name)} where these elements inherit it (or fix the reference)`,
      };
    }
    const values = [...rendered];
    return {
      cause: `${code(name)} resolves to ${values[0]?.[1].value ?? "a value"} off the system on ${things} (${values.map(([noun]) => noun).join(", ")})`,
      evidence,
      fix: `Set ${code(name)} to a declared token value`,
    };
  }
  if (candidate.kind === "component") {
    const label = candidate.label ?? candidate.key;
    const source = candidate.key.startsWith("component:")
      ? "declared in checks.components"
      : candidate.key.startsWith("idiom-name:")
        ? "shared data-idiom-name"
        : "shared class signature";
    return {
      cause: `The ${code(label)} component fails ${rules.length} rules across ${count} ${count === 1 ? "instance" : "instances"}: ${rules.join(", ")}`,
      evidence: [
        `${count} ${count === 1 ? "instance" : "instances"} of ${code(label)} (${source})`,
        rulesLine,
      ],
      fix: `Fix the ${code(label)} component once`,
    };
  }
  if (candidate.kind === "style-rule") {
    const { sheet, selector } = sheetSelector(candidate.key);
    const properties = [
      ...new Set(
        symptoms.flatMap((symptom) =>
          symptom.resolved.flatMap(({ target, element }) =>
            target.properties
              .filter((property) => {
                const source = element.styleSources?.[property];
                return source?.sheet === sheet && source.selector === selector;
              })
              .map(nounFor),
          ),
        ),
      ),
    ];
    return {
      cause: `${code(selector)} in ${sheet} sets the offending ${list(properties)} on ${count} ${count === 1 ? "element" : "elements"}`,
      evidence: [`authored in ${code(sheet)} ${code(selector)}`, rulesLine],
      fix: `Edit ${code(selector)} in ${sheet}`,
    };
  }
  return {
    cause: `${code(candidate.key)} fails ${rules.length} rules at once: ${rules.join(", ")}`,
    evidence: [`every symptom sits inside ${code(candidate.key)}`, rulesLine],
  };
}

export function rootCauseIssues(
  groups: CheckGroup[],
  findingsById: ReadonlyMap<string, Finding>,
  primary: ReadonlySet<string>,
  context?: IssueRankingContext,
  aggregate?: AggregateCauseOptions,
): CheckIssue[] {
  if (context === undefined) return collapseIssues(groups, primary, context);
  const symptoms: Symptom[] = groups.map((group) => {
    const findings = group.members.flatMap((member) => {
      const finding = findingsById.get(member.id);
      return finding === undefined ? [] : [finding];
    });
    const targets = symptomTargets(findings, group);
    const resolved = resolveTargets(group, targets, context);
    return {
      group,
      findings,
      family:
        ruleFamily(group.category, group.rule) ?? group.rule ?? group.category,
      targets,
      resolved,
      candidates: candidatesFor(resolved, targets).map((candidate) =>
        aggregate !== undefined &&
        (candidate.kind === "region" ||
          (candidate.kind === "component" &&
            candidate.key.startsWith("class:")))
          ? {
              ...candidate,
              key: JSON.stringify([
                aggregate.groupFlows.get(group.id),
                candidate.key,
              ]),
            }
          : candidate,
      ),
    };
  });
  const { causes, rest } = assign(symptoms, aggregate);
  const issues = causes.map((assignment) =>
    rootCauseIssue(assignment, context),
  );
  return [
    ...issues,
    ...collapseIssues(
      rest.map((symptom) => symptom.group),
      primary,
      context,
    ),
  ].sort(comparePriority);
}

function rootCauseIssue(
  assignment: Assignment,
  context: IssueRankingContext,
): CheckIssue {
  const groups = assignment.symptoms.map((symptom) => symptom.group);
  const counts = affectedCounts(
    groups.flatMap((group) => group.coordinates),
    context,
  );
  const ranked = groups.map((group) => ({
    group,
    ranking: scoreGroup(group, counts, context),
  }));
  const winner = [...ranked].sort(
    (left, right) =>
      right.ranking.score - left.ranking.score ||
      severityOrder[left.group.severity] - severityOrder[right.group.severity],
  )[0] as (typeof ranked)[number];
  const example = winner.group;
  const breadth = rootCauseBreadth(groups.length);
  const rules = [
    ...new Set(
      groups.flatMap((group) => (group.rule === undefined ? [] : [group.rule])),
    ),
  ];
  const { candidate } = assignment;
  const ordered = [
    assignment.symptoms.find((symptom) => symptom.group === example),
    ...assignment.symptoms.filter((symptom) => symptom.group !== example),
  ].filter((symptom): symptom is Symptom => symptom !== undefined);
  const rootCause: RootCause = {
    id: `cause-${createHash("sha256")
      .update(`${candidate.kind}\0${candidate.key}`)
      .digest("hex")
      .slice(0, 12)}`,
    kind: candidate.kind,
    key: candidate.key,
    confidence: candidate.confidence,
    ...describe(assignment),
    symptoms: ordered.map(({ group, findings, targets }) => ({
      group: group.id,
      category: group.category,
      ...(group.rule === undefined ? {} : { rule: group.rule }),
      ...((group.selector ?? targets[0]?.selector) === undefined
        ? {}
        : { selector: group.selector ?? targets[0]?.selector }),
      measurement: firstSentence(group.problem),
      findings: group.members.map((member) => {
        const finding = findings.find(({ id }) => id === member.id);
        return {
          id: member.id,
          basis: finding?.basis,
          basisDetails: finding?.basisDetails,
          acceptance: finding?.acceptance,
          fingerprint: finding?.fingerprint ?? "",
          status: finding?.status ?? "open",
          ...(member.deferred === true ? { deferred: true as const } : {}),
        };
      }),
    })),
    counts: {
      symptoms: groups.length,
      findings: groups.reduce((sum, group) => sum + group.members.length, 0),
    },
  };
  return {
    id: example.id,
    severity: groups.reduce(
      (worst, group) =>
        severityOrder[group.severity] < severityOrder[worst]
          ? group.severity
          : worst,
      example.severity,
    ),
    category: example.category,
    ...(rules.length === 1 ? { rule: rules[0] } : {}),
    rules,
    family: ruleFamily(example.category, example.rule),
    salience: winner.ranking.salience,
    prominence: winner.ranking.prominence,
    score: winner.ranking.score * breadth,
    explanation: { ...winner.ranking.explanation, breadth },
    groups: ordered.map((symptom) => symptom.group.id),
    elements: groups.length,
    places: counts.places,
    findings: rootCause.counts.findings,
    primaryAction: ranked.some(({ ranking }) => ranking.primaryAction),
    ...(groups.every((group) => group.deferred === true)
      ? { deferred: true }
      : {}),
    rootCause,
  };
}
