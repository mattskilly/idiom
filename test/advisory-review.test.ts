import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { run } from "../src/cli.js";
import {
  type CritiqueInput,
  critiqueResult,
  type ModelFindingCandidate,
} from "../src/critique/types.js";
import type { AdvisoryReview } from "../src/review/advisory.js";
import { runReview } from "../src/review/run.js";
import type { Finding } from "../src/schemas/finding.js";
import { reviewFixture } from "./benchmark-support.js";
import { storedRun, studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const runId = "2026-10-24T12-00-00-000Z";
const fixtures = join(import.meta.dirname, "fixtures", "advisory");
const page = (name: string) => readFile(join(fixtures, name), "utf8");

const intents = {
  "carousel-cards":
    "A section heading introduces a row of equal cards; the heading sits clearly apart from the cards.",
  "logo-marquee":
    "A marquee of customer logos that reads as social proof at a glance.",
};

// A 1×1 PNG: enough for a managed reference entry.
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function managedReference(project: string, name: string) {
  const directory = join(project, ".idiom", "references", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "image.png"), tinyPng);
  await writeFile(
    join(directory, "reference.json"),
    JSON.stringify({
      version: 1,
      name,
      note: "The approved carousel layout.",
      image: "image.png",
      mediaType: "image/png",
      sourceKind: "file",
      source: "design/carousel.png",
    }),
  );
}

async function writeFlow(project: string, content: unknown | undefined) {
  await writeFile(
    join(project, ".idiom", "flows", "studio-lab.json"),
    JSON.stringify({
      id: "studio-lab",
      title: "Studio",
      intent: ["Marketing patterns"],
      setup: [],
      viewports: ["desktop"],
      states: ["carousel-cards", "logo-marquee"].map((state) => ({
        id: state,
        description: state,
        url: `/lab/${state}`,
        expect: { status: 200 },
      })),
      ...(content === undefined ? {} : { content }),
    }),
  );
}

const declaredContent = {
  patterns: [
    {
      id: "carousel-cards",
      state: "carousel-cards",
      intent: intents["carousel-cards"],
    },
    {
      id: "logo-marquee",
      state: "logo-marquee",
      intent: intents["logo-marquee"],
    },
  ],
};

async function advisoryProject(
  options: { content?: unknown | null; states?: string[] } = {},
) {
  const { project, commit } = await studioProject(directories, [
    "carousel-cards",
    "logo-marquee",
  ]);
  await writeFlow(
    project,
    options.content === null ? undefined : (options.content ?? declaredContent),
  );
  await managedReference(project, "carousel-cards");
  const states = options.states ?? ["carousel-cards", "logo-marquee"];
  await storedRun(
    project,
    runId,
    commit,
    await Promise.all(
      states.map(async (state) => ({
        state,
        html: "",
        content: await page(`${state}.html`),
      })),
    ),
  );
  return project;
}

/** The stubbed provider's answer for each pattern it is told about. */
function patternFinding(input: CritiqueInput): ModelFindingCandidate[] {
  const pattern = input.page?.pattern?.id;
  const screenshot = input.screenshots[0];
  const section = input.page?.sections[0]?.id ?? "s0";
  if (screenshot === undefined) return [];
  const base = {
    severity: "major" as const,
    confidence: 0.8,
    state: screenshot.state,
    viewport: screenshot.viewport,
    screenshots: [screenshot.label],
    references: [],
    section,
  };
  if (pattern === "carousel-cards")
    return [
      {
        ...base,
        category: "hierarchy",
        aspect: "spacing",
        rule: `Pattern intent: ${intents["carousel-cards"]}`,
        selectorHint: "carousel heading",
        explanation:
          "The section heading sits 0px above the card row, so it reads as part of the first card.",
        suggestedArea: "carousel section",
        acceptance: ["The heading has a clear gap above the card row."],
        fix: "Add the section heading gap between the heading and the card row.",
      },
    ];
  if (pattern === "logo-marquee")
    return [
      {
        ...base,
        category: "generic-pattern",
        aspect: "coherence",
        rule: `Pattern intent: ${intents["logo-marquee"]}`,
        selectorHint: "logo track",
        explanation:
          "The grey dashed boxes labelled Logo read as broken thumbnails, not customer logos.",
        suggestedArea: "logo bar",
        acceptance: ["Every logo slot shows a real wordmark or mark."],
        fix: "Replace the placeholder boxes with the customers' logo images.",
      },
    ];
  return [];
}

function stub(options: { failFor?: string } = {}) {
  const inputs: CritiqueInput[] = [];
  return {
    inputs,
    critique: {
      async critique(input: CritiqueInput) {
        inputs.push(input);
        if (
          options.failFor !== undefined &&
          input.page?.pattern?.id === options.failFor
        )
          throw new Error("provider exploded");
        // The main flow critique (no pattern) returns nothing.
        return critiqueResult({ findings: patternFinding(input) });
      },
    },
  };
}

let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

test("on current main no rule catches a heading touching its cards or a placeholder-logo marquee", async () => {
  for (const name of ["carousel-cards.html", "logo-marquee.html"]) {
    for (const checks of [{}, { page: {} }]) {
      const findings = await reviewFixture(browser, await page(name), {
        checks,
      });
      expect(
        findings.map(({ candidate }) => candidate.category).sort(),
        `${name} ${JSON.stringify(checks)}`,
      ).toEqual(["heading-structure"]);
    }
  }
}, 60_000);

test("review critiques each declared pattern with its intent and keeps the results advisory", async () => {
  const project = await advisoryProject();
  const { inputs, critique } = stub();
  const result = await runReview({
    project,
    flow: "studio-lab",
    from: runId,
    dependencies: { critique },
  });
  const patternInputs = inputs.filter(
    (input) => input.page?.pattern !== undefined,
  );
  expect(patternInputs.map((input) => input.page?.pattern?.id)).toEqual([
    "carousel-cards",
    "logo-marquee",
  ]);
  const [carousel, marquee] = patternInputs;
  expect(carousel?.screenshots.map((item) => item.label)).toEqual([
    "carousel-cards/desktop",
  ]);
  expect(marquee?.screenshots.map((item) => item.label)).toEqual([
    "logo-marquee/desktop",
  ]);
  expect(carousel?.page?.pattern).toEqual({
    id: "carousel-cards",
    intent: intents["carousel-cards"],
    reference: "reference:carousel-cards",
    aspects: ["spacing", "hierarchy", "coherence"],
  });
  expect(marquee?.page?.pattern?.reference).toBeUndefined();
  expect(marquee?.page?.pattern?.intent).toBe(intents["logo-marquee"]);
  for (const input of patternInputs) {
    expect(input.page?.sections.length).toBeGreaterThan(0);
    expect(input.geometry?.[0]?.rows.length).toBeGreaterThan(0);
    expect(input.decisionObservationAllowance).toBe(0);
    expect(
      input.deterministicFindings.every(
        (finding) => finding.state === input.screenshots[0]?.state,
      ),
    ).toBe(true);
  }

  expect(result.advisory?.path).toBe(
    join(result.runDirectory, "advisory.json"),
  );
  const advisory = JSON.parse(
    await readFile(join(result.runDirectory, "advisory.json"), "utf8"),
  ) as AdvisoryReview;
  expect(advisory.outcome).toEqual({ kind: "full" });
  expect(
    advisory.patterns.map((pattern) => ({
      id: pattern.id,
      status: pattern.status,
      aspects: pattern.findings.map((entry) => entry.aspect),
    })),
  ).toEqual([
    { id: "carousel-cards", status: "ok", aspects: ["spacing"] },
    { id: "logo-marquee", status: "ok", aspects: ["coherence"] },
  ]);
  for (const pattern of advisory.patterns) {
    const entry = pattern.findings[0];
    expect(entry?.section).toMatch(/^s\d+$/);
    expect(entry?.finding.id).toMatch(/^advisory-\d+$/);
    const crop = entry?.finding.evidence.screenshots.find((path) =>
      path.includes("/crops/"),
    );
    expect(crop, pattern.id).toBeDefined();
    await access(join(result.runDirectory, crop as string));
  }

  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("## Advisory design review (does not gate)");
  expect(report).toContain(": spacing (major, advisory)");
  expect(report).toContain(": coherence (major, advisory)");
  expect(report).toContain("read as broken thumbnails");
  const html = await readFile(result.htmlReportPath, "utf8");
  expect(html).toContain("<h2>Advisory design review</h2>");

  const findings = JSON.parse(
    await readFile(result.findingsPath, "utf8"),
  ) as Finding[];
  const all = [...findings, ...result.deferredFindings];
  expect(all.some((finding) => finding.layer === "model")).toBe(false);
  expect(
    result.groups.some((group) =>
      group.members.some((member) => member.id.startsWith("advisory-")),
    ),
  ).toBe(false);
  expect(result.outcome).toEqual({ kind: "full" });
}, 120_000);

test("main findings keep their ids with or without declared content", async () => {
  const withContent = await advisoryProject();
  const withoutContent = await advisoryProject({ content: null });
  const ids = async (project: string) => {
    const result = await runReview({
      project,
      flow: "studio-lab",
      from: runId,
      dependencies: { critique: stub().critique },
    });
    expect(result.advisory === undefined).toBe(project === withoutContent);
    return (
      JSON.parse(await readFile(result.findingsPath, "utf8")) as Finding[]
    ).map((finding) => `${finding.id} ${finding.fingerprint}`);
  };
  expect(await ids(withContent)).toEqual(await ids(withoutContent));
}, 120_000);

test("check --advisory prints the advisory block but never changes the exit code", async () => {
  const project = await advisoryProject();
  const { inputs, critique } = stub();
  const base = [
    "node",
    "idiom",
    "check",
    "--all",
    "studio-lab",
    "--from",
    runId,
    "--project",
    project,
  ];
  const invoke = async (extra: string[]) => {
    const stdout: string[] = [];
    const code = await run([...base, ...extra], {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
      review: { critique },
    });
    return { code, stdout: stdout.join("") };
  };

  const plain = await invoke(["--fail-on", "blocker"]);
  expect(inputs).toHaveLength(0);
  expect(plain.stdout).not.toContain("Advisory design review");

  const advised = await invoke(["--advisory", "--fail-on", "blocker"]);
  expect(advised.code).toBe(plain.code);
  expect(advised.code).toBe(0);
  expect(inputs.map((input) => input.page?.pattern?.id)).toEqual([
    "carousel-cards",
    "logo-marquee",
  ]);
  expect(advised.stdout).toContain(
    "Advisory design review (does not affect the exit code): 2 finding(s) across 2 pattern(s).",
  );
  expect(advised.stdout).toContain("[advisory · spacing] carousel-cards — s");
  expect(advised.stdout).toContain("[advisory · coherence] logo-marquee — s");
  expect(advised.stdout).toMatch(/Evidence: .*crops\/advisory-/);
  const lines = advised.stdout.trimEnd().split("\n");
  if (plain.stdout.includes("Full report: "))
    expect(lines.at(-1)).toMatch(/^Full report: /);

  // A failing gate fails the same way with or without advisory results.
  const strictPlain = await invoke(["--fail-on", "minor"]);
  const strictAdvised = await invoke(["--advisory", "--fail-on", "minor"]);
  expect(strictAdvised.code).toBe(strictPlain.code);

  const json = async (extra: string[]) =>
    JSON.parse(
      (await invoke(["--json", "--fail-on", "never", ...extra])).stdout,
    );
  const withAdvisory = await json(["--advisory"]);
  const without = await json([]);
  expect(withAdvisory.blocking).toBe(without.blocking);
  expect(withAdvisory.findings).toEqual(without.findings);
  expect(without.advisory).toBeUndefined();
  expect(withAdvisory.advisory.outcome).toEqual({ kind: "full" });
  expect(
    withAdvisory.advisory.patterns.map(
      (pattern: { findings: Array<{ aspect: string }> }) =>
        pattern.findings.map((finding) => finding.aspect),
    ),
  ).toEqual([["spacing"], ["coherence"]]);
}, 120_000);

test("a failing pattern degrades only the advisory review", async () => {
  const project = await advisoryProject();
  const { critique } = stub({ failFor: "carousel-cards" });
  const result = await runReview({
    project,
    flow: "studio-lab",
    from: runId,
    dependencies: { critique },
  });
  expect(result.outcome).toEqual({ kind: "full" });
  const review = result.advisory?.review;
  expect(review?.outcome.kind).toBe("degraded");
  expect(review?.patterns.map((pattern) => pattern.status)).toEqual([
    "failed",
    "ok",
  ]);
  expect(review?.patterns[0]?.reason).toContain("provider exploded");
  expect(review?.patterns[1]?.findings).toHaveLength(1);

  const stdout: string[] = [];
  const plain = await run(
    [
      "node",
      "idiom",
      "check",
      "--all",
      "studio-lab",
      "--from",
      runId,
      "--project",
      project,
      "--fail-on",
      "blocker",
    ],
    { stdout: () => undefined, stderr: () => undefined, review: { critique } },
  );
  const advised = await run(
    [
      "node",
      "idiom",
      "check",
      "--all",
      "studio-lab",
      "--from",
      runId,
      "--project",
      project,
      "--fail-on",
      "blocker",
      "--advisory",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
      review: { critique },
    },
  );
  expect(advised).toBe(plain);
  expect(stdout.join("")).toContain("carousel-cards: failed (");
}, 120_000);

test("a pattern whose state is not in the run is skipped", async () => {
  const project = await advisoryProject({ states: ["carousel-cards"] });
  const result = await runReview({
    project,
    flow: "studio-lab",
    from: runId,
    dependencies: { critique: stub().critique },
  });
  expect(
    result.advisory?.review.patterns.map((pattern) => [
      pattern.id,
      pattern.status,
      pattern.reason,
    ]),
  ).toEqual([
    ["carousel-cards", "ok", undefined],
    ["logo-marquee", "skipped", "not captured in this run"],
  ]);
  expect(result.advisory?.review.outcome).toEqual({ kind: "full" });
}, 120_000);

test("a missing explicit reference fails that pattern only", async () => {
  const project = await advisoryProject({
    content: {
      patterns: [
        { ...declaredContent.patterns[0], reference: "nowhere-to-be-found" },
        declaredContent.patterns[1],
      ],
    },
  });
  const result = await runReview({
    project,
    flow: "studio-lab",
    from: runId,
    dependencies: { critique: stub().critique },
  });
  const [carousel, marquee] = result.advisory?.review.patterns ?? [];
  expect(carousel?.status).toBe("failed");
  expect(carousel?.reason).toContain("nowhere-to-be-found");
  expect(marquee?.status).toBe("ok");
}, 120_000);

test("an explicit file reference is sent as a pattern reference", async () => {
  const project = await advisoryProject({
    content: {
      patterns: [
        {
          ...declaredContent.patterns[1],
          reference: "design/logo-bar.md",
        },
      ],
    },
  });
  await mkdir(join(project, "design"), { recursive: true });
  await writeFile(
    join(project, "design", "logo-bar.md"),
    "Logos sit in one row, greyscale, at a shared cap height.\n",
  );
  const { inputs, critique } = stub();
  await runReview({
    project,
    flow: "studio-lab",
    from: runId,
    dependencies: { critique },
  });
  const input = inputs.find((item) => item.page?.pattern !== undefined);
  expect(input?.page?.pattern?.reference).toBe("pattern:logo-marquee");
  expect(input?.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: "pattern:logo-marquee",
        kind: "text",
        content: "Logos sit in one row, greyscale, at a shared cap height.\n",
      }),
    ]),
  );
}, 120_000);

test("deterministic-only review runs no advisory pass and --advisory needs content", async () => {
  const project = await advisoryProject();
  const { inputs, critique } = stub();
  const result = await runReview({
    project,
    flow: "studio-lab",
    from: runId,
    deterministicOnly: true,
    dependencies: { critique },
  });
  expect(inputs).toHaveLength(0);
  expect(result.advisory).toBeUndefined();

  const bare = await advisoryProject({ content: null });
  await expect(
    runReview({
      project: bare,
      flow: "studio-lab",
      from: runId,
      deterministicOnly: true,
      advisory: true,
      dependencies: { critique },
    }),
  ).rejects.toThrow(
    "--advisory needs a flow with a content block declaring patterns",
  );
}, 120_000);
