import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { signalChecks } from "../src/checks/registry.js";
import type { ObservationArtifact } from "../src/checks/types.js";
import { run as runCli } from "../src/cli.js";
import {
  type CheckSummary,
  renderCheckSummary,
} from "../src/commands/check.js";
import { defaultChecksSettings } from "../src/schemas/project.js";
import {
  baselineProject,
  commit,
  storedBaselineRun,
} from "./baseline-support.js";
import {
  fixture,
  type ReviewedFixture,
  type ReviewOptions,
  reviewFixture,
  reviewStates,
} from "./benchmark-support.js";
import { type LoadingServer, startLoadingServer } from "./loading-support.js";

/**
 * Design partner benchmark (dogfooding request #43): the seven chrome defects a
 * human found on 2026-10-22 that idiom 0.2.0 reported none of. Each defect is
 * a predicate over findings. A release scores "found / 7" on before.html and
 * must report none of them, and no new-check noise, on after.html.
 * Both the original explicit settings and zero-config defaults plus DESIGN.md
 * exercise the full CLI retention paths.
 */
const benchmarkModes = ["configured", "defaults"] as const;
type BenchmarkMode = (typeof benchmarkModes)[number];

const checks = {
  explanation: "visible",
  components: [
    { name: "override dot", selector: ".bp-override-dot", width: 8, height: 8 },
  ],
};

type BenchmarkFinding = {
  category: string;
  rule?: string | undefined;
  selector?: string | undefined;
  problem: string;
  severity: string;
};

const normalized = (findings: ReviewedFixture): BenchmarkFinding[] =>
  findings.map(({ candidate }) => ({
    category: candidate.category,
    rule: candidate.rule,
    selector: candidate.selectorHint,
    problem: candidate.explanation,
    severity: candidate.severity,
  }));

type Defect = {
  id: number;
  name: string;
  found: (findings: BenchmarkFinding[]) => boolean;
};

const has = (
  findings: BenchmarkFinding[],
  category: string,
  match: (text: string) => boolean,
) =>
  findings.some(
    (finding) =>
      finding.category === category &&
      match(`${finding.rule} ${finding.selector} ${finding.problem}`),
  );

const defects: Defect[] = [
  {
    id: 1,
    name: 'bare "?" beside the Layers heading',
    found: (f) =>
      has(
        f,
        "unexplained-control",
        (t) => t.includes("summary") && t.includes('"?"'),
      ),
  },
  {
    id: 2,
    name: "Page settings reachable three ways",
    found: (f) =>
      has(
        f,
        "duplicate-entry",
        (t) => t.includes("Page settings") && t.includes("3 controls"),
      ),
  },
  {
    id: 3,
    name: "override dots at 12px against an 8px design",
    found: (f) =>
      has(
        f,
        "component-size",
        (t) => t.includes("override dot") && t.includes("12×12"),
      ),
  },
  {
    id: 4,
    name: "Button / Highlight specimen text below centre",
    found: (f) =>
      has(
        f,
        "text-centering",
        (t) => t.includes("#chip-button") || t.includes("#chip-highlight"),
      ),
  },
  {
    id: 5,
    name: "composer input touching send; Versions cards flush with their button",
    found: (f) =>
      has(
        f,
        "adjacent-gap",
        (t) => t.includes("#ai-input") || t.includes("#ai-send"),
      ) && has(f, "adjacent-gap", (t) => t.includes("#name-version")),
  },
  {
    id: 6,
    name: '"Name this version" does nothing',
    found: (f) => has(f, "dead-control", (t) => t.includes("#name-version")),
  },
  {
    id: 7,
    name: '"View terms" and top-bar Help as disabled navigation buttons',
    found: (f) =>
      ["#view-terms", "#top-help"].every((selector) =>
        f.some(
          (finding) =>
            finding.category === "dead-affordance" &&
            finding.rule === "idiom:disabled-link-button" &&
            finding.selector === selector &&
            finding.severity === "minor",
        ),
      ),
  },
];

const newCategories = new Set<string>(signalChecks.map((check) => check.id));
/** Expected after the fix: Matt asked for a visible placeholder over dead text. */
const expectedAfter = new Set(["idiom:placeholder-link"]);

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

async function review(
  name: string,
  primary = new Set<string>(),
  retained?: Map<string, ObservationArtifact>,
  mode: BenchmarkMode = "configured",
): Promise<ReviewedFixture> {
  const html = await fixture(name);
  const settings =
    mode === "configured"
      ? { checks }
      : {
          design: await readFile(
            join(import.meta.dirname, "fixtures/benchmark/DESIGN.md"),
            "utf8",
          ),
        };
  const onObservations: NonNullable<
    Parameters<typeof reviewFixture>[2]
  >["onObservations"] = (observations) => {
    if (observations.version === 2)
      for (const element of observations.elements)
        if (element.signals?.paint?.primaryAction === true)
          primary.add(element.selector);
  };
  return [
    ...(await reviewFixture(browser, html, {
      ...settings,
      probe: mode === "configured" || defaultChecksSettings.probe.enabled,
      onObservations: (observations) => {
        retained?.set("editor", observations);
        onObservations?.(observations);
      },
    })),
    ...(await reviewFixture(browser, html, {
      ...settings,
      probe: mode === "defaults" && defaultChecksSettings.probe.enabled,
      state: "composer-focused",
      focus: "#ai-input",
      onObservations: (observations) => {
        retained?.set("composer-focused", observations);
        onObservations?.(observations);
      },
    })),
  ];
}

/** The all-text witness must occur inside its own rendered group block. */
function expectRenderedGroup(
  summary: CheckSummary,
  text: string,
  groupId: string,
) {
  const group = summary.groups?.find((group) => group.id === groupId);
  expect(group).toBeDefined();
  if (group === undefined) return;
  const block = text.split(/\n\s*\n/).find((block) => {
    const heading = block.split("\n")[0] ?? "";
    return (
      (heading.includes(` — ${group.selector ?? group.where}`) ||
        heading.includes(`(${group.id})`)) &&
      block.includes(`Problem: ${group.problem}`)
    );
  });
  expect(block, group.id).toBeDefined();
  expect(block).toContain(group.selector ?? group.where);
  if (group.screenshot !== undefined) expect(block).toContain(group.screenshot);
  for (const member of group.members) {
    // Deferred singletons have no Decide line; repeated groups have Members.
    if (
      group.members.length > 1 ||
      group.coordinates.length > 1 ||
      !group.deferred
    )
      expect(block, member.id).toContain(member.id);
  }
}

function expectCompleteCatalogue(summary: CheckSummary) {
  const groups = summary.groups ?? [];
  const issueGroupIds = (summary.issues ?? []).flatMap((issue) => issue.groups);
  expect(issueGroupIds.sort()).toEqual(groups.map((g) => g.id).sort());
  expect(new Set(issueGroupIds).size).toBe(issueGroupIds.length);
  const memberIds = groups.flatMap((g) => g.members.map((m) => m.id));
  expect(memberIds.sort()).toEqual(summary.findings.map((f) => f.id).sort());
  expect(new Set(memberIds).size).toBe(memberIds.length);
}

test.each(benchmarkModes)(
  "benchmark (%s): retains all seven defects through CLI JSON and all text with measured ranks",
  async (mode) => {
    const retained = new Map<string, ObservationArtifact>();
    const before = normalized(
      await review("before.html", new Set(), retained, mode),
    );
    expect(defects.filter((defect) => !defect.found(before))).toEqual([]);
    const { project, configPath } = await baselineProject({
      states: ["editor", "composer-focused"],
      viewports: [{ name: "desktop", width: 1440, height: 900 }],
      maxFindings: 1,
    });
    try {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      if (mode === "configured") config.checks = checks;
      else {
        delete config.checks;
        await writeFile(
          join(project, "DESIGN.md"),
          await readFile(
            join(import.meta.dirname, "fixtures/benchmark/DESIGN.md"),
            "utf8",
          ),
        );
      }
      await writeFile(configPath, JSON.stringify(config));
      const sourceCommit = await commit(project, "benchmark settings");
      const from = "2026-10-22T12-00-00-000Z";
      const html = await fixture("before.html");
      expect([...retained.keys()]).toEqual(["editor", "composer-focused"]);
      await storedBaselineRun(
        project,
        from,
        sourceCommit,
        [...retained].map(([state, observations]) => ({
          state,
          observations,
          html,
          size: { width: 1440, height: 900 },
        })),
      );
      const invoke = async (...args: string[]) => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const code = await runCli(
          [
            "node",
            "idiom",
            "check",
            "--all",
            "studio",
            "--project",
            project,
            "--from",
            from,
            "--fail-on",
            "never",
            ...args,
          ],
          {
            stdout: (message) => stdout.push(message),
            stderr: (message) => stderr.push(message),
          },
        );
        expect(stderr.join("\n")).not.toContain("check failed");
        expect(code).toBe(0);
        return stdout.join("\n");
      };
      const summary = JSON.parse(await invoke("--json")) as CheckSummary;
      expectCompleteCatalogue(summary);
      expect(summary.findings.some((finding) => finding.deferred)).toBe(true);
      expect(
        defects.filter((defect) => !defect.found(summary.findings)),
      ).toEqual([]);
      const one = JSON.parse(
        await invoke("--top", "1", "--json"),
      ) as CheckSummary;
      expect(one.findings).toEqual(summary.findings);
      expect(one.groups).toEqual(summary.groups);
      expect(one.issues).toEqual(summary.issues);
      const persisted = await readFile(
        join(summary.runDirectory, "findings.json"),
        "utf8",
      );
      const durableGroups = await readFile(
        join(summary.runDirectory, "groups.json"),
        "utf8",
      );
      const text = await invoke("--all");
      expect(
        await readFile(join(summary.runDirectory, "findings.json"), "utf8"),
      ).toBe(persisted);
      expect(
        await readFile(join(summary.runDirectory, "groups.json"), "utf8"),
      ).toBe(durableGroups);
      // The exact selector/problem printed for group examples must still satisfy
      // the original predicates, including both witnesses of #5 and #7.
      expect(
        defects.filter((defect) => !defect.found(summary.groups ?? [])),
      ).toEqual([]);
      // Assert every group, including non-example siblings and deferred members.
      for (const group of summary.groups ?? [])
        expectRenderedGroup(summary, text, group.id);
      const compact = renderCheckSummary(summary);
      expect(compact.match(/^\d+\. /gm)).toHaveLength(5);
      expect(compact).toContain("Also found (");
      const byId = new Map(
        summary.findings.map((finding) => [finding.id, finding]),
      );
      const groups = summary.groups ?? [];
      const issues = summary.issues ?? [];
      const findingsIn = (ids: string[]) =>
        groups
          .filter((g) => ids.includes(g.id))
          .flatMap((g) =>
            g.members.flatMap((m) => {
              const finding = byId.get(m.id);
              expect(finding).toBeDefined();
              return finding === undefined ? [] : [finding];
            }),
          );
      const top7Text =
        (await invoke("--all", "--top", "7")).split("Also found (")[0] ?? "";
      for (const issue of issues.slice(0, 7))
        for (const id of issue.groups)
          expectRenderedGroup(summary, top7Text, id);
      expect(
        defects.filter(
          (defect) =>
            !defect.found(
              findingsIn(issues.slice(0, 7).flatMap((issue) => issue.groups)),
            ),
        ),
      ).toEqual([]);
      expect(
        defects.filter((defect) =>
          defect.found(
            findingsIn(issues.slice(0, 5).flatMap((issue) => issue.groups)),
          ),
        ).length,
      ).toBeGreaterThanOrEqual(5);
      const rows = defects.map((defect) => {
        const index = issues.findIndex((_, index) =>
          defect.found(
            findingsIn(
              issues.slice(0, index + 1).flatMap((issue) => issue.groups),
            ),
          ),
        );
        expect(index, defect.name).toBeGreaterThanOrEqual(0);
        expect(index, defect.name).toBeLessThan(7);
        // A conjunctive predicate needs multiple groups. A contributing group
        // loses a witness when removed from the complete defect evidence.
        const contributing = groups.filter((group) => {
          const members = findingsIn([group.id]);
          return (
            defect.found(members) ||
            members.some(
              (member) =>
                !defect.found(
                  summary.findings.filter(
                    (f) =>
                      f.category !== member.category ||
                      f.rule !== member.rule ||
                      f.selector !== member.selector ||
                      f.problem !== member.problem,
                  ),
                ),
            )
          );
        });
        expect(contributing.length, defect.name).toBeGreaterThan(0);
        return {
          defect: defect.id,
          rank: index + 1,
          top5: index < 5,
          groups: contributing.map((group) => ({
            id: group.id,
            issue: issues.find((issue) => issue.groups.includes(group.id))?.id,
            rank:
              issues.findIndex((issue) => issue.groups.includes(group.id)) + 1,
          })),
        };
      });
      console.info(
        `benchmark CLI retention (${mode}): 7/7 JSON, 7/7 all text; ${rows.filter((r) => r.top5).length}/7 Top 5\n${JSON.stringify(rows, null, 2)}`,
      );
      console.info(
        [
          "| Defect | JSON | All text | Rank | Top 5 | Groups / issue ranks |",
          "| --- | --- | --- | ---: | --- | --- |",
          ...rows.map(
            (row) =>
              `| #${row.defect} | Yes | Yes | ${row.rank} | ${row.top5 ? "Yes" : "No"} | ${row.groups.map((g) => `${g.id} / ${g.issue}@${g.rank}`).join("; ")} |`,
          ),
          `Compact full-view renderer: ${compact.match(/^\d+\. /gm)?.length} numbered examples; ${issues.length} total issues.`,
          ...compact.split("\n").filter((line) => /^ {2}[a-z-]+:/.test(line)),
        ].join("\n"),
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  60_000,
);

test.each(benchmarkModes)(
  "benchmark (%s): reports none of them, and no new-check noise, after the fix",
  async (mode) => {
    const after = await review("after.html", new Set(), undefined, mode);
    const stillFound = defects
      .filter((defect) => defect.found(normalized(after)))
      .map((d) => `#${d.id} ${d.name}`);
    const noise = after
      .filter(
        ({ candidate }) =>
          newCategories.has(candidate.category) &&
          !expectedAfter.has(candidate.rule),
      )
      .map(
        ({ candidate, state }) =>
          `${state}: ${candidate.category} ${candidate.explanation}`,
      );
    console.info(
      `benchmark after: ${stillFound.length} defects remain, ${noise.length} new-check findings`,
    );
    expect(stillFound).toEqual([]);
    expect(noise).toEqual([]);
    expect(
      after.some(
        ({ candidate }) => candidate.rule === "idiom:placeholder-link",
      ),
    ).toBe(true);
  },
  60_000,
);

const copyChecks = {
  copy: {
    locale: "en-CA",
    retired: [
      { term: "Style guide", preferred: "Brand" },
      { term: "Follow guide", preferred: "Follow brand" },
    ],
    jargon: [
      { term: "nodes", preferred: "items" },
      { term: "Disclosure", preferred: "Expand" },
      { term: "Inherited", preferred: "From brand" },
      { term: "en", preferred: "English" },
    ],
    glossary: [{ term: "Patterns-built", preferred: "Built from patterns" }],
  },
};

const copyDefects: Defect[] = [
  {
    id: 3,
    name: '"On primary on primary"',
    found: (f) =>
      has(
        f,
        "copy-lint",
        (t) =>
          t.includes("repeated-words") && t.includes("On primary on primary"),
      ),
  },
  {
    id: 3,
    name: "onPrimary",
    found: (f) => has(f, "copy-lint", (t) => t.includes('"onPrimary"')),
  },
  {
    id: 3,
    name: "Neutral/Text",
    found: (f) => has(f, "copy-lint", (t) => t.includes("Neutral/Text")),
  },
  {
    id: 3,
    name: "color.text",
    found: (f) => has(f, "copy-lint", (t) => t.includes("color.text")),
  },
  {
    id: 3,
    name: "Link On Background casing",
    found: (f) =>
      has(
        f,
        "copy-lint",
        (t) =>
          t.includes("mixed-label-casing") && t.includes("Link On Background"),
      ),
  },
  {
    id: 3,
    name: "Patterns-built",
    found: (f) =>
      has(
        f,
        "copy-lint",
        (t) => t.includes("glossary") && t.includes("Patterns-built"),
      ),
  },
  {
    id: 22,
    name: "Organise / colour beside Colors",
    found: (f) =>
      has(f, "copy-lint", (t) => t.includes("mixed-locale-spelling")),
  },
  {
    id: 27,
    name: "▾ twisty and ◉ ▣ tab glyphs",
    found: (f) =>
      has(f, "glyph-icon", (t) => t.includes('"▾"')) &&
      has(f, "glyph-icon", (t) => t.includes('"◉"')),
  },
  {
    id: 42,
    name: '"Renderer failed" thumbnails',
    found: (f) => has(f, "error-text", (t) => t.includes("Renderer failed")),
  },
];

test("benchmark: copy, glyph and error-text misses are caught, then clear", async () => {
  const before = await reviewFixture(
    browser,
    await fixture("copy-before.html"),
    { checks: copyChecks },
  );
  for (const [selector, term] of [
    ["#history-term", "Style guide"],
    ["#follow-term", "Follow guide"],
    ["#nodes-term", "nodes"],
    ["#disclosure-term", "Disclosure"],
  ]) {
    expect(
      before.some(
        ({ candidate: c }) =>
          c.selectorHint === selector && c.verification.params?.term === term,
      ),
    ).toBe(true);
  }
  const missed = copyDefects
    .filter((defect) => !defect.found(normalized(before)))
    .map((d) => `#${d.id} ${d.name}`);
  console.info(
    `copy benchmark before: found ${copyDefects.length - missed.length}/${copyDefects.length}`,
  );
  expect(missed).toEqual([]);
  const after = await reviewFixture(browser, await fixture("copy-after.html"), {
    checks: copyChecks,
  });
  const noise = after
    .filter(({ candidate }) => newCategories.has(candidate.category))
    .map(({ candidate }) => `${candidate.category} ${candidate.explanation}`);
  expect(noise).toEqual([]);
}, 60_000);

test("spacing rhythm ignores rows cut by a scroll container or the fold (#6)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const html = await readFile(
    join(import.meta.dirname, "fixtures/spacing-rhythm/fold.html"),
    "utf8",
  );
  for (const height of [843, 731, 620]) {
    const found = await reviewFixture(browser, html, {
      viewport: { width: 390, height },
    });
    expect(
      found.filter(({ candidate }) => candidate.category === "spacing-rhythm"),
    ).toEqual([]);
  }
}, 60_000);

test("native selects beside the product's custom selects are flagged; all-native is consistent (#7)", async () => {
  const page = (zoom: string) => `<!doctype html><html><body>
    <style>.combo{display:inline-flex;align-items:center;height:32px;padding:0 10px;border:1px solid #ccc;border-radius:6px;background:#fff}
    select.styled{appearance:none;height:32px;padding:0 10px;border:1px solid #ccc;border-radius:6px;background:#fff}</style>
    <div class="toolbar">
      <button class="combo" role="combobox" aria-expanded="false" aria-label="State">Default</button>
      <select class="styled" aria-label="Sort"><option>Newest</option></select>
      ${zoom}
    </div></body></html>`;
  const before = await reviewFixture(
    browser,
    page('<select id="zoom" aria-label="Zoom"><option>Fit</option></select>'),
  );
  expect(
    before
      .filter(({ candidate }) => candidate.category === "native-control")
      .map(({ candidate }) => candidate.selectorHint),
  ).toEqual(["#zoom"]);
  const after = await reviewFixture(
    browser,
    page(
      '<select id="zoom" class="styled" aria-label="Zoom"><option>Fit</option></select>',
    ),
  );
  expect(
    after.filter(({ candidate }) => candidate.category === "native-control"),
  ).toEqual([]);
  const allNative = await reviewFixture(
    browser,
    '<!doctype html><html><body><select aria-label="A"><option>a</option></select><select aria-label="B"><option>b</option></select></body></html>',
  );
  expect(
    allNative.filter(
      ({ candidate }) => candidate.category === "native-control",
    ),
  ).toEqual([]);
}, 60_000);

/**
 * Loading feedback (file-199): the probe's held replay slows each action's
 * responses and watches what the user would see. Every case is served over
 * HTTP so the fixtures' fetches reach a real (counting) server.
 */
describe("loading feedback while requests are held", () => {
  let server: LoadingServer;
  beforeAll(async () => {
    server = await startLoadingServer();
  });
  afterAll(async () => {
    await server.close();
  });
  const review = (path: string) =>
    reviewFixture(browser, "", {
      url: `${server.origin}/${path}`,
      probe: true,
    });
  const rules = (findings: ReviewedFixture) =>
    findings
      .filter(({ candidate }) =>
        ["loading-state-missing", "double-submit"].includes(candidate.category),
      )
      .map(({ candidate }) => ({
        rule: candidate.rule,
        selector: candidate.selectorHint,
        timeline: candidate.timeline,
        problem: candidate.explanation,
      }));

  test("a fetch with no pending feedback is found; aria-busy and a label fix it", async () => {
    const before = rules(await review("loading-state/before.html"));
    expect(before).toEqual([
      expect.objectContaining({
        rule: "idiom:loading-state-missing",
        selector: "#load",
        timeline: "slow-probe-1",
        problem: expect.stringMatching(/GET \/api\/items/),
      }),
    ]);
    expect(rules(await review("loading-state/after.html"))).toEqual([]);
  }, 90_000);

  test("an enabled submit sends a duplicate POST, which is blocked; disabling it fixes both", async () => {
    const before = rules(await review("double-submit/before.html"));
    expect(before.map(({ rule }) => rule).sort()).toEqual([
      "idiom:double-submit",
      "idiom:loading-state-missing",
    ]);
    expect(rules(await review("double-submit/after.html"))).toEqual([]);
  }, 90_000);

  test("a route change that empties main is found despite nav highlight and announcer; a skeleton fixes it", async () => {
    const before = rules(await review("route-change/before.html"));
    expect(before).toEqual([
      expect.objectContaining({
        rule: "idiom:loading-state-missing",
        problem: expect.stringMatching(
          /^Navigating to \/orders left the main content empty/,
        ),
      }),
    ]);
    expect(rules(await review("route-change/after.html"))).toEqual([]);
  }, 90_000);

  test.each([
    "skeleton-swap",
    "document-nav",
    "optimistic",
    "fire-and-forget",
    "disabled-trigger",
    "safe-only",
    "carousel",
  ])(
    "exclusion %s reports neither rule",
    async (name) => {
      expect(rules(await review(`loading-exclusions/${name}.html`))).toEqual(
        [],
      );
    },
    90_000,
  );

  test("no non-GET request ever reached the server", () => {
    expect(server.nonGet).toEqual([]);
  });
});

/**
 * Everything transitions (file-200): content that swaps, expands, lists,
 * announces or routes with no transition snaps. Each `before` must produce
 * one major `idiom:motion-snap`; each `after` (the fix the finding
 * recommends) and each deliberate non-defect must produce none. Runs under
 * the harness default, prefers-reduced-motion: reduce, so the probe's
 * normal-motion confirmation is what finds the snaps.
 */
describe("everything transitions", () => {
  let server: Server;
  let origin = "";
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      try {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(await fixture(path.slice(1)));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  const review = async (name: string, options: ReviewOptions = {}) => {
    const served = name.startsWith("motion-route/");
    const { findings, tuples } = await reviewStates(
      browser,
      [
        {
          state: "editor",
          html: served ? "" : await fixture(name),
          ...(served ? { url: `${origin}/${name}` } : {}),
        },
      ],
      { probe: true, ...options },
    );
    return {
      snaps: findings
        .map(({ candidate }) => candidate)
        .filter((candidate) => candidate.rule === "idiom:motion-snap"),
      findings,
      tuple: tuples[0],
    };
  };
  test.each([
    ["motion-tabs", "content-swap"],
    ["motion-segmented", "content-swap"],
    ["motion-accordion", "expand-collapse"],
    ["motion-list", "list-item"],
    ["motion-toast", "status"],
    ["motion-route", "route"],
  ])(
    "%s snaps before (%s) and transitions after",
    async (name, kind) => {
      const before = await review(`${name}/before.html`);
      expect(before.snaps).toEqual([
        expect.objectContaining({
          severity: "major",
          verification: expect.objectContaining({
            params: expect.objectContaining({ kind }),
          }),
        }),
      ]);
      const [snap] = before.snaps;
      expect(snap?.fix).toMatch(/150ms ease-out/);
      expect(snap?.fix).toContain(
        kind === "expand-collapse"
          ? "grid-template-rows"
          : kind === "route"
            ? "startViewTransition"
            : "opacity",
      );
      // The evidence is the normal-motion replay; the motion audit stays reduced.
      const evidence = before.tuple?.timelines?.actions.find(
        (action) => action.id === snap?.timeline,
      );
      expect(evidence).toMatchObject({
        confirmation: true,
        reducedMotion: false,
      });
      const observations = before.tuple?.observations;
      expect(
        observations?.version === 2 ? observations.motion?.reducedMotion : 0,
      ).toBe(true);
      const after = await review(`${name}/after.html`);
      expect(after.snaps).toEqual([]);
    },
    60_000,
  );
  test("twelve snapping tabs make one finding listing every tab", async () => {
    const { snaps } = await review("motion-tabs/before.html");
    const actions = snaps[0]?.verification.params?.actions as unknown[];
    // Tab 1 is already selected; tabs 2 and 3 each swap the panel slot.
    expect(actions.length).toBeGreaterThanOrEqual(2);
  }, 60_000);
  test.each(["motion-tabs/before.html", "motion-list/before.html"])(
    "%s is judged directly in a normal-motion capture",
    async (name) => {
      const { snaps, tuple } = await review(name, { reducedMotion: false });
      expect(snaps).toHaveLength(1);
      expect(
        tuple?.timelines?.actions.some((action) => action.confirmation),
      ).toBe(false);
    },
    60_000,
  );
  test.each([
    "motion-counter/after.html",
    "motion-small/after.html",
    "motion-focus/after.html",
    "motion-hover/after.html",
    "motion-reduce-honoring/after.html",
  ])(
    "non-defect %s reports no snap",
    async (name) => {
      const { snaps, findings } = await review(name);
      expect(snaps).toEqual([]);
      if (name.startsWith("motion-reduce-honoring"))
        expect(
          findings.filter(
            ({ candidate }) => candidate.rule === "idiom:motion-reduced",
          ),
        ).toEqual([]);
    },
    60_000,
  );
});

/**
 * Interaction shift (file-198): content displaced by an action is found in
 * each `before` fixture and absent from its `after`. Every fixture probes its
 * one control, so the action timeline is recorded as capture records it.
 */
const shifts = (findings: ReviewedFixture, category = "interaction-shift") =>
  findings
    .filter(({ candidate }) => candidate.category === category)
    .map(({ candidate }) => candidate);

const delayedResults = async (page: import("playwright").Page) => {
  await page.route("http://idiom.test/results", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({
      json: ["Ada Lovelace", "Grace Hopper", "Katherine Johnson"],
    });
  });
};

test("interaction shift: an in-flow notice pushes the page; an overlay does not", async () => {
  const before = shifts(
    await reviewFixture(
      browser,
      await fixture("interaction-shift-push/before.html"),
      { probe: true },
    ),
  );
  expect(before).toHaveLength(1);
  const [hit] = before;
  expect(hit?.severity).toBe("major");
  expect(hit?.selectorHint).toBe('div[role="status"]');
  expect(hit?.timeline).toBe("probe-1");
  expect(hit?.explanation).toContain("48px down");
  expect(hit?.explanation).toContain("body > main");
  expect(hit?.explanation).not.toContain("late:");
  expect(hit?.fix).toContain("Overlay instead of pushing");
  const after = await reviewFixture(
    browser,
    await fixture("interaction-shift-push/after.html"),
    { probe: true },
  );
  expect(shifts(after)).toEqual([]);
}, 60_000);

test("interaction shift: results arriving 700ms after the click are a late shift; reserved space is not", async () => {
  const before = shifts(
    await reviewFixture(
      browser,
      await fixture("interaction-shift-late/before.html"),
      { probe: true, routes: delayedResults },
    ),
  );
  expect(before).toHaveLength(1);
  const [hit] = before;
  expect(hit?.selectorHint).toBe("ul.results");
  expect(hit?.explanation).toContain("late: async content arrived");
  expect(hit?.explanation).toContain("p.note (120px)");
  const time = Number(/(\d+)ms after input/.exec(hit?.explanation ?? "")?.[1]);
  expect(time).toBeGreaterThan(500);
  expect(hit?.fix).toContain("min-height: 120px");
  const after = await reviewFixture(
    browser,
    await fixture("interaction-shift-late/after.html"),
    { probe: true, routes: delayedResults },
  );
  expect(shifts(after)).toEqual([]);
}, 60_000);

test("interaction shift: staggered late batches report separate jumps; reserved space is clean", async () => {
  const routes = async (page: import("playwright").Page) => {
    await page.route("http://idiom.test/batch/*", async (route) => {
      const index = Number(
        new URL(route.request().url()).pathname.split("/").at(-1),
      );
      await new Promise((resolve) => setTimeout(resolve, 700 + index * 300));
      await route.fulfill({ json: ["Ada", "Grace", "Katherine"][index] });
    });
  };
  const before = shifts(
    await reviewFixture(
      browser,
      await fixture("interaction-shift-batches/before.html"),
      { probe: true, routes },
    ),
  );
  expect(before).toHaveLength(3);
  expect(
    before.map((hit) => /batch-\d/.exec(hit.selectorHint ?? "")?.[0]).sort(),
  ).toEqual(["batch-0", "batch-1", "batch-2"]);
  for (const hit of before) {
    expect(hit).toMatchObject({ severity: "major", timeline: "probe-1" });
    expect(hit.explanation).toContain("late: async content arrived");
    expect(hit.explanation).toContain("p.note (50px)");
    expect(hit.fix).toContain("min-height: 50px");
  }
  const after = await reviewFixture(
    browser,
    await fixture("interaction-shift-batches/after.html"),
    { probe: true, routes },
  );
  expect(shifts(after)).toEqual([]);
}, 60_000);

test("interaction shift: a message that snaps in is reported; one that animates open is not", async () => {
  const before = shifts(
    await reviewFixture(
      browser,
      await fixture("interaction-shift-animated/before.html"),
      { probe: true },
    ),
  );
  expect(before.map((candidate) => candidate.selectorHint)).toEqual([
    "div.saved",
  ]);
  expect(before[0]?.explanation).toContain("body > main > form");
  const after = await reviewFixture(
    browser,
    await fixture("interaction-shift-animated/after.html"),
    { probe: true },
  );
  expect(shifts(after)).toEqual([]);
}, 60_000);

test("layout shift: names the promo that arrived late in load; a reserved slot is clean", async () => {
  // Served, so the load timeline's init script runs on a real navigation.
  const before = shifts(
    await reviewFixture(
      browser,
      await fixture("layout-shift-late-content/before.html"),
      { serve: true, settleMs: 800 },
    ),
    "layout-shift",
  );
  expect(before).toHaveLength(1);
  const [hit] = before;
  expect(hit?.severity).toBe("major");
  expect(hit?.explanation).toContain(
    "came from late content: aside.promo was inserted (360px)",
  );
  expect(hit?.timeline).toBe("load");
  expect(hit?.fix).toContain("min-height: 360px");
  const after = await reviewFixture(
    browser,
    await fixture("layout-shift-late-content/after.html"),
    { serve: true, settleMs: 800 },
  );
  expect(shifts(after, "layout-shift")).toEqual([]);
}, 60_000);

test("interaction shift: scrolling, the effect region, sorting, filtering, overlays and off-screen movement are not shifts", async () => {
  for (const name of [
    "scroll",
    "effect-region",
    "reorder",
    "filter",
    "overlay",
    "offscreen",
  ]) {
    const findings = await reviewFixture(
      browser,
      await fixture(`interaction-shift-exclusions/${name}.html`),
      { probe: true },
    );
    expect(shifts(findings), name).toEqual([]);
  }
}, 120_000);
