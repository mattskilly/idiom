import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { renderSweepSummary, sweepCommand } from "../src/commands/sweep.js";
import {
  type CritiqueInput,
  critiqueResult,
  type ModelFindingCandidate,
} from "../src/critique/types.js";
import { runReview } from "../src/review/run.js";
import type { Finding } from "../src/schemas/finding.js";
import { storedRun, studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runId = "2026-10-22T12-00-00-000Z";

async function sweepProject(options: { spec?: string } = {}) {
  const { project, commit } = await studioProject(directories, [
    "editor",
    "preview",
  ]);
  await storedRun(project, runId, commit, [
    { state: "editor", html: "before.html" },
    { state: "preview", html: "after.html" },
  ]);
  if (options.spec !== undefined) {
    await writeFile(join(project, "SPECS.md"), options.spec);
    const path = join(project, ".idiom", "project.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.design.specFile = "SPECS.md";
    await writeFile(path, JSON.stringify(config, null, 2));
  }
  return project;
}

function candidate(
  state: string,
  overrides: Partial<ModelFindingCandidate> = {},
): ModelFindingCandidate {
  return {
    category: "hierarchy",
    severity: "minor",
    confidence: 0.7,
    rule: "DESIGN.md: one primary action per surface",
    selectorHint: "main",
    state,
    viewport: "desktop",
    screenshots: [`${state}/desktop`],
    references: [],
    explanation: "Two buttons compete for primary emphasis.",
    suggestedArea: "editor toolbar",
    acceptance: ["Only one button uses the primary fill."],
    ...overrides,
  };
}

test("sweep critiques each surface with its own screenshots, crops, geometry and the spec", async () => {
  const project = await sweepProject({
    spec: "# Specs\n\nOverride dots are 8×8px.\n",
  });
  const inputs: CritiqueInput[] = [];
  const result = await runReview({
    project,
    flow: "studio-lab",
    from: runId,
    mode: "sweep",
    dependencies: {
      critique: {
        async critique(input) {
          inputs.push(input);
          return critiqueResult({ findings: [] });
        },
      },
    },
  });
  expect(result.outcome).toEqual({ kind: "full" });
  expect(inputs.map((input) => input.screenshots.map((s) => s.label))).toEqual([
    ["editor/desktop"],
    ["preview/desktop"],
  ]);
  for (const input of inputs) {
    expect(input.spec).toEqual({
      file: "SPECS.md",
      content: "# Specs\n\nOverride dots are 8×8px.\n",
    });
    expect(input.crops?.length).toBeGreaterThan(0);
    for (const crop of input.crops ?? []) {
      await access(crop.readPath);
      expect(crop.screenshot).toBe(`${crop.state}/desktop`);
    }
    expect(
      input.deterministicFindings.every(
        (f) => f.state === input.screenshots[0]?.state,
      ),
    ).toBe(true);
  }
  const editor = inputs[0]?.geometry?.[0];
  expect(editor?.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        class: "bp-override-dot",
        name: "Mobile override",
        size: "12×12",
        radius: "full",
      }),
    ]),
  );
  const preview = inputs[1]?.geometry?.[0];
  expect(preview?.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        class: "bp-override-dot",
        name: "Mobile override",
        size: "8×8",
      }),
    ]),
  );
  const sweep = JSON.parse(
    await readFile(join(result.runDirectory, "sweep.json"), "utf8"),
  );
  expect(sweep).toMatchObject({
    flow: "studio-lab",
    spec: "SPECS.md",
    surfaces: [
      { state: "editor", status: "ok" },
      { state: "preview", status: "ok" },
    ],
  });
}, 60_000);

test("without a spec file the sweep sends no spec and rejects spec-mismatch", async () => {
  const project = await sweepProject();
  const inputs: CritiqueInput[] = [];
  const summary = await sweepCommand({
    project,
    flow: "studio-lab",
    from: runId,
    dependencies: {
      critique: {
        async critique(input) {
          inputs.push(input);
          const state = input.screenshots[0]?.state ?? "";
          return critiqueResult({
            findings:
              state === "editor"
                ? [candidate(state, { category: "spec-mismatch" })]
                : [candidate(state)],
          });
        },
      },
    },
  });
  expect(inputs.every((input) => input.spec === undefined)).toBe(true);
  expect(summary.outcome.kind).toBe("degraded");
  expect(summary.outcome.kind === "degraded" && summary.outcome.reason).toMatch(
    /critique failed for 1 of 2 surfaces: editor: .*spec-mismatch/,
  );
  expect(summary.surfaces).toEqual([
    expect.objectContaining({ state: "editor", status: "failed" }),
    expect.objectContaining({ state: "preview", status: "ok" }),
  ]);
  // The failing surface loses its model findings; the other keeps them.
  expect(
    summary.findings.filter((finding) => finding.layer === "model"),
  ).toEqual([expect.objectContaining({ where: "preview/desktop" })]);
  const sweep = JSON.parse(await readFile(summary.sweepPath, "utf8"));
  expect(sweep.surfaces[0]).toMatchObject({
    state: "editor",
    status: "failed",
    reason: expect.stringContaining("spec-mismatch"),
  });
}, 60_000);

test("sweep keeps every finding, ranks severity first and measured before model, and emits tickets", async () => {
  const project = await sweepProject({ spec: "Override dots are 8px.\n" });
  const summary = await sweepCommand({
    project,
    flow: "studio-lab",
    from: runId,
    emitTickets: join(project, "triage"),
    dependencies: {
      critique: {
        async critique(input) {
          const state = input.screenshots[0]?.state ?? "";
          if (state !== "editor") return critiqueResult({ findings: [] });
          return critiqueResult({
            findings: [
              ...["blocker", "major", "minor", "minor", "minor", "minor"].map(
                (severity, index) =>
                  candidate(state, {
                    severity: severity as ModelFindingCandidate["severity"],
                    selectorHint: `.area-${index}`,
                    rule: `DESIGN.md rule ${index}`,
                  }),
              ),
              candidate(state, {
                category: "spec-mismatch",
                severity: "major",
                rule: "SPECS.md: Override dots are 8px.",
                explanation: "Measured 16×16 against the specified 8px.",
                selectorHint: ".bp-override-dot",
              }),
            ],
          });
        },
      },
    },
  });
  expect(summary.outcome).toEqual({ kind: "full" });
  const findings = JSON.parse(
    await readFile(join(summary.runDirectory, "findings.json"), "utf8"),
  ) as Finding[];
  const model = findings.filter((finding) => finding.layer === "model");
  expect(model).toHaveLength(7);
  expect(model.map((finding) => finding.category)).toContain("spec-mismatch");
  const order = { blocker: 0, major: 1, minor: 2 } as const;
  const ranks = summary.findings.map(
    (finding) =>
      order[finding.severity] * 2 + (finding.layer === "model" ? 1 : 0),
  );
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(summary.findings.some((f) => f.layer === "deterministic")).toBe(true);
  expect(summary.tickets?.outcomes.length).toBeGreaterThan(0);
  const text = renderSweepSummary(summary);
  expect(text).toMatch(
    /^idiom sweep studio-lab: \d+ finding\(s\) across 2 surface\(s\), \d+ blocking — deterministic \d+, model 7/,
  );
  expect(text).toContain("[model] spec-mismatch");
  expect(text).toContain("[measured]");
  expect(text).toContain("  editor:");
}, 60_000);

test("sweep refuses deterministic-only and a missing configured spec file", async () => {
  const project = await sweepProject();
  await expect(
    runReview({
      project,
      flow: "studio-lab",
      from: runId,
      mode: "sweep",
      deterministicOnly: true,
    }),
  ).rejects.toThrow(/deterministic-only/);
  const path = join(project, ".idiom", "project.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.design.specFile = "missing/SPECS.md";
  await writeFile(path, JSON.stringify(config, null, 2));
  await expect(
    sweepCommand({ project, flow: "studio-lab", from: runId }),
  ).rejects.toThrow(/design\.specFile "missing\/SPECS\.md"/);
}, 60_000);

test("the sweep CLI renders the ranked list and gates only when asked", async () => {
  const project = await sweepProject();
  const output: string[] = [];
  const review = {
    critique: {
      async critique(input: CritiqueInput) {
        const state = input.screenshots[0]?.state ?? "";
        return critiqueResult({
          findings: [candidate(state, { severity: "major" })],
        });
      },
    },
  };
  const argv = [
    "node",
    "idiom",
    "sweep",
    "studio-lab",
    "--from",
    runId,
    "--project",
    project,
  ];
  const code = await run(argv, {
    stdout: (message) => output.push(message),
    stderr: (message) => output.push(message),
    review,
  });
  expect(code).toBe(0);
  expect(output.join("")).toMatch(
    /idiom sweep studio-lab: \d+ finding\(s\) across 2 surface\(s\)/,
  );
  expect(output.join("")).toContain("[major] [model] hierarchy");
  const gated = await run([...argv, "--fail-on", "major"], {
    stdout: () => undefined,
    stderr: (message) => output.push(message),
    review,
  });
  expect(gated).toBe(1);
  expect(output.join("")).toMatch(
    /sweep failed: \d+ open finding\(s\) at or above major/,
  );
}, 60_000);
