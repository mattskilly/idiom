import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
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
  reviewFixture,
} from "./benchmark-support.js";

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
      const text = await invoke("--all");
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
      const rows = defects.map((defect) => {
        const index = issues.findIndex((_, index) =>
          defect.found(
            findingsIn(
              issues.slice(0, index + 1).flatMap((issue) => issue.groups),
            ),
          ),
        );
        expect(index, defect.name).toBeGreaterThanOrEqual(0);
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
