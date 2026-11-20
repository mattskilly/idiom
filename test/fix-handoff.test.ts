import { expect, test } from "vitest";
import type { SummaryFinding } from "../src/baseline/summary.js";
import type { CheckSummary } from "../src/commands/check.js";
import { type FixSnapshot, selectTargets } from "../src/fix/check.js";
import { blockingFindings } from "../src/fix/handoff/blocking.js";
import { measuredValue, suggestedFix } from "../src/fix/handoff/fix.js";
import { roundProgress } from "../src/fix/handoff/progress.js";
import { rankFindingIds } from "../src/fix/handoff/rank.js";
import { renderSummary } from "../src/fix/handoff/render.js";
import { findingSelector } from "../src/fix/handoff/selector.js";
import type { HandoffFinding, HandoffRound } from "../src/fix/handoff/types.js";
import {
  type DirectorSources,
  directorWords,
} from "../src/fix/handoff/words.js";
import type { CatalogFinding } from "../src/review/catalog.js";

const finding = (
  id: string,
  extra: Partial<SummaryFinding> = {},
): SummaryFinding => ({
  id,
  severity: "major",
  category: "adjacent-gap",
  rule: "idiom:adjacent-elements-touch",
  where: "list/desktop",
  problem: `${id} problem`,
  fix: [`${id} done`],
  ...extra,
});

function issueSummary(): Pick<CheckSummary, "findings" | "groups" | "issues"> {
  const ids = ["f1", "f2", "f3", "f4", "f5"];
  const group = (id: string, members: string[]) => ({
    id,
    severity: "major" as const,
    category: "adjacent-gap" as const,
    where: "list/desktop",
    problem: "",
    fix: [],
    members: members.map((member) => ({
      id: member,
      severity: "major" as const,
      where: "list/desktop",
      coordinates: ["list/desktop"],
    })),
    coordinates: [],
    states: [],
    viewports: [],
    colorSchemes: [],
  });
  const issue = (id: string, groups: string[], rootCause?: unknown) =>
    ({
      id,
      groups,
      severity: "major",
      category: "adjacent-gap",
      ...(rootCause === undefined ? {} : { rootCause }),
    }) as unknown as NonNullable<CheckSummary["issues"]>[number];
  return {
    findings: ids.map((id) => finding(id)),
    groups: [
      group("g1", ["f4"]),
      group("g2", ["f2", "f1"]),
      group("g3", ["f3", "f5"]),
    ],
    issues: [issue("i1", ["g1"]), issue("i2", ["g2"]), issue("i3", ["g3"])],
  };
}

test("rankFindingIds walks issue order, caps at top, and matches fix's selectTargets", () => {
  const summary = issueSummary();
  const ids = ["f1", "f2", "f3", "f4", "f5"];
  expect(rankFindingIds(summary, ids, 3)).toEqual(["f4", "f2", "f1"]);
  expect(rankFindingIds(summary, ["f3", "f5"], 3)).toEqual(["f3", "f5"]);
  const records = ids.map(
    (id) => ({ finding: { id } }) as unknown as CatalogFinding,
  );
  const snapshot = { summary } as unknown as FixSnapshot;
  for (const top of [1, 2, 3, 5])
    expect(
      selectTargets(snapshot, records, top).map((record) => record.finding.id),
    ).toEqual(rankFindingIds(summary, ids, top));
  // Without issues, summary order holds.
  expect(
    rankFindingIds({ findings: summary.findings }, ["f5", "f1", "f2"], 2),
  ).toEqual(["f1", "f2"]);
});

test("a root cause is taken whole or not at all", () => {
  const summary = issueSummary();
  const cause = { id: "rc", symptoms: [], fix: "Set gap on .toolbar" };
  (summary.issues as Array<{ rootCause?: unknown }>)[1] = {
    ...(summary.issues?.[1] as object),
    rootCause: cause,
  };
  // f4 is selected first, so the root cause (f2, f1) is excluded whole.
  expect(rankFindingIds(summary, ["f1", "f2", "f3", "f4", "f5"], 3)).toEqual([
    "f4",
  ]);
  // Leading with the root cause takes it whole, past the cap.
  expect(rankFindingIds(summary, ["f1", "f2", "f3", "f5"], 1)).toEqual([
    "f2",
    "f1",
  ]);
});

test("findingSelector prefers the acceptance target, then the check's selector, then a hint", () => {
  const acceptance = {
    version: 1,
    kind: "rule",
    rule: "r",
    check: "c",
    doneWhen: [],
    coordinate: { flow: "f", state: "s", viewport: "v" },
    requiredCoordinates: [],
    target: { kind: "selectors", selectors: [".from-target", ".second"] },
    condition: {},
  } as unknown as SummaryFinding["acceptance"];
  expect(findingSelector({ acceptance, selector: ".param" })).toBe(
    ".from-target",
  );
  expect(
    findingSelector({ params: { selector: ".from-params" }, selector: ".s" }),
  ).toBe(".from-params");
  expect(findingSelector({ selector: ".summary" })).toBe(".summary");
  expect(findingSelector({ selectorHint: ".hint" })).toBe(".hint");
  expect(findingSelector({})).toBe("document");
});

const subject = {
  id: "finding-1",
  flow: "orders",
  state: "list",
  rule: "idiom:adjacent-elements-touch",
  category: "adjacent-gap",
  fingerprint: "fp",
  explanation: "two buttons sit 2px apart",
};
const empty: DirectorSources = {
  learned: [],
  rules: { version: 1, overrides: [] },
  rulings: [],
  design: [],
};
const learned = (
  id: string,
  flow: string,
  state: string,
  observation: string,
) => ({
  version: 1 as const,
  id,
  recordedAt: "2026-11-14T12:00:00.000Z",
  flow,
  state,
  observation,
  kind: "observation" as const,
  target: { file: ".idiom/rules.json" },
  entry: null,
  import: {
    name: "catches",
    source: "catches.md",
    row: id,
    line: 1,
    checks: ["adjacent-gap"],
  },
});
const ruling = (id: string, wording: string, reason?: string) => ({
  id,
  fingerprint: `fp-${id}`,
  choiceKey: id,
  outcome: "rule" as const,
  wording,
  ...(reason === undefined ? {} : { reason }),
  recordedAt: "2026-11-14T12:00:00.000Z",
});

test("directorWords resolves learned, ruling, rules, design, then the rule reference, labelled", () => {
  const override = {
    id: "toolbar",
    match: { rule: "idiom:adjacent-elements-touch" },
    action: "severity" as const,
    severity: "major" as const,
    reason: "Toolbar buttons that touch read as one control.",
  };
  const all: DirectorSources = {
    learned: [
      learned("learned-1", "other", "x", "Elsewhere: keep 4px."),
      learned("learned-2", "orders", "detail", "Same flow: keep 6px."),
      learned(
        "learned-3",
        "orders",
        "list",
        "Buttons in a toolbar keep 8px apart.",
      ),
    ],
    rules: { version: 1, overrides: [override] },
    rulings: [
      ruling("ruling-1", "Toolbars breathe.", "Cramped toolbars misclick."),
    ],
    design: [ruling("ruling-2", "adjacent-gap: never let controls touch.")],
  };
  expect(directorWords(subject, all)).toEqual({
    text: "Buttons in a toolbar keep 8px apart.",
    source: "learned",
    ref: "learned-3",
  });
  expect(
    directorWords(subject, { ...all, learned: all.learned.slice(0, 2) }).ref,
  ).toBe("learned-2");
  expect(
    directorWords(subject, { ...all, learned: all.learned.slice(0, 1) }).ref,
  ).toBe("learned-1");
  const cited = { ...subject, explanation: "per ruling-1, two buttons touch" };
  expect(directorWords(cited, { ...all, learned: [] })).toEqual({
    text: "Toolbars breathe. Reason: Cramped toolbars misclick.",
    source: "ruling",
    ref: "ruling-1",
  });
  expect(directorWords(subject, { ...all, learned: [] })).toEqual({
    text: override.reason,
    source: "rules",
    ref: ".idiom/rules.json#toolbar",
  });
  expect(
    directorWords(subject, {
      ...empty,
      design: all.design,
    }),
  ).toEqual({
    text: "adjacent-gap: never let controls touch.",
    source: "design",
    ref: "DESIGN.md#ruling-2",
  });
  const fallback = directorWords(subject, empty);
  expect(fallback.source).toBe("rule-reference");
  expect(fallback.ref).toBe("https://idiom.build/docs/rules#adjacent-gap");
});

test("suggestedFix: root cause, then measured value to target, then doneWhen", () => {
  const measured = {
    kind: "measured" as const,
    rule: "idiom:adjacent-elements-touch",
    summary: "a and b sit 2px apart",
    measurement: { selector: ".a", minimum: 3, parent: ".toolbar" },
  };
  expect(
    suggestedFix({
      category: "adjacent-gap",
      selector: ".a",
      basisDetails: measured,
      summary: measured.summary,
      doneWhen: ["apart"],
      rootCauseFix: "Restore the toolbar gap token",
    }),
  ).toBe("Restore the toolbar gap token.");
  expect(
    suggestedFix({
      category: "adjacent-gap",
      selector: ".a",
      basisDetails: measured,
      summary: measured.summary,
      doneWhen: ["apart"],
    }),
  ).toBe("Change gap on `.toolbar` from 2px to at least 3px.");
  expect(
    suggestedFix({
      category: "control-gap",
      selector: ".chip",
      basisDetails: {
        ...measured,
        measurement: { selector: ".chip", gap: 1, min: 4 },
      },
      summary: "",
      doneWhen: [],
    }),
  ).toBe("Change gap on `.chip` from 1px to at least 4px.");
  expect(
    suggestedFix({
      category: "spacing-rhythm",
      selector: ".x",
      summary: "off rhythm",
      doneWhen: ["The gap matches its siblings."],
    }),
  ).toBe("Make this true: The gap matches its siblings.");
  expect(measuredValue(undefined, "x sit 0.5px apart")).toBe("0.5px");
});

const handoffFinding = (
  id: string,
  extra: Partial<HandoffFinding> = {},
): HandoffFinding => ({
  rank: 1,
  id,
  fingerprint: `fp-${id}`,
  key: "list/desktop",
  flow: "orders",
  state: "list",
  viewport: "desktop",
  severity: "major",
  rule: "idiom:adjacent-elements-touch",
  category: "adjacent-gap",
  selector: `.${id}`,
  measured: { summary: "2px apart", value: "2px" },
  words: { text: "Keep 8px apart.", source: "learned", ref: "learned-1" },
  suggestedFix: "Change gap on `.toolbar` from 2px to at least 3px.",
  doneWhen: ["apart"],
  crops: [],
  ...extra,
});

test("roundProgress compares coordinate and fingerprint, never bare ids", () => {
  const a = handoffFinding("finding-1");
  const b = handoffFinding("finding-2");
  // Same id, different fingerprint: a different finding.
  const renamed = handoffFinding("finding-1", { fingerprint: "fp-other" });
  // Same fingerprint under another id at the same coordinate: still b.
  const realiased = handoffFinding("finding-9", {
    fingerprint: "fp-finding-2",
  });
  expect(
    roundProgress({ targets: [a, b], blocking: [a, b] }, [realiased]),
  ).toEqual({
    fixed: ["finding-1"],
    persisting: ["finding-2"],
    introduced: [],
  });
  expect(roundProgress({ targets: [a], blocking: [a] }, [renamed])).toEqual({
    fixed: ["finding-1"],
    persisting: [],
    introduced: ["finding-1"],
  });
  // Another coordinate is another occurrence.
  expect(
    roundProgress({ targets: [a], blocking: [a] }, [
      handoffFinding("finding-1", { key: "list/mobile" }),
    ]).introduced,
  ).toEqual(["finding-1"]);
});

const round = (
  number: number,
  next: HandoffRound["next"],
  targets: HandoffFinding[],
  remaining: HandoffFinding[] = [],
): HandoffRound => ({
  version: 1,
  round: number,
  base: "base",
  head: "head",
  next,
  targets,
  remaining,
  timing: { totalMs: 1 },
});

test("renderSummary is at most 15 lines with every field per finding and no raw JSON", () => {
  const many = Array.from({ length: 14 }, (_, index) =>
    handoffFinding(`finding-${index + 1}`),
  );
  const rounds = [
    round(0, "repair", many.slice(0, 3), many.slice(3)),
    round(1, "repair", many.slice(1, 4), many.slice(4)),
    round(2, "repair", many.slice(1, 4), many.slice(4)),
    round(3, "stop", many.slice(1, 4), many.slice(4)),
  ];
  const text = renderSummary(rounds);
  const lines = text.trimEnd().split("\n");
  expect(lines.length).toBeLessThanOrEqual(15);
  expect(lines[0]).toBe(
    "Idiom fix: fixed 1 of 14 new blocking finding(s) in 3 round(s).",
  );
  expect(text).toContain(
    '- finding-2 idiom:adjacent-elements-touch at `.finding-2` (list, desktop): measured 2px; "Keep 8px apart." (learned-1); suggested: Change gap on `.toolbar` from 2px to at least 3px. Rounds tried: 3.',
  );
  expect(text).toContain("Fixed and committed: finding-1.");
  expect(text).toContain("idiom-fix-report");
  expect(text).not.toMatch(/[{}]/);
});

test("blockingFindings is the gate's own failing set", () => {
  const summary = {
    findings: [
      finding("a"),
      finding("b", { severity: "minor" }),
      finding("c"),
      finding("d", { basis: "judged" }),
    ],
    preExistingFindings: [finding("c")],
  } as unknown as CheckSummary;
  const checked = [{ flow: "orders", summary }];
  expect(
    blockingFindings(checked, { failOn: "major" }).map(
      (item) => item.finding.id,
    ),
  ).toEqual(["a"]);
  expect(
    blockingFindings(checked, {
      failOn: "minor",
      failOnJudged: true,
      decisionIds: new Set(["a"]),
    }).map((item) => item.finding.id),
  ).toEqual(["b", "d"]);
  expect(blockingFindings(checked, { failOn: "never" })).toEqual([]);
});
