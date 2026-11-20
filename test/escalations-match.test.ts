import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  CONFLICT_THRESHOLD,
  DECISIVE_THRESHOLD,
  MATCH_FLOOR,
  type Match,
  MIN_SHARED_TERMS,
  mergeIdentical,
  rankMatches,
  tokenize,
  verdictFor,
} from "../src/escalations/match.js";
import { loadPrecedent, type Precedent } from "../src/escalations/precedent.js";
import { renderRulingBlock } from "../src/rulings/law.js";
import {
  FILTER_RULING,
  FOOTER_REJECTION,
  precedentProject,
} from "./escalations-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const precedent = (
  id: string,
  text: string,
  extra: Partial<Precedent> = {},
): Precedent => ({
  kind: "ruling",
  id,
  file: "DESIGN.md",
  where: `DESIGN.md (recorded ruling ${id})`,
  text,
  matchText: text,
  ...extra,
});

const match = (id: string, score: number): Match => ({
  ...precedent(id, id),
  score,
  sharedTerms: ["a", "b"],
  copies: 1,
});

test("the tokeniser drops stop words and question scaffolding and folds plurals", () => {
  expect(
    tokenize("Should the Filters use a dropdown, which the spec wants?"),
  ).toEqual(["filter", "dropdown"]);
  expect(tokenize("boxes buttons class status")).toEqual([
    "box",
    "button",
    "class",
    "statu",
  ]);
});

test("the documented thresholds", () => {
  expect({
    MATCH_FLOOR,
    DECISIVE_THRESHOLD,
    CONFLICT_THRESHOLD,
    MIN_SHARED_TERMS,
  }).toEqual({
    MATCH_FLOOR: 0.15,
    DECISIVE_THRESHOLD: 0.35,
    CONFLICT_THRESHOLD: 0.25,
    MIN_SHARED_TERMS: 2,
  });
});

test("verdict boundaries: decisive at the threshold, open just below, conflict at the conflict threshold", () => {
  expect(verdictFor([])).toEqual({ open: "no precedent" });
  expect(verdictFor([match("ruling-1", DECISIVE_THRESHOLD - 0.001)])).toEqual({
    open: "below threshold",
    closest: match("ruling-1", DECISIVE_THRESHOLD - 0.001),
  });
  expect(verdictFor([match("ruling-1", DECISIVE_THRESHOLD)])).toEqual({
    decisive: match("ruling-1", DECISIVE_THRESHOLD),
  });
  expect(
    verdictFor([match("ruling-1", 0.9), match("ruling-2", CONFLICT_THRESHOLD)]),
  ).toMatchObject({ open: "conflicting precedent: ruling-2" });
  expect(
    verdictFor([
      match("ruling-1", 0.9),
      match("ruling-2", CONFLICT_THRESHOLD - 0.001),
    ]),
  ).toMatchObject({ decisive: { id: "ruling-1" } });
});

test("a single shared term is never a match, however rare", () => {
  const corpus = [
    precedent("ruling-1", "Segmented"),
    precedent("ruling-2", "Cards stack on mobile."),
  ];
  expect(rankMatches("Should this be segmented?", corpus)).toEqual([]);
  expect(
    rankMatches("Should this be a segmented control?", [
      precedent("ruling-1", "Segmented control"),
    ]).map((item) => item.id),
  ).toEqual(["ruling-1"]);
});

test("ranking is by score with the heaviest shared terms as the reason", () => {
  const corpus = [
    precedent("ruling-1", FILTER_RULING),
    precedent("ruling-2", "Filters sit above the list, left aligned."),
    precedent("ruling-3", "Toasts never hold an action."),
  ];
  const ranked = rankMatches(
    "The status filter has four options; should it be a dropdown or a segmented control?",
    corpus,
  );
  expect(ranked.map((item) => item.id)).toEqual(["ruling-1"]);
  const [top] = ranked;
  expect(top?.sharedTerms).toEqual([
    "control",
    "dropdown",
    "option",
    "segmented",
    "filter",
  ]);
  expect(top?.score).toBeGreaterThanOrEqual(DECISIVE_THRESHOLD);
});

test("identical precedents merge, so copies of one answer never conflict", () => {
  const copies = [
    precedent("IDM-1", FOOTER_REJECTION, {
      kind: "decision",
      stance: "rejected",
      at: "2026-11-01T00:00:00.000Z",
    }),
    precedent("IDM-2", `${FOOTER_REJECTION} `, {
      kind: "decision",
      stance: "rejected",
      at: "2026-11-02T00:00:00.000Z",
    }),
  ];
  expect(mergeIdentical(copies)).toEqual([
    expect.objectContaining({ id: "IDM-2", copies: 2 }),
  ]);
  const ranked = rankMatches(
    "Should the confirmation footer get a second primary button?",
    copies,
  );
  expect(ranked).toHaveLength(1);
  expect(verdictFor(ranked)).toMatchObject({ decisive: { id: "IDM-2" } });
});

test("precedent: superseded decisions dropped, Idiom-bug reasons excluded, no-rule rulings excluded", async () => {
  const project = await precedentProject(directories);
  const designPath = join(project, "DESIGN.md");
  await writeFile(
    designPath,
    `${await readFile(designPath, "utf8")}\n${renderRulingBlock({
      id: "ruling-3",
      fingerprint: "fp-ruling-3",
      choiceKey: "choice-ruling-3",
      outcome: "no-rule",
      recordedAt: "2026-11-10T12:00:00.000Z",
    })}\n`,
  );
  const corpus = await loadPrecedent({
    projectDirectory: project,
    stateProjectDirectory: project,
    designFile: "DESIGN.md",
  });
  expect(corpus.map((item) => `${item.kind} ${item.id}`)).toEqual([
    "ruling ruling-1",
    "ruling ruling-2",
    "decision IDM-footer-primary",
    "decision IDM-form-toast",
    "law learned-1",
  ]);
  const footer = corpus.find((item) => item.id === "IDM-footer-primary");
  expect(footer).toMatchObject({
    stance: "rejected",
    text: FOOTER_REJECTION,
    where: ".idiom/decisions.jsonl line 2",
  });
  expect(corpus.find((item) => item.id === "learned-1")).toMatchObject({
    text: "Time picker chips keep at least an 8px gap between them.",
    where: ".idiom/learned.jsonl (learned-1)",
  });
});

test("precedent: a ruling only in the decision log is located there", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-escalations-log-"));
  directories.push(project);
  await mkdir(join(project, ".idiom"), { recursive: true });
  const resolution = {
    id: "ruling-7",
    fingerprint: "fp-7",
    choiceKey: "choice-7",
    outcome: "rule" as const,
    wording: "Use sentence case for button labels.",
    recordedAt: "2026-11-10T12:00:00.000Z",
  };
  await writeFile(
    join(project, ".idiom", "decisions.jsonl"),
    `${JSON.stringify({
      at: "2026-11-10T12:00:00.000Z",
      commit: "abc1234",
      findingId: "ruling-7",
      fingerprint: "fp-7",
      decision: "ruling",
      actor: "human",
      reason: "Recorded from a brief.",
      resolution,
    })}\n`,
  );
  const corpus = await loadPrecedent({
    projectDirectory: project,
    stateProjectDirectory: project,
    designFile: "DESIGN.md",
  });
  expect(corpus).toEqual([
    expect.objectContaining({
      kind: "ruling",
      id: "ruling-7",
      file: ".idiom/decisions.jsonl",
      where: ".idiom/decisions.jsonl (ruling ruling-7)",
    }),
  ]);
});
