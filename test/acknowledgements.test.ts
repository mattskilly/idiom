import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  latestAcknowledgement,
  materialEvidenceChange,
  parseUntil,
  resolveAcknowledgement,
  stampAcknowledgements,
  type TicketStateLookup,
  trackerTicketState,
} from "../src/decisions/acknowledgements.js";
import {
  type Acknowledgement,
  acknowledgementSchema,
} from "../src/schemas/decision.js";
import { findingSchema } from "../src/schemas/finding.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function ack(overrides: Partial<Acknowledgement> = {}): Acknowledgement {
  return acknowledgementSchema.parse({
    at: "2026-11-06T12:00:00.000Z",
    commit: "abc123",
    findingId: "finding-12",
    fingerprint: "fp-12",
    decision: "acknowledge",
    reference: "ABC-123",
    evidence: {
      severity: "minor",
      rule: "idiom:contrast",
      category: "contrast",
    },
    ...overrides,
  });
}

const target = {
  id: "finding-12",
  ids: ["finding-12"],
  fingerprints: ["fp-12"],
};
const observed = {
  severity: "minor" as const,
  rule: "idiom:contrast",
  category: "contrast" as const,
};
const noTracker: TicketStateLookup = async () => undefined;
const today = new Date("2026-11-06T15:00:00.000Z");

async function resolve(
  entries: Acknowledgement[],
  options: {
    finding?:
      | typeof observed
      | {
          severity: "major" | "minor" | "blocker";
          rule?: string;
          category: "contrast";
        };
    ticketState?: TicketStateLookup;
    now?: Date;
  } = {},
) {
  return resolveAcknowledgement({
    target,
    finding: options.finding ?? observed,
    entries,
    ticketState: options.ticketState ?? noTracker,
    now: options.now ?? today,
  });
}

test("the latest acknowledge or unacknowledge entry wins, matched by alias id or fingerprint", () => {
  const lineage = {
    ids: ["finding-12", "IDM-old"],
    fingerprints: ["fp-12", "fp-old"],
  };
  const first = ack({ reference: "ABC-1" });
  const byAliasId = ack({
    findingId: "IDM-old",
    fingerprint: "x",
    reference: "ABC-2",
  });
  const byAliasFingerprint = ack({
    findingId: "other",
    fingerprint: "fp-old",
    reference: "ABC-3",
  });
  const unrelated = ack({ findingId: "finding-9", fingerprint: "fp-9" });
  expect(latestAcknowledgement(lineage, [first, byAliasId, unrelated])).toBe(
    byAliasId,
  );
  expect(
    latestAcknowledgement(lineage, [first, byAliasId, byAliasFingerprint]),
  ).toBe(byAliasFingerprint);
  expect(latestAcknowledgement(lineage, [unrelated])).toBeUndefined();
  const removed = ack({ decision: "unacknowledge", evidence: undefined });
  expect(latestAcknowledgement(lineage, [first, removed])).toBe(removed);
});

test("an acknowledgement in force resolves active", async () => {
  expect(await resolve([ack()])).toMatchObject({ kind: "active" });
  expect(await resolve([])).toBeUndefined();
});

test("unacknowledging lapses it with the date it was removed", async () => {
  const state = await resolve([
    ack(),
    ack({
      decision: "unacknowledge",
      evidence: undefined,
      at: "2026-11-06T13:00:00.000Z",
    }),
  ]);
  expect(state).toMatchObject({
    kind: "lapsed",
    lapse: {
      reason: "unacknowledged",
      message:
        "finding-12 was acknowledged for ABC-123 and unacknowledged on 2026-11-06; it counts again.",
    },
  });
  // A new acknowledgement after the removal is in force again.
  expect(
    await resolve([
      ack(),
      ack({ decision: "unacknowledge", evidence: undefined }),
      ack({ reference: "ABC-200" }),
    ]),
  ).toMatchObject({ kind: "active", record: { reference: "ABC-200" } });
});

test("a tracker ticket that reaches done lapses it; earlier states keep it", async () => {
  const root = await mkdtemp(join(tmpdir(), "idiom-ack-tracker-"));
  directories.push(root);
  const roots = [join(root, ".autobuild", "tickets")];
  const place = async (state: string) => {
    await mkdir(join(roots[0] as string, state), { recursive: true });
    await writeFile(join(roots[0] as string, state, "file-1592.md"), "# t\n");
  };
  const lookup: TicketStateLookup = (reference) =>
    trackerTicketState(roots, reference);
  const record = ack({ reference: "file-1592" });

  expect(await trackerTicketState(roots, "file-1592")).toBeUndefined();
  expect(await resolve([record], { ticketState: lookup })).toMatchObject({
    kind: "active",
  });
  await place("doing");
  expect(await resolve([record], { ticketState: lookup })).toMatchObject({
    kind: "active",
  });
  // In doing and done at once: the earliest state wins, as lifecycle reads it.
  await place("done");
  expect(await trackerTicketState(roots, "file-1592")).toBe("doing");
  expect(await resolve([record], { ticketState: lookup })).toMatchObject({
    kind: "active",
  });
  await rm(join(roots[0] as string, "doing"), { recursive: true });
  expect(await resolve([record], { ticketState: lookup })).toMatchObject({
    kind: "lapsed",
    lapse: {
      reason: "ticket-done",
      ticketState: "done",
      message:
        "finding-12 was acknowledged for file-1592, which is now done; it counts again.",
    },
  });
});

test("a reference that is not a plain ticket id never reaches the filesystem", async () => {
  const root = await mkdtemp(join(tmpdir(), "idiom-ack-paths-"));
  directories.push(root);
  const tickets = join(root, "tickets");
  // A done ticket the traversal would otherwise find.
  await mkdir(join(tickets, "done"), { recursive: true });
  await writeFile(join(tickets, "done", "x.md"), "# t\n");
  await mkdir(join(root, "done"), { recursive: true });
  await writeFile(join(root, "done", "escape.md"), "# t\n");
  for (const reference of [
    "../escape",
    "done/x",
    "a..b",
    "https://tracker.example/browse/ABC-123",
    "/etc/passwd",
  ])
    expect(await trackerTicketState([tickets], reference)).toBeUndefined();
  const lookup = vi.fn((reference: string) =>
    trackerTicketState([tickets], reference),
  );
  expect(
    await resolve([ack({ reference: "../done/escape" })], {
      ticketState: lookup,
    }),
  ).toMatchObject({ kind: "active" });
});

test("until is inclusive: active on the day, lapsed the day after", async () => {
  const record = ack({ until: "2026-12-01" });
  expect(
    await resolve([record], { now: new Date("2026-12-01T23:59:59.000Z") }),
  ).toMatchObject({ kind: "active" });
  expect(
    await resolve([record], { now: new Date("2026-12-02T00:00:00.000Z") }),
  ).toMatchObject({
    kind: "lapsed",
    lapse: {
      reason: "expired",
      message:
        "finding-12 was acknowledged for ABC-123 until 2026-12-01, which has passed; it counts again.",
    },
  });
});

test("evidence lapses it when more severe or under another rule, not when milder", async () => {
  expect(
    await resolve([ack()], {
      finding: {
        severity: "major",
        rule: "idiom:contrast",
        category: "contrast",
      },
    }),
  ).toMatchObject({
    kind: "lapsed",
    lapse: {
      reason: "evidence-changed",
      detail: "severity minor → major",
      message:
        "finding-12 was acknowledged for ABC-123, but its evidence changed (severity minor → major); it counts again.",
    },
  });
  // A milder occurrence is the same tracked problem.
  expect(
    await resolve(
      [
        ack({
          evidence: {
            severity: "major",
            rule: "idiom:contrast",
            category: "contrast",
          },
        }),
      ],
      { finding: observed },
    ),
  ).toMatchObject({ kind: "active" });
  expect(
    materialEvidenceChange(
      ack({
        evidence: {
          severity: "major",
          rule: "idiom:contrast",
          category: "contrast",
        },
      }),
      { severity: "minor", rule: "idiom:contrast", category: "contrast" },
    ),
  ).toBeUndefined();
  expect(
    materialEvidenceChange(ack(), {
      severity: "minor",
      rule: "idiom:other",
      category: "contrast",
    }),
  ).toBe("rule idiom:contrast → idiom:other");
});

test("the first applicable lapse rule wins", async () => {
  const lookup: TicketStateLookup = async () => "done";
  const record = ack({ until: "2026-01-01" });
  expect(
    await resolve([record], {
      ticketState: lookup,
      finding: { severity: "major", category: "contrast", rule: "x" },
    }),
  ).toMatchObject({ lapse: { reason: "ticket-done" } });
  expect(
    await resolve([record], {
      finding: { severity: "major", category: "contrast", rule: "x" },
    }),
  ).toMatchObject({ lapse: { reason: "expired" } });
});

test("parseUntil accepts today or later and rejects malformed, impossible and past dates", () => {
  expect(parseUntil("2026-11-06", today)).toBe("2026-11-06");
  expect(parseUntil(" 2027-02-28 ", today)).toBe("2027-02-28");
  for (const value of [
    "2026-11",
    "11/06/2026",
    "tomorrow",
    "2026-02-30",
    "2027-13-01",
  ])
    expect(() => parseUntil(value, today)).toThrow("--until expects a date");
  expect(() => parseUntil("2026-11-05", today)).toThrow(
    "--until must be today or later (got 2026-11-05)",
  );
});

test("stamping marks findings in force, strips stale stamps and reports each lapse once", async () => {
  const base = findingSchema.parse({
    id: "finding-12",
    fingerprint: "fp-12",
    createdAt: "2026-11-06T12:00:00.000Z",
    commit: "abc123",
    flow: "booking",
    state: "ready",
    viewport: "mobile",
    layer: "deterministic",
    category: "contrast",
    severity: "minor",
    confidence: 1,
    rule: "idiom:contrast",
    evidence: { screenshots: [] },
    explanation: "Low contrast.",
    acceptance: ["Contrast meets 4.5:1."],
    verification: { kind: "deterministic-check", check: "contrast" },
    status: "open",
    acknowledgement: { reference: "OLD-1", at: "2026-11-01T00:00:00.000Z" },
  });
  const other = { ...base, id: "finding-13", fingerprint: "fp-13" };
  const targetFor = (finding: typeof base) => ({
    id: finding.id,
    ids: [finding.id],
    fingerprints: [finding.fingerprint],
  });
  const active = await stampAcknowledgements([base, other], {
    targetFor,
    entries: [ack({ until: "2026-12-01", note: "Tracked in Jira" })],
    ticketState: noTracker,
    now: today,
  });
  expect(active.findings[0]?.acknowledgement).toEqual({
    reference: "ABC-123",
    at: "2026-11-06T12:00:00.000Z",
    until: "2026-12-01",
    note: "Tracked in Jira",
  });
  expect(active.findings[1]).not.toHaveProperty("acknowledgement");
  expect(active.lapses).toEqual([]);
  const lapsed = await stampAcknowledgements([base, base], {
    targetFor,
    entries: [ack(), ack({ decision: "unacknowledge", evidence: undefined })],
    ticketState: noTracker,
    now: today,
  });
  expect(lapsed.findings.map((finding) => finding.acknowledgement)).toEqual([
    undefined,
    undefined,
  ]);
  expect(lapsed.lapses).toHaveLength(1);
});
