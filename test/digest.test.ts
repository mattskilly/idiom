import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type DigestFlow,
  digestFlow,
  loadFlowRecords,
  oneClause,
} from "../src/digest/build.js";
import {
  DIGEST_RECORD_FILE,
  type DigestOccurrence,
  type DigestRecord,
  digestRecordSchema,
  readDigestRecord,
} from "../src/digest/record.js";
import { DIGEST_LINE_BUDGET, renderDigest } from "../src/digest/render.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const captured = [
  "cart/desktop",
  "cart/mobile",
  "checkout/desktop",
  "checkout/mobile",
  "done/desktop",
  "done/mobile",
];

function occurrence(
  overrides: Partial<DigestOccurrence> & { fingerprint: string },
): DigestOccurrence {
  const where = overrides.where ?? "cart/desktop";
  const [state = "cart", viewport = "desktop"] = where.split("/");
  return {
    id: `id-${overrides.fingerprint}`,
    where,
    state,
    viewport,
    category: "token-drift",
    rule: "idiom:token-drift",
    severity: "major",
    problem: "The colour is off the token scale. Use a declared token.",
    disposition: "open",
    score: 7,
    impactReasons: [],
    ...overrides,
  };
}

let clock = 0;
function record(
  runId: string,
  occurrences: DigestOccurrence[],
  overrides: Partial<DigestRecord> = {},
): DigestRecord {
  clock += 1;
  return {
    version: 1,
    flow: "shop",
    runId,
    completedAt: `2026-11-0${Math.min(9, clock)}T08:30:00.000Z`,
    commit: "abc123",
    dirty: false,
    reportPath: `.idiom/reports/${runId}/report.md`,
    configHash: "hash-1",
    scope: "full",
    coverage: { selected: captured.length, captured, problems: [] },
    occurrences,
    ...overrides,
  };
}

/** Newest first, as the engine reads them. */
async function stored(records: DigestRecord[]): Promise<DigestRecord[]> {
  const project = await mkdtemp(join(tmpdir(), "idiom-digest-"));
  directories.push(project);
  const reports = join(project, ".idiom", "reports");
  for (const entry of records) {
    await mkdir(join(reports, entry.runId), { recursive: true });
    await writeFile(
      join(reports, entry.runId, DIGEST_RECORD_FILE),
      JSON.stringify(digestRecordSchema.parse(entry)),
    );
  }
  return (await loadFlowRecords(reports)).get("shop") ?? [];
}

const run = (hour: number) => `2026-11-0${hour}T08-30-00-000Z` as const;

test("nothing new: identical complete runs give a quiet verdict", async () => {
  clock = 0;
  const same = [occurrence({ fingerprint: "a" })];
  const records = await stored([record(run(1), same), record(run(2), same)]);
  const flow = digestFlow("shop", records);
  expect(flow.verdict).toBe("nothing-new");
  expect(flow.text).toBe(`Nothing new since ${run(1)}, 2026-11-01 08:30 UTC.`);
  expect(flow.since?.id).toBe(run(1));
  const lines = renderDigest([flow]);
  expect(lines[0]).toBe(flow.text);
  expect(lines).toContain("Also: 1 open unchanged.");
  expect(lines.at(-1)).toBe(`Report: .idiom/reports/${run(2)}/report.md`);
});

test("new and fixed: majors get a line, minors are counted, fixed findings are listed", async () => {
  clock = 0;
  const gone = occurrence({ fingerprint: "gone", severity: "minor" });
  const kept = occurrence({ fingerprint: "kept" });
  const records = await stored([
    record(run(1), [gone, kept]),
    record(run(2), [
      kept,
      occurrence({
        fingerprint: "wide",
        groupKey: "g-wide",
        id: "wide-2",
        where: "checkout/desktop",
        rule: "idiom:clipped-text",
        problem: "The label is clipped; it loses two characters",
      }),
      occurrence({
        fingerprint: "wide",
        groupKey: "g-wide",
        id: "wide-1",
        where: "cart/desktop",
        rule: "idiom:clipped-text",
        problem: "The label is clipped; it loses two characters",
      }),
      occurrence({ fingerprint: "small", severity: "minor" }),
    ]),
  ]);
  const flow = digestFlow("shop", records);
  expect(flow.verdict).toBe("changes");
  expect(flow.text).toBe(`2 new, 1 fixed since ${run(1)}.`);
  expect(flow.newFindings).toHaveLength(1);
  expect(flow.newFindings[0]).toMatchObject({
    id: "wide-1",
    ids: ["wide-1", "wide-2"],
    states: ["cart", "checkout"],
    impactReasons: ["states"],
    impact: 1,
  });
  expect(flow.counts).toMatchObject({ newMinor: 1, unchanged: 1 });
  expect(renderDigest([flow])).toEqual([
    `2 new, 1 fixed since ${run(1)}.`,
    "+ wide-1 [major] idiom:clipped-text — cart, checkout — The label is clipped",
    "- id-gone [minor] idiom:token-drift — cart — fixed",
    "Also: 1 new minor, 1 open unchanged.",
    "Decisions: attribution unavailable (legacy snapshot).",
    `Report: .idiom/reports/${run(2)}/report.md`,
  ]);
});

test("coverage problems come first, are never findings, and leave their coordinates uncompared", async () => {
  clock = 0;
  const records = await stored([
    record(run(1), [occurrence({ fingerprint: "a" })]),
    record(
      run(2),
      [
        occurrence({ fingerprint: "a" }),
        occurrence({
          fingerprint: "fail",
          where: "checkout/mobile",
          category: "missing-state",
          rule: "idiom:tuple-failure:capture",
          severity: "blocker",
          coverageOnly: true,
        }),
        occurrence({ fingerprint: "late", where: "checkout/mobile" }),
      ],
      {
        coverage: {
          selected: 6,
          captured: captured.filter(
            (key) => key !== "checkout/mobile" && key !== "done/mobile",
          ),
          problems: [
            {
              kind: "failed",
              where: "checkout/mobile/light",
              detail: "The declared state did not render during capture",
            },
            {
              kind: "interrupted",
              where: "done/mobile/light",
              detail: "not captured",
            },
            {
              kind: "busy-host",
              tuples: ["cart/mobile/light"],
              detail: "1 of 6 tuples timed out",
            },
          ],
        },
      },
    ),
  ]);
  const flow = digestFlow("shop", records);
  expect(flow.verdict).toBe("changes");
  expect(flow.text).toBe(`0 new, 0 fixed since ${run(1)}.`);
  expect(flow.newFindings).toEqual([]);
  expect(flow.counts).toEqual({
    newMinor: 0,
    unchanged: 1,
    notCompared: 1,
    acknowledged: 0,
    rejected: 0,
  });
  const lines = renderDigest([flow]);
  expect(lines.slice(1, 4)).toEqual([
    "! failed checkout/mobile/light — The declared state did not render during capture",
    "! interrupted done/mobile/light — not captured",
    "! busy host: 1 of 6 tuples timed out — re-run on an idle host",
  ]);
  expect(lines.join("\n")).not.toContain("tuple-failure");
});

test("a partial run is never latest and an incomplete run is never the default comparison", async () => {
  clock = 0;
  const failed = {
    selected: 6,
    captured,
    problems: [
      { kind: "failed" as const, where: "cart/desktop/light", detail: "x" },
    ],
  };
  const records = await stored([
    record(run(1), []),
    record(run(2), [], { coverage: failed }),
    record(run(3), []),
    record(run(4), [], { scope: "partial" }),
  ]);
  const flow = digestFlow("shop", records);
  expect(flow.run.id).toBe(run(3));
  expect(flow.since?.id).toBe(run(1));
  // An explicit run may be incomplete; it still has to be full scope.
  expect(digestFlow("shop", records, run(2)).since?.id).toBe(run(2));
  expect(() => digestFlow("shop", records, run(4))).toThrow(
    /checked only part of the flow/,
  );
  expect(() => digestFlow("shop", records, run(3))).toThrow(
    /that is the latest run/,
  );
  expect(() => digestFlow("shop", records, "2026-10-01T00-00-00-000Z")).toThrow(
    new RegExp(
      `no digest record for that run of shop; the oldest complete run of shop is ${run(1)}`,
    ),
  );
  expect(() => digestFlow("shop", [])).toThrow(
    "no checked run of shop yet; run idiom check shop",
  );
  expect(() => digestFlow("shop", records, "last week")).toThrow(
    /expected a run id, a YYYY-MM-DD date or an ISO datetime/,
  );
});

test("--since a date or datetime picks the newest complete run before it", async () => {
  clock = 0;
  const records = await stored([
    record(run(1), [], { completedAt: "2026-11-01T23:59:00.000Z" }),
    record(run(2), [], { completedAt: "2026-11-02T00:00:00.000Z" }),
    record(run(3), [], { completedAt: "2026-11-03T12:00:00.000Z" }),
  ]);
  expect(digestFlow("shop", records, "2026-11-02").since?.id).toBe(run(1));
  expect(digestFlow("shop", records, "2026-11-03").since?.id).toBe(run(2));
  expect(digestFlow("shop", records, "2026-11-02T00:00:00Z").since?.id).toBe(
    run(2),
  );
  expect(() => digestFlow("shop", records, "2026-11-01T23:58:59Z")).toThrow(
    /no complete run of shop before then/,
  );
  expect(() => digestFlow("shop", records, "2026-11-01")).toThrow(
    `--since 2026-11-01: no complete run of shop before then; the oldest complete run of shop is ${run(1)} (2026-11-01 23:59 UTC)`,
  );
});

test("acknowledged and rejected findings are neither new nor fixed, only counted", async () => {
  clock = 0;
  const records = await stored([
    record(run(1), [
      occurrence({ fingerprint: "ack" }),
      occurrence({ fingerprint: "rej" }),
    ]),
    record(run(2), [
      occurrence({ fingerprint: "ack", disposition: "acknowledged" }),
      occurrence({ fingerprint: "rej", disposition: "rejected" }),
    ]),
  ]);
  const flow = digestFlow("shop", records);
  expect(flow.verdict).toBe("nothing-new");
  expect(flow.fixed).toEqual([]);
  expect(flow.counts).toMatchObject({ acknowledged: 1, rejected: 1 });
  expect(renderDigest([flow])).toContain("Also: 1 acknowledged, 1 rejected.");
});

test("a changed checks configuration is called out on the verdict", async () => {
  clock = 0;
  const records = await stored([
    record(run(1), []),
    record(run(2), [], { configHash: "hash-2" }),
  ]);
  expect(digestFlow("shop", records).text).toBe(
    `Nothing new since ${run(1)}, 2026-11-01 08:30 UTC. Checks configuration changed since then.`,
  );
});

test("no earlier complete run says so", async () => {
  clock = 0;
  const flow = digestFlow("shop", await stored([record(run(1), [])]));
  expect(flow.verdict).toBe("no-comparison");
  expect(flow.text).toBe(
    `No earlier complete run of shop to compare with (latest ${run(1)}, 2026-11-01 08:30 UTC).`,
  );
});

function largeFlow(flow: string): DigestFlow {
  clock = 0;
  const before = Array.from({ length: 40 }, (_, index) =>
    occurrence({
      fingerprint: `old-${index}`,
      where: captured[index % captured.length] as string,
    }),
  );
  const after = Array.from({ length: 120 }, (_, index) =>
    occurrence({
      fingerprint: `new-${index}`,
      where: captured[index % captured.length] as string,
    }),
  );
  const problems = Array.from({ length: 12 }, (_, index) => ({
    kind: "failed" as const,
    where: `extra-${index}/desktop/light`,
    detail: "capture failed",
  }));
  return digestFlow(flow, [
    record(run(2), after, {
      flow,
      coverage: { selected: 18, captured, problems },
    }),
    record(run(1), before, { flow }),
  ]);
}

test("a large run stays within the line budget with overflow lines; JSON stays complete", () => {
  const flow = largeFlow("shop");
  expect(flow.newFindings).toHaveLength(120);
  expect(flow.fixed).toHaveLength(40);
  expect(flow.coverage).toHaveLength(12);
  const lines = renderDigest([flow]);
  expect(lines.length).toBeLessThanOrEqual(DIGEST_LINE_BUDGET);
  expect(lines).toHaveLength(DIGEST_LINE_BUDGET);
  // 25 − verdict, counts, decision attribution, report = 21: coverage 5, fixed reserves 3, new 14.
  expect(lines).toContain("…and 8 more coverage problems");
  expect(lines).toContain(
    `…and 108 more new findings at major or above — idiom check shop or .idiom/reports/${run(2)}/report.md`,
  );
  expect(lines).toContain("…and 38 more fixed");
  const three = renderDigest([
    largeFlow("alpha"),
    largeFlow("beta"),
    largeFlow("gamma"),
  ]);
  expect(three.length).toBeLessThanOrEqual(DIGEST_LINE_BUDGET);
  expect(three.slice(0, 3).map((line) => line.split(":")[0])).toEqual([
    "alpha",
    "beta",
    "gamma",
  ]);
  expect(three.some((line) => line.startsWith("+ alpha/"))).toBe(true);
});

test("within a severity, a broad interactive finding ranks above a higher-scoring cosmetic one", async () => {
  clock = 0;
  const records = await stored([
    record(run(1), []),
    record(run(2), [
      occurrence({ fingerprint: "cosmetic", id: "a-cosmetic", score: 28 }),
      ...["cart/desktop", "checkout/desktop", "done/desktop"].map((where) =>
        occurrence({
          fingerprint: `control-${where}`,
          groupKey: "control",
          id: `z-control-${where.split("/")[0]}`,
          where,
          score: 4,
          impactReasons: ["interactive"],
        }),
      ),
    ]),
  ]);
  const flow = digestFlow("shop", records);
  expect(flow.newFindings.map((item) => [item.id, item.impactReasons])).toEqual(
    [
      ["z-control-cart", ["states", "interactive"]],
      ["a-cosmetic", []],
    ],
  );
});

test("oneClause keeps the first clause and caps its length", () => {
  expect(oneClause("Off scale. Use a token.")).toBe("Off scale");
  expect(oneClause("Clipped; loses text")).toBe("Clipped");
  expect(oneClause("Gap too small — 2px")).toBe("Gap too small");
  expect(oneClause("first line\nsecond")).toBe("first line");
  expect(oneClause("v1.2 is fine")).toBe("v1.2 is fine");
  const long = oneClause("x".repeat(150));
  expect(long).toHaveLength(100);
  expect(long.endsWith("…")).toBe(true);
});

test("an unreadable record is skipped, never fatal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-digest-bad-"));
  directories.push(directory);
  await writeFile(join(directory, DIGEST_RECORD_FILE), "{not json");
  expect(await readDigestRecord(directory)).toBeUndefined();
  await writeFile(
    join(directory, DIGEST_RECORD_FILE),
    JSON.stringify({ version: 2 }),
  );
  expect(await readDigestRecord(directory)).toBeUndefined();
});

test("info persists in records but its addition and removal produce no digest changes or counts", async () => {
  clock = 0;
  const info = occurrence({ fingerprint: "info-card", severity: "info" });
  for (const [before, after] of [
    [[], [info]],
    [[info], []],
    [[info], [info]],
  ] as const) {
    const records = await stored([
      record(run(1), [...before]),
      record(run(2), [...after]),
    ]);
    const flow = digestFlow("shop", records);
    expect(flow.verdict).toBe("nothing-new");
    expect(flow.newFindings).toEqual([]);
    expect(flow.fixed).toEqual([]);
    expect(Object.values(flow.counts).every((count) => count === 0)).toBe(true);
    expect(renderDigest([flow]).join("\n")).not.toContain("info-card");
  }
  const records = await stored([
    record(run(1), []),
    record(run(2), [
      info,
      occurrence({ fingerprint: "minor", severity: "minor" }),
      occurrence({ fingerprint: "major", severity: "major" }),
    ]),
  ]);
  const flow = digestFlow("shop", records);
  expect(flow.newFindings.map((entry) => entry.severity)).toEqual(["major"]);
  expect(flow.counts.newMinor).toBe(1);
});

test("human-found metric shares the 25-line budget across eight busy flows", () => {
  const records = [
    record(
      run(2),
      Array.from({ length: 12 }, (_, index) =>
        occurrence({ fingerprint: `new-${index}` }),
      ),
    ),
    record(run(1), []),
  ];
  const flows = Array.from({ length: 8 }, (_, index) =>
    digestFlow(`flow-${index}`, records),
  );
  const humanFound = {
    logged: 4,
    covered: 2,
    coveredByRun: 1,
    coveredByMark: 1,
    open: 2,
    latest: "2026-11-04T12:00:00.000Z",
    openEntries: [],
  };
  const lines = renderDigest(flows, {
    humanFound,
    now: new Date("2026-11-06T12:00:00.000Z"),
  });
  expect(lines.length).toBeLessThanOrEqual(DIGEST_LINE_BUDGET);
  expect(
    lines.filter((line) => line.startsWith("Human-found misses:")),
  ).toEqual([
    "Human-found misses: 4 logged, 2 now covered by a rule, 2 open (latest: 2 days ago).",
  ]);
  expect(
    lines.findIndex((line) => line.startsWith("Human-found misses:")),
  ).toBeLessThan(lines.findIndex((line) => line.startsWith("Report (")));
  expect(renderDigest(flows).join("\n")).not.toContain("Human-found misses:");
});

test("digest decision partitions retain mixed actors, deduplicate sources, and disclose legacy attribution", () => {
  const source = (line: number) => ({ line, sha256: String(line).repeat(64) });
  const snapshot = (
    line: number,
    actor: string,
    decision: "accept" | "reject" | "acknowledge",
  ) => ({
    source: source(line),
    actor,
    decision,
    occurrences: [
      { fingerprint: "a", where: "cart/mobile" },
      { fingerprint: "a", where: "cart/desktop" },
    ],
  });
  const snapshots = [
    snapshot(1, "human", "accept"),
    snapshot(2, "agent", "reject"),
    snapshot(3, "human", "acknowledge"),
    snapshot(4, "historical-bot", "reject"),
  ];
  const records = [
    record(
      run(2),
      [occurrence({ fingerprint: "config-only", disposition: "rejected" })],
      { appliedDecisions: [...snapshots, snapshot(1, "human", "accept")] },
    ),
    record(run(1), []),
  ];
  const flow = digestFlow("shop", records);
  expect(flow.decisions).toEqual({
    available: true,
    human: { accept: 1, reject: 0, acknowledge: 1 },
    agent: { accept: 0, reject: 1, acknowledge: 0 },
    unattributed: { accept: 0, reject: 1, acknowledge: 0 },
  });
  expect(flow.counts.rejected).toBe(1); // Configuration affects occurrence totals, never judgment counts.
  const text = renderDigest([flow]).join("\n");
  expect(text).toContain(
    "human 1 accept / 0 reject / 1 acknowledge; agent 0 accept / 1 reject / 0 acknowledge; unattributed 0 accept / 1 reject / 0 acknowledge",
  );
  const unrelated = digestFlow("other", [
    record(run(2), [], { flow: "other", appliedDecisions: [] }),
  ]);
  expect(unrelated.decisions.human.accept).toBe(0);
  const legacy = digestFlow("shop", [record(run(2), [])]);
  expect(legacy.decisions.available).toBe(false);
});
