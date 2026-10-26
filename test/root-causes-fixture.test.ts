import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run as runCli } from "../src/cli.js";
import { checkCommand, renderCheckSummary } from "../src/commands/check.js";
import { collapseIssues } from "../src/review/issues.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { baselineProject, storedBaselineRun } from "./baseline-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * Three inputs reference an undefined --control-scale for radius, padding
 * and shadow (falling back on 4px, 6px and a heavy ring) beside six buttons
 * on the defined tokens. A header help link is undersized and a footer link
 * is a placeholder: two unrelated defects.
 */
async function brokenTokenProject() {
  const setup = await baselineProject({ maxFindings: 5 });
  directories.push(setup.project);
  const config = JSON.parse(await readFile(setup.configPath, "utf8"));
  config.checks = {
    ...(config.checks ?? {}),
    scales: { spacing: [4, 8, 12, 16, 24] },
  };
  await writeFile(setup.configPath, JSON.stringify(config));
  const html = await readFile(
    join(import.meta.dirname, "fixtures/root-causes/broken-token.html"),
    "utf8",
  );
  await storedBaselineRun(setup.project, "run", setup.commit, [{ html }]);
  return setup.project;
}

test("one broken token yields one root-cause issue across radius, spacing and shadow; unrelated defects stay separate", async () => {
  const project = await brokenTokenProject();
  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
  });
  const findings = findingSchema
    .array()
    .parse(
      JSON.parse(
        await readFile(join(summary.runDirectory, "findings.json"), "utf8"),
      ),
    );
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const issues = summary.issues ?? [];
  const causes = issues.filter((issue) => issue.rootCause !== undefined);
  expect(causes).toHaveLength(1);
  const [issue] = causes;
  const cause = issue?.rootCause;
  expect(cause).toMatchObject({
    kind: "token",
    key: "--control-scale",
    confidence: 0.9,
    counts: { symptoms: 3, findings: 3 },
  });
  expect(cause?.cause).toMatch(
    /^`--control-scale` is not applied: 3 controls fall back on /,
  );
  expect(cause?.fix).toContain("Define `--control-scale`");
  expect(cause?.evidence.join("\n")).toContain("unresolved on every element");
  const symptoms = (cause?.symptoms ?? []).map((symptom) => {
    const finding = byId.get(symptom.findings[0]?.id ?? "") as Finding;
    return `${symptom.rule}:${finding.verification.params?.property}`;
  });
  expect(symptoms.sort()).toEqual([
    "idiom:off-scale-spacing:spacing",
    "idiom:scale-outlier:radius",
    "idiom:scale-outlier:shadow",
  ]);
  // The root-cause issue id is still a group id, and leads its own groups.
  expect(issue?.id).toBe(issue?.groups[0]);
  expect(issue?.explanation.breadth).toBeGreaterThan(1);

  // The two unrelated defects stay separate, plain issues.
  const rest = issues.filter((candidate) => candidate.rootCause === undefined);
  expect(rest.map((candidate) => candidate.category).sort()).toEqual([
    "dead-affordance",
    "target-size",
  ]);

  // Findings and groups are untouched; every group still belongs to one issue.
  expect(summary.findings).toHaveLength(5);
  expect(summary.groups).toHaveLength(5);
  const withoutCauses = collapseIssues(summary.groups ?? [], new Set());
  expect(issues.flatMap((candidate) => candidate.groups).sort()).toEqual(
    withoutCauses.flatMap((candidate) => candidate.groups).sort(),
  );
  for (const symptom of cause?.symptoms ?? [])
    for (const finding of symptom.findings) {
      expect(finding.fingerprint).toBe(byId.get(finding.id)?.fingerprint);
      expect(finding.status).toBe("open");
    }

  const text = renderCheckSummary(summary);
  expect(text).toMatch(/^1\. \[minor\] root cause — `--control-scale`/m);
  expect(text).toContain("Confidence: 0.9 (token --control-scale)");
  expect(text).toContain("Symptoms (3; 3 findings):");
  expect(text).toContain("Done when: every symptom above clears on recheck.");
  expect(text).not.toContain("Symptom: [");

  const all = renderCheckSummary(summary, { all: true });
  const blocks = all
    .split("\n\n")
    .filter((block) => block.trimStart().startsWith("Symptom: ["));
  expect(blocks).toHaveLength(3);
  for (const block of blocks)
    expect(block).toMatch(/Decide: idiom decide --(finding|group) /);
}, 60_000);

test("--json carries every symptom's finding id and fingerprint, and --emit-tickets writes one ticket per cause", async () => {
  const project = await brokenTokenProject();
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
  const cause = json.issues.find(
    (issue: { rootCause?: unknown }) => issue.rootCause !== undefined,
  ).rootCause as {
    symptoms: Array<{ findings: Array<{ id: string; fingerprint: string }> }>;
  };
  const symptomFindings = cause.symptoms.flatMap((symptom) => symptom.findings);
  expect(symptomFindings).toHaveLength(3);
  for (const finding of symptomFindings)
    expect(json.findings).toContainEqual(
      expect.objectContaining({ id: finding.id }),
    );
  expect(symptomFindings.every((finding) => finding.fingerprint !== "")).toBe(
    true,
  );
  expect(json.findings).toHaveLength(5);

  const summary = await checkCommand({
    all: true,
    project,
    flow: "studio",
    from: "run",
    emitTickets: join(project, "proposals"),
  });
  const created = summary.tickets?.outcomes.filter(
    (outcome) => outcome.kind === "created",
  );
  // One ticket for the cause, one per unrelated defect.
  expect(created).toHaveLength(3);
  const causeTicket = created?.find(
    (outcome) => outcome.kind === "created" && outcome.findingIds.length === 3,
  );
  expect(causeTicket).toBeDefined();
  const body = await readFile(
    causeTicket?.kind === "created" ? causeTicket.path : "",
    "utf8",
  );
  expect(body).toContain(
    'title = "Resolve root cause: `--control-scale` is not applied',
  );
  expect(body).toContain(
    "- [ ] All 3 symptoms below clear on recheck (one fix for the shared cause)",
  );
  expect(body).toContain('Root cause key: "token:--control-scale"');
}, 60_000);
