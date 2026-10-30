import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  type CritiqueInput,
  critiqueResult,
  type ModelFindingCandidate,
} from "../src/critique/types.js";
import { createQuickConfiguration } from "../src/quick/config.js";
import { runPageReview } from "../src/review/page.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const fixtures = join(import.meta.dirname, "fixtures/page-review");
const directories: string[] = [];
let server: Server;
let origin: string;

beforeAll(async () => {
  const pages = {
    "/before": await readFile(join(fixtures, "before.html"), "utf8"),
    "/after": await readFile(join(fixtures, "after.html"), "utf8"),
    "/divs":
      '<!doctype html><html><body><div id="root"><div style="min-height:400px"><h1>Launchpad</h1><p>Launch in 3 days.</p></div></div></body></html>',
  } as Record<string, string>;
  server = createServer((request, response) => {
    const body = pages[request.url ?? ""];
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "text/html; charset=utf-8",
    });
    response.end(body ?? "missing");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-page-review-"));
  directories.push(directory);
  return directory;
}

const stubClaim: ModelFindingCandidate = {
  category: "unsupported-claim",
  severity: "major",
  confidence: 0.7,
  rule: "Brief: every statistic must come from the brief",
  selectorHint: "section.hero p",
  state: "page-1",
  viewport: "desktop",
  screenshots: ["page-1/desktop"],
  references: [],
  explanation: 'The hero claims "87% faster launches"; the brief has none.',
  suggestedArea: "hero",
  acceptance: ["The hero states only figures from the brief."],
  section: "s1",
  citations: [
    {
      source: "brief",
      line: 3,
      excerpt: "Launch in 3 days for $49/month.",
    },
  ],
  fix: "Replace the claim with the brief's launch promise.",
  focus: "hierarchy",
};

function stub(findings: ModelFindingCandidate[]) {
  const inputs: CritiqueInput[] = [];
  return {
    inputs,
    critique: {
      async critique(input: CritiqueInput) {
        inputs.push(input);
        return critiqueResult({ findings });
      },
    },
  };
}

async function findings(path: string): Promise<Finding[]> {
  return (JSON.parse(await readFile(path, "utf8")) as unknown[]).map((item) =>
    findingSchema.parse(item),
  );
}

test("page review reports deterministic and cited model findings", async () => {
  const directory = await temporaryDirectory();
  const adapter = stub([stubClaim]);
  const result = await runPageReview({
    url: `${origin}/before`,
    brief: join(fixtures, "brief.md"),
    direction: join(fixtures, "direction.md"),
    focus: ["hierarchy"],
    frames: ["Calm, editorial, one accent colour."],
    cwd: directory,
    model: "stub-model",
    maxFindings: 20,
    dependencies: { critique: adapter.critique },
  });
  expect(result.outcome).toEqual({ kind: "full" });
  expect(result.counts.total).toBe(2);
  const input = adapter.inputs[0];
  expect(input?.page?.sections.map((section) => section.role)).toEqual([
    "hero",
    "body",
    "final",
    "footer",
  ]);
  expect(input?.page?.brief?.lines[2]).toBe(
    "Offer: Launchpad builds your product landing page. Launch in 3 days for $49/month.",
  );
  expect(input?.references).toEqual([
    {
      label: "frame-1",
      polarity: "reference",
      kind: "text",
      content: "Calm, editorial, one accent colour.",
    },
  ]);
  expect(input?.decisionObservationAllowance).toBe(0);

  const written = await findings(result.findingsPath);
  const model = written.find((finding) => finding.layer === "model");
  expect(model).toMatchObject({
    category: "unsupported-claim",
    fix: stubClaim.fix,
    focus: "hierarchy",
    evidence: { section: "s1", citations: stubClaim.citations },
  });
  // Focus ranks the model finding first among the major findings.
  expect(written[0]?.layer).toBe("model");
  expect(
    written
      .filter(
        (finding) =>
          finding.category === "page-content" &&
          finding.rule === "idiom:unsupported-claim" &&
          finding.viewport === "desktop",
      )
      .map((finding) => finding.verification.params?.claim)
      .sort(),
  ).toEqual(["12,000+ teams", "87%"]);

  const report = await readFile(result.reportPath, "utf8");
  expect(report).toContain("## Page-review scope");
  expect(report).toContain("Section: s1 (Your landing page, done)");
  expect(report).toContain('Brief L3: "Launch in 3 days for $49/month."');
  expect(report).toContain(`Fix: ${stubClaim.fix}`);
  expect(report).not.toContain("## Unruled decisions");
  const html = await readFile(result.htmlReportPath, "utf8");
  expect(html).toContain("Page-review scope");
  expect(html).toContain("<strong>Fix:</strong>");
}, 60_000);

test("a compliant page yields no page-content findings", async () => {
  const directory = await temporaryDirectory();
  const adapter = stub([]);
  const result = await runPageReview({
    url: `${origin}/after`,
    brief: join(fixtures, "brief.md"),
    cwd: directory,
    model: "stub-model",
    dependencies: { critique: adapter.critique },
  });
  expect(result.outcome).toEqual({ kind: "full" });
  const all = [
    ...(await findings(result.findingsPath)),
    ...result.deferredFindings,
  ];
  expect(all.filter((finding) => finding.category === "page-content")).toEqual(
    [],
  );
}, 60_000);

test("deterministic-only skips the adapter; no model outside a project degrades", async () => {
  const directory = await temporaryDirectory();
  const adapter = stub([stubClaim]);
  const skipped = await runPageReview({
    url: `${origin}/after`,
    cwd: directory,
    out: "deterministic",
    deterministicOnly: true,
    model: "stub-model",
    dependencies: { critique: adapter.critique },
  });
  expect(skipped.outcome).toEqual({ kind: "deterministic-only" });
  expect(adapter.inputs).toEqual([]);
  const degraded = await runPageReview({
    url: `${origin}/after`,
    cwd: directory,
    out: "degraded",
    dependencies: { critique: adapter.critique },
  });
  expect(degraded.outcome).toEqual({
    kind: "degraded",
    reason: "no model configured; pass --model or run inside an Idiom project",
  });
  expect(adapter.inputs).toEqual([]);
}, 60_000);

test("a missing brief fails with the path", async () => {
  const directory = await temporaryDirectory();
  await expect(
    runPageReview({
      url: `${origin}/after`,
      brief: "missing-brief.md",
      cwd: directory,
    }),
  ).rejects.toThrow("cannot read brief missing-brief.md");
});

test("project checks and glossary file reach configured page review", async () => {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, ".idiom"), { recursive: true });
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "Launchpad", framework: "other" },
      server: {
        build: "",
        start: "true",
        readyUrl: `${origin}/`,
        port: 1,
        env: {},
        startupTimeoutMs: 1000,
      },
      viewports: [{ name: "desktop", width: 1440, height: 900 }],
      capture: {
        timezoneId: "UTC",
        locale: "en-US",
        colorScheme: "light",
        reducedMotion: true,
        fullPage: true,
        settleMs: 0,
      },
      design: {},
      model: { provider: "claude-code", model: "project-model" },
      checks: {
        copy: { jargon: [{ term: "founders", preferred: "people" }] },
        primaryRegion: { selector: "main", minShare: 0.5 },
        page: { ctaSelectors: [".button"] },
        bandEdges: {},
        wordBreak: {},
      },
    }),
  );
  await writeFile(
    join(directory, ".idiom/glossary.json"),
    JSON.stringify({
      locale: "en-CA",
      retired: [{ term: "Launchpad", preferred: "Launch studio" }],
    }),
  );
  const adapter = stub([]);
  const result = await runPageReview({
    url: `${origin}/after`,
    cwd: directory,
    dependencies: { critique: adapter.critique },
  });
  expect(result.outcome).toEqual({ kind: "full" });
  const copy = [
    ...(await findings(result.findingsPath)),
    ...result.deferredFindings,
  ].filter((f) => f.category === "copy-lint");
  for (const [rule, term, preferred] of [
    ["idiom:retired-term", "Launchpad", "Launch studio"],
    ["idiom:jargon-in-copy", "founders", "people"],
  ]) {
    expect(
      copy.some(
        (f) =>
          f.rule === rule &&
          f.verification.params?.term === term &&
          f.explanation.includes(preferred ?? ""),
      ),
    ).toBe(true);
  }
  const observations = observationArtifactSchema.parse(
    JSON.parse(
      await readFile(
        join(result.runDirectory, "page-1", "desktop", "observations.json"),
        "utf8",
      ),
    ),
  );
  expect(
    observations.version === 2
      ? observations.selectorMarks?.map((mark) => mark.purpose)
      : [],
  ).toEqual(["primary-region", "cta"]);
  const report = await readFile(result.reportPath, "utf8");
  expect(report).toMatch(/\| page-1 \| desktop \| primary-region \| ran \|/);
  expect(observations).toMatchObject({
    bandEdges: { status: "ran" },
    wordBreaks: { status: "ran" },
  });
  expect(report).toMatch(/\| page-1 \| desktop \| band-edges \| ran \|/);
  expect(report).toMatch(/\| page-1 \| desktop \| word-break \| ran \|/);
}, 60_000);

test("createQuickConfiguration keeps quick defaults and carries page checks", () => {
  const quick = createQuickConfiguration(["https://example.com"]);
  expect(quick.project.checks).toEqual(checksConfigSchema.parse({}));
  expect(quick.flow.id).toBe("quick-review");
  const checks = checksConfigSchema.parse({ page: { ctaSelectors: [".x"] } });
  const page = createQuickConfiguration(["https://example.com"], {
    flowId: "page-review",
    title: "Page review",
    colorSchemes: ["light"],
    statePrefix: "page",
    checks,
  });
  expect(page.project.checks.page?.ctaSelectors).toEqual([".x"]);
  expect(page.project.colorSchemes).toEqual(["light"]);
  expect(page.flow).toMatchObject({
    id: "page-review",
    colorSchemes: ["light"],
  });
});

test("a page with no detected sections is critiqued as one whole-page section", async () => {
  const directory = await temporaryDirectory();
  const adapter = stub([]);
  await runPageReview({
    url: `${origin}/divs`,
    brief: join(fixtures, "brief.md"),
    cwd: directory,
    model: "stub-model",
    dependencies: { critique: adapter.critique },
  });
  expect(adapter.inputs[0]?.page?.sections).toEqual([
    { id: "s0", role: "page", selector: "body" },
  ]);
}, 60_000);

test("page review honors the project fallback unless a provider is explicit", async () => {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, ".idiom"), { recursive: true });
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "Launchpad", framework: "other" },
      server: {
        build: "",
        start: "true",
        readyUrl: `${origin}/`,
        port: 1,
        env: {},
        startupTimeoutMs: 1000,
      },
      viewports: [{ name: "desktop", width: 1440, height: 900 }],
      capture: {},
      design: {},
      model: {
        provider: "claude-code",
        model: "project-model",
        fallback: { provider: "codex", model: "fallback-model" },
      },
    }),
  );
  const calls: Array<{ provider: string; model: string }> = [];
  const createCritiqueAdapter = (options: {
    provider: string;
    model: string;
  }) => {
    calls.push({ provider: options.provider, model: options.model });
    return {
      async critique() {
        if (options.provider === "claude-code")
          throw new Error("claude unavailable");
        return critiqueResult({ findings: [] });
      },
    };
  };

  const configured = await runPageReview({
    url: `${origin}/after`,
    cwd: directory,
    deterministicOnly: false,
    dependencies: { createCritiqueAdapter },
  });
  expect(configured.outcome).toEqual({
    kind: "full",
    fallback: {
      from: "claude-code",
      to: "codex",
      reason: "claude unavailable",
    },
  });
  expect(calls).toEqual([
    { provider: "claude-code", model: "project-model" },
    { provider: "codex", model: "fallback-model" },
  ]);
  expect(await readFile(configured.reportPath, "utf8")).toContain(
    "Model layer completed using fallback provider codex after claude-code failed: claude unavailable.",
  );

  calls.length = 0;
  const explicitCodex = await runPageReview({
    url: `${origin}/after`,
    cwd: directory,
    provider: "codex",
    dependencies: { createCritiqueAdapter },
  });
  expect(explicitCodex.outcome).toEqual({ kind: "full" });
  expect(calls).toEqual([{ provider: "codex", model: "project-model" }]);

  calls.length = 0;
  const explicitClaude = await runPageReview({
    url: `${origin}/after`,
    cwd: directory,
    provider: "claude-code",
    dependencies: { createCritiqueAdapter },
  });
  expect(explicitClaude.outcome).toEqual({
    kind: "degraded",
    reason: "claude unavailable",
  });
  expect(calls).toEqual([{ provider: "claude-code", model: "project-model" }]);
});
