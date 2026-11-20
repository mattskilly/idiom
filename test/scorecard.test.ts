import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { GitRead } from "../src/changed/git.js";
import { run as runCli } from "../src/cli.js";
import { scorecardCommand } from "../src/commands/scorecard.js";
import { lineHash } from "../src/decisions/attribution.js";
import {
  DIGEST_RECORD_FILE,
  type DigestOccurrence,
  type DigestRecord,
  digestRecordSchema,
} from "../src/digest/record.js";
import { ledgerSchema } from "../src/nightly/ledger.js";
import { decisionLogEntrySchema } from "../src/schemas/decision.js";
import {
  type LearnedEntry,
  learnedEntrySchema,
} from "../src/schemas/learned.js";
import { buildScorecard } from "../src/scorecard/build.js";
import { loadScorecardInputs } from "../src/scorecard/load.js";
import { renderScorecard } from "../src/scorecard/render.js";
import { weekWindow } from "../src/scorecard/weeks.js";
import { watchDirectory, watchTreeReports } from "../src/watch/state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * The fixture project: three ISO weeks with data (W43, W44, W46) and one empty
 * week (W45) inside the default four-week window ending 2026-11-15 (W46).
 */
const NOW = new Date("2026-11-15T12:00:00Z");

function occurrence(
  overrides: Partial<DigestOccurrence> & {
    fingerprint: string;
    category: string;
    problem: string;
  },
): DigestOccurrence {
  const where = overrides.where ?? "cart/desktop";
  const [state = "cart", viewport = "desktop"] = where.split("/");
  return {
    id: `id-${overrides.fingerprint}`,
    where,
    state,
    viewport,
    severity: "major",
    disposition: "open",
    score: 5,
    impactReasons: [],
    ...overrides,
  };
}

function digest(
  runId: string,
  completedAt: string,
  occurrences: DigestOccurrence[],
): DigestRecord {
  return digestRecordSchema.parse({
    version: 1,
    flow: "shop",
    runId,
    completedAt,
    commit: "abc123",
    dirty: false,
    reportPath: `.idiom/reports/${runId}/report.md`,
    configHash: "hash-1",
    scope: "full",
    coverage: { selected: 4, captured: [], problems: [] },
    occurrences,
  });
}

// P1: one element at two viewports, Idiom first (W43), later echoed by a learned law.
const p1 = (where: string) =>
  occurrence({
    fingerprint: "fp-gap",
    id: `id-gap-${where}`,
    where,
    category: "control-gap",
    rule: "idiom:control-gap",
    problem: "Buttons sit 2px apart; adjacent controls need an 8px gap.",
  });
// P2: first seen through a filed ticket a day before its run (W43).
const p2 = occurrence({
  fingerprint: "fp-contrast",
  where: "checkout/desktop",
  category: "contrast",
  rule: "axe:color-contrast",
  problem: "Total price text has contrast 3.1:1 against its background.",
});
// P3: found by Idiom after the director logged it (W44): absorbed.
const p3 = occurrence({
  fingerprint: "fp-banner",
  where: "checkout/desktop",
  category: "token-drift",
  rule: "idiom:token-drift",
  problem: "Checkout banner colour is off the token scale.",
});
// P5: Idiom first (W44); the director's selector note comes a week later.
const p5 = occurrence({
  fingerprint: "fp-remove",
  groupKey: "a.remove-item",
  category: "target-size",
  rule: "idiom:target-size",
  problem: "The remove link is 16px tall; tap targets need 24px.",
});
// P4: same UTC day as an imported day-only miss (W46): the director's.
const p4 = occurrence({
  fingerprint: "fp-glossary",
  category: "copy-lint",
  rule: "idiom:glossary-term",
  problem: "Uses 'Checkout' where the glossary says 'Check out'.",
});
const coverage = occurrence({
  fingerprint: "fp-timeout",
  category: "capture",
  rule: "idiom:tuple-failure:timeout",
  coverageOnly: true,
  problem: "Capture timed out.",
});

const runA = digest("2026-10-20T10-00-00-000Z", "2026-10-20T10:00:00.000Z", [
  p1("cart/desktop"),
  p1("cart/mobile"),
  p2,
  coverage,
]);
const runB = digest("2026-10-28T10-00-00-000Z", "2026-10-28T10:00:00.000Z", [
  p1("cart/desktop"),
  p3,
  p5,
]);
const runC = digest("2026-11-10T09-00-00-000Z", "2026-11-10T09:00:00.000Z", [
  p4,
]);

const ledger = ledgerSchema.parse({
  version: 1,
  entries: [
    {
      sink: "autobuild",
      ticket: "file-200",
      findingIds: [],
      fingerprints: ["fp-contrast"],
      flows: ["shop"],
      labels: ["idiom"],
      bodyDigest: "d1",
      filedAt: "2026-10-19T08:00:00.000Z",
      updatedAt: "2026-10-19T08:00:00.000Z",
    },
    // Its run is gone (a discarded build worktree): Idiom's, by ticket (W46).
    {
      sink: "autobuild",
      ticket: "file-201",
      findingIds: ["id-gone"],
      fingerprints: ["fp-gone"],
      flows: ["shop"],
      labels: ["idiom"],
      bodyDigest: "d2",
      filedAt: "2026-11-11T08:00:00.000Z",
      updatedAt: "2026-11-11T08:00:00.000Z",
    },
  ],
});

function learned(
  id: number,
  overrides: Partial<LearnedEntry> & { observation: string },
): LearnedEntry {
  return learnedEntrySchema.parse({
    version: 1,
    id: `learned-${id}`,
    recordedAt: "2026-11-14T10:00:00Z",
    flow: "shop",
    state: "cart",
    kind: "observation",
    target: { file: ".idiom/flows/shop.json" },
    entry: {},
    ...overrides,
  });
}

const learnedLog = [
  // Echoes P1 a week after Idiom found it: rule match, Idiom first.
  learned(1, {
    kind: "law",
    recordedAt: "2026-10-27T12:00:00Z",
    observation: "Cramped buttons",
    target: { file: ".idiom/project.json", check: "control-gap" },
  }),
  // Before P3's run: words match, director first.
  learned(2, {
    state: "checkout",
    recordedAt: "2026-10-26T09:00:00Z",
    observation: "The banner colours are off the token scale on checkout",
  }),
  // No finding at all: director first.
  learned(3, {
    state: "checkout",
    recordedAt: "2026-10-21T12:00:00Z",
    observation: "Promo code field label is clipped on mobile",
  }),
  // Imported, found the same UTC day Idiom first saw P4: director.
  learned(4, {
    observation: "Checkout button wording",
    import: {
      name: "misses",
      source: "misses.md",
      row: "4",
      line: 6,
      category: "copy",
      surface: "cart drawer",
      date: "2026-11-10",
      checks: ["copy-lint"],
    },
  }),
  // Imported with no date: undated, in no week.
  learned(5, {
    state: "checkout",
    observation: "Gift wrap toggle has no label",
    import: {
      name: "misses",
      source: "misses.md",
      row: "5",
      line: 7,
      checks: [],
    },
  }),
  // Harvested; shares only two of seven words with P2: a near miss, its own.
  learned(6, {
    state: "checkout",
    observation: "Price total looks heavy and misaligned beside the coupon",
    harvest: {
      source: "pr-review",
      key: "pr-12-review-1",
      at: "2026-11-12T10:00:00Z",
      categories: ["visual"],
    },
  }),
  // Selector match after Idiom's P5: Idiom first.
  learned(7, {
    recordedAt: "2026-11-03T08:00:00Z",
    observation: "Remove link is tiny",
    target: { file: ".idiom/flows/shop.json", selector: "a.remove-item" },
  }),
];

/** Decision log lines; line 8 reattributes line 6 (agent → human). */
function decisionLines(): string[] {
  const base = (
    at: string,
    findingId: string,
    decision: string,
    actor: "human" | "agent",
    extra: Record<string, unknown> = {},
  ) =>
    JSON.stringify(
      decisionLogEntrySchema.parse({
        at,
        commit: "abc123",
        findingId,
        fingerprint: `fp-${findingId}`,
        decision,
        actor,
        ...(actor === "agent" ? { agent: "claude" } : {}),
        ...extra,
      }),
    );
  const ack = {
    reference: "file-300",
    evidence: { severity: "major", category: "contrast" },
  };
  const lines = [
    // W43: one accept, one reject, one agent accept (excluded).
    base("2026-10-20T11:00:00.000Z", "f-a", "accept", "human"),
    base("2026-10-20T12:00:00.000Z", "f-b", "reject", "human"),
    base("2026-10-21T12:00:00.000Z", "f-c", "accept", "agent"),
    // W44: f-d decided twice (last wins: reject), f-e reattributed to human.
    base("2026-10-27T12:00:00.000Z", "f-d", "accept", "human"),
    base("2026-10-28T12:00:00.000Z", "f-d", "reject", "human"),
    base("2026-10-28T13:00:00.000Z", "f-e", "accept", "agent"),
    base("2026-10-29T12:00:00.000Z", "f-f", "acknowledge", "human", ack),
  ];
  lines.push(
    JSON.stringify({
      at: "2026-10-29T13:00:00.000Z",
      commit: "abc123",
      findingId: "f-e",
      fingerprint: "fp-f-e",
      decision: "reattribute",
      target: { line: 6, sha256: lineHash(lines[5] as string) },
      actor: "human",
      note: "the director made this call",
    }),
    base("2026-10-30T12:00:00.000Z", "f-h", "accept", "human"),
    // W45: nothing. W46: an acknowledgement, then its removal (ignored).
    base("2026-11-10T12:00:00.000Z", "f-g", "acknowledge", "human", ack),
    base("2026-11-11T12:00:00.000Z", "f-g", "unacknowledge", "human", {
      reference: "file-300",
    }),
  );
  return lines;
}

async function writeRun(root: string, record: DigestRecord) {
  await mkdir(join(root, record.runId), { recursive: true });
  await writeFile(
    join(root, record.runId, DIGEST_RECORD_FILE),
    JSON.stringify(record),
  );
}

/** Pretends the project is a repository root whose common dir is `<tmp>/git`. */
function fakeGit(project: string, common: string): GitRead {
  return async (_cwd, args) => {
    if (args.includes("--git-common-dir")) return `${common}\n`;
    if (args.includes("--show-toplevel")) return `${project}\n`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

async function fixtureProject(): Promise<{ project: string; git: GitRead }> {
  const root = await mkdtemp(join(tmpdir(), "idiom-scorecard-"));
  directories.push(root);
  const project = join(root, "project");
  const idiom = join(project, ".idiom");
  await mkdir(join(idiom, "flows"), { recursive: true });
  await writeFile(
    join(idiom, "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "fixture", framework: "other" },
      server: {
        build: "build",
        start: "start",
        readyUrl: "http://127.0.0.1:1",
        port: 1,
        env: {},
      },
      surfaces: [{ id: "store", name: "Store" }],
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
  );
  await writeFile(
    join(idiom, "flows", "shop.json"),
    JSON.stringify({
      id: "shop",
      surface: "store",
      title: "Shop",
      intent: [],
      setup: [],
      states: [
        { id: "cart", description: "Cart", url: "/cart", expect: {} },
        {
          id: "checkout",
          description: "Checkout",
          url: "/checkout",
          expect: {},
        },
      ],
    }),
  );
  const reports = join(idiom, "reports");
  await writeRun(reports, runA);
  await writeRun(reports, runB);
  // The watch tree holds run C and a copy of run A (counted once).
  const git = fakeGit(project, join(root, "git"));
  const watchReports = watchTreeReports(await watchDirectory(project, git), "");
  await writeRun(watchReports, runC);
  await writeRun(watchReports, runA);
  await writeFile(
    join(idiom, "filed-tickets.json"),
    JSON.stringify(ledger, null, 2),
  );
  await writeFile(
    join(idiom, "learned.jsonl"),
    `${learnedLog.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await writeFile(
    join(idiom, "decisions.jsonl"),
    `${decisionLines().join("\n")}\n`,
  );
  return { project, git };
}

/** The hand count, written out before running anything. */
const HAND_COUNT = {
  found: {
    // P1 (Idiom), P2 (Idiom, by ticket), learned-3 (director).
    "2026-W43": { idiom: 2, director: 1, total: 3 },
    // learned-2 + P3 (director), P5 + learned-7 (Idiom).
    "2026-W44": { idiom: 1, director: 1, total: 2 },
    "2026-W45": { idiom: 0, director: 0, total: 0 },
    // learned-4 + P4 (director, same day), file-201 (Idiom), learned-6 (director).
    "2026-W46": { idiom: 1, director: 2, total: 3 },
  },
  overall: { idiom: 4, director: 4, total: 8, directorShare: 0.5 },
  acceptance: {
    "2026-W43": { accepted: 1, rejected: 1, acknowledged: 0, n: 2, agent: 1 },
    "2026-W44": { accepted: 2, rejected: 1, acknowledged: 1, n: 3, agent: 0 },
    "2026-W45": { accepted: 0, rejected: 0, acknowledged: 0, n: 0, agent: 0 },
    "2026-W46": { accepted: 0, rejected: 0, acknowledged: 1, n: 0, agent: 0 },
  },
  acceptanceOverall: { accepted: 3, rejected: 2, acknowledged: 2, n: 5 },
};

test("the fixture scorecard matches the hand count", async () => {
  const { project, git } = await fixtureProject();
  const inputs = await loadScorecardInputs({ projectDirectory: project, git });
  expect(inputs.runRoots).toHaveLength(2);
  const card = buildScorecard({
    ...inputs,
    window: weekWindow({ now: NOW }),
    verbose: true,
  });

  expect(
    Object.fromEntries(
      card.weeks.map((week) => [
        week.week,
        { idiom: week.idiom, director: week.director, total: week.total },
      ]),
    ),
  ).toEqual(HAND_COUNT.found);
  expect(card.overall).toMatchObject(HAND_COUNT.overall);
  expect(card.weeks.map((week) => week.directorShare)).toEqual([
    1 / 3,
    0.5,
    null,
    2 / 3,
  ]);
  expect(
    Object.fromEntries(
      card.acceptance.weeks.map((week) => [
        week.week,
        {
          accepted: week.accepted,
          rejected: week.rejected,
          acknowledged: week.acknowledged,
          n: week.n,
          agent: week.agentExcluded,
        },
      ]),
    ),
  ).toEqual(HAND_COUNT.acceptance);
  expect(card.acceptance.weeks.map((week) => week.rate)).toEqual([
    0.5,
    2 / 3,
    null,
    null,
  ]);
  expect(card.acceptance.overall).toMatchObject({
    ...HAND_COUNT.acceptanceOverall,
    rate: 0.6,
    agentExcluded: 1,
  });
  expect(card.overall.byCategory).toEqual([
    { name: "contrast", idiom: 1, director: 0 },
    { name: "control-gap", idiom: 1, director: 0 },
    { name: "copy", idiom: 0, director: 1 },
    { name: "target-size", idiom: 1, director: 0 },
    { name: "visual", idiom: 0, director: 1 },
    { name: "unrecorded", idiom: 1, director: 2 },
  ]);
  expect(card.overall.bySurface).toEqual([
    { name: "store", idiom: 4, director: 3 },
    { name: "cart drawer", idiom: 0, director: 1 },
  ]);
  expect(card.sources).toMatchObject({
    runs: 3,
    ledgerEntries: 2,
    learned: 7,
    undated: 1,
    decisions: 10,
  });
  expect(
    card.pairs?.map((pair) => [
      pair.learned,
      pair.via,
      pair.foundBy,
      pair.week,
    ]),
  ).toEqual([
    ["learned-1", "rule", "idiom", "2026-W43"],
    ["learned-2", "words", "director", "2026-W44"],
    ["learned-4", "rule", "director", "2026-W46"],
    ["learned-7", "selector", "idiom", "2026-W44"],
  ]);

  const text = renderScorecard(card).join("\n");
  const json = JSON.parse(JSON.stringify(card));
  // The spec's evidence: the fixture scorecard in text and JSON.
  console.log(`${text}\n\n${JSON.stringify(json, null, 2)}`);
  expect(text).toBe(
    [
      "Scorecard 2026-W43 to 2026-W46 (ISO weeks, UTC)",
      "Found first (UI problems first found by Idiom vs by the director)",
      "  2026-W43  Idiom 2  director 1  director share 33% (n=3)",
      "  2026-W44  Idiom 1  director 1  director share 50% (n=2)",
      "  2026-W45  no UI problems recorded",
      "  2026-W46  Idiom 1  director 2  director share 67% (n=3)",
      "  Window    Idiom 4  director 4  director share 50% (n=8)",
      "  By category: contrast 1/0, control-gap 1/0, copy 0/1, target-size 1/0, visual 0/1, unrecorded 1/2 (Idiom/director)",
      "  By surface:  store 4/3, cart drawer 0/1 (Idiom/director)",
      "Acceptance (director decisions on findings)",
      "  2026-W43  1 accepted, 1 rejected, 0 acknowledged — 50% accepted (n=2); 1 agent decision excluded",
      "  2026-W44  2 accepted, 1 rejected, 1 acknowledged — 67% accepted (n=3)",
      "  2026-W45  no director accept/reject decisions",
      "  2026-W46  no director accept/reject decisions (1 acknowledged)",
      "  Window    3 accepted, 2 rejected, 2 acknowledged — 60% accepted (n=5); 1 agent decision excluded",
      "Sources: 3 runs (oldest 2026-10-20; 1 watch root), 2 filed tickets, 7 learned (1 undated, not placed), 10 decisions",
      "note: Idiom runs before 2026-10-20 are not stored; Idiom-first may be undercounted",
      "Matches:",
      "  learned-1 ↔ shop/cart idiom:control-gap (rule: control-gap) — Idiom first, 2026-W43",
      "  learned-2 ↔ shop/checkout idiom:token-drift (words: banner, colour, off, token, scale, checkout) — director first, 2026-W44",
      "  learned-4 ↔ shop/cart idiom:glossary-term (rule: copy-lint) — director first, 2026-W46",
      "  learned-7 ↔ shop/cart idiom:target-size (selector: a.remove-item) — Idiom first, 2026-W44",
    ].join("\n"),
  );
  const empty = json.weeks.find(
    (week: { week: string }) => week.week === "2026-W45",
  );
  expect(empty).toMatchObject({ total: 0, directorShare: null });
  expect(json.acceptance.weeks[2]).toMatchObject({ n: 0, rate: null });
});

test("an empty project reports every week as empty, never 0%", async () => {
  const card = buildScorecard({
    runs: [],
    runRoots: ["/p/.idiom/reports"],
    ledger: [],
    learned: [],
    decisions: [],
    flowSurfaces: new Map(),
    window: weekWindow({ now: NOW, weeks: "2" }),
  });
  expect(card.overall.directorShare).toBeNull();
  expect(card.acceptance.overall.rate).toBeNull();
  const text = renderScorecard(card).join("\n");
  expect(text).not.toContain("0%");
  expect(text).toContain("2026-W45  no UI problems recorded");
  expect(text).toContain("Window    no director accept/reject decisions");
  expect(text).toContain("note: no stored Idiom runs");
});

test("a malformed ledger warns and the scorecard still runs", async () => {
  const { project, git } = await fixtureProject();
  await writeFile(join(project, ".idiom", "filed-tickets.json"), "{");
  const result = await scorecardCommand({
    project,
    now: NOW,
    git,
  });
  expect(result.warnings[0]).toMatch(/^filed tickets not read: malformed/);
  expect(result.card.sources.ledgerEntries).toBe(0);
});

test("CLI: scorecard --json names the window, counts and rates", async () => {
  const { project } = await fixtureProject();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    [
      "node",
      "idiom",
      "scorecard",
      "--project",
      project,
      "--json",
      "--weeks",
      "3",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      review: { now: () => NOW },
    },
  );
  expect(stderr.join("")).toBe("");
  expect(code).toBe(0);
  const payload = JSON.parse(stdout.join(""));
  expect(payload.interfaceVersion).toBe(1);
  expect(payload.window).toMatchObject({
    from: "2026-W44",
    to: "2026-W46",
    weeks: ["2026-W44", "2026-W45", "2026-W46"],
  });
  expect(payload.acceptance.overall).toMatchObject({ n: 3 });
  expect(payload.weeks[1]).toMatchObject({ total: 0, directorShare: null });

  const bad = await runCli(
    ["node", "idiom", "scorecard", "--project", project, "--weeks", "0"],
    {
      stdout: () => {},
      stderr: (message) => stderr.push(message),
      review: { now: () => NOW },
    },
  );
  expect(bad).not.toBe(0);
  expect(stderr.join("")).toContain("--weeks must be a whole number");
});
