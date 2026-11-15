import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  DIGEST_RECORD_FILE,
  type DigestOccurrence,
  type DigestRecord,
  digestRecordSchema,
} from "../src/digest/record.js";
import { loadTrends, renderTrend } from "../src/digest/trend.js";
import { decisionSchema } from "../src/schemas/decision.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const captured = ["home/desktop", "home/mobile", "book/desktop", "book/mobile"];

function occurrence(
  fingerprint: string,
  overrides: Partial<DigestOccurrence> = {},
): DigestOccurrence {
  return {
    id: `id-${fingerprint}`,
    fingerprint,
    where: "home/desktop",
    state: "home",
    viewport: "desktop",
    category: "token-drift",
    rule: "idiom:token-drift",
    severity: "major",
    problem: "The colour is off the token scale.",
    disposition: "open",
    score: 7,
    impactReasons: [],
    ...overrides,
  };
}

function record(
  day: number,
  commit: string,
  occurrences: DigestOccurrence[],
  overrides: Partial<DigestRecord> = {},
): DigestRecord {
  const runId = `2026-11-${String(day).padStart(2, "0")}T08-30-00-000Z`;
  return {
    version: 1,
    flow: "booking",
    runId,
    completedAt: `2026-11-${String(day).padStart(2, "0")}T08:30:00.000Z`,
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

async function project(records: DigestRecord[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-trend-"));
  directories.push(directory);
  const reports = join(directory, ".idiom", "reports");
  for (const entry of records) {
    await mkdir(join(reports, entry.runId), { recursive: true });
    await writeFile(
      join(reports, entry.runId, DIGEST_RECORD_FILE),
      JSON.stringify(digestRecordSchema.parse(entry)),
    );
  }
  return directory;
}

const blocker = (fp: string) => occurrence(fp, { severity: "blocker" });
const major = (fp: string) => occurrence(fp, { severity: "major" });
const minor = (fp: string) => occurrence(fp, { severity: "minor" });

/** Six full runs (the oldest falls out of the window) and one partial run. */
function fixtureRuns(): DigestRecord[] {
  // Rejected by a later rule decision: excluded from every run, old ones too.
  const ruled = major("ruled");
  return [
    record(1, "0000000aaaa", [blocker("old"), major("old-2")]),
    record(2, "1111111bbbb", [
      blocker("b1"),
      major("m1"),
      major("m2"),
      minor("n1"),
      ruled,
      // Acknowledged, rejected, info and coverage-only never count.
      occurrence("ack", { disposition: "acknowledged" }),
      occurrence("rej", { disposition: "rejected" }),
      occurrence("info", { severity: "info" }),
      occurrence("tuple", {
        severity: "blocker",
        rule: "idiom:tuple-failure:navigation",
        coverageOnly: true,
      }),
    ]),
    record(3, "2222222cccc", [major("m1"), major("m2"), minor("n1"), ruled], {
      dirty: true,
    }),
    // A partial-scope run measures part of the flow: left out.
    record(4, "3333333dddd", [], { scope: "partial" }),
    record(5, "4444444eeee", [major("m1"), minor("n1"), ruled], {
      coverage: {
        selected: 4,
        captured: ["home/desktop", "home/mobile"],
        problems: [
          {
            kind: "failed",
            where: "book/desktop/light",
            detail: "capture failed",
          },
          {
            kind: "interrupted",
            where: "book/mobile/light",
            detail: "not captured",
          },
          // The same coordinate twice counts once.
          {
            kind: "failed",
            where: "book/mobile/light",
            detail: "capture failed",
          },
        ],
      },
    }),
    record(6, "5555555ffff", [minor("n1"), minor("n2"), ruled]),
    record(7, "6666666gggg", [minor("n2"), ruled]),
    // Another flow never mixes in.
    record(8, "7777777hhhh", [blocker("x")], { flow: "account" }),
  ];
}

test("the trend spans the last five full runs, oldest first, counting open blocker/major/minor", async () => {
  const directory = await project(fixtureRuns());
  await writeFile(
    join(directory, ".idiom", "decisions.jsonl"),
    `${JSON.stringify(
      decisionSchema.parse({
        at: "2026-11-08T12:00:00.000Z",
        commit: "6666666gggg",
        findingId: "id-ruled",
        fingerprint: "ruled",
        decision: "reject",
        scope: "rule",
        actor: "human",
      }),
    )}\n`,
  );
  const [trend, ...rest] = await loadTrends({
    projectDirectory: directory,
    flows: ["booking"],
  });
  expect(rest).toEqual([]);
  expect(trend?.flow).toBe("booking");
  expect(
    trend?.runs.map(({ completedAt, commit, blocker, major, minor }) => ({
      day: completedAt.slice(0, 10),
      commit,
      counts: [blocker, major, minor],
    })),
  ).toEqual([
    { day: "2026-11-02", commit: "1111111bbbb", counts: [1, 2, 1] },
    { day: "2026-11-03", commit: "2222222cccc", counts: [0, 2, 1] },
    { day: "2026-11-05", commit: "4444444eeee", counts: [0, 1, 1] },
    { day: "2026-11-06", commit: "5555555ffff", counts: [0, 0, 2] },
    { day: "2026-11-07", commit: "6666666gggg", counts: [0, 0, 1] },
  ]);
  expect(trend?.runs.map((run) => run.coverageGap)).toEqual([
    undefined,
    undefined,
    { missing: 2, selected: 4, kinds: ["failed", "interrupted"] },
    undefined,
    undefined,
  ]);
  expect(renderTrend(trend)).toEqual([
    "Trend for booking (last 5 runs, oldest first; open blocker/major/minor, acknowledged and rejected excluded):",
    "  2026-11-02 1111111  1/2/1",
    "  2026-11-03 2222222 (dirty)  0/2/1",
    "  2026-11-05 4444444  0/1/1  coverage gap: 2 of 4 tuples missing — not comparable",
    "  2026-11-06 5555555  0/0/2",
    "  2026-11-07 6666666  0/0/1",
  ]);
});

test("without a decision log, a later rejection is not applied and every flow is listed", async () => {
  const directory = await project(fixtureRuns());
  const trends = await loadTrends({ projectDirectory: directory });
  expect(trends.map((trend) => trend.flow)).toEqual(["account", "booking"]);
  const booking = trends[1];
  expect(booking?.runs.map((run) => run.major)).toEqual([3, 3, 2, 1, 1]);
  // A single point is not a line; JSON still carries it.
  expect(trends[0]?.runs).toHaveLength(1);
  expect(renderTrend(trends[0])).toEqual([]);
});

test("an instance rejection of a finding id is excluded; busy-host gaps read as deferred", async () => {
  const directory = await project([
    record(1, "aaaaaaa1", [major("m1"), major("m2")]),
    record(2, "bbbbbbb2", [major("m1"), major("m2")], {
      coverage: {
        selected: 4,
        captured,
        problems: [
          {
            kind: "busy-host",
            tuples: ["book/desktop/light", "book/mobile/light"],
            detail: "deferred",
          },
        ],
      },
    }),
  ]);
  await writeFile(
    join(directory, ".idiom", "decisions.jsonl"),
    `${JSON.stringify(
      decisionSchema.parse({
        at: "2026-11-03T12:00:00.000Z",
        commit: "bbbbbbb2",
        findingId: "id-m2",
        fingerprint: "m2",
        decision: "reject",
        scope: "instance",
        actor: "human",
      }),
    )}\n`,
  );
  const [trend] = await loadTrends({ projectDirectory: directory });
  expect(trend?.runs.map((run) => run.major)).toEqual([1, 1]);
  expect(renderTrend(trend).at(-1)).toBe(
    "  2026-11-02 bbbbbbb  0/1/0  coverage gap: 2 of 4 tuples deferred (busy host) — not comparable",
  );
});
