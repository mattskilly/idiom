import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ATTRIBUTION_RECORD_FILE,
  type AttributionRecord,
  introductionKey,
  introductionsByKey,
} from "../src/attribution/record.js";
import type { CheckTuple } from "../src/checks/types.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { digestFlows } from "../src/digest/build.js";
import {
  DIGEST_RECORD_FILE,
  type DigestOccurrence,
  type DigestRecord,
} from "../src/digest/record.js";
import { DIGEST_LINE_BUDGET, renderDigest } from "../src/digest/render.js";
import { renderReviewHtmlReport } from "../src/review/html-report.js";
import { renderReport } from "../src/review/report.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";

const FROM = "abc1234".padEnd(40, "0");
const TO = "def5678".padEnd(40, "0");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-attribution-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  return directory;
}

function finding(
  id: string,
  fingerprint: string,
  overrides: Partial<Finding> = {},
): Finding {
  return findingSchema.parse({
    id,
    fingerprint,
    createdAt: "2026-11-06T00:00:00.000Z",
    commit: TO,
    flow: "shop",
    state: "cart",
    viewport: "desktop",
    layer: "deterministic",
    category: "element-overlap",
    severity: "major",
    confidence: 1,
    rule: "idiom:element-overlap",
    evidence: { screenshots: [] },
    explanation: "The banner overlaps the checkout button.",
    acceptance: ["Nothing overlaps the button."],
    verification: { kind: "deterministic-check", check: "element-overlap" },
    status: "open",
    ...overrides,
  });
}

function attribution(
  runId: string,
  fingerprint: string,
  id = "finding-1",
): AttributionRecord {
  return {
    version: 1,
    flow: "shop",
    runId,
    commit: TO,
    dirty: false,
    previous: {
      runId: "run-1",
      commit: FROM,
      dirty: false,
      completedAt: "2026-11-05T08:00:00.000Z",
    },
    configChanged: false,
    introductions: [
      {
        id,
        fingerprint,
        where: "cart/desktop",
        state: "cart",
        range: {
          from: FROM,
          to: TO,
          commits: 4,
          linear: true,
          fromDirty: false,
          toDirty: false,
        },
        candidates: [
          { commit: TO, subject: "Add promo banner", tickets: ["file-263"] },
        ],
        likely: {
          commit: TO,
          subject: "Add promo banner",
          tickets: ["file-263"],
        },
      },
    ],
  };
}

const tuple = {
  flow: "shop",
  state: "cart",
  viewport: "desktop",
  width: 1440,
  height: 900,
  commit: TO,
  createdAt: "2026-11-06T00:00:00.000Z",
  console: [],
  mismatches: [],
  metadataPath: "metadata.json",
  artifactPaths: [],
} as CheckTuple;

test("the report shows Appeared only under the finding with an introduction", () => {
  const introduced = finding("finding-1", "f-new");
  const old = finding("finding-2", "f-old", {
    explanation: "An older overlap.",
  });
  const introductions = introductionsByKey(attribution("run-2", "f-new"));
  expect(introductions.has(introductionKey("cart/desktop", "f-new"))).toBe(
    true,
  );
  const options = {
    flow: "shop",
    commit: TO,
    findings: [introduced, old],
    tuples: [tuple],
    coverage: [],
    outcome: { kind: "deterministic-only" as const },
    introductions,
  };
  const markdown = renderReport(options);
  const line =
    'Appeared: appeared between abc1234 and def5678 (4 commits); likely introduced by def5678 "Add promo banner" (file-263).';
  expect(markdown.split(line)).toHaveLength(2);
  const section = (id: string) =>
    markdown.slice(markdown.indexOf(`#### ${id}:`)).split("#### ")[1] ?? "";
  expect(section("finding-1")).toContain("appeared between");
  expect(section("finding-2")).not.toContain("appeared between");
  const html = renderReviewHtmlReport({ ...options, screenshots: new Map() });
  expect(html.split("appeared between abc1234")).toHaveLength(2);
  expect(html).toContain('"Add promo banner"');
  expect(renderReport({ ...options, introductions: undefined })).not.toContain(
    "appeared between",
  );
});

function occurrence(fingerprint: string, id: string): DigestOccurrence {
  return {
    id,
    fingerprint,
    where: "cart/desktop",
    state: "cart",
    viewport: "desktop",
    category: "element-overlap",
    rule: "idiom:element-overlap",
    severity: "major",
    problem: "The banner overlaps the checkout button.",
    disposition: "open",
    score: 5,
    impactReasons: [],
  };
}

function digestRecord(
  runId: string,
  commit: string,
  occurrences: DigestOccurrence[],
  completedAt: string,
): DigestRecord {
  return {
    version: 1,
    flow: "shop",
    runId,
    completedAt,
    commit,
    dirty: false,
    reportPath: `.idiom/reports/${runId}/report.md`,
    configHash: "hash-1",
    scope: "full",
    coverage: { selected: 1, captured: ["cart/desktop"], problems: [] },
    occurrences,
  };
}

async function writeRun(
  directory: string,
  runId: string,
  files: Record<string, unknown>,
): Promise<string> {
  const path = join(directory, ".idiom", "reports", runId);
  await mkdir(path, { recursive: true });
  for (const [name, value] of Object.entries(files))
    await writeFile(join(path, name), `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

test("digest appends the range to a new finding's line and carries it in JSON", async () => {
  const directory = await project();
  await writeRun(directory, "2026-11-05T08-00-00-000Z", {
    [DIGEST_RECORD_FILE]: digestRecord(
      "2026-11-05T08-00-00-000Z",
      FROM,
      [],
      "2026-11-05T08:00:00.000Z",
    ),
  });
  const latest = "2026-11-06T08-00-00-000Z";
  await writeRun(directory, latest, {
    [DIGEST_RECORD_FILE]: digestRecord(
      latest,
      TO,
      [occurrence("f-new", "finding-1")],
      "2026-11-06T08:00:00.000Z",
    ),
    [ATTRIBUTION_RECORD_FILE]: attribution(latest, "f-new"),
  });
  const flows = await digestFlows({ project: directory });
  const lines = renderDigest(flows);
  expect(lines.length).toBeLessThanOrEqual(DIGEST_LINE_BUDGET);
  expect(lines).toContain(
    "+ finding-1 [major] idiom:element-overlap — cart — The banner overlaps the checkout button. · appeared between abc1234 and def5678 (4 commits), likely def5678 (file-263)",
  );
  const json = JSON.parse(JSON.stringify({ flows }));
  expect(json.flows[0].attribution).toEqual({
    previousCommit: FROM,
    commit: TO,
  });
  expect(json.flows[0].newFindings[0].introduced.range).toMatchObject({
    from: FROM,
    to: TO,
  });
});

test("digest without attribution.json keeps its lines unchanged", async () => {
  const directory = await project();
  await writeRun(directory, "2026-11-05T08-00-00-000Z", {
    [DIGEST_RECORD_FILE]: digestRecord(
      "2026-11-05T08-00-00-000Z",
      FROM,
      [],
      "2026-11-05T08:00:00.000Z",
    ),
  });
  await writeRun(directory, "2026-11-06T08-00-00-000Z", {
    [DIGEST_RECORD_FILE]: digestRecord(
      "2026-11-06T08-00-00-000Z",
      TO,
      [occurrence("f-new", "finding-1")],
      "2026-11-06T08:00:00.000Z",
    ),
  });
  const flows = await digestFlows({ project: directory });
  expect(flows[0]?.attribution).toBeNull();
  expect(renderDigest(flows).join("\n")).not.toContain("appeared between");
});

async function idiom(cwd: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", ...args], {
    cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("") };
}

test("decide --list shows Appeared and Likely cause; --json carries the range", async () => {
  const directory = await project();
  await writeRun(directory, "2026-11-05T08-00-00-000Z", {
    "findings.json": [finding("finding-2", "f-old")],
  });
  const latest = "2026-11-06T08-00-00-000Z";
  await writeRun(directory, latest, {
    "findings.json": [
      finding("finding-1", "f-new"),
      finding("finding-2", "f-old"),
    ],
    [ATTRIBUTION_RECORD_FILE]: attribution(latest, "f-new"),
  });
  const listed = await idiom(directory, ["decide", "--list"]);
  expect(listed.code).toBe(0);
  const block = listed.stdout.slice(listed.stdout.indexOf("finding-1 —"));
  expect(block).toContain(
    "  Appeared: appeared between abc1234 and def5678 (4 commits)",
  );
  expect(block).toContain(
    '  Likely cause: likely introduced by def5678 "Add promo banner" (file-263)',
  );
  const other = listed.stdout.slice(
    listed.stdout.indexOf("finding-2 —"),
    listed.stdout.indexOf("finding-1 —") > listed.stdout.indexOf("finding-2 —")
      ? listed.stdout.indexOf("finding-1 —")
      : undefined,
  );
  expect(other).not.toContain("Appeared:");

  const json = await idiom(directory, ["decide", "--list", "--json"]);
  expect(json.code).toBe(0);
  const payload = JSON.parse(json.stdout);
  expect(payload.interfaceVersion).toBe(1);
  const lifecycle = payload.lifecycles.find(
    (entry: { id: string }) => entry.id === "finding-1",
  );
  expect(lifecycle.introduced.range).toMatchObject({ from: FROM, to: TO });

  const rejected = await idiom(directory, ["decide", "--json"]);
  expect(rejected.code).toBe(1);
  expect(rejected.stderr).toContain(
    "--json applies only to idiom decide --list",
  );
});
