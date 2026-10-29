import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compareToBaseline } from "../src/baseline/compare.js";
import { checksConfigHash } from "../src/baseline/config-hash.js";
import {
  tupleCoordinate,
  tupleCoordinateKey,
} from "../src/baseline/coordinate.js";
import { selectBaselineRecord } from "../src/baseline/resolve.js";
import {
  type BaselineRecord,
  baselineFileSchema,
} from "../src/baseline/schema.js";
import {
  baselinePath,
  readBaselineFile,
  writeBaselineRecord,
} from "../src/baseline/store.js";
import {
  expectedCaptureTupleKeys,
  snapshotSource,
} from "../src/capture/resolve.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { deterministicCheckIds } from "../src/checks/types.js";
import { run } from "../src/cli.js";
import { baselineRecordCommand } from "../src/commands/baseline.js";
import { checkCommand, renderCheckSummary } from "../src/commands/check.js";
import { decideCommand } from "../src/commands/decide.js";
import { reviewCommand } from "../src/commands/review.js";
import type { ModelFindingCandidate } from "../src/critique/types.js";
import { loadRunTuples } from "../src/review/artifacts.js";
import { loadReviewCatalog } from "../src/review/catalog.js";
import {
  buildDeterministicDrafts,
  finalizeDeterministicOccurrences,
  finalizeFindings,
  nameFindingDrafts,
  suppressFindingDrafts,
  writeFindings,
} from "../src/review/findings.js";
import { findingFingerprintIdentity } from "../src/review/fingerprint.js";
import { FindingNamingSession } from "../src/review/names.js";
import { runReview } from "../src/review/run.js";
import type { Finding } from "../src/schemas/finding.js";
import { projectSchema } from "../src/schemas/project.js";
import { validateProject } from "../src/validation.js";
import {
  deterministicCandidateRecords,
  deterministicFingerprintSet,
} from "../src/verify/evaluate.js";
import {
  baselineProject,
  cleanHtml,
  commit,
  git,
  missing,
  storedBaselineRun,
} from "./baseline-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(options: Parameters<typeof baselineProject>[0] = {}) {
  const result = await baselineProject(options);
  directories.push(result.project);
  return result;
}
const check = (project: string, from = "later") =>
  checkCommand({ project, flow: "studio", from, sinceBaseline: true });
const review = (project: string, from = "later") =>
  reviewCommand({
    project,
    flow: "studio",
    from,
    deterministicOnly: true,
    sinceBaseline: true,
  });
const record = (project: string, from = "initial") =>
  baselineRecordCommand({ project, flow: "studio", from });
async function cli(
  project: string,
  verb: "check" | "review",
  from = "later",
  flags: string[] = [],
) {
  let out = "",
    err = "";
  const code = await run(
    [
      "node",
      "idiom",
      "--project",
      project,
      verb,
      "studio",
      ...(verb === "review" ? ["--deterministic-only"] : []),
      "--from",
      from,
      "--since-baseline",
      ...flags,
    ],
    {
      stdout: (message) => {
        out += message;
      },
      stderr: (message) => {
        err += message;
      },
    },
  );
  return { code, out, err };
}
async function load(project: string, from: string) {
  const validated = await validateProject({ project, flow: "studio" });
  const flow = validated.flows[0]?.flow;
  if (flow === undefined) throw Error("missing flow");
  const loaded = await loadRunTuples(
    validated,
    flow,
    join(project, ".idiom/reports", from),
  );
  return { ...loaded, validated };
}
async function candidates(project: string, from: string) {
  const loaded = await load(project, from);
  return deterministicCandidateRecords({
    tuples: loaded.tuples,
    expectedTupleKeys: loaded.expectedTupleKeys,
    legacyColorScheme: loaded.validated.project.capture.colorScheme,
    config: checksConfigFrom(loaded.validated.project.checks),
  });
}

test("fixture delta reports exactly one new, one fixed and one pre-existing through check and review", async () => {
  const { project, commit: sha } = await setup({
    required: ["#old", "#new", "#shared"],
  });
  const fixture = (name: string) =>
    readFile(join(import.meta.dirname, "fixtures", name), "utf8");
  await storedBaselineRun(project, "initial", sha, [
    {
      html: await fixture("baseline-before.html"),
      mismatches: [missing("#old"), missing("#shared")],
    },
  ]);
  await storedBaselineRun(project, "later", sha, [
    {
      html: await fixture("baseline-after.html"),
      mismatches: [missing("#new"), missing("#shared")],
    },
  ]);
  const recorded = await record(project);
  expect(recorded).toMatchObject({
    findingCount: 2,
    tupleCount: 1,
    replaced: false,
    commit: sha,
  });
  expect(JSON.parse(await readFile(recorded.path, "utf8"))).toMatchObject({
    version: 1,
    flow: "studio",
    records: [{ commit: sha }],
  });
  const summary = await check(project);
  expect(summary.findings).toHaveLength(1);
  expect(summary.fixed).toHaveLength(1);
  expect(summary.preExisting).toBe(1);
  expect(summary.findings[0]?.problem).toContain("#new");
  expect(summary.findings[0]?.fingerprint).toBeTruthy();
  expect(summary.preExistingFindings?.[0]?.fingerprint).toBeTruthy();
  expect(summary.fixed?.[0]?.selector).toContain("#old");
  expect(summary.baseline?.stale).toBeUndefined();
  for (const heading of [
    "New (1):",
    "Fixed since baseline (1):",
    "Pre-existing (1):",
  ])
    expect(renderCheckSummary(summary)).toContain(heading);
  const reviewed = await review(project);
  expect(reviewed.comparison).toEqual({
    currentJudged: [],
    findings: summary.findings,
    fixed: summary.fixed,
    baseline: summary.baseline,
    blocking: summary.blocking,
    preExisting: 1,
    preExistingFindings: summary.preExistingFindings,
    unclassified: 0,
  });
  expect(
    JSON.parse(
      await readFile(
        join(reviewed.runDirectory, "baseline-comparison.json"),
        "utf8",
      ),
    ),
  ).toEqual(reviewed.comparison);
  expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  expect((await cli(project, "check", "initial")).code).toBe(0);
  expect(
    (await cli(project, "check", "later", ["--fail-on", "minor"])).code,
  ).toBe(1);
}, 60_000);

test("desktop persistence cannot hide a new mobile occurrence, its evidence, or the CLI gate", async () => {
  const { project, commit: sha } = await setup({ mobile: true });
  await storedBaselineRun(project, "initial", sha, [
    {
      mismatches: [missing()],
      html: cleanHtml.replace('id="required"', 'id="other"'),
    },
    { viewport: "mobile" },
  ]);
  await record(project);
  await storedBaselineRun(
    project,
    "later",
    sha,
    ["desktop", "mobile"].map((viewport) => ({
      viewport: viewport as "desktop" | "mobile",
      mismatches: [missing()],
      html: cleanHtml.replace('id="required"', 'id="other"'),
    })),
  );
  const raw = await candidates(project, "later");
  expect(raw).toHaveLength(2);
  expect(raw[0]?.fingerprint).toBe(raw[1]?.fingerprint);
  const ordinary = await runReview({
    project,
    flow: "studio",
    from: "later",
    deterministicOnly: true,
  });
  expect(ordinary).not.toHaveProperty("deterministicOccurrences");
  const material = JSON.parse(
    await readFile(ordinary.findingsPath, "utf8"),
  ) as Finding[];
  expect(material).toHaveLength(1);
  expect(material[0]?.viewport).toBe("desktop");
  const summary = await check(project);
  expect(summary.findings).toHaveLength(1);
  expect(summary.findings[0]).toMatchObject({
    where: "editor/mobile",
    occurrenceOnly: true,
    severity: "blocker",
  });
  expect(summary.findings[0]?.screenshot).toContain("editor/mobile/");
  expect(summary.preExistingFindings?.[0]).toMatchObject({
    where: "editor/desktop",
    id: summary.findings[0]?.id,
  });
  expect(summary.fixed).toEqual([]);
  for (const verb of ["check", "review"] as const) {
    const text = await cli(project, verb, "later", ["--fail-on", "blocker"]);
    expect(text.code).toBe(1);
    expect(
      text.out.split("New (1):")[1]?.split("Fixed since baseline")[0],
    ).toContain("editor/mobile");
    expect(
      text.out.split("New (1):")[1]?.split("Fixed since baseline")[0],
    ).not.toContain("Decide:");
    expect(text.out.split("Pre-existing (1):")[1]).toContain("editor/desktop");
    const json = await cli(project, verb, "later", [
      "--json",
      "--fail-on",
      "blocker",
    ]);
    expect(json.code).toBe(1);
    const payload = JSON.parse(json.out);
    const comparison = verb === "check" ? payload : payload.comparison;
    expect(
      comparison.findings.map((finding: { where: string }) => finding.where),
    ).toEqual(["editor/mobile"]);
    expect(
      comparison.preExistingFindings.map(
        (finding: { where: string }) => finding.where,
      ),
    ).toEqual(["editor/desktop"]);
    expect(comparison.fixed).toEqual([]);
  }
  expect((await review(project)).comparison).toMatchObject({
    findings: summary.findings,
    preExistingFindings: summary.preExistingFindings,
    fixed: [],
  });

  await writeFile(
    join(project, ".idiom/rules.json"),
    JSON.stringify({
      version: 1,
      overrides: [
        {
          id: "less-severe",
          match: { fingerprint: raw[0]?.fingerprint },
          action: "severity",
          severity: "minor",
          reason: "Fixture policy",
        },
      ],
    }),
  );
  for (const verb of ["check", "review"] as const) {
    const minor = await cli(project, verb, "later", [
      "--json",
      "--fail-on",
      "major",
    ]);
    expect(minor.code).toBe(0);
    const payload = JSON.parse(minor.out);
    const comparison = verb === "check" ? payload : payload.comparison;
    expect(comparison.findings[0].severity).toBe("minor");
    expect(comparison.preExistingFindings[0].severity).toBe("minor");
    expect(
      (await cli(project, verb, "later", ["--fail-on", "minor"])).code,
    ).toBe(1);
  }
  await writeFile(
    join(project, ".idiom/rules.json"),
    JSON.stringify({
      version: 1,
      overrides: [
        {
          id: "suppress",
          match: { fingerprint: raw[0]?.fingerprint },
          action: "suppress",
          reason: "Fixture policy",
        },
      ],
    }),
  );
  expect(await check(project)).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 0,
  });
  expect((await review(project)).comparison).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 0,
  });
  await writeFile(
    join(project, ".idiom/rules.json"),
    JSON.stringify({ version: 1, overrides: [] }),
  );
  await decideCommand({ project, finding: material[0]?.id, accept: true });
  const accepted = await runReview({
    project,
    flow: "studio",
    from: "later",
    deterministicOnly: true,
    includeDeterministicOccurrences: true,
  });
  expect(
    accepted.deterministicOccurrences?.map((finding) => finding.status),
  ).toEqual(["open", "open"]);
  expect((await check(project)).findings).toHaveLength(1);
  await decideCommand({
    project,
    finding: material[0]?.id,
    reject: true,
    scope: "instance",
  });
  // Instance decisions currently leave ordinary review's stored status unchanged.
  // Baseline occurrences must preserve that same lifecycle behavior.
  expect((await check(project)).findings).toHaveLength(1);
  await decideCommand({ project, finding: material[0]?.id, accept: true });
  await decideCommand({
    project,
    finding: material[0]?.id,
    reject: true,
    scope: "rule",
  });
  expect(await check(project)).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 0,
  });
  expect((await review(project)).comparison).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 0,
  });
}, 60_000);

test("an unchanged complete inert scheme blocker is recorded and pre-existing in both gates", async () => {
  const { project, commit: sha } = await setup({ schemes: true });
  await storedBaselineRun(project, "initial", sha, [
    { scheme: "light" },
    { scheme: "dark" },
  ]);
  const ordinary = await runReview({
    project,
    flow: "studio",
    from: "initial",
    deterministicOnly: true,
  });
  expect(
    JSON.parse(await readFile(ordinary.findingsPath, "utf8")),
  ).toContainEqual(
    expect.objectContaining({
      rule: "idiom:missing-color-scheme",
      colorScheme: "dark",
    }),
  );
  const recorded = await record(project);
  const file = await readBaselineFile(recorded.path);
  const dark = file?.records[0]?.tuples.find(
    (tuple) => tuple.colorScheme === "dark",
  );
  expect(dark?.findings).toContainEqual(
    expect.objectContaining({ rule: "idiom:missing-color-scheme" }),
  );
  expect(dark?.findings[0]?.fingerprint).toBe(
    (await candidates(project, "initial")).find(
      (candidate) => candidate.rule === "idiom:missing-color-scheme",
    )?.fingerprint,
  );
  expect(await check(project, "initial")).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 1,
  });
  expect((await review(project, "initial")).comparison).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 1,
  });
  for (const verb of ["check", "review"] as const)
    expect(
      (await cli(project, verb, "initial", ["--fail-on", "blocker"])).code,
    ).toBe(0);
  const loaded = await load(project, "initial");
  const expected = runDeterministicChecks(
    loaded.tuples,
    loaded.expectedTupleKeys,
    checksConfigFrom(loaded.validated.project.checks),
  );
  const expectedRecords = expected.candidates.map(({ tuple, candidate }) => ({
    key: tupleCoordinateKey(tupleCoordinate(tuple)),
    ...findingFingerprintIdentity({
      category: candidate.category,
      flow: tuple.flow,
      state: tuple.state,
      rule: candidate.rule,
      selectorHint: candidate.fingerprintHint ?? candidate.selectorHint,
      colorScheme: tuple.colorScheme,
      legacyColorScheme: "light",
    }),
  }));
  expect(
    (await candidates(project, "initial")).map(
      ({ key, fingerprint, aliases }) => ({ key, fingerprint, aliases }),
    ),
  ).toEqual(expectedRecords);
  expect(deterministicFingerprintSet(loaded.tuples, "light")).not.toContain(
    dark?.findings[0]?.fingerprint,
  );
  await storedBaselineRun(project, "partial", sha, [{ scheme: "light" }]);
  expect(
    (await candidates(project, "partial")).some(
      (candidate) => candidate.rule === "idiom:missing-color-scheme",
    ),
  ).toBe(false);
}, 60_000);

test("a clean tuple proves its last defect fixed; an omitted or failed tuple cannot", async () => {
  const { project, commit: sha } = await setup({ mobile: true });
  await storedBaselineRun(project, "initial", sha, [
    {},
    { viewport: "mobile", mismatches: [missing()] },
  ]);
  await record(project);
  await storedBaselineRun(project, "clean", sha, [{}, { viewport: "mobile" }]);
  await storedBaselineRun(project, "omitted", sha, [{}]);
  await storedBaselineRun(project, "failed", sha, [
    {},
    { viewport: "mobile", failure: { stage: "navigate", message: "offline" } },
  ]);
  for (const command of [
    check,
    async (project: string, from: string) =>
      (await review(project, from)).comparison,
  ]) {
    expect(await command(project, "clean")).toMatchObject({
      findings: [],
      fixed: [expect.objectContaining({ where: "editor/mobile" })],
      baseline: { uncoveredTuples: [] },
    });
    expect(await command(project, "omitted")).toMatchObject({
      fixed: [],
      baseline: { uncoveredTuples: ["editor/mobile"] },
    });
    expect(await command(project, "failed")).toMatchObject({
      fixed: [],
      baseline: { uncoveredTuples: ["editor/mobile"] },
    });
  }
}, 60_000);

test("stale normalized checks include capture settings, warn in text and remain comparable in JSON", async () => {
  const { project, commit: sha, configPath } = await setup();
  await storedBaselineRun(project, "initial", sha, [
    { mismatches: [missing()] },
  ]);
  await record(project);
  const original = JSON.parse(await readFile(configPath, "utf8"));
  for (const checks of [
    { minGap: 12 },
    { probe: { enabled: false } },
    { disguisedControl: { ignore: ["#skip"] } },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...original, checks }));
    for (const verb of ["check", "review"] as const) {
      const json = await cli(project, verb, "initial", ["--json"]);
      expect(json.code).toBe(0);
      const payload = JSON.parse(json.out);
      const comparison = verb === "check" ? payload : payload.comparison;
      expect(comparison.baseline.stale.reason).toContain(
        "checks configuration changed",
      );
      const text = await cli(project, verb, "initial");
      expect(text.out).toContain("possibly stale");
      expect(text.err).toContain("possibly stale");
    }
  }
}, 60_000);

test("full mode leaves review defaults untouched; flag conflict, missing baseline and dirty captures fail explicitly", async () => {
  const { project, commit: sha } = await setup({ mobile: true });
  await storedBaselineRun(project, "initial", sha, [
    {},
    { viewport: "mobile", dirty: true },
  ]);
  await expect(record(project)).rejects.toThrow(
    "baseline record needs a capture of a clean tree",
  );
  await expect(check(project, "initial")).rejects.toThrow(
    "no recorded baseline",
  );
  await expect(
    checkCommand({
      project,
      flow: "studio",
      from: "initial",
      baseline: "initial",
      sinceBaseline: true,
    }),
  ).rejects.toThrow("mutually exclusive");
  const ordinary = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "initial",
  });
  expect(ordinary).not.toHaveProperty("baseline");
  expect(ordinary).not.toHaveProperty("fixed");
  expect(ordinary).not.toHaveProperty("preExistingFindings");
  expect(
    await reviewCommand({
      project,
      flow: "studio",
      from: "initial",
      deterministicOnly: true,
    }),
  ).not.toHaveProperty("comparison");
}, 60_000);

test("an occurrence beyond the ordinary attention cap still gates, and model findings stay unclassified", async () => {
  const { project, commit: sha } = await setup({
    maxFindings: 1,
    required: ["#a", "#b", "#c"],
  });
  await storedBaselineRun(project, "initial", sha);
  await record(project);
  await storedBaselineRun(project, "later", sha, [
    { mismatches: [missing("#a"), missing("#b"), missing("#c")] },
  ]);
  const summary = await check(project);
  expect(summary.findings).toHaveLength(3);
  expect(summary.findings.filter((finding) => finding.deferred)).toHaveLength(
    2,
  );
  expect(
    (await cli(project, "check", "later", ["--fail-on", "blocker"])).code,
  ).toBe(1);
  const reviewed = await reviewCommand({
    project,
    flow: "studio",
    from: "initial",
    sinceBaseline: true,
    dependencies: {
      critique: {
        critique: async () => [
          {
            category: "hierarchy",
            severity: "major",
            confidence: 0.9,
            rule: "DESIGN.md: hierarchy",
            selectorHint: "main",
            state: "editor",
            viewport: "desktop",
            screenshots: ["editor/desktop"],
            references: [],
            explanation: "The hierarchy needs emphasis.",
            suggestedArea: "main",
            acceptance: ["Use one dominant heading."],
          },
        ],
      },
    },
  });
  expect(reviewed.comparison).toMatchObject({ findings: [], unclassified: 1 });
  expect(reviewed.comparison?.currentJudged).toHaveLength(1);
  const model: ModelFindingCandidate = {
    category: "hierarchy",
    severity: "major",
    confidence: 0.9,
    rule: "DESIGN.md: hierarchy",
    selectorHint: "main",
    state: "editor",
    viewport: "desktop",
    screenshots: ["editor/desktop"],
    references: [],
    explanation: "The hierarchy needs emphasis.",
    suggestedArea: "main",
    acceptance: ["Use one dominant heading."],
  };
  for (const optIn of [false, true]) {
    const code = await run(
      [
        "node",
        "idiom",
        "review",
        "studio",
        "--project",
        project,
        "--from",
        "initial",
        "--since-baseline",
        "--fail-on",
        "major",
        ...(optIn ? ["--fail-on-judged"] : []),
      ],
      {
        stdout: () => {},
        stderr: () => {},
        review: { critique: { critique: async () => [model] } },
      },
    );
    expect(code).toBe(optIn ? 1 : 0);
  }

  // Recording reads all raw candidates even when policy hides every live row.
  await writeFile(
    join(project, ".idiom/rules.json"),
    JSON.stringify({
      version: 1,
      overrides: [
        {
          id: "hide-expectations",
          action: "suppress",
          match: { category: "missing-state" },
          reason: "Fixture policy",
        },
      ],
    }),
  );
  expect(await record(project, "later")).toMatchObject({ findingCount: 3 });
  expect(await check(project)).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 0,
  });
}, 60_000);

const baselineRecord = (
  sha: string,
  overrides: Partial<BaselineRecord> = {},
): BaselineRecord => ({
  commit: sha,
  recordedAt: "2026-10-23T12:00:00.000Z",
  idiomVersion: "0.4.0",
  configHash: `sha256:${"a".repeat(64)}`,
  tuples: [],
  ...overrides,
});
test("real Git ancestry selects the nearest reachable baseline from an absolute shared directory", async () => {
  const { project, configPath, commit: a } = await setup();
  const shared = await mkdtemp(join(tmpdir(), "idiom-shared-baseline-"));
  directories.push(shared);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({ ...config, baselines: { directory: shared } }),
  );
  const b = await commit(project, "B");
  await git(project, "checkout", "-qb", "feature");
  await commit(project, "D");
  await git(project, "checkout", "-q", "main");
  const c = await commit(project, "C");
  await git(project, "checkout", "-q", "feature");
  const path = baselinePath(shared, "studio");
  for (const sha of [a, b, c])
    await writeBaselineRecord(path, "studio", baselineRecord(sha));
  const file = await readBaselineFile(path);
  if (file === undefined) throw Error("missing baseline");
  expect(
    await selectBaselineRecord({ projectDirectory: project, file }),
  ).toMatchObject({ record: { commit: b }, distance: 1 });
  const missingFile = {
    ...file,
    records: [...file.records, baselineRecord("f".repeat(40))],
  };
  await expect(
    selectBaselineRecord({ projectDirectory: project, file: missingFile }),
  ).rejects.toThrow("fetch");
  file.records = file.records.filter((record) => record.commit !== b);
  expect(
    await selectBaselineRecord({ projectDirectory: project, file }),
  ).toMatchObject({ record: { commit: a }, distance: 2 });
  file.records = file.records.filter((record) => record.commit !== a);
  expect(
    await selectBaselineRecord({ projectDirectory: project, file }),
  ).toBeUndefined();
  await writeFile(path, JSON.stringify(file));
  await storedBaselineRun(project, "initial", b);
  await expect(check(project, "initial")).rejects.toThrow(
    "no recorded baseline",
  );
}, 60_000);

test("store validates compact files, sorts deterministically, replaces commits and retains at most twenty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-baseline-store-"));
  directories.push(directory);
  const path = baselinePath(directory, "studio");
  expect(await readBaselineFile(path)).toBeUndefined();
  const finding = {
    fingerprint: "b".repeat(64),
    aliases: [],
    category: "missing-state" as const,
    rule: "test",
    severity: "major" as const,
    selector: "#required",
  };
  const record = baselineRecord("a".repeat(40), {
    tuples: [
      {
        state: "z",
        viewport: "desktop",
        findings: [finding, { ...finding, fingerprint: "a".repeat(64) }],
      },
      { state: "a", viewport: "mobile", findings: [] },
    ],
  });
  expect(await writeBaselineRecord(path, "studio", record)).toEqual({
    replaced: false,
  });
  const first = await readFile(path, "utf8");
  expect(
    await writeBaselineRecord(path, "studio", {
      ...record,
      tuples: [...record.tuples].reverse(),
    }),
  ).toEqual({ replaced: true });
  expect(await readFile(path, "utf8")).toBe(first);
  expect((await readBaselineFile(path))?.records).toHaveLength(1);
  for (let i = 0; i < 23; i++)
    await writeBaselineRecord(
      path,
      "studio",
      baselineRecord(i.toString(16).padStart(40, "0")),
    );
  expect((await readBaselineFile(path))?.records).toHaveLength(20);
  expect((await readBaselineFile(path))?.records[0]?.commit).toBe(
    (22).toString(16).padStart(40, "0"),
  );
  expect(() => baselinePath(directory, "../escape")).toThrow(
    "invalid baseline flow",
  );
  await expect(writeBaselineRecord(path, "other", record)).rejects.toThrow(
    "belongs to flow",
  );
  expect(
    baselineFileSchema.safeParse({
      version: 1,
      flow: "studio",
      records: [baselineRecord("b".repeat(64))],
    }).success,
  ).toBe(true);
  for (const bytes of ["{", JSON.stringify({ version: 2, screenshots: [] })]) {
    await writeFile(path, bytes);
    await expect(readBaselineFile(path)).rejects.toThrow(path);
  }
});

test("the full normalized checks block hashes defaults and key order equally, and includes capture inputs and check ids", async () => {
  const { configPath } = await setup();
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const normalized = projectSchema.parse(raw);
  const hash = checksConfigHash(normalized.checks);
  expect(
    checksConfigHash(
      projectSchema.parse({ ...raw, checks: normalized.checks }).checks,
    ),
  ).toBe(hash);
  expect(
    checksConfigHash(
      Object.fromEntries(
        Object.entries(normalized.checks).reverse(),
      ) as typeof normalized.checks,
    ),
  ).toBe(hash);
  const variants = [
    {
      components: [
        { name: "button", selector: ".button", width: 44, height: 44 },
      ],
    },
    { freshState: { historySelectors: [".history"] } },
    { freshState: { unsavedSelectors: [".draft"] } },
    { alarm: { ignore: [".alarm"] } },
    { probe: { enabled: false } },
    { disguisedControl: { ignore: [".control"] } },
  ];
  for (const checks of variants)
    expect(
      checksConfigHash(projectSchema.parse({ ...raw, checks }).checks),
    ).not.toBe(hash);
  const mutableCheckIds = deterministicCheckIds as unknown as string[];
  const id = mutableCheckIds.pop();
  try {
    expect(checksConfigHash(normalized.checks)).not.toBe(hash);
  } finally {
    if (id !== undefined) mutableCheckIds.push(id);
  }
  const withBaselines = projectSchema.parse({
    ...raw,
    baselines: { directory: "../shared" },
  });
  expect(checksConfigHash(withBaselines.checks)).toBe(hash);
  expect(
    projectSchema.safeParse({
      ...raw,
      baselines: { directory: "x", unknown: true },
    }).success,
  ).toBe(false);
});

test("identity aliases match only inside the same tuple, and raw suppressed candidates prevent false fixes", async () => {
  const { project, commit: sha } = await setup();
  await storedBaselineRun(project, "initial", sha, [
    { mismatches: [missing()] },
  ]);
  const result = await runReview({
    project,
    flow: "studio",
    from: "initial",
    deterministicOnly: true,
    includeDeterministicOccurrences: true,
  });
  const candidate = (await candidates(project, "initial"))[0];
  const finding = result.deterministicOccurrences?.[0];
  if (candidate === undefined || finding === undefined)
    throw Error("missing fixture defect");
  const alias = "c".repeat(64);
  const record = baselineRecord(sha, {
    tuples: [
      {
        state: "editor",
        viewport: "desktop",
        findings: [{ ...candidate, fingerprint: alias, aliases: [] }].map(
          ({ fingerprint, aliases, category, rule, severity, selector }) => ({
            fingerprint,
            aliases,
            category,
            rule,
            severity,
            selector,
          }),
        ),
      },
    ],
  });
  const options = {
    record,
    currentCandidates: [{ ...candidate, aliases: [alias] }],
    currentTupleKeys: new Set([candidate.key]),
    liveOccurrences: [finding],
    currentConfigHash: record.configHash,
  };
  expect(compareToBaseline(options)).toMatchObject({
    newFindings: [],
    preExisting: [finding],
    fixed: [],
  });
  expect(compareToBaseline({ ...options, liveOccurrences: [] })).toMatchObject({
    newFindings: [],
    preExisting: [],
    fixed: [],
  });
  expect(
    compareToBaseline({
      ...options,
      currentCandidates: [],
      liveOccurrences: [],
    }).fixed,
  ).toHaveLength(1);
  expect(
    compareToBaseline({
      ...options,
      currentCandidates: [],
      liveOccurrences: [],
      currentTupleKeys: new Set(),
    }),
  ).toMatchObject({ fixed: [], uncoveredTuples: [candidate.key] });
  const light = { ...finding, colorScheme: "light" as const };
  const differentScheme = {
    ...record,
    tuples: record.tuples.map((tuple) => ({
      ...tuple,
      colorScheme: "dark" as const,
    })),
  };
  expect(
    compareToBaseline({
      ...options,
      record: differentScheme,
      liveOccurrences: [light],
      currentCandidates: [
        { ...candidate, key: "editor/desktop/light", aliases: [alias] },
      ],
    }).newFindings,
  ).toEqual([light]);
});

test("per-tuple finalization reuses canonical names and every catalog status without copying a representative's severity", async () => {
  const { project, commit: sha } = await setup({ mobile: true });
  await storedBaselineRun(project, "initial", sha, [
    { mismatches: [missing()] },
    { viewport: "mobile", mismatches: [missing()] },
  ]);
  await record(project);
  const loaded = await load(project, "initial");
  const catalog = await loadReviewCatalog({ project });
  const drafts = nameFindingDrafts(
    new FindingNamingSession(catalog.names),
    buildDeterministicDrafts({
      runId: loaded.runId,
      entries: runDeterministicChecks(loaded.tuples, loaded.expectedTupleKeys)
        .candidates,
      legacyColorScheme: "light",
    }),
  ).map((draft) => ({
    ...draft,
    finding: {
      ...draft.finding,
      severity:
        draft.finding.viewport === "mobile"
          ? ("minor" as const)
          : ("blocker" as const),
    },
  }));
  const lineage = catalog.lineages[0];
  if (lineage === undefined) throw Error("missing lineage");
  for (const status of [
    "open",
    "approved",
    "rejected",
    "ticketed",
    "verified-fixed",
    "verify-failed",
  ] as const) {
    lineage.latest.finding.status = status;
    const occurrences = finalizeDeterministicOccurrences({
      runId: loaded.runId,
      drafts,
      catalog,
    });
    expect(occurrences).toHaveLength(2);
    expect(new Set(occurrences.map((finding) => finding.id)).size).toBe(1);
    for (const draft of drafts)
      expect(
        occurrences.find(
          (finding) => finding.viewport === draft.finding.viewport,
        ),
      ).toEqual(
        finalizeFindings({ runId: loaded.runId, drafts: [draft], catalog })[0],
      );
    expect(occurrences.map((finding) => finding.severity)).toEqual([
      "blocker",
      "minor",
    ]);
    expect(occurrences.map((finding) => finding.status)).toEqual([
      status,
      status,
    ]);
  }
  // Persisted catalog status is authoritative for both ordinary review and the gate.
  for (const status of ["approved", "rejected"] as const) {
    await writeFindings(lineage.latest.runDirectory, [
      { ...lineage.latest.finding, status },
    ]);
    const comparison = await check(project, "initial");
    expect(comparison.findings).toEqual([]);
    expect(comparison.preExisting).toBe(status === "approved" ? 2 : 0);
    expect(comparison.fixed).toEqual([]);
  }
  // Scheme-aware light identities carry real scheme-less legacy aliases.
  const schemeDrafts = buildDeterministicDrafts({
    runId: loaded.runId,
    legacyColorScheme: "light",
    entries: runDeterministicChecks(
      loaded.tuples.map((tuple) => ({
        ...tuple,
        colorSchemeAxis: true,
        colorScheme: "light",
      })),
      loaded.expectedTupleKeys,
    ).candidates,
  });
  const alias = schemeDrafts[0]?.fingerprintAliases?.[0];
  if (alias === undefined) throw Error("expected a real legacy alias");
  const decision = {
    at: "2026-10-23T12:00:00.000Z",
    commit: sha,
    findingId: "finding-1",
    fingerprint: alias,
    decision: "reject" as const,
    scope: "rule" as const,
    actor: "human" as const,
  };
  expect(suppressFindingDrafts(schemeDrafts, [decision]).kept).toEqual([]);
  expect(
    suppressFindingDrafts(schemeDrafts, [
      decision,
      { ...decision, decision: "accept" },
    ]).kept,
  ).toHaveLength(2);
}, 60_000);

test("candidate records preserve legacy collapsed-grid exclusions and retained per-combination evidence", async () => {
  const { project, commit: sha } = await setup();
  await writeFile(
    join(project, ".idiom/flows/studio.json"),
    JSON.stringify({
      id: "studio",
      title: "Studio",
      intent: [],
      setup: [],
      states: [{ id: "editor", description: "Editor", url: "/", expect: {} }],
      toggles: { panel: { good: [], bad: [] } },
    }),
  );
  const combination = (option: string) => ({
    base: "editor",
    label: `panel=${option}`,
    options: { panel: option },
    equivalent: [],
  });
  const directory = await storedBaselineRun(project, "combinations", sha, [
    {},
    { state: "editor.panel-good", combination: combination("good") },
    {
      state: "editor.panel-bad",
      combination: combination("bad"),
      layoutRepresentative: "editor.panel-good",
      mismatches: [missing()],
    },
  ]);
  const report = {
    version: 1,
    evidence: "per-combination",
    captured: 2,
    collapsed: [
      {
        state: "editor.panel-bad",
        viewport: "desktop",
        colorScheme: "light",
        colorSchemeAxis: false,
        combination: "panel=bad",
        sameAs: { state: "editor.panel-good", combination: "panel=good" },
      },
    ],
    notes: [],
  };
  await writeFile(join(directory, "combinations.json"), JSON.stringify(report));
  const retained = await load(project, "combinations");
  expect(retained.collapsedTupleKeys).toEqual([]);
  expect(retained.expectedTupleKeys).toHaveLength(3);
  const compareHelperWithChecks = async () => {
    const loaded = await load(project, "combinations");
    const flow = loaded.validated.flows[0]?.flow;
    if (flow === undefined) throw Error("missing flow");
    const expectedKeys = expectedCaptureTupleKeys({
      project: loaded.validated.project,
      flow,
      collapsed: loaded.collapsedTupleKeys,
    });
    expect(loaded.expectedTupleKeys).toEqual(expectedKeys);
    const expected = runDeterministicChecks(
      loaded.tuples,
      expectedKeys,
      checksConfigFrom(loaded.validated.project.checks),
    ).candidates.map(({ tuple, candidate }) => ({
      key: tupleCoordinateKey(tupleCoordinate(tuple)),
      ...findingFingerprintIdentity({
        category: candidate.category,
        flow: tuple.flow,
        state: tuple.state,
        rule: candidate.rule,
        selectorHint: candidate.fingerprintHint ?? candidate.selectorHint,
      }),
    }));
    expect(
      (await candidates(project, "combinations")).map(
        ({ key, fingerprint, aliases }) => ({ key, fingerprint, aliases }),
      ),
    ).toEqual(expected);
  };
  await compareHelperWithChecks();
  expect(await candidates(project, "combinations")).toContainEqual(
    expect.objectContaining({ key: "editor.panel-bad/desktop#panel=bad" }),
  );
  await record(project, "combinations");
  expect(await check(project, "combinations")).toMatchObject({
    findings: [],
    fixed: [],
    preExisting: 1,
  });
  await rm(join(directory, "editor.panel-bad"), { recursive: true });
  const { evidence: _evidence, ...legacy } = report;
  await writeFile(join(directory, "combinations.json"), JSON.stringify(legacy));
  const omitted = await load(project, "combinations");
  expect(omitted.collapsedTupleKeys).toEqual([
    "editor.panel-bad\0desktop\0light",
  ]);
  expect(omitted.expectedTupleKeys).toHaveLength(2);
  expect(omitted.expectedTupleKeys).not.toContain(
    "editor.panel-bad\0desktop\0light",
  );
  await compareHelperWithChecks();
  expect(await check(project, "combinations")).toMatchObject({
    findings: [],
    fixed: [],
    baseline: { uncoveredTuples: ["editor.panel-bad/desktop#panel=bad"] },
  });
}, 60_000);

test("record CLI uses the captured commit at configurable relative locations and emits JSON metadata", async () => {
  const { project, configPath, commit: sha } = await setup();
  await storedBaselineRun(project, "initial", sha, [
    { mismatches: [missing()] },
  ]);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({ ...config, baselines: { directory: "snapshots" } }),
  );
  const head = await commit(project, "configure directory");
  expect(head).not.toBe(sha);
  let out = "";
  expect(
    await run(
      [
        "node",
        "idiom",
        "--project",
        project,
        "baseline",
        "record",
        "studio",
        "--from",
        "initial",
        "--json",
      ],
      {
        stdout: (message) => {
          out += message;
        },
      },
    ),
  ).toBe(0);
  expect(JSON.parse(out)).toMatchObject({
    path: join(project, "snapshots/studio.json"),
    commit: sha,
    replaced: false,
    findingCount: 1,
  });
  const summary = await check(project, "initial");
  expect(summary.baseline).toMatchObject({ commit: sha, distance: 1 });
  out = "";
  expect(
    await run(
      [
        "node",
        "idiom",
        "--project",
        project,
        "baseline",
        "record",
        "studio",
        "--from",
        "initial",
      ],
      {
        stdout: (message) => {
          out += message;
        },
      },
    ),
  ).toBe(0);
  expect(out).toContain(`Recorded baseline for studio at ${sha.slice(0, 12)}`);
  expect(out).toContain("Commit this file.");
}, 60_000);

test("equal-distance Git records are selected by recording time", async () => {
  const early = baselineRecord("a".repeat(40));
  const late = baselineRecord("b".repeat(40), {
    recordedAt: "2026-10-23T13:00:00.000Z",
  });
  expect(
    await selectBaselineRecord({
      projectDirectory: "/unused",
      file: { version: 1, flow: "studio", records: [early, late] },
      git: {
        head: async () => "c".repeat(40),
        isAncestor: async () => true,
        distance: async () => 2,
      },
    }),
  ).toEqual({ record: late, distance: 2 });
});

test("default check accepts its exact HEAD capture once, reports the acceptance, and keeps repeat bytes unchanged", async () => {
  const { project, commit: sha } = await setup({ required: ["#a", "#b"] });
  await storedBaselineRun(project, "initial", sha, [
    { mismatches: [missing("#a")] },
  ]);
  const summary = await checkCommand({
    project,
    flow: "studio",
    from: "initial",
  });
  expect(summary.baselineRecorded).toMatchObject({
    commit: sha,
    tupleCount: 1,
    findingCount: 1,
  });
  expect(summary.findings).toEqual([]);
  expect(summary.fixed).toEqual([]);
  expect(summary.preExistingFindings).toHaveLength(1);
  expect(renderCheckSummary(summary)).toContain(
    "Automatically recorded baseline",
  );
  expect(renderCheckSummary(summary)).toContain("Commit this file");
  const path = summary.baselineRecorded?.path as string;
  const bytes = await readFile(path, "utf8");
  const repeated = await checkCommand({
    project,
    flow: "studio",
    from: "initial",
  });
  expect(repeated.baselineRecorded).toBeUndefined();
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect((await readBaselineFile(path))?.records).toHaveLength(1);
  let stdout = "";
  expect(
    await run(
      [
        "node",
        "idiom",
        "check",
        "studio",
        "--project",
        project,
        "--from",
        "initial",
        "--json",
      ],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: () => {},
      },
    ),
  ).toBe(0);
  expect(JSON.parse(stdout).preExistingFindings).toHaveLength(1);
  const full = await checkCommand({
    project,
    flow: "studio",
    from: "initial",
    all: true,
  });
  expect(full.blocking).toBe(1);
  expect(full.findings).toHaveLength(1);
  expect(
    await run(
      [
        "node",
        "idiom",
        "check",
        "studio",
        "--project",
        project,
        "--from",
        "initial",
        "--all",
        "--fail-on",
        "blocker",
      ],
      { stdout: () => {}, stderr: () => {} },
    ),
  ).toBe(1);
}, 60_000);

test("default comparison separates new, fixed and existing; accept advances explicitly and can replace a commit", async () => {
  const { project, commit: sha } = await setup({
    required: ["#a", "#b", "#c"],
  });
  await storedBaselineRun(project, "initial", sha, [
    { mismatches: [missing("#a"), missing("#b")] },
  ]);
  await checkCommand({ project, flow: "studio", from: "initial" });
  const next = await commit(project, "intentional update");
  await storedBaselineRun(project, "later", next, [
    { dirty: true, mismatches: [missing("#b"), missing("#c")] },
  ]);
  const summary = await checkCommand({
    project,
    flow: "studio",
    from: "later",
  });
  expect(summary.findings).toHaveLength(1);
  expect(summary.fixed).toHaveLength(1);
  expect(summary.preExistingFindings).toHaveLength(1);
  expect(summary.blocking).toBe(1);
  expect(renderCheckSummary(summary)).toMatch(
    /New[\s\S]*Fixed[\s\S]*Pre-existing/,
  );
  await expect(
    baselineRecordCommand({ project, flow: "studio", from: "later" }),
  ).rejects.toThrow("clean tree");
  await storedBaselineRun(project, "accepted", next, [
    { mismatches: [missing("#b"), missing("#c")] },
  ]);
  let stdout = "";
  expect(
    await run(
      [
        "node",
        "idiom",
        "baseline",
        "accept",
        "studio",
        "--project",
        project,
        "--from",
        "accepted",
        "--json",
      ],
      {
        stdout: (s) => {
          stdout += s;
        },
        stderr: () => {},
      },
    ),
  ).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ commit: next, replaced: false });
  expect(
    (await checkCommand({ project, flow: "studio", from: "later" })).findings,
  ).toEqual([]);
  expect(
    (await baselineRecordCommand({ project, flow: "studio", from: "accepted" }))
      .replaced,
  ).toBe(true);
  expect(
    (
      await readBaselineFile(
        baselinePath(join(project, ".idiom/baselines"), "studio"),
      )
    )?.records,
  ).toHaveLength(2);
}, 60_000);

test("accept infers only a sole flow and out/file overrides bypass a nearer accepted HEAD record", async () => {
  const { project, commit: sha } = await setup({ required: ["#a", "#b"] });
  await storedBaselineRun(project, "initial", sha);
  await writeFile(
    join(project, ".idiom/flows/another.json"),
    JSON.stringify({
      id: "another",
      title: "Another",
      intent: [],
      setup: [],
      states: [{ id: "default", description: "Default", url: "/", expect: {} }],
    }),
  );
  await expect(
    baselineRecordCommand({ project, from: "initial" }),
  ).rejects.toThrow("choose one of");
  await rm(join(project, ".idiom/flows/example.json"), { force: true });
  // init's starter flow name can change; retain only studio for this inference test.
  const { readdir } = await import("node:fs/promises");
  for (const file of await readdir(join(project, ".idiom/flows")))
    if (file !== "studio.json") await rm(join(project, ".idiom/flows", file));
  const accepted = await baselineRecordCommand({
    project,
    from: "initial",
    out: "private-baselines",
    cwd: project,
  });
  expect(accepted.path).toBe(join(project, "private-baselines/studio.json"));
  let acceptedJson = "";
  expect(
    await run(
      [
        "node",
        "idiom",
        "baseline",
        "accept",
        "--project",
        project,
        "--from",
        "initial",
        "--out",
        join(project, "private-baselines"),
        "--json",
      ],
      {
        stdout: (line) => {
          acceptedJson += line;
        },
        stderr: () => {},
      },
    ),
  ).toBe(0);
  expect(JSON.parse(acceptedJson)).toMatchObject({
    flow: "studio",
    commit: sha,
    replaced: true,
  });
  const head = await commit(project, "head");
  await storedBaselineRun(project, "later", head, [
    { mismatches: [missing("#a")] },
  ]);
  await baselineRecordCommand({ project, flow: "studio", from: "later" });
  const normal = await checkCommand({ project, flow: "studio", from: "later" });
  expect(normal.findings).toEqual([]);
  const explicit = await checkCommand({
    project,
    flow: "studio",
    from: "later",
    baselineFile: "private-baselines/studio.json",
    cwd: project,
  });
  expect(explicit.baseline?.commit).toBe(sha);
  expect(explicit.findings).toHaveLength(1);
}, 60_000);

test.each([
  { name: "dirty", dirty: true },
  { name: "failed", failure: { stage: "navigation", message: "failed" } },
])(
  "automatic baseline rejects $name capture evidence without a record",
  async ({ name, ...tuple }) => {
    const { project, commit: sha } = await setup();
    await storedBaselineRun(project, "initial", sha, [tuple]);
    await expect(
      checkCommand({ project, flow: "studio", from: "initial" }),
    ).rejects.toThrow(/clean tree|successful capture/);
    expect(
      await readBaselineFile(
        baselinePath(join(project, ".idiom/baselines"), "studio"),
      ),
    ).toBeUndefined();
  },
  60_000,
);

test("automatic baseline rejects a historical capture while manual record preserves its original commit", async () => {
  const { project, commit: sha } = await setup();
  await storedBaselineRun(project, "initial", sha);
  await commit(project, "later");
  await expect(
    checkCommand({ project, flow: "studio", from: "initial" }),
  ).rejects.toThrow("clean HEAD");
  expect((await record(project)).commit).toBe(sha);
}, 60_000);

test("default initializes alongside unrelated branch records, but cannot bootstrap missing Git objects", async () => {
  const { project, commit: initial } = await setup();
  await git(project, "checkout", "-qb", "other");
  const other = await commit(project, "other");
  await git(project, "checkout", "-q", "main");
  const path = baselinePath(join(project, ".idiom/baselines"), "studio");
  await writeBaselineRecord(path, "studio", baselineRecord(other));
  await storedBaselineRun(project, "initial", initial);
  expect(
    (await checkCommand({ project, flow: "studio", from: "initial" }))
      .baselineRecorded?.commit,
  ).toBe(initial);
  expect((await readBaselineFile(path))?.records.map((r) => r.commit)).toEqual([
    initial,
    other,
  ]);
  await writeBaselineRecord(path, "studio", baselineRecord("f".repeat(40)));
  const bytes = await readFile(path, "utf8");
  await expect(
    checkCommand({ project, flow: "studio", from: "initial" }),
  ).rejects.toThrow("fetch");
  expect(await readFile(path, "utf8")).toBe(bytes);
}, 60_000);

test("explicit missing, malformed, wrong-flow and unrelated files fail before capture and never bootstrap", async () => {
  const { project, commit: sha } = await setup();
  const path = join(project, "explicit.json");
  const checkFile = () =>
    checkCommand({
      project,
      flow: "studio",
      baselineFile: path,
      from: "absent",
    });
  await expect(checkFile()).rejects.toThrow("no recorded baseline");
  await writeFile(path, "broken");
  await expect(checkFile()).rejects.toThrow("cannot read baseline");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      flow: "another",
      records: [baselineRecord(sha)],
    }),
  );
  await expect(checkFile()).rejects.toThrow("belongs to flow");
  for (const options of [
    { all: true, baselineFile: path },
    { all: true, sinceBaseline: true },
    { all: true, baseline: "absent" },
    { baselineFile: path, sinceBaseline: true },
    { baseline: "absent", baselineFile: path },
  ])
    await expect(
      checkCommand({ project, flow: "studio", ...options }),
    ).rejects.toThrow("mutually exclusive");
}, 60_000);

test("fresh scoped bootstrap captures once, records actual coordinates in the custom directory, and leaves later coverage new", async () => {
  const { project, configPath } = await setup({ mobile: true, required: [] });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.baselines = { directory: "accepted" };
  config.server = {
    build: "node -e 0",
    start: `node '${join(import.meta.dirname, "fixtures/github-action/server.mjs")}'`,
    port: 3123,
    readyUrl: "http://127.0.0.1:3123",
    env: {},
  };
  config.checks = { probe: { enabled: false } };
  config.capture = { settleMs: 0 };
  await writeFile(configPath, JSON.stringify(config));
  await copyFile(
    join(import.meta.dirname, "fixtures/github-action/before.html"),
    join(project, "index.html"),
  );
  const sha = await commit(project, "runnable fixture");
  let captures = 0,
    stdout = "";
  const code = await run(
    [
      "node",
      "idiom",
      "check",
      "studio",
      "--project",
      project,
      "--viewports",
      "mobile",
      "--json",
    ],
    {
      stdout: (s) => {
        stdout += s;
      },
      stderr: () => {},
      review: {
        capture: {
          snapshotSource: async (directory) => {
            captures++;
            return snapshotSource(directory);
          },
        },
      },
    },
  );
  expect(code).toBe(0);
  expect(captures).toBe(1);
  const summary = JSON.parse(stdout);
  expect(summary.baselineRecorded).toMatchObject({
    commit: sha,
    tupleCount: 1,
    path: join(project, "accepted/studio.json"),
  });
  expect(summary.findings).toEqual([]);
  const file = await readBaselineFile(summary.baselineRecorded.path);
  expect(file?.records[0]?.tuples.map((tuple) => tuple.viewport)).toEqual([
    "mobile",
  ]);
  const html = await readFile(join(project, "index.html"), "utf8");
  await storedBaselineRun(project, "expanded", sha, [
    { html, dirty: true },
    { viewport: "mobile", html, dirty: true },
  ]);
  const expanded = await checkCommand({
    project,
    flow: "studio",
    from: "expanded",
  });
  expect(expanded.findings).toHaveLength(1);
  expect(expanded.findings[0]?.where).toBe("editor/desktop");
  expect(expanded.preExistingFindings).toHaveLength(1);
}, 60_000);

test("automatic published baseline and acceptance copy pixel evidence, including out override", async () => {
  const { project } = await setup();
  await writeFile(
    join(project, ".idiom/flows/studio.json"),
    JSON.stringify({
      id: "studio",
      title: "Studio",
      intent: [],
      setup: [],
      kind: "published",
      pages: ["/"],
      viewports: ["desktop"],
    }),
  );
  const sha = await commit(project, "published");
  await storedBaselineRun(project, "initial", sha, [{ state: "page-root" }]);
  const summary = await checkCommand({
    project,
    flow: "studio",
    from: "initial",
  });
  expect(summary.baselineRecorded?.pixelCount).toBe(1);
  expect(renderCheckSummary(summary)).toContain("studio.pixels");
  const source = await readFile(
    join(project, ".idiom/reports/initial/page-root/desktop/screenshot.png"),
  );
  expect(
    await readFile(
      join(project, ".idiom/baselines/studio.pixels/page-root--desktop.png"),
    ),
  ).toEqual(source);
  const accepted = await baselineRecordCommand({
    project,
    flow: "studio",
    from: "initial",
    cwd: project,
    out: "private",
  });
  expect(accepted.pixelCount).toBe(1);
  expect(
    await readFile(
      join(project, "private/studio.pixels/page-root--desktop.png"),
    ),
  ).toEqual(source);
}, 60_000);

test("missing selected capture coordinates and shallow baseline ancestry cannot initialize a replacement", async () => {
  const { project, commit: original } = await setup({ mobile: true });
  await storedBaselineRun(project, "incomplete", original);
  await expect(
    checkCommand({ project, flow: "studio", from: "incomplete" }),
  ).rejects.toThrow("successful capture");
  const path = baselinePath(join(project, ".idiom/baselines"), "studio");
  expect(await readBaselineFile(path)).toBeUndefined();
  await writeBaselineRecord(path, "studio", baselineRecord(original));
  await commit(project, "later with baseline");
  const cloned = await mkdtemp(join(tmpdir(), "idiom-shallow-"));
  directories.push(cloned);
  await git(project, "clone", "--depth=1", `file://${project}`, cloned);
  const bytes = await readFile(
    join(cloned, ".idiom/baselines/studio.json"),
    "utf8",
  );
  await expect(
    checkCommand({ project: cloned, flow: "studio", from: "absent" }),
  ).rejects.toThrow("fetch");
  expect(
    await readFile(join(cloned, ".idiom/baselines/studio.json"), "utf8"),
  ).toBe(bytes);
  await writeFile(path, "invalid JSON");
  await expect(
    checkCommand({ project, flow: "studio", from: "absent" }),
  ).rejects.toThrow("cannot read baseline");
}, 60_000);

test("manual record validates the requested manifest identity before capture", async () => {
  const { project } = await setup();
  await writeFile(
    join(project, ".idiom/flows/alias.json"),
    await readFile(join(project, ".idiom/flows/studio.json")),
  );
  await expect(
    baselineRecordCommand({ project, flow: "alias", from: "absent" }),
  ).rejects.toThrow("does not match the manifest id");
});
