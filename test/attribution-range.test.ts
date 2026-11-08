import { expect, test } from "vitest";
import {
  attributeIntroductions,
  MAX_ATTRIBUTION_COMMITS,
} from "../src/attribution/attribute.js";
import { commitInfo } from "../src/attribution/git.js";
import type { RecordedIntroduction } from "../src/attribution/record.js";
import { causeText, rangeText } from "../src/attribution/render.js";
import {
  DEFAULT_TICKET_PATTERN,
  ticketIds,
} from "../src/attribution/tickets.js";
import type { GitRead } from "../src/changed/git.js";
import type { selectChangedStates } from "../src/changed/select.js";
import {
  classifyOccurrences,
  previousCompleteRecord,
} from "../src/digest/build.js";
import type { DigestOccurrence, DigestRecord } from "../src/digest/record.js";
import { projectSchema } from "../src/schemas/project.js";

const FROM = "a".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const TO = "3".repeat(40);
const captured = ["cart/desktop", "checkout/desktop", "done/desktop"];

function occurrence(
  fingerprint: string,
  overrides: Partial<DigestOccurrence> = {},
): DigestOccurrence {
  const where = overrides.where ?? "cart/desktop";
  const [state = "cart", viewport = "desktop"] = where.split("/");
  return {
    id: `finding-${fingerprint}`,
    fingerprint,
    where,
    state,
    viewport,
    category: "layout",
    rule: "idiom:element-overlap",
    severity: "major",
    problem: "Two elements overlap.",
    disposition: "open",
    score: 5,
    impactReasons: [],
    ...overrides,
  };
}

function record(
  runId: string,
  commit: string,
  occurrences: DigestOccurrence[],
  overrides: Partial<DigestRecord> = {},
): DigestRecord {
  return {
    version: 1,
    flow: "shop",
    runId,
    completedAt: "2026-11-05T08:30:00.000Z",
    commit,
    dirty: false,
    reportPath: `.idiom/reports/${runId}/report.md`,
    configHash: "hash-1",
    scope: "full",
    coverage: { selected: captured.length, captured, problems: [] },
    occurrences,
    ...overrides,
  };
}

type FakeCommit = {
  sha: string;
  subject: string;
  body?: string;
  parents?: string[];
  files: string[];
};

/** A linear history FROM → commits → (last is TO). */
function fakeGit(
  commits: FakeCommit[],
  options: { ancestor?: boolean; failOn?: string } = {},
): GitRead {
  const known = new Map<string, string>([
    [FROM, FROM],
    ...commits.map((commit) => [commit.sha, commit.sha] as const),
  ]);
  return async (_cwd, args) => {
    if (options.failOn !== undefined && args[0] === options.failOn)
      throw new Error("fatal: bad object\nmore detail");
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return "/repo\n";
    if (args[0] === "rev-parse") {
      const sha = (args.at(-1) ?? "").replace("^{commit}", "");
      const resolved = known.get(sha);
      if (resolved === undefined) throw new Error(`unknown revision ${sha}`);
      return `${resolved}\n`;
    }
    if (args[0] === "merge-base") {
      if (options.ancestor === false) throw new Error("exit 1");
      return "";
    }
    if (args[0] === "rev-list")
      return `${commits.map((commit) => commit.sha).join("\n")}\n`;
    if (args[0] === "log") {
      const commit = commits.find((entry) => entry.sha === args.at(-1));
      if (commit === undefined) throw new Error("no commit");
      return `${commit.sha}\0${(commit.parents ?? ["p"]).join(" ")}\0${commit.subject}\0${commit.body ?? ""}\n`;
    }
    if (args[0] === "diff-tree") {
      const commit = commits.find((entry) => entry.sha === args.at(-1));
      return `${(commit?.files ?? []).join("\0")}\0`;
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

/** Injected file→state mapping: `<state>.tsx` touches that state of shop. */
const select: typeof selectChangedStates = async (
  _project,
  _flows,
  changes,
) => ({
  git: changes,
  candidates: [],
  selected: [],
  skipped: [],
  fallbackFiles: [],
  files: changes.files.map((file) => ({
    path: file.path,
    kind: "route",
    reason: "test",
    routes: [],
    states: file.path.endsWith(".tsx")
      ? [{ flow: "shop", state: file.path.replace(/\.tsx$/, "") }]
      : [],
  })),
});

const attribute = (
  current: DigestRecord,
  previous: DigestRecord | null,
  git: GitRead,
  ticketPattern = DEFAULT_TICKET_PATTERN,
) =>
  attributeIntroductions({
    projectDirectory: "/repo",
    flows: [],
    current,
    previous,
    ticketPattern,
    git,
    select,
  });

const history: FakeCommit[] = [
  { sha: C1, subject: "Tidy footer", files: ["done.tsx"] },
  { sha: C2, subject: "Add promo banner (file-263)", files: ["cart.tsx"] },
  { sha: TO, subject: "Update copy", files: ["README.md"] },
];

test("only open, comparable, newly added design occurrences get a range", async () => {
  const previous = record("run-1", FROM, [
    occurrence("kept"),
    occurrence("gone"),
  ]);
  const current = record(
    "run-2",
    TO,
    [
      occurrence("kept"),
      occurrence("new"),
      occurrence("acked", { disposition: "acknowledged" }),
      occurrence("rejected", { disposition: "rejected" }),
      occurrence("tuple", {
        coverageOnly: true,
        rule: "idiom:tuple-failure:x",
      }),
      occurrence("info", { severity: "info" }),
      occurrence("uncaptured", { where: "elsewhere/desktop" }),
      occurrence("failed", { where: "checkout/desktop" }),
    ],
    {
      coverage: {
        selected: 3,
        captured,
        problems: [
          { kind: "failed", where: "checkout/desktop/light", detail: "x" },
        ],
      },
    },
  );
  expect(
    classifyOccurrences(current, previous).added.map((o) => o.fingerprint),
  ).toEqual(["new"]);
  const result = await attribute(current, previous, fakeGit(history));
  expect(result.previous).toMatchObject({ runId: "run-1", commit: FROM });
  expect(result.introductions).toHaveLength(1);
  expect(result.introductions[0]).toMatchObject({
    fingerprint: "new",
    where: "cart/desktop",
    range: {
      from: FROM,
      to: TO,
      commits: 3,
      linear: true,
      fromDirty: false,
      toDirty: false,
    },
  });
});

test("no previous run: previous is null and nothing is attributed", async () => {
  const result = await attribute(
    record("run-1", TO, [occurrence("new")]),
    null,
    fakeGit(history),
  );
  expect(result.previous).toBeNull();
  expect(result.introductions).toEqual([]);
});

test("an unresolvable commit records the previous run but no introductions", async () => {
  const result = await attribute(
    record("run-2", "unknown", [occurrence("new")]),
    record("run-1", FROM, []),
    fakeGit(history),
  );
  expect(result.previous?.commit).toBe(FROM);
  expect(result.introductions).toEqual([]);
});

test("a non-ancestor range is not linear and omits candidates", async () => {
  const result = await attribute(
    record("run-2", TO, [occurrence("new")], { dirty: true }),
    record("run-1", FROM, [], { dirty: true, configHash: "hash-0" }),
    fakeGit(history, { ancestor: false }),
  );
  expect(result.configChanged).toBe(true);
  expect(result.introductions[0]).toMatchObject({
    range: { linear: false, commits: null, fromDirty: true, toDirty: true },
    candidatesOmitted: "not a linear range",
  });
  expect(result.introductions[0]?.candidates).toBeUndefined();
});

test("a git failure inside the range becomes candidatesOmitted", async () => {
  const result = await attribute(
    record("run-2", TO, [occurrence("new")]),
    record("run-1", FROM, []),
    fakeGit(history, { failOn: "diff-tree" }),
  );
  expect(result.introductions[0]?.candidatesOmitted).toBe(
    "git: fatal: bad object",
  );
});

test("ranges over the commit cap record the range only", async () => {
  const many = Array.from({ length: MAX_ATTRIBUTION_COMMITS + 1 }, (_, i) => ({
    sha: i === MAX_ATTRIBUTION_COMMITS ? TO : `${i}`.padStart(40, "0"),
    subject: "x",
    files: ["cart.tsx"],
  }));
  const result = await attribute(
    record("run-2", TO, [occurrence("new")]),
    record("run-1", FROM, []),
    fakeGit(many),
  );
  expect(result.introductions[0]).toMatchObject({
    range: { commits: MAX_ATTRIBUTION_COMMITS + 1 },
    candidatesOmitted: `range longer than ${MAX_ATTRIBUTION_COMMITS} commits`,
  });
});

test("exactly one commit touching the state is the likely cause", async () => {
  const result = await attribute(
    record("run-2", TO, [occurrence("new")]),
    record("run-1", FROM, []),
    fakeGit(history),
  );
  const [introduction] = result.introductions;
  expect(introduction?.candidates).toEqual([
    {
      commit: C2,
      subject: "Add promo banner (file-263)",
      tickets: ["file-263"],
    },
  ]);
  expect(introduction?.likely?.commit).toBe(C2);
});

test("two commits touching the state leave no likely cause", async () => {
  const result = await attribute(
    record("run-2", TO, [occurrence("new")]),
    record("run-1", FROM, []),
    fakeGit([
      { sha: C1, subject: "First ABC-12", files: ["cart.tsx"] },
      { sha: C2, subject: "Second", files: ["cart.tsx"] },
      { sha: TO, subject: "Third", files: ["README.md"] },
    ]),
  );
  const [introduction] = result.introductions;
  expect(introduction?.likely).toBeUndefined();
  expect(introduction?.candidates?.map((cause) => cause.commit)).toEqual([
    C1,
    C2,
  ]);
  expect(causeText(introduction as RecordedIntroduction)).toBe(
    "commits touching this state: 1111111 (ABC-12), 2222222",
  );
});

test("a merge shows its PR title and finds the ticket in its body", async () => {
  const result = await attribute(
    record("run-2", TO, [occurrence("new")]),
    record("run-1", FROM, []),
    fakeGit([
      {
        sha: TO,
        subject: "Merge pull request #12 from team/banner",
        body: "\nAdd promo banner for PROJ-7\n",
        parents: [FROM, C1],
        files: ["cart.tsx"],
      },
    ]),
  );
  expect(result.introductions[0]?.likely).toEqual({
    commit: TO,
    subject: "Add promo banner for PROJ-7",
    tickets: ["PROJ-7"],
  });
});

test("commitInfo keeps a plain merge subject when the body is empty", async () => {
  const info = await commitInfo(
    "/repo",
    TO,
    fakeGit([
      {
        sha: TO,
        subject: "Merge branch 'main'",
        parents: [FROM, C1],
        files: [],
      },
    ]),
  );
  expect(info).toMatchObject({
    merge: true,
    shownSubject: "Merge branch 'main'",
  });
});

test("ticket ids: default pattern, subject before body, custom pattern", () => {
  expect(
    ticketIds(
      "Fix ABC-123 and file-263\nAlso ABC-123 and XY-9",
      DEFAULT_TICKET_PATTERN,
    ),
  ).toEqual(["ABC-123", "file-263", "XY-9"]);
  expect(ticketIds("Fix #42 (ABC-1)", "#\\d+")).toEqual(["#42"]);
});

test("a custom attribution.ticketPattern replaces the default", async () => {
  const result = await attribute(
    record("run-2", TO, [occurrence("new")]),
    record("run-1", FROM, []),
    fakeGit(history),
    "#\\d+",
  );
  expect(result.introductions[0]?.likely?.tickets).toEqual([]);
});

test("attribution.ticketPattern must compile", () => {
  const issues = (pattern: string) =>
    (
      projectSchema.safeParse({ attribution: { ticketPattern: pattern } }).error
        ?.issues ?? []
    ).filter((issue) => issue.path[0] === "attribution");
  expect(issues("(")).toEqual([
    expect.objectContaining({
      path: ["attribution", "ticketPattern"],
      message: "must be a valid regular expression",
    }),
  ]);
  expect(issues("#\\d+")).toEqual([]);
});

test("previousCompleteRecord skips partial, incomplete and the current run", () => {
  const newestFirst = [
    record("run-4", TO, []),
    record("run-3", C2, [], { scope: "partial" }),
    record("run-2", C1, [], {
      coverage: {
        selected: 3,
        captured,
        problems: [{ kind: "interrupted", detail: "not captured" }],
      },
    }),
    record("run-1", FROM, []),
  ];
  expect(previousCompleteRecord(newestFirst, "run-4")?.runId).toBe("run-1");
  // A fresh run has no record yet: the newest qualifying one is previous.
  expect(previousCompleteRecord(newestFirst, "run-5")?.runId).toBe("run-4");
  expect(previousCompleteRecord(newestFirst, "run-1")).toBeNull();
});

test("range and cause text use the exact spec strings", () => {
  const introduction: RecordedIntroduction = {
    id: "finding-1",
    fingerprint: "f",
    where: "cart/desktop",
    state: "cart",
    range: {
      from: "abc1234ffff",
      to: "def5678ffff",
      commits: 4,
      linear: true,
      fromDirty: false,
      toDirty: false,
    },
    candidates: [],
    likely: {
      commit: "def5678ffff",
      subject: "Add promo banner",
      tickets: ["file-263"],
    },
    configChanged: false,
    runId: "run-2",
  };
  expect(rangeText(introduction)).toBe(
    "appeared between abc1234 and def5678 (4 commits)",
  );
  expect(causeText(introduction)).toBe(
    'likely introduced by def5678 "Add promo banner" (file-263)',
  );
  expect(
    rangeText({
      ...introduction,
      range: { ...introduction.range, commits: 1, toDirty: true },
      configChanged: true,
    }),
  ).toBe(
    "appeared between abc1234 and def5678 (1 commit); plus uncommitted changes; checks configuration changed between runs",
  );
  expect(
    rangeText({
      ...introduction,
      range: { ...introduction.range, commits: null, linear: false },
    }),
  ).toBe("appeared between abc1234 and def5678 (not a linear range)");
  expect(
    rangeText({
      ...introduction,
      range: { ...introduction.range, commits: 0 },
    }),
  ).toBe("appeared between abc1234 and def5678 (no commits between runs)");
  expect(causeText({ candidates: [], likely: undefined })).toBe(
    "no commit in range touched this state's files",
  );
  expect(
    causeText({
      candidates: Array.from({ length: 7 }, (_, i) => ({
        commit: `${i}`.repeat(8),
        subject: "s",
        tickets: [],
      })),
    }),
  ).toBe(
    "commits touching this state: 0000000, 1111111, 2222222, 3333333, 4444444 +2",
  );
  expect(causeText({ candidatesOmitted: "not a linear range" })).toBe(
    "not a linear range",
  );
});
