import { readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type ProjectFileFormat,
  projectFileFormats,
} from "../src/migrations/formats.js";
import { migrateProjectFiles } from "../src/migrations/run.js";
import { put, read, temporary, tree } from "./skill-support.js";

const now = () => new Date("2026-11-09T12:34:56.789Z");
const stamp = "upgrade-20261109T123456Z";

/** A test-only format at version 2: format 1's `name` became `label`. */
const fixture: ProjectFileFormat = {
  id: "fixture",
  locations: ["fixture.json", "fixtures/*.json"],
  kind: "document",
  current: 2,
  migrations: {
    1: ({ name, ...rest }) => ({ ...rest, version: 2, label: name }),
  },
  validate: (value) =>
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 2 &&
    typeof (value as { label?: unknown }).label === "string",
  summary: "fixture",
};
const fixtureLog: ProjectFileFormat = {
  id: "fixture-log",
  locations: ["fixture.jsonl"],
  kind: "log",
  current: 2,
  migrations: { 1: (value) => ({ ...value, version: 2 }) },
  validate: () => true,
  readsOlder: true,
  summary: "fixture log",
};
const formats = [...projectFileFormats, fixture, fixtureLog];
const v1 = `{"version":1,"name":"Ada","extra":[1,2]}\n`;
const v2 = `{\n  "version": 2,\n  "label": "Bea"\n}\n`;

const migrate = (root: string, dryRun = false, list = formats) =>
  migrateProjectFiles(
    { projectDirectory: root, dryRun, now },
    { formats: list },
  );

async function repoFile(path: string): Promise<string> {
  return readFile(join(import.meta.dirname, "..", path), "utf8");
}

describe("migrateProjectFiles", () => {
  test("migrates an older document, keeping the original in one backup directory", async () => {
    const root = await temporary();
    await put(root, ".idiom/fixture.json", v1);
    const report = await migrate(root);
    expect(report.backupDirectory).toBe(`.idiom/backups/${stamp}`);
    expect(report.files).toEqual([
      {
        path: ".idiom/fixture.json",
        format: "fixture",
        kind: "document",
        outcome: "migrated",
        version: 1,
        currentVersion: 2,
        from: 1,
        to: 2,
        backupPath: `.idiom/backups/${stamp}/fixture.json`,
      },
    ]);
    expect(JSON.parse(await read(root, ".idiom/fixture.json"))).toEqual({
      version: 2,
      extra: [1, 2],
      label: "Ada",
    });
    expect(await read(root, `.idiom/backups/${stamp}/fixture.json`)).toBe(v1);
  });

  test("current files are only read, byte for byte", async () => {
    const root = await temporary();
    await put(root, ".idiom/fixture.json", v2);
    await put(
      root,
      ".idiom/project.json",
      await repoFile(".idiom/project.json"),
    );
    await put(root, ".idiom/rules.json", await repoFile(".idiom/rules.json"));
    const before = await tree(root);
    const times = await Promise.all(
      ["fixture.json", "project.json", "rules.json"].map(
        async (name) => (await stat(join(root, ".idiom", name))).mtimeMs,
      ),
    );
    const report = await migrate(root);
    expect(report.files.map((file) => [file.path, file.outcome])).toEqual([
      [".idiom/fixture.json", "current"],
      [".idiom/project.json", "current"],
      [".idiom/rules.json", "current"],
    ]);
    expect(report.backupDirectory).toBeNull();
    expect(await tree(root)).toEqual(before);
    expect(
      await Promise.all(
        ["fixture.json", "project.json", "rules.json"].map(
          async (name) => (await stat(join(root, ".idiom", name))).mtimeMs,
        ),
      ),
    ).toEqual(times);
  });

  test("dry run reports the migration and writes nothing", async () => {
    const root = await temporary();
    await put(root, ".idiom/fixture.json", v1);
    const before = await tree(root);
    const report = await migrate(root, true);
    expect(report.files).toMatchObject([
      { outcome: "migrated", from: 1, to: 2 },
    ]);
    expect(report.files[0]?.backupPath).toBeUndefined();
    expect(report.backupDirectory).toBeNull();
    expect(await tree(root)).toEqual(before);
  });

  test("a second run changes nothing", async () => {
    const root = await temporary();
    await put(root, ".idiom/fixture.json", v1);
    await put(root, ".idiom/fixtures/b.json", v1);
    await migrate(root);
    const before = await tree(root);
    const again = await migrate(root);
    expect(again.backupDirectory).toBeNull();
    expect(again.files.map((file) => file.outcome)).toEqual([
      "current",
      "current",
    ]);
    expect(await tree(root)).toEqual(before);
  });

  test("a newer document or log record is refused and left untouched", async () => {
    const root = await temporary();
    await put(root, ".idiom/fixture.json", `{"version":3}\n`);
    await put(root, ".idiom/rules.json", `{"version":2,"overrides":[]}\n`);
    await put(root, ".idiom/fixture.jsonl", `{"version":1}\n{"version":3}\n`);
    const before = await tree(root);
    const report = await migrate(root);
    expect(report.files).toMatchObject([
      { path: ".idiom/fixture.json", outcome: "refused", version: 3 },
      { path: ".idiom/fixture.jsonl", outcome: "refused", version: 3 },
      { path: ".idiom/rules.json", outcome: "refused", version: 2 },
    ]);
    expect(report.files[2]?.reason).toBe(
      "format 2 is newer than format 1, the newest this Idiom understands; update Idiom, then run idiom upgrade again",
    );
    expect(await tree(root)).toEqual(before);
  });

  test("a migration that fails the current schema writes nothing", async () => {
    const root = await temporary();
    await put(root, ".idiom/fixture.json", v1);
    const broken: ProjectFileFormat = {
      ...fixture,
      migrations: { 1: (value) => ({ ...value, version: 2 }) },
    };
    const throwing: ProjectFileFormat = {
      ...fixture,
      id: "throwing",
      locations: ["throwing.json"],
      migrations: {
        1: () => {
          throw new Error("boom");
        },
      },
    };
    await put(root, ".idiom/throwing.json", v1);
    const before = await tree(root);
    const report = await migrate(root, false, [broken, throwing]);
    expect(report.files).toMatchObject([
      {
        outcome: "failed",
        reason:
          "the migrated file does not pass the format 2 schema; nothing written",
      },
      {
        outcome: "failed",
        reason: "migration from format 1 failed (boom); nothing written",
      },
    ]);
    expect(report.backupDirectory).toBeNull();
    expect(await tree(root)).toEqual(before);
  });

  test("logs are never rewritten; older records are kept", async () => {
    const root = await temporary();
    const log = `{"version":1,"a":1}\n{"version":2,"a":2}\nnot json\n`;
    await put(root, ".idiom/fixture.jsonl", log);
    const report = await migrate(root);
    expect(report.files).toEqual([
      {
        path: ".idiom/fixture.jsonl",
        format: "fixture-log",
        kind: "log",
        outcome: "kept",
        version: 2,
        currentVersion: 2,
        reason: "records at format 1 stay as written; Idiom reads them",
      },
    ]);
    expect(await read(root, ".idiom/fixture.jsonl")).toBe(log);
    expect(report.backupDirectory).toBeNull();
  });

  test("unversioned and user-owned files are neither touched nor listed", async () => {
    const root = await temporary();
    await put(root, ".idiom/flows/site.json", `{"version":1,"id":"site"}`);
    await put(root, ".idiom/glossary.json", `{"version":1}`);
    await put(root, ".idiom/decisions.jsonl", `{"version":1}\n`);
    await put(root, ".idiom/reports/x/findings.json", `{"version":1}`);
    await put(root, ".idiom/cache/x.json", `{"version":1}`);
    await put(root, ".idiom/.hidden.json", `{"version":1}`);
    await put(root, ".idiom/fixtures/.dot.json", `{"version":1}`);
    await put(root, ".idiom/fixtures/deeper/x.json", `{"version":1}`);
    await put(root, "DESIGN.md", "# Design\n");
    await put(root, "fixture.json", v1);
    const before = await tree(root);
    const report = await migrate(root);
    expect(report.files).toEqual([]);
    expect(await tree(root)).toEqual(before);
  });

  test("briefs and their triages are matched once, each by its own format", async () => {
    const root = await temporary();
    await put(root, ".idiom/briefs/a.json", `{"version":1}`);
    await put(
      root,
      ".idiom/briefs/triage/triage-0123abcdef.json",
      `{"version":1}`,
    );
    await put(root, ".idiom/references/hero/reference.json", `{"version":1}`);
    await put(
      root,
      ".idiom/anti-references/noise/reference.json",
      `{"version":1}`,
    );
    const report = await migrate(root);
    expect(report.files.map((file) => [file.path, file.format])).toEqual([
      [".idiom/anti-references/noise/reference.json", "reference"],
      [".idiom/briefs/a.json", "brief"],
      [".idiom/briefs/triage/triage-0123abcdef.json", "brief-triage"],
      [".idiom/references/hero/reference.json", "reference"],
    ]);
  });

  test("malformed, unversioned and symlinked files are skipped untouched", async () => {
    const root = await temporary();
    await put(root, ".idiom/fixture.json", "{not json");
    await put(root, ".idiom/fixtures/a.json", `{"name":"no version"}`);
    await put(root, ".idiom/fixtures/b.json", `[1]`);
    await put(root, "elsewhere.json", v1);
    await symlink(
      join(root, "elsewhere.json"),
      join(root, ".idiom/rules.json"),
    );
    const before = await tree(root);
    const report = await migrate(root);
    expect(
      report.files.map((file) => [file.path, file.outcome, file.reason]),
    ).toEqual([
      [
        ".idiom/fixture.json",
        "skipped",
        "not valid JSON; idiom validate reports it",
      ],
      [
        ".idiom/fixtures/a.json",
        "skipped",
        "no format version; idiom validate reports it",
      ],
      [
        ".idiom/fixtures/b.json",
        "skipped",
        "not a JSON object; idiom validate reports it",
      ],
      [".idiom/rules.json", "skipped", "not a regular file"],
    ]);
    expect(await tree(root)).toEqual(before);
  });

  test("an existing backup directory for the same second is never overwritten", async () => {
    const root = await temporary();
    await put(root, `.idiom/backups/${stamp}/fixture.json`, "earlier\n");
    await put(root, ".idiom/fixture.json", v1);
    const report = await migrate(root);
    expect(report.backupDirectory).toBe(`.idiom/backups/${stamp}-2`);
    expect(await read(root, `.idiom/backups/${stamp}/fixture.json`)).toBe(
      "earlier\n",
    );
    expect(await read(root, `.idiom/backups/${stamp}-2/fixture.json`)).toBe(v1);
  });

  test("an uninitialized project has no versioned files", async () => {
    const root = await temporary();
    expect(await migrate(root)).toEqual({ backupDirectory: null, files: [] });
  });
});

describe("the versioned-file registry", () => {
  test("ids are unique and migrations cover exactly 1..current-1", () => {
    const ids = projectFileFormats.map((format) => format.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const format of [...projectFileFormats, fixture, fixtureLog])
      expect(
        Object.keys(format.migrations).map(Number).sort(),
        format.id,
      ).toEqual(Array.from({ length: format.current - 1 }, (_, i) => i + 1));
  });

  test("every log past format 1 keeps reading older records", () => {
    for (const format of projectFileFormats)
      if (format.kind === "log" && format.current > 1)
        expect(format.readsOlder, format.id).toBe(true);
  });

  test("each registry version is the version its reader accepts", async () => {
    const at = "2026-01-01T00:00:00.000Z";
    const samples: Record<string, Record<string, unknown>> = {
      project: JSON.parse(await repoFile(".idiom/project.json")),
      rules: JSON.parse(await repoFile(".idiom/rules.json")),
      "finding-names": JSON.parse(await repoFile(".idiom/finding-names.json")),
      "ruling-names": JSON.parse(await repoFile(".idiom/ruling-names.json")),
      baseline: JSON.parse(await repoFile(".idiom/baselines/site.json")),
      "filed-tickets": { version: 1, entries: [] },
      brief: {
        version: 1,
        slug: "pinned-group",
        title: "Pinned group",
        request: "Pin the group",
        research: [],
        rubricVersion: 1,
        createdAt: at,
        updatedAt: at,
        researchRun: {
          provider: "claude-code",
          model: "m",
          budgetMs: 1,
          durationMs: 1,
          calls: 0,
          incomplete: { stage: "research", note: "stopped", unresearched: [] },
        },
      },
      "brief-triage": {
        version: 1,
        id: "triage-0123abcdef",
        request: "r",
        rubricVersion: 1,
        createdAt: at,
        verdict: "design decision",
        reason: "",
        questions: [],
      },
      reference: {
        version: 1,
        name: "hero",
        note: "n",
        image: "image.png",
        mediaType: "image/png",
        sourceKind: "file",
        source: "hero.png",
      },
      learned: {
        version: 1,
        id: "learned-1",
        recordedAt: at,
        flow: "site",
        state: "home",
        observation: "o",
        kind: "glossary",
        target: { file: "DESIGN.md" },
        entry: null,
      },
      harvest: {
        version: 1,
        autobuild: { through: at },
        pullRequests: { repo: "acme/shop", through: at },
        lastRunAt: at,
      },
    };
    expect(Object.keys(samples).sort()).toEqual(
      projectFileFormats.map((format) => format.id).sort(),
    );
    for (const format of projectFileFormats) {
      const sample = samples[format.id] as Record<string, unknown>;
      expect(sample.version, format.id).toBe(format.current);
      expect(format.validate(sample), format.id).toBe(true);
      expect(
        format.validate({ ...sample, version: format.current + 1 }),
        format.id,
      ).toBe(false);
    }
  });
});
