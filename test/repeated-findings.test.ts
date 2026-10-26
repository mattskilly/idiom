import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run as runCli } from "../src/cli.js";
import { checkCommand, renderCheckSummary } from "../src/commands/check.js";
import { decideCommand } from "../src/commands/decide.js";
import { readDecisionLog } from "../src/decisions/log.js";
import { groupRepeatedFindings, readGroups } from "../src/review/groups.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import {
  baselineProject,
  type StoredTuple,
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

const html = () =>
  readFile(
    join(import.meta.dirname, "fixtures/repeated-findings/undersized.html"),
    "utf8",
  );

// Both viewports are below 768px and use the coarse threshold, so the control repeats in every one of the 8 coordinates.
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "mobile-short", width: 390, height: 664 },
];

async function repeatedProject(options: { maxFindings?: number } = {}) {
  const setup = await baselineProject({
    states: ["editor", "preview"],
    viewports,
    schemes: true,
    maxFindings: options.maxFindings ?? 5,
  });
  directories.push(setup.project);
  const markup = await html();
  const tuples: StoredTuple[] = [];
  for (const state of ["editor", "preview"])
    for (const viewport of viewports)
      for (const scheme of ["light", "dark"] as const)
        tuples.push({
          state,
          viewport: viewport.name,
          size: { width: viewport.width, height: viewport.height },
          scheme,
          html: markup,
        });
  await storedBaselineRun(setup.project, "run", setup.commit, tuples);
  return setup;
}

const coordinateKeys = [
  "editor/mobile/dark",
  "editor/mobile/light",
  "editor/mobile-short/dark",
  "editor/mobile-short/light",
  "preview/mobile/dark",
  "preview/mobile/light",
  "preview/mobile-short/dark",
  "preview/mobile-short/light",
];

test("one undersized control across 2 states x 2 viewports x 2 schemes is one grouped finding with 8 coordinates", async () => {
  const { project } = await repeatedProject();
  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });

  // Before grouping, main already collapsed viewports by fingerprint (which
  // omits the viewport) but kept one finding per state x scheme: 4 here.
  const targetFindings = summary.findings.filter(
    (finding) => finding.category === "target-size",
  );
  expect(targetFindings).toHaveLength(4);

  const groups = (summary.groups ?? []).filter(
    (group) => group.category === "target-size",
  );
  expect(groups).toHaveLength(1);
  const group = groups[0];
  expect(group?.members).toHaveLength(4);
  expect(group?.coordinates).toEqual(coordinateKeys);
  expect(group?.states).toEqual(["editor", "preview"]);
  expect(group?.viewports).toEqual(["mobile", "mobile-short"]);
  expect([...(group?.colorSchemes ?? [])].sort()).toEqual(["dark", "light"]);
  expect(group?.screenshot).toContain("/crops/");
  expect(group?.members.flatMap((member) => member.coordinates).sort()).toEqual(
    [...coordinateKeys].sort(),
  );

  const text = renderCheckSummary(summary);
  expect(text.match(/^\d+\. \[minor\] target-size/gm)).toHaveLength(1);
  expect(text).toMatch(
    /seen in 2 states; viewports: mobile, mobile-short; schemes: (light, dark|dark, light) \(8 coordinates\)/,
  );
  expect(text).toContain(`idiom decide --group ${group?.id}`);
  expect(group?.id).toMatch(/^group-[0-9a-f]{12}$/);

  const markdown = await readFile(summary.reportPath, "utf8");
  expect(markdown).toContain("## Repeated findings");
  expect(markdown).toContain(`- ${group?.id}: target-size`);
  expect(
    await readFile(join(summary.runDirectory, "report.html"), "utf8"),
  ).toContain("<h2>Repeated findings</h2>");
}, 30_000);

test("the report has no Repeated findings section when nothing repeats", async () => {
  const setup = await baselineProject({ maxFindings: 5 });
  directories.push(setup.project);
  await storedBaselineRun(setup.project, "run", setup.commit, [{}]);
  const summary = await checkCommand({
    all: true,
    project: setup.project,
    flow: "studio",
    from: "run",
  });
  expect(await readFile(summary.reportPath, "utf8")).not.toContain(
    "Repeated findings",
  );
});

test("--json keeps every member coordinate and --ungrouped restores one entry per finding", async () => {
  const { project } = await repeatedProject();
  const stdout: string[] = [];
  await runCli(
    [
      "node",
      "idiom",
      "check",
      "--all",
      "studio",
      "--project",
      project,
      "--from",
      "run",
      "--json",
      "--fail-on",
      "never",
    ],
    { stdout: (message) => stdout.push(message) },
  );
  const json = JSON.parse(stdout.join("\n"));
  const group = json.groups.find(
    (candidate: { category: string }) => candidate.category === "target-size",
  );
  expect(group.coordinates).toHaveLength(8);
  for (const member of group.members)
    expect(member.coordinates).toHaveLength(2);
  expect(json.reportPath).toEqual(expect.any(String));
  const summaryBefore = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });
  expect(json.findings).toEqual(summaryBefore.findings);
  expect(json.groups).toEqual(summaryBefore.groups);
  expect(
    json.issues.flatMap((issue: { groups: string[] }) => issue.groups).sort(),
  ).toEqual(json.groups.map((group: { id: string }) => group.id).sort());

  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });
  const ungrouped = renderCheckSummary(summary, { ungrouped: true });
  expect(ungrouped.match(/target-size/g)).toHaveLength(4);
  expect(ungrouped).not.toContain("--group");
  expect(ungrouped).toContain("Full report: ");
}, 30_000);

test("decide --group records one decision per member, including members past the review cap", async () => {
  // missing-state takes the first slot; one target-size member is material.
  const { project } = await repeatedProject({ maxFindings: 2 });
  const before = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });
  const group = before.groups?.find(
    (candidate) => candidate.category === "target-size",
  );
  expect(group?.members).toHaveLength(4);
  expect(group?.members.some((member) => member.deferred === true)).toBe(true);
  expect(group?.members.some((member) => member.deferred !== true)).toBe(true);

  const result = await decideCommand({
    project,
    group: group?.id,
    reject: true,
    scope: "rule",
    reason: "decorative toolbar, covered by a larger hit area",
  });
  expect(result.rejected).toBe(4);
  const decisions = await readDecisionLog(project);
  expect(decisions.map((decision) => decision.findingId).sort()).toEqual(
    group?.members.map((member) => member.id).sort(),
  );
  const stored = (await readGroups(before.runDirectory))?.find(
    (candidate) => candidate.id === group?.id,
  );
  const fingerprints = new Set(
    stored?.members.map((member) => member.fingerprint),
  );
  expect(fingerprints.size).toBe(4);
  for (const decision of decisions)
    expect(fingerprints.has(decision.fingerprint)).toBe(true);

  const after = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });
  expect(
    after.groups?.filter((candidate) => candidate.category === "target-size"),
  ).toEqual([]);
}, 30_000);

test("a decision on one member still suppresses only that member, under its existing id", async () => {
  const { project } = await repeatedProject();
  const before = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });
  const group = before.groups?.find(
    (candidate) => candidate.category === "target-size",
  );
  const member = group?.members[0];
  await decideCommand({
    project,
    finding: member?.id,
    reject: true,
    scope: "rule",
  });

  const after = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });
  const regrouped = after.groups?.find(
    (candidate) => candidate.category === "target-size",
  );
  expect(regrouped?.id).toBe(group?.id);
  expect(regrouped?.members).toHaveLength(3);
  expect(regrouped?.coordinates).toHaveLength(6);
  expect(regrouped?.members.map((candidate) => candidate.id)).not.toContain(
    member?.id,
  );
  expect(regrouped?.members.map((candidate) => candidate.id).sort()).toEqual(
    group?.members
      .filter((candidate) => candidate.id !== member?.id)
      .map((candidate) => candidate.id)
      .sort(),
  );
}, 30_000);

test("decide rejects --finding with --group and unknown group ids", async () => {
  const { project } = await repeatedProject();
  await checkCommand({ all: true, project, flow: "studio", from: "run" });
  await expect(
    decideCommand({
      project,
      finding: "finding-1",
      group: "group-000000000000",
      reject: true,
    }),
  ).rejects.toThrow("provide only one of --finding or --group");
  await expect(
    decideCommand({ project, group: "group-000000000000", reject: true }),
  ).rejects.toThrow('unknown group id "group-000000000000"');
}, 30_000);

const finding = (overrides: Partial<Finding>): Finding =>
  findingSchema.parse({
    id: "finding-1",
    fingerprint: "a".repeat(64),
    createdAt: "2026-10-23T00:00:00.000Z",
    commit: "c".repeat(40),
    flow: "studio",
    state: "editor",
    viewport: "mobile",
    layer: "deterministic",
    category: "target-size",
    rule: "target-size",
    severity: "minor",
    confidence: 1,
    status: "open",
    explanation: "Too small.",
    evidence: { screenshots: [], artifacts: [] },
    acceptance: ["It is big enough."],
    verification: {
      kind: "deterministic-check",
      check: "target-size",
      params: {},
    },
    ...overrides,
  });

test("a group's severity is its worst member; groups rank by severity, then coordinate count", () => {
  const groups = groupRepeatedFindings(
    [
      finding({
        id: "finding-1",
        fingerprint: "1".repeat(64),
        groupKey: "small",
      }),
      finding({
        id: "finding-2",
        fingerprint: "2".repeat(64),
        groupKey: "wide",
        state: "editor",
      }),
      finding({
        id: "finding-3",
        fingerprint: "3".repeat(64),
        groupKey: "wide",
        state: "preview",
      }),
      finding({
        id: "finding-4",
        fingerprint: "4".repeat(64),
        groupKey: "mixed",
        state: "editor",
      }),
      finding({
        id: "finding-5",
        fingerprint: "5".repeat(64),
        groupKey: "mixed",
        state: "preview",
        severity: "major",
      }),
    ],
    new Map(),
  );
  expect(groups.map((group) => group.key)).toEqual(["mixed", "wide", "small"]);
  expect(groups[0]?.severity).toBe("major");
  expect(groups[0]?.representative).toBe("finding-4");
  for (const group of groups) expect(group.id).toMatch(/^group-[0-9a-f]{12}$/);
}, 30_000);
