import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { decideCommand } from "../src/commands/decide.js";
import { initProject } from "../src/commands/init.js";
import { appendDecision, readDecisionLog } from "../src/decisions/log.js";
import {
  checkpointLineageStatus,
  loadReviewCatalog,
} from "../src/review/catalog.js";
import {
  type FindingDraft,
  finalizeFindings,
  suppressFindingDrafts,
} from "../src/review/findings.js";
import {
  findingFingerprint,
  findingFingerprintIdentity,
  normalizeSelectorHint,
} from "../src/review/fingerprint.js";
import {
  reduceLifecycles,
  renderLifecycleList,
} from "../src/review/lifecycle.js";
import { evaluateRules, readRules } from "../src/rules/index.js";
import { findingSchema } from "../src/schemas/finding.js";
import { rulesSchema } from "../src/schemas/rules.js";
import { ticketId } from "../src/tickets/render.js";
import { validateProject } from "../src/validation.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function finding(options: {
  id: string;
  fingerprint: string;
  createdAt: string;
  status?: "open" | "ticketed" | "verified-fixed" | "verify-failed";
}) {
  return findingSchema.parse({
    id: options.id,
    fingerprint: options.fingerprint,
    createdAt: options.createdAt,
    commit: "abc123",
    flow: "booking",
    state: "ready",
    viewport: "phone",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    rule: "idiom:target-size",
    evidence: { screenshots: [] },
    explanation: "The action is too small.",
    acceptance: ["The target is at least 44px."],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: options.status ?? "open",
  });
}

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-memory-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  return directory;
}

async function reportRun(
  directory: string,
  run: string,
  findings: ReturnType<typeof finding>[],
): Promise<void> {
  const path = join(directory, ".idiom", "reports", run);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "findings.json"),
    `${JSON.stringify(findings, null, 2)}\n`,
  );
}

describe("canonical fingerprints", () => {
  test("normalizes class order, generated classes, Unicode, and combinator spacing", () => {
    expect(
      normalizeSelectorHint("  main > button.primary.css-abcde.large  "),
    ).toBe("main > button.large.primary");
    expect(normalizeSelectorHint("button.large.primary")).toBe(
      "button.large.primary",
    );
    expect(normalizeSelectorHint('#save[data-testid="a"]:hover')).toBe(
      '#save[data-testid="a"]:hover',
    );
    expect(normalizeSelectorHint("cafe\u0301   action")).toBe("café action");
    expect(normalizeSelectorHint("error at https://example.com/a.b")).toBe(
      "error at https://example.com/a.b",
    );
    expect(normalizeSelectorHint(".css-1a2b3c")).toBe(".css-1a2b3c");
    expect(normalizeSelectorHint(".css-4d5e6f")).toBe(".css-4d5e6f");
    expect(normalizeSelectorHint("button.css-1a2b3c")).toBe("button");
    expect(normalizeSelectorHint("button.css-4d5e6f")).toBe("button");
    expect(
      findingFingerprint({
        category: "contrast",
        flow: "booking",
        state: "ready",
        rule: "axe:color-contrast",
        selectorHint: ".css-1a2b3c",
      }),
    ).not.toBe(
      findingFingerprint({
        category: "contrast",
        flow: "booking",
        state: "ready",
        rule: "axe:color-contrast",
        selectorHint: ".css-4d5e6f",
      }),
    );
  });

  test("returns a canonical fingerprint plus a legacy compatibility alias", () => {
    const input = {
      category: "target-size",
      flow: "booking",
      state: "ready",
      rule: "idiom:target-size",
      selectorHint: "button.primary.css-abcde",
    };
    const identity = findingFingerprintIdentity(input);
    expect(identity.fingerprint).toBe(findingFingerprint(input));
    expect(identity.aliases).toHaveLength(1);
    expect(findingFingerprint(input)).toBe(
      findingFingerprint({
        ...input,
        selectorHint: "button.primary.css-fedcb",
      }),
    );
  });
});

describe("project rules", () => {
  test("enforces strict action shape, nonempty matches, and unique ids", () => {
    expect(
      rulesSchema.safeParse({
        version: 1,
        overrides: [
          { id: "one", match: {}, action: "suppress", reason: "Intentional" },
        ],
      }).success,
    ).toBe(false);
    expect(
      rulesSchema.safeParse({
        version: 1,
        overrides: [
          {
            id: "one",
            match: { flow: "booking" },
            action: "severity",
            reason: "Lower impact here",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      rulesSchema.safeParse({
        version: 1,
        overrides: [
          {
            id: "one",
            match: { flow: "booking" },
            action: "suppress",
            reason: "A",
          },
          {
            id: "one",
            match: { state: "ready" },
            action: "suppress",
            reason: "B",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("uses conjunctive matching, suppression dominance, and last severity", () => {
    const rules = rulesSchema.parse({
      version: 1,
      overrides: [
        {
          id: "broad",
          match: { flow: "booking" },
          action: "severity",
          severity: "minor",
          reason: "Broad downgrade",
        },
        {
          id: "specific",
          match: { flow: "booking", state: "ready" },
          action: "severity",
          severity: "blocker",
          reason: "Critical state",
        },
        {
          id: "suppress",
          match: { fingerprint: "legacy" },
          action: "suppress",
          reason: "Permanent exception",
        },
      ],
    });
    const policy = evaluateRules(rules, {
      ...finding({
        id: "IDM-1",
        fingerprint: "canonical",
        createdAt: "2026-08-14T12:00:00.000Z",
      }),
      fingerprintAliases: ["legacy"],
    });
    expect(policy.severity).toMatchObject({
      effective: "blocker",
      override: { id: "specific" },
    });
    expect(policy.suppression?.id).toBe("suppress");
  });

  test("missing rules default to empty and a present malformed file fails", async () => {
    const directory = await project();
    await rm(join(directory, ".idiom", "rules.json"));
    await expect(readRules(directory)).resolves.toEqual({
      version: 1,
      overrides: [],
    });
    await writeFile(join(directory, ".idiom", "rules.json"), "{ nope");
    await expect(readRules(directory)).rejects.toThrow(
      ".idiom/rules.json: malformed JSON",
    );
  });

  test("the committed booking example validates without a rules file", async () => {
    const result = await validateProject({
      project: join(import.meta.dirname, "..", "examples", "booking"),
      flow: "booking",
    });
    expect(result.rules).toEqual({ version: 1, overrides: [] });
  });
});

describe("lineage and lifecycle", () => {
  test("a later canonical rule acceptance cancels a legacy rejection", () => {
    const draft: FindingDraft = {
      finding: finding({
        id: "draft",
        fingerprint: "canonical",
        createdAt: "2026-08-15T12:00:00.000Z",
      }),
      selectorHint: "button.primary",
      stableOrder: 0,
      fingerprintAliases: ["legacy"],
    };
    const result = suppressFindingDrafts(
      [draft],
      [
        {
          at: "2026-08-14T12:00:00.000Z",
          commit: "abc123",
          findingId: "old",
          fingerprint: "legacy",
          decision: "reject",
          scope: "rule",
          actor: "human",
        },
        {
          at: "2026-08-15T12:00:00.000Z",
          commit: "abc123",
          findingId: "old",
          fingerprint: "canonical",
          decision: "accept",
          scope: "rule",
          actor: "human",
        },
      ],
    );
    expect(result.kept).toEqual([draft]);
    expect(result.suppressed).toEqual([]);
  });

  test("groups consecutive observations and reuses the first published id", async () => {
    const directory = await project();
    const first = finding({
      id: "IDM-first-0001",
      fingerprint: "same-fingerprint",
      createdAt: "2026-08-14T12:00:00.000Z",
    });
    const second = finding({
      id: "IDM-second-0001",
      fingerprint: "same-fingerprint",
      createdAt: "2026-08-15T12:00:00.000Z",
    });
    await reportRun(directory, "2026-08-14", [first]);
    await reportRun(directory, "2026-08-15", [second]);
    const catalog = await loadReviewCatalog({ project: directory });
    expect(catalog.lineages).toHaveLength(1);
    expect(catalog.lineages[0]).toMatchObject({
      id: "finding-1",
      ids: ["finding-1", first.id, second.id],
    });

    const draft: FindingDraft = {
      finding: { ...second, id: "draft" },
      selectorHint: "button.primary",
      stableOrder: 0,
    };
    expect(
      finalizeFindings({ runId: "third", drafts: [draft], catalog })[0]?.id,
    ).toBe("finding-1");

    const unrelated: FindingDraft = {
      ...draft,
      finding: { ...second, id: "draft-new", fingerprint: "new-fingerprint" },
    };
    expect(
      finalizeFindings({ runId: "first", drafts: [unrelated], catalog })[0]?.id,
    ).toBe("finding-2");
  });

  test("reduces decision, historical ticket, and verification checkpoints", async () => {
    const directory = await project();
    const first = finding({
      id: "IDM-first-0001",
      fingerprint: "legacy-fingerprint",
      createdAt: "2026-08-14T12:00:00.000Z",
    });
    const current = finding({
      id: first.id,
      fingerprint: "canonical-fingerprint",
      createdAt: "2026-08-15T12:00:00.000Z",
    });
    await reportRun(directory, "2026-08-14", [first]);
    await reportRun(directory, "2026-08-15", [current]);
    await appendDecision({
      projectDirectory: directory,
      finding: first,
      decision: "accept",
      scope: "instance",
      now: () => new Date("2026-08-15T13:00:00.000Z"),
    });
    const oldTicketId = ticketId(first.fingerprint, first.id);
    const ticket = join(
      directory,
      ".autobuild",
      "tickets",
      "ready",
      `${oldTicketId}.md`,
    );
    await mkdir(join(ticket, ".."), { recursive: true });
    await writeFile(ticket, "historical ticket");

    const catalog = await loadReviewCatalog({ project: directory });
    await checkpointLineageStatus({
      catalog,
      findingId: first.id,
      status: "ticketed",
    });
    await checkpointLineageStatus({
      catalog,
      findingId: first.id,
      status: "verify-failed",
    });
    const refreshed = await loadReviewCatalog({ project: directory });
    const lifecycles = await reduceLifecycles({
      catalog: refreshed,
      decisions: await readDecisionLog(directory),
    });
    expect(lifecycles[0]).toMatchObject({
      id: "finding-1",
      occurrences: 2,
      ticket: { id: oldTicketId, state: "ready", conflict: false },
      verification: "verify-failed",
      path: ["open", "approved", "ticketed", "verify-failed"],
    });
    const output = renderLifecycleList(lifecycles);
    expect(output).toContain("legacy-fingerprint");
    expect(output).toContain("open -> approved -> ticketed -> verify-failed");
  });

  test("an additional report root merges by run id and leaves the default alone", async () => {
    const directory = await project();
    const secondary = await mkdtemp(join(tmpdir(), "idiom-secondary-"));
    directories.push(secondary);
    const current = {
      ...finding({
        id: "IDM-first-0001",
        fingerprint: "same-fingerprint",
        createdAt: "2026-08-15T12:00:00.000Z",
      }),
      explanation: "The authoritative local copy.",
    };
    await reportRun(directory, "2026-08-15", [current]);
    await reportRun(secondary, "2026-08-14", [
      finding({
        id: "IDM-first-0001",
        fingerprint: "same-fingerprint",
        createdAt: "2026-08-14T12:00:00.000Z",
      }),
    ]);
    await reportRun(secondary, "2026-08-15", [
      {
        ...current,
        explanation: "A stale inherited copy that must never win.",
      },
    ]);
    const additionalReportRoots = [join(secondary, ".idiom", "reports")];

    const isolated = await loadReviewCatalog({ project: directory });
    expect(isolated.runs.map((run) => run.runId)).toEqual(["2026-08-15"]);
    expect(isolated.lineages[0]?.occurrences).toHaveLength(1);

    const merged = await loadReviewCatalog({
      project: directory,
      additionalReportRoots,
    });
    expect(merged.runs.map((run) => run.runId)).toEqual([
      "2026-08-14",
      "2026-08-15",
    ]);
    expect(merged.lineages).toHaveLength(1);
    expect(merged.lineages[0]?.occurrences).toHaveLength(2);
    expect(merged.lineages[0]?.first.finding.createdAt).toBe(
      "2026-08-14T12:00:00.000Z",
    );
    expect(merged.lineages[0]?.latest.finding.explanation).toBe(
      "The authoritative local copy.",
    );

    // Passing the project's own reports again resolves to the same root.
    await expect(
      loadReviewCatalog({
        project: directory,
        additionalReportRoots: [join(directory, ".idiom", "reports")],
      }),
    ).resolves.toMatchObject({ runs: isolated.runs });
  });

  test("an additional tracker root resolves state without inventing a conflict", async () => {
    const directory = await project();
    const secondary = await mkdtemp(join(tmpdir(), "idiom-secondary-"));
    directories.push(secondary);
    const item = finding({
      id: "IDM-run-0001",
      fingerprint: "fingerprint",
      createdAt: "2026-08-15T12:00:00.000Z",
    });
    await reportRun(directory, "2026-08-15", [item]);
    const id = ticketId(item.fingerprint, item.id);
    const additionalTrackerRoots = [join(secondary, ".autobuild", "tickets")];
    const load = async () => ({
      catalog: await loadReviewCatalog({ project: directory }),
      decisions: await readDecisionLog(directory),
    });
    const ticketAt = async (root: string, state: string) => {
      await mkdir(join(root, ".autobuild", "tickets", state), {
        recursive: true,
      });
      await writeFile(
        join(root, ".autobuild", "tickets", state, `${id}.md`),
        "ticket",
      );
    };

    await ticketAt(secondary, "ready");
    expect((await reduceLifecycles(await load()))[0]?.ticket).toBeUndefined();
    expect(
      (await reduceLifecycles({ ...(await load()), additionalTrackerRoots }))[0]
        ?.ticket,
    ).toMatchObject({ id, state: "ready", conflict: false });

    // The same ticket visible from both roots is one ticket, not a conflict.
    await ticketAt(directory, "ready");
    const shared = (
      await reduceLifecycles({ ...(await load()), additionalTrackerRoots })
    )[0]?.ticket;
    expect(shared).toMatchObject({ state: "ready", conflict: false });
    expect(shared?.paths).toEqual([
      join(directory, ".autobuild", "tickets", "ready", `${id}.md`),
    ]);

    // A genuinely different state across roots is still a conflict.
    await ticketAt(secondary, "done");
    expect(
      (await reduceLifecycles({ ...(await load()), additionalTrackerRoots }))[0]
        ?.ticket,
    ).toMatchObject({ state: "ready", conflict: true });
  });

  test("decide --list is read-only and mutually exclusive with writes", async () => {
    const directory = await project();
    const item = finding({
      id: "IDM-run-0001",
      fingerprint: "fingerprint",
      createdAt: "2026-08-15T12:00:00.000Z",
    });
    await reportRun(directory, "2026-08-15", [item]);
    const decisionsPath = join(directory, ".idiom", "decisions.jsonl");
    const before = await readFile(decisionsPath, "utf8");
    const output: string[] = [];
    const result = await decideCommand({
      project: directory,
      list: true,
      write: (message) => output.push(message),
    });
    expect(result.listed).toBe(true);
    expect(output.join("\n")).toContain("Lifecycle: open");
    expect(await readFile(decisionsPath, "utf8")).toBe(before);
    await expect(
      decideCommand({
        project: directory,
        list: true,
        finding: item.id,
        accept: true,
      }),
    ).rejects.toThrow("--list cannot be combined");
    expect(await readFile(decisionsPath, "utf8")).toBe(before);
  });
});
