import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { readDecisionLog } from "../src/decisions/log.js";
import {
  loadReviewCatalog,
  newestOpenFindings,
} from "../src/review/catalog.js";
import {
  compareFindingNames,
  FindingNamingSession,
  findingNameRegistrySchema,
  loadFindingNames,
  persistFindingNames,
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

  test("unions compatible primary memory and fails divergent allocations", async () => {
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
    await expect(
      loadFindingNames({
        projectDirectory: local,
        gitTopology: async () => primary,
      }),
    ).rejects.toThrow(/finding-1 is allocated to unrelated identities/);
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
