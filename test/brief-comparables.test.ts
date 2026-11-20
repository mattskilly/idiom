import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  type ComparableCapture,
  runComparableResearch,
} from "../src/brief/comparable-research.js";
import {
  type Measurement,
  parseProductComparables,
  proposeCriteria,
  requestTerms,
  selectComparables,
} from "../src/brief/comparables.js";
import { lintCriteria } from "../src/brief/lint.js";
import {
  edgeGap,
  isSignInUrl,
  SignInWallError,
  subjectMeasurements,
} from "../src/brief/measure.js";
import { ReferenceNavigationError } from "../src/capture/browser.js";
import { type ProgramDependencies, run } from "../src/cli.js";
import { initProject, initSummaryLines } from "../src/commands/init.js";
import { loadReferenceContext } from "../src/critique/context.js";
import { INTERFACE_VERSION } from "../src/interface/version.js";
import {
  type BriefReference,
  briefConfigSchema,
  type Project,
  projectSchema,
} from "../src/schemas/project.js";
import { readTemplate } from "../src/templates.js";
import { validateProjectConfiguration } from "../src/validation.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-comparables-"));
  directories.push(directory);
  return directory;
}

const alpha: BriefReference = {
  name: "Alpha",
  tier: "bar",
  note: "a calm document editor",
  url: "https://alpha.example/",
  pages: [
    { surface: "pricing table", url: "https://alpha.example/pricing" },
    {
      surface: "editor selection toolbar",
      url: "https://alpha.example/editor",
    },
  ],
};
const beta: BriefReference = {
  name: "Beta",
  tier: "bar",
  note: "a whiteboard",
  pages: [{ surface: "selection toolbar", url: "https://beta.example/board" }],
};
const gamma: BriefReference = {
  name: "Gamma",
  tier: "floor",
  note: "an older editor with chips",
  url: "https://gamma.example/",
};
const delta: BriefReference = {
  name: "Delta",
  tier: "bar",
  note: "a spreadsheet",
  url: "https://delta.example/",
};

test("PRODUCT.md comparables: pipe grammar, tiers, pages, bad URLs and comments", () => {
  const parsed = parseProductComparables(`# Product

## Comparable products

<!--
- Commented Out | https://nope.example | ignored
-->
- Alpha | https://alpha.example/ | a calm document editor
  - editor selection toolbar | https://alpha.example/editor
  - broken page | not a url
- [always] Beta | the whiteboard everyone compares to
- [floor] Gamma | ftp://gamma.example | legacy
* Delta

## Hard constraints

- Not a comparable | https://x.example | no
`);
  expect(parsed.references).toEqual([
    {
      name: "Alpha",
      tier: "bar",
      note: "a calm document editor",
      url: "https://alpha.example/",
      pages: [
        {
          surface: "editor selection toolbar",
          url: "https://alpha.example/editor",
        },
      ],
    },
    {
      name: "Beta",
      tier: "always",
      note: "the whiteboard everyone compares to",
    },
    { name: "Gamma", tier: "floor", note: "legacy" },
    { name: "Delta", tier: "bar", note: "listed in PRODUCT.md" },
  ]);
  expect(parsed.warnings).toHaveLength(2);
  expect(parsed.warnings[0]).toContain("broken page");
  expect(parsed.warnings[1]).toContain("ftp://gamma.example");
  expect(
    briefConfigSchema.safeParse({ references: parsed.references }).success,
  ).toBe(true);
});

test("the template's Comparable products section seeds nothing", async () => {
  const parsed = parseProductComparables(await readTemplate("PRODUCT.md"));
  expect(parsed).toEqual({ references: [], warnings: [] });
});

test("request terms drop stopwords, singularize and dedupe in order", () => {
  expect(
    requestTerms("Add the selection toolbar offset chips to the toolbar"),
  ).toEqual(["selection", "toolbar", "offset", "chip"]);
});

test("selection ranks page-surface matches, names the matched words and picks the page", () => {
  const { selections, warnings } = selectComparables(
    [delta, gamma, beta, alpha],
    "selection toolbar offset chip",
  );
  expect(warnings).toEqual([]);
  expect(selections.map((selection) => selection.name)).toEqual([
    "Beta",
    "Alpha",
    "Gamma",
  ]);
  expect(selections[0]?.page).toEqual({
    url: "https://beta.example/board",
    surface: "selection toolbar",
  });
  expect(selections[0]?.reason).toBe(
    'tier bar; its page "selection toolbar" matches selection, toolbar',
  );
  expect(selections[1]?.page?.url).toBe("https://alpha.example/editor");
  expect(selections[2]?.reason).toBe(
    "tier floor; its name or note matches chip",
  );
  expect(selections[2]?.page).toEqual({ url: "https://gamma.example/" });
});

test("always-tier comes first, at most three, and too few matches fill to two", () => {
  const always = { ...delta, name: "Always", tier: "always" };
  const capped = selectComparables(
    [alpha, beta, gamma, always],
    "selection toolbar chip",
  );
  expect(capped.selections.map((selection) => selection.name)).toEqual([
    "Always",
    "Alpha",
    "Beta",
  ]);
  expect(capped.selections[0]?.reason).toMatch(/^tier always/);

  const filled = selectComparables([delta, gamma], "pricing tiers");
  expect(filled.selections.map((selection) => selection.name)).toEqual([
    "Delta",
    "Gamma",
  ]);
  expect(filled.selections[1]?.reason).toBe(
    "tier floor; no request words matched, filled to reach 2 comparables",
  );
});

test("a single comparable warns, none asks for the list, no URL means no public page", () => {
  const single = selectComparables(
    [{ name: "Solo", tier: "bar", note: "solo" }],
    "toolbar",
  );
  expect(single.warnings[0]).toContain("list at least 2");
  expect(single.selections[0]?.page).toBeUndefined();
  expect(() => selectComparables([], "toolbar")).toThrow(
    /no comparable products are listed.*Comparable products/,
  );
});

test("edge gaps: disjoint, diagonal, overlapping and contained", () => {
  const a = { x: 0, y: 0, width: 100, height: 40 };
  expect(edgeGap(a, { x: 108, y: 0, width: 20, height: 20 })).toBe(8);
  expect(edgeGap(a, { x: 10, y: 52, width: 20, height: 20 })).toBe(12);
  expect(edgeGap(a, { x: 103, y: 44, width: 10, height: 10 })).toBe(5);
  expect(edgeGap(a, { x: 90, y: 30, width: 20, height: 20 })).toBe(0);
  expect(edgeGap(a, { x: 6, y: 10, width: 20, height: 20 })).toBe(6);
  expect(edgeGap({ x: 6, y: 10, width: 20, height: 20 }, a)).toBe(6);
});

test("subject measurements name the smaller element first in a pair gap", () => {
  const measurements = subjectMeasurements(
    [
      {
        name: "selection toolbar",
        selector: ".selection-toolbar",
        box: { x: 0, y: 40, width: 320, height: 40 },
        radius: 8,
        fontSize: 14,
        duration: 150,
      },
      {
        name: "offset chip",
        selector: ".offset-chip",
        box: { x: 0, y: 0, width: 60, height: 24 },
      },
    ],
    { url: "https://alpha.example/editor", viewport: "desktop" },
  );
  expect(measurements[0]).toMatchObject({
    subject: "offset chip to selection toolbar",
    property: "gap",
    value: 16,
    selector: ".offset-chip → .selection-toolbar",
  });
  expect(
    measurements.map((m) => `${m.subject} ${m.property} ${m.value}${m.unit}`),
  ).toEqual([
    "offset chip to selection toolbar gap 16px",
    "selection toolbar width 320px",
    "selection toolbar height 40px",
    "selection toolbar radius 8px",
    "selection toolbar font size 14px",
    "selection toolbar duration 150ms",
    "offset chip width 60px",
    "offset chip height 24px",
  ]);
});

function measurement(
  subject: string,
  property: Measurement["property"],
  value: number,
  unit: "px" | "ms" = "px",
): Measurement {
  return {
    subject,
    property,
    value,
    unit,
    selector: ".x",
    url: "https://x.example/",
    viewport: "desktop",
  };
}

test("criteria take floor and cap across references, widen a single value, and pass lint", () => {
  const criteria = proposeCriteria([
    {
      comparable: "Alpha",
      reference: "reference:alpha-selection-toolbar",
      measurements: [
        measurement("selection toolbar", "width", 320),
        measurement("offset chip to selection toolbar", "gap", 6),
        measurement("selection toolbar", "duration", 150, "ms"),
      ],
    },
    {
      comparable: "Beta",
      reference: "reference:beta-selection-toolbar",
      measurements: [
        measurement("selection toolbar", "width", 360),
        measurement("selection toolbar to offset chip", "gap", 12),
      ],
    },
  ]);
  expect(criteria.map((criterion) => criterion.text)).toEqual([
    "Offset chip to selection toolbar gap is at least 6px and at most 12px (Alpha 6px, reference:alpha-selection-toolbar; Beta 12px, reference:beta-selection-toolbar).",
    "Selection toolbar width is at least 320px and at most 360px (Alpha 320px, reference:alpha-selection-toolbar; Beta 360px, reference:beta-selection-toolbar).",
    "Selection toolbar duration is at least 135ms and at most 165ms (Alpha 150ms, reference:alpha-selection-toolbar; one reference, ±10%).",
  ]);
  expect(criteria[2]).toMatchObject({ floor: 135, cap: 165, widened: true });
  expect(
    lintCriteria(
      criteria.map((criterion, index) => ({
        text: criterion.text,
        line: index + 1,
      })),
    ),
  ).toEqual([]);
  // A tiny single value still widens by at least 1.
  expect(
    proposeCriteria([
      {
        comparable: "Alpha",
        reference: "reference:a",
        measurements: [measurement("chip", "radius", 4)],
      },
    ])[0],
  ).toMatchObject({ floor: 3, cap: 5 });
});

test("sign-in URLs are recognized by host or path segment", () => {
  expect(isSignInUrl("https://example.com/login?next=/editor")).toBe(true);
  expect(isSignInUrl("https://auth.example.com/")).toBe(true);
  expect(isSignInUrl("https://example.com/users/sign-in")).toBe(true);
  expect(isSignInUrl("https://example.com/editor")).toBe(false);
  expect(isSignInUrl("https://example.com/authors")).toBe(false);
});

function testProject(references: BriefReference[]): Project {
  return projectSchema.parse({
    version: 1,
    app: { name: "comparables", framework: "other" },
    server: {
      build: "true",
      start: "true",
      readyUrl: "http://127.0.0.1:3000/",
      port: 3000,
      env: {},
    },
    viewports: [{ name: "desktop", width: 1280, height: 800 }],
    capture: { settleMs: 0 },
    design: {},
    brief: { references },
    model: { provider: "anthropic", model: "unused" },
  });
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fakeCapture(
  gaps: Record<string, number>,
  failures: Record<string, Error> = {},
): ComparableCapture {
  return async ({ url, viewport }) => {
    const failure = failures[url];
    if (failure !== undefined) throw failure;
    return {
      image: png,
      measurements: [
        {
          subject: "offset chip to selection toolbar",
          property: "gap",
          value: gaps[url] ?? 0,
          unit: "px",
          selector: ".offset-chip → .selection-toolbar",
          url,
          viewport: viewport.name,
        },
      ],
      unmatched: [],
    };
  };
}

test("research stores each capture as a managed reference the reviewer reads, and reports sign-in walls", async () => {
  const directory = await temporary();
  const project = testProject([alpha, beta, gamma]);
  const run = () =>
    runComparableResearch({
      projectDirectory: directory,
      project,
      cwd: directory,
      request: "selection toolbar offset chip",
      dependencies: {
        now: () => new Date("2026-11-16T09:00:00Z"),
        captureComparable: fakeCapture(
          {
            "https://alpha.example/editor": 8,
            "https://beta.example/board": 12,
          },
          {
            "https://gamma.example/": new SignInWallError(),
          },
        ),
      },
    });
  const result = await run();
  expect(result.comparables.map((c) => [c.name, c.status])).toEqual([
    ["Alpha", "captured"],
    ["Beta", "captured"],
    ["Gamma", "not-reachable"],
  ]);
  expect(result.comparables[2]?.notReachable).toBe(
    "sign-in required; not logged into",
  );
  expect(result.comparables[1]?.reference).toEqual({
    label: "reference:beta-selection-toolbar",
    name: "beta-selection-toolbar",
    source: "https://beta.example/board",
    capturedAt: "2026-11-16T09:00:00.000Z",
    viewport: { name: "desktop", width: 1280, height: 800 },
  });
  expect(result.criteria.map((criterion) => criterion.text)).toEqual([
    "Offset chip to selection toolbar gap is at least 8px and at most 12px (Alpha 8px, reference:alpha-editor-selection-toolbar; Beta 12px, reference:beta-selection-toolbar).",
  ]);
  const stored = JSON.parse(
    await readFile(
      join(
        directory,
        ".idiom",
        "references",
        "alpha-editor-selection-toolbar",
        "reference.json",
      ),
      "utf8",
    ),
  );
  expect(stored).toMatchObject({
    sourceKind: "url",
    source: "https://alpha.example/editor",
    capturedAt: "2026-11-16T09:00:00.000Z",
    viewport: { name: "desktop" },
  });
  expect(stored.note).toContain(
    'Comparable for "selection toolbar offset chip"',
  );
  expect(stored.note).toContain(
    "offset chip to selection toolbar gap 8px (.offset-chip → .selection-toolbar)",
  );
  const context = await loadReferenceContext(directory);
  expect(context.map((entry) => entry.label)).toEqual([
    "reference:alpha-editor-selection-toolbar",
    "reference:beta-selection-toolbar",
  ]);
  expect(context[0]).toMatchObject({
    note: stored.note,
    source: "https://alpha.example/editor",
  });

  // A second run never overwrites: names are suffixed.
  const again = await run();
  expect(again.comparables[0]?.reference?.name).toBe(
    "alpha-editor-selection-toolbar-2",
  );
});

test("an HTTP 401 is a sign-in wall and other failures keep their message; nothing is stored", async () => {
  const directory = await temporary();
  const result = await runComparableResearch({
    projectDirectory: directory,
    project: testProject([delta, gamma]),
    cwd: directory,
    request: "toolbar",
    dependencies: {
      captureComparable: fakeCapture(
        {},
        {
          "https://delta.example/": new ReferenceNavigationError(
            "navigation returned HTTP 401",
            401,
          ),
          "https://gamma.example/": new ReferenceNavigationError(
            "navigation returned HTTP 500",
            500,
          ),
        },
      ),
    },
  });
  expect(result.comparables.map((c) => c.notReachable)).toEqual([
    "sign-in required; not logged into",
    "navigation returned HTTP 500",
  ]);
  expect(result.criteria).toEqual([]);
  expect(result.warnings.at(-1)).toContain("no comparable could be captured");
  expect(await loadReferenceContext(directory)).toEqual([]);
});

test("with no configured list, research reads PRODUCT.md, and with neither it asks for one", async () => {
  const directory = await temporary();
  const project = testProject([]);
  const options = {
    projectDirectory: directory,
    project,
    cwd: directory,
    request: "selection toolbar",
    dependencies: { captureComparable: fakeCapture({}) },
  };
  await expect(runComparableResearch(options)).rejects.toThrow(
    /no comparable products are listed/,
  );
  await writeFile(
    join(directory, "PRODUCT.md"),
    "## Comparable products\n\n- Alpha | https://alpha.example/ | calm\n- Beta | https://beta.example/ | busy\n",
  );
  const result = await runComparableResearch(options);
  expect(result.listSource).toBe("product");
  expect(result.comparables.map((c) => c.status)).toEqual([
    "captured",
    "captured",
  ]);
});

test("init seeds brief.references from an existing PRODUCT.md, and only then", async () => {
  const directory = await temporary();
  await writeFile(
    join(directory, "PRODUCT.md"),
    "# Product\n\n## Comparable products\n\n- Alpha | https://alpha.example/ | calm editor\n  - selection toolbar | https://alpha.example/editor\n- [always] Beta | busy whiteboard\n",
  );
  const result = await initProject({ project: directory, yes: true });
  expect(result.seededComparables).toBe(2);
  expect(initSummaryLines(result)).toContain(
    "Seeded 2 comparable product(s) from PRODUCT.md into brief.references.",
  );
  const { project } = await validateProjectConfiguration({
    project: directory,
  });
  expect(project.brief?.references).toEqual([
    {
      name: "Alpha",
      tier: "bar",
      note: "calm editor",
      url: "https://alpha.example/",
      pages: [
        { surface: "selection toolbar", url: "https://alpha.example/editor" },
      ],
    },
    { name: "Beta", tier: "always", note: "busy whiteboard" },
  ]);
  const rerun = await initProject({ project: directory, yes: true });
  expect(rerun.unchanged).toContain(join(".idiom", "project.json"));
  expect(rerun.seededComparables).toBeUndefined();

  const plain = await temporary();
  const fresh = await initProject({ project: plain, yes: true });
  expect(fresh.seededComparables).toBeUndefined();
  const { project: unseeded } = await validateProjectConfiguration({
    project: plain,
  });
  expect(unseeded.brief?.references).toEqual([]);
});

test("init leaves an existing project.json untouched", async () => {
  const directory = await temporary();
  await initProject({ project: directory, yes: true });
  const before = await readFile(
    join(directory, ".idiom", "project.json"),
    "utf8",
  );
  await writeFile(
    join(directory, "PRODUCT.md"),
    "## Comparable products\n\n- Alpha | https://alpha.example/ | calm\n",
  );
  const result = await initProject({ project: directory, yes: true });
  expect(result.seededComparables).toBeUndefined();
  expect(result.skipped).toContain(join(".idiom", "project.json"));
  expect(
    await readFile(join(directory, ".idiom", "project.json"), "utf8"),
  ).toBe(before);
});

test("brief references accept pages and reject a malformed page URL", () => {
  expect(briefConfigSchema.safeParse({ references: [alpha] }).success).toBe(
    true,
  );
  expect(
    briefConfigSchema.safeParse({
      references: [
        { ...alpha, pages: [{ surface: "toolbar", url: "not a url" }] },
      ],
    }).success,
  ).toBe(false);
});

async function idiom(
  cwd: string,
  args: string[],
  brief: ProgramDependencies["brief"] = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", ...args], {
    cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    brief: { now: () => new Date("2026-11-16T09:00:00Z"), ...brief },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function seededProject(): Promise<string> {
  const directory = await temporary();
  await writeFile(
    join(directory, "PRODUCT.md"),
    "## Comparable products\n\n- Alpha | https://alpha.example/ | calm\n  - selection toolbar | https://alpha.example/editor\n- Beta | https://beta.example/ | busy\n  - selection toolbar | https://beta.example/board\n",
  );
  await initProject({ project: directory, yes: true });
  return directory;
}

test("idiom brief research routes to comparables and prints pasteable criteria", async () => {
  const directory = await seededProject();
  const captureComparable = fakeCapture({
    "https://alpha.example/editor": 8,
    "https://beta.example/board": 12,
  });
  const json = await idiom(
    directory,
    ["brief", "research", "selection toolbar offset chip", "--json"],
    { captureComparable },
  );
  expect(json.stderr).toBe("");
  expect(json.code).toBe(0);
  const payload = JSON.parse(json.stdout);
  expect(payload.interfaceVersion).toBe(INTERFACE_VERSION);
  expect(Object.keys(payload)).toEqual([
    "interfaceVersion",
    "request",
    "terms",
    "listSource",
    "warnings",
    "comparables",
    "criteria",
  ]);
  expect(payload.criteria[0].text).toContain(
    "Offset chip to selection toolbar gap is at least 8px and at most 12px",
  );

  const text = await idiom(
    directory,
    ["brief", "research", "selection toolbar offset chip"],
    { captureComparable },
  );
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("Proposed acceptance criteria:\n- Offset chip");
  expect(text.stdout).toContain(
    "References stored: reference:alpha-selection-toolbar-2, reference:beta-selection-toolbar-2",
  );
});

test("--research stays on the parent: rejected on brief research, still routed by brief", async () => {
  const directory = await seededProject();
  const rejected = await idiom(directory, [
    "brief",
    "research",
    "toolbar",
    "--research",
  ]);
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain(
    '--research applies only to idiom brief "<request>" --research, not idiom brief research',
  );
  const parent = await idiom(directory, ["brief", "research the toolbar"]);
  expect(parent.code).not.toBe(0);
  expect(parent.stderr).toContain("pass --research");
});
