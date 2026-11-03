import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { readDecisionLog } from "../src/decisions/log.js";
import { RunFailure } from "../src/errors.js";
import {
  loadReviewCatalog,
  newestOpenFindings,
} from "../src/review/catalog.js";
import {
  compareFindingNames,
  FindingNamingSession,
  findingNameDivergenceWarning,
  findingNameRegistrySchema,
  loadFindingNames,
  persistFindingNames,
  preflightFindingNameRegistry,
} from "../src/review/names.js";
import { findingSchema } from "../src/schemas/finding.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(label = "idiom-finding-names-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  return directory;
}

async function writeRegistry(
  directory: string,
  entries: Array<{ name: string; fingerprints: string[]; legacyIds: string[] }>,
): Promise<void> {
  const next =
    Math.max(0, ...entries.map(({ name }) => Number(name.slice(8)))) + 1;
  await writeFile(
    join(directory, ".idiom", "finding-names.json"),
    `${JSON.stringify({ version: 1, next, entries })}\n`,
  );
}

async function writeReport(
  directory: string,
  runId: string,
  findings: unknown[],
): Promise<void> {
  const run = join(directory, ".idiom", "reports", runId);
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "findings.json"), JSON.stringify(findings));
}

function finding(id: string, fingerprint: string) {
  return findingSchema.parse({
    id,
    fingerprint,
    createdAt: "2026-08-20T13:43:38.374Z",
    commit: "legacy-commit",
    flow: "booking",
    state: "ready",
    viewport: "mobile",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    rule: "idiom:target-size",
    evidence: { screenshots: [] },
    explanation: "The action is too small.",
    acceptance: ["The action is at least 44px."],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: "open",
  });
}

describe("finding-name registry", () => {
  test("rejects sequence, name, alias, and identity corruption", () => {
    expect(
      findingNameRegistrySchema.safeParse({
        version: 1,
        next: 2,
        entries: [
          {
            name: "finding-2",
            fingerprints: ["print-a"],
            legacyIds: [],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      findingNameRegistrySchema.safeParse({
        version: 1,
        next: 3,
        entries: [
          {
            name: "finding-1",
            fingerprints: ["shared"],
            legacyIds: [],
          },
          {
            name: "finding-2",
            fingerprints: ["shared"],
            legacyIds: ["finding-1"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("bootstraps all 19 legacy rows as 16 stable lineages", async () => {
    const directory = await project();
    const fixture = await readFile(
      join(import.meta.dirname, "fixtures", "finding-names", "decisions.jsonl"),
      "utf8",
    );
    await writeFile(join(directory, ".idiom", "decisions.jsonl"), fixture);

    const decisions = await readDecisionLog(directory);
    expect(decisions).toHaveLength(19);
    expect(new Set(decisions.map((decision) => decision.findingId)).size).toBe(
      16,
    );
    const reportDirectory = join(
      directory,
      ".idiom",
      "reports",
      "legacy-review",
    );
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      join(reportDirectory, "findings.json"),
      `${JSON.stringify(
        Array.from({ length: 16 }, (_, index) =>
          finding(
            `IDM-2026-08-20T13-43-38-374Z-${String(index + 1).padStart(4, "0")}`,
            `fingerprint-${String(index + 1).padStart(2, "0")}`,
          ),
        ),
      )}\n`,
    );
    const state = await loadFindingNames({ projectDirectory: directory });
    expect(state.registry.entries).toHaveLength(16);
    expect(state.registry.next).toBe(17);
    expect(state.registry.entries.map((entry) => entry.name)).toEqual(
      Array.from({ length: 16 }, (_, index) => `finding-${index + 1}`),
    );
    expect(
      new FindingNamingSession(state).name(
        finding("draft-new", "unrelated-new-fingerprint"),
        [],
        { preserveIdAsAlias: false },
      ).id,
    ).toBe("finding-17");
    const catalog = await loadReviewCatalog({ project: directory });
    expect(newestOpenFindings(catalog, decisions)).toEqual([]);
    await persistFindingNames(state);
    const bytes = await readFile(state.path, "utf8");

    await rm(join(directory, ".idiom", "reports"), {
      recursive: true,
      force: true,
    });
    const reloaded = await loadFindingNames({ projectDirectory: directory });
    expect(reloaded.changed).toBe(false);
    await persistFindingNames(reloaded);
    expect(await readFile(state.path, "utf8")).toBe(bytes);
  });

  test("recovers canonical claims before allocating remaining legacy identities", async () => {
    const directory = await project();
    const rows = [
      {
        at: "2026-08-20T10:00:00.000Z",
        commit: "one",
        findingId: "IDM-legacy-first",
        fingerprint: "legacy-first",
        decision: "accept",
        scope: "instance",
        actor: "human",
      },
      {
        at: "2026-08-20T10:01:00.000Z",
        commit: "three",
        findingId: "finding-3",
        fingerprint: "claimed-three",
        decision: "accept",
        scope: "instance",
        actor: "human",
      },
      {
        at: "2026-08-20T10:02:00.000Z",
        commit: "nine",
        findingId: "finding-9",
        fingerprint: "claimed-nine",
        decision: "reject",
        scope: "rule",
        actor: "human",
      },
    ];
    await writeFile(
      join(directory, ".idiom", "decisions.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    await rm(join(directory, ".idiom", "finding-names.json"));

    const state = await loadFindingNames({ projectDirectory: directory });
    expect(state.registry.entries.map(({ name }) => name)).toEqual([
      "finding-3",
      "finding-9",
      "finding-10",
    ]);
    expect(state.registry.next).toBe(11);
    expect(
      state.registry.entries.find(({ name }) => name === "finding-10")
        ?.legacyIds,
    ).toEqual(["IDM-legacy-first"]);
  });

  test("unions compatible primary memory and lets this checkout win divergent allocations", async () => {
    const local = await project("idiom-finding-names-local-");
    const primary = await project("idiom-finding-names-primary-");
    await writeFile(
      join(primary, ".idiom", "finding-names.json"),
      `${JSON.stringify({
        version: 1,
        next: 2,
        entries: [
          {
            name: "finding-1",
            fingerprints: ["primary-print"],
            legacyIds: ["IDM-primary"],
          },
        ],
      })}\n`,
    );
    const merged = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
    });
    expect(merged.registry.entries[0]).toMatchObject({
      name: "finding-1",
      legacyIds: ["IDM-primary"],
    });

    await writeFile(
      join(local, ".idiom", "finding-names.json"),
      `${JSON.stringify({
        version: 1,
        next: 2,
        entries: [
          {
            name: "finding-1",
            fingerprints: ["unrelated-print"],
            legacyIds: ["IDM-local"],
          },
        ],
      })}\n`,
    );
    const diverged = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
    });
    expect(diverged.registry.entries).toEqual([
      {
        name: "finding-1",
        fingerprints: ["unrelated-print"],
        legacyIds: ["IDM-local"],
      },
    ]);
    const primaryRegistry = join(primary, ".idiom", "finding-names.json");
    expect(diverged.divergence).toEqual({ path: primaryRegistry, skipped: 1 });
    const warning = findingNameDivergenceWarning(diverged);
    expect(warning).toContain("skipped 1 conflicting entry from");
    expect(warning).toContain(primaryRegistry);
    expect(warning).toContain("--isolated-registry");
    expect(warning?.split("\n")).toHaveLength(1);
  });

  test("keeps this checkout's name when the primary names the identity differently", async () => {
    const local = await project("idiom-finding-names-local-");
    const primary = await project("idiom-finding-names-primary-");
    await writeRegistry(primary, [
      { name: "finding-1", fingerprints: ["shared-print"], legacyIds: [] },
      { name: "finding-2", fingerprints: ["primary-only"], legacyIds: [] },
    ]);
    await writeRegistry(local, [
      { name: "finding-3", fingerprints: ["shared-print"], legacyIds: [] },
    ]);
    const state = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
    });
    expect(state.registry.entries.map(({ name }) => name)).toEqual([
      "finding-2",
      "finding-3",
    ]);
    expect(
      state.registry.entries.find(({ name }) => name === "finding-3")
        ?.fingerprints,
    ).toEqual(["shared-print"]);
    expect(state.divergence?.skipped).toBe(1);
  });

  test("divergent allocations resolve stably and never cross-merge inherited evidence", async () => {
    const local = await project("idiom-finding-names-local-");
    const primary = await project("idiom-finding-names-primary-");
    await writeRegistry(primary, [
      { name: "finding-1", fingerprints: ["primary-print"], legacyIds: [] },
      { name: "finding-2", fingerprints: ["primary-two"], legacyIds: [] },
      { name: "finding-5", fingerprints: ["compatible"], legacyIds: [] },
    ]);
    await writeReport(primary, "run-primary", [
      finding("finding-1", "primary-print"),
      finding("finding-2", "primary-two"),
    ]);
    await writeRegistry(local, [
      { name: "finding-1", fingerprints: ["local-print"], legacyIds: [] },
      { name: "finding-2", fingerprints: ["local-two"], legacyIds: [] },
    ]);
    await writeReport(local, "run-local", [
      finding("finding-1", "local-print"),
      finding("finding-2", "local-two"),
    ]);
    const first = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
    });
    expect(first.registry.entries).toEqual([
      { name: "finding-1", fingerprints: ["local-print"], legacyIds: [] },
      { name: "finding-2", fingerprints: ["local-two"], legacyIds: [] },
      { name: "finding-5", fingerprints: ["compatible"], legacyIds: [] },
    ]);
    expect(first.registry.next).toBe(6);
    // Two registry entries and the two primary report records naming them.
    expect(first.divergence?.skipped).toBe(4);
    const warning = findingNameDivergenceWarning(first);
    expect(warning).toContain("skipped 4 conflicting entries");

    await persistFindingNames(first);
    const second = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
    });
    expect(second.registry).toEqual(first.registry);
    expect(second.changed).toBe(false);
    expect(findingNameDivergenceWarning(second)).toBe(warning);
  });

  test("an inherited report cannot claim a local name for another fingerprint", async () => {
    const local = await project("idiom-finding-names-local-");
    const primary = await project("idiom-finding-names-primary-");
    await writeRegistry(local, [
      { name: "finding-1", fingerprints: ["local-print"], legacyIds: [] },
    ]);
    await writeReport(primary, "run-primary", [
      finding("finding-1", "primary-print"),
    ]);
    const state = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
    });
    expect(state.registry.entries).toEqual([
      { name: "finding-1", fingerprints: ["local-print"], legacyIds: [] },
    ]);
    expect(state.divergence).toEqual({
      path: join(primary, ".idiom"),
      skipped: 1,
    });
  });

  test("an isolated registry ignores the primary by option or by config", async () => {
    const local = await project("idiom-finding-names-local-");
    const primary = await project("idiom-finding-names-primary-");
    await writeRegistry(primary, [
      { name: "finding-1", fingerprints: ["primary-print"], legacyIds: [] },
      { name: "finding-7", fingerprints: ["other"], legacyIds: [] },
    ]);
    await writeRegistry(local, [
      { name: "finding-1", fingerprints: ["local-print"], legacyIds: [] },
    ]);
    const isolated = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
      isolatedRegistry: true,
    });
    expect(isolated.registry.entries.map(({ name }) => name)).toEqual([
      "finding-1",
    ]);
    expect(isolated.registry.next).toBe(2);
    expect(isolated.divergence).toBeUndefined();

    const configPath = join(local, ".idiom", "project.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      JSON.stringify({ ...config, findingNames: { isolatedRegistry: true } }),
    );
    const configured = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
    });
    expect(configured.registry).toEqual(isolated.registry);
    expect(configured.divergence).toBeUndefined();
    const overridden = await loadFindingNames({
      projectDirectory: local,
      gitTopology: async () => primary,
      isolatedRegistry: false,
    });
    expect(overridden.divergence?.skipped).toBe(1);
  });

  test("a conflict in this checkout's own evidence still refuses", async () => {
    const local = await project("idiom-finding-names-local-");
    await writeRegistry(local, [
      { name: "finding-1", fingerprints: ["one"], legacyIds: [] },
      { name: "finding-2", fingerprints: ["two"], legacyIds: [] },
    ]);
    await writeReport(local, "run-local", [finding("finding-1", "two")]);
    await expect(loadFindingNames({ projectDirectory: local })).rejects.toThrow(
      /conflicting finding/,
    );
    await expect(
      preflightFindingNameRegistry({ projectDirectory: local }),
    ).rejects.toMatchObject({
      stage: "preflight",
      cause: "finding-name-registry",
    });
  });

  test("preflight passes divergence and refuses a corrupt primary registry", async () => {
    const local = await project("idiom-finding-names-local-");
    const primary = await project("idiom-finding-names-primary-");
    await writeRegistry(primary, [
      { name: "finding-1", fingerprints: ["primary-print"], legacyIds: [] },
    ]);
    await writeRegistry(local, [
      { name: "finding-1", fingerprints: ["local-print"], legacyIds: [] },
    ]);
    await expect(
      preflightFindingNameRegistry({
        projectDirectory: local,
        gitTopology: async () => primary,
      }),
    ).resolves.toBeUndefined();

    await writeFile(
      join(primary, ".idiom", "finding-names.json"),
      '{"version":1,"entries":"nope"}',
    );
    const refusal = await preflightFindingNameRegistry({
      projectDirectory: local,
      gitTopology: async () => primary,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RunFailure);
    expect(refusal).toMatchObject({
      stage: "preflight",
      cause: "finding-name-registry",
    });
    expect((refusal as RunFailure).hint).toContain("--isolated-registry");
    await expect(
      preflightFindingNameRegistry({
        projectDirectory: local,
        gitTopology: async () => primary,
        isolatedRegistry: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("names aliases once, persists atomically, and reuses them without reports", async () => {
    const directory = await project();
    const state = await loadFindingNames({ projectDirectory: directory });
    const session = new FindingNamingSession(state);
    const migrated = session.name(finding("IDM-old", "stable-print"));
    expect(migrated).toMatchObject({
      id: "finding-1",
      idAliases: ["IDM-old"],
    });
    expect(
      session.name(finding("draft-next", "stable-print"), [], {
        preserveIdAsAlias: false,
      }),
    ).toMatchObject({ id: "finding-1", idAliases: ["IDM-old"] });
    await persistFindingNames(state);
    const reloaded = await loadFindingNames({ projectDirectory: directory });
    expect(
      new FindingNamingSession(reloaded).name(
        finding("draft-replay", "stable-print"),
        [],
        { preserveIdAsAlias: false },
      ),
    ).toMatchObject({ id: "finding-1", idAliases: ["IDM-old"] });
  });

  test("sorts canonical names numerically before degraded identities", () => {
    expect(
      ["fingerprint-z", "finding-10", "finding-2", "fingerprint-a"].sort(
        compareFindingNames,
      ),
    ).toEqual(["finding-2", "finding-10", "fingerprint-a", "fingerprint-z"]);
  });
});

describe("malformed tracker tickets during name bootstrap", () => {
  async function writeTicket(
    root: string,
    state: string,
    name: string,
    body: string,
  ): Promise<string> {
    const path = join(root, state, name);
    await mkdir(join(root, state), { recursive: true });
    await writeFile(path, body);
    return path;
  }
  const block = (value: unknown) =>
    `\`\`\`idiom:finding\n${JSON.stringify(value)}\n\`\`\`\n`;

  test("a malformed own ticket is reported while valid tickets still name lineages", async () => {
    const directory = await project();
    const tickets = join(directory, ".autobuild", "tickets");
    await writeTicket(
      tickets,
      "done",
      "valid.md",
      block(finding("IDM-valid-0001", "valid-print")),
    );
    const broken = await writeTicket(tickets, "done", "broken.md", block({}));

    const state = await loadFindingNames({ projectDirectory: directory });

    expect(state.malformedTickets).toEqual([
      {
        path: broken,
        error: expect.stringContaining(
          `cannot parse tracker ticket ${broken}: invalid idiom:finding`,
        ),
      },
    ]);
    expect(state.registry.entries).toEqual([
      {
        name: "finding-1",
        fingerprints: ["valid-print"],
        legacyIds: ["IDM-valid-0001"],
      },
    ]);
    await expect(
      preflightFindingNameRegistry({ projectDirectory: directory }),
    ).resolves.toBeUndefined();
  });

  test("a duplicate embedded identity in one own ticket is reported, not thrown", async () => {
    const directory = await project();
    const tickets = join(directory, ".autobuild", "tickets");
    const record = finding("IDM-dup-0001", "dup-print");
    const path = await writeTicket(
      tickets,
      "triage",
      "dup.md",
      block(record) + block({ ...record, explanation: "Different." }),
    );

    const state = await loadFindingNames({ projectDirectory: directory });

    expect(state.malformedTickets.map((ticket) => ticket.path)).toEqual([path]);
    expect(state.malformedTickets[0]?.error).toMatch(/incompatible|ambiguous/);
  });

  test("a name minted for a lineage a malformed ticket mentions is provisional", async () => {
    const directory = await project();
    await writeReport(directory, "2026-08-20T13-43-38-374Z", [
      finding("IDM-run-0001", "mentioned-print"),
      finding("IDM-run-0002", "unmentioned-print"),
    ]);
    await writeTicket(
      join(directory, ".autobuild", "tickets"),
      "done",
      "broken.md",
      block({ id: "IDM-run-0001", fingerprint: "mentioned-print", x: 1 }),
    );

    const state = await loadFindingNames({ projectDirectory: directory });
    expect(state.registry.entries.map((entry) => entry.name)).toEqual([
      "finding-1",
      "finding-2",
    ]);
    expect(state.provisional).toEqual(["finding-1"]);
    await persistFindingNames(state);

    const written = JSON.parse(await readFile(state.path, "utf8")) as {
      next: number;
      entries: Array<{ name: string; fingerprints: string[] }>;
    };
    expect(written.next).toBe(3);
    expect(written.entries).toEqual([
      expect.objectContaining({
        name: "finding-2",
        fingerprints: ["unmentioned-print"],
      }),
    ]);
    // Still resolvable in memory for this run.
    expect(state.registry.entries).toHaveLength(2);
  });

  test("a malformed inherited ticket counts as divergence and is not reported as own", async () => {
    const directory = await project();
    const inherited = await mkdtemp(join(tmpdir(), "idiom-inherited-tracker-"));
    directories.push(inherited);
    await writeTicket(inherited, "done", "broken.md", block({}));

    const state = await loadFindingNames({
      projectDirectory: directory,
      additionalTrackerRoots: [inherited],
      isolatedRegistry: true,
    });

    expect(state.malformedTickets).toEqual([]);
    expect(state.divergence?.skipped).toBeGreaterThanOrEqual(1);
  });
});
