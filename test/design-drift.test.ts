import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { ObservationArtifactV2 } from "../src/checks/types.js";
import { matchElements } from "../src/design/match.js";
import {
  crossesStep,
  measureDrift,
  normalizeColor,
  normalizeFamily,
  numericAllowance,
} from "../src/design/measure.js";
import { resolveDesignSource } from "../src/design/source.js";
import { createQuickConfiguration } from "../src/quick/config.js";
import { captureLiteralPages, writeReviewReports } from "../src/quick/run.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { attachCrops } from "../src/review/crops.js";
import {
  buildDeterministicDrafts,
  finalizeFindings,
} from "../src/review/findings.js";
import {
  designDriftConfigSchema,
  designSourceSchema,
} from "../src/schemas/design.js";
import { flowSchema } from "../src/schemas/flow.js";
import { checksConfigSchema } from "../src/schemas/project.js";

const fixtures = join(import.meta.dirname, "fixtures/design-drift");
let browser: Browser;
let design: ObservationArtifactV2, app: ObservationArtifactV2;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
  const observe = async (file: string) => {
    await page.setContent(await readFile(join(fixtures, file), "utf8"));
    return (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { designComparison: true },
    )) as ObservationArtifactV2;
  };
  design = await observe("design.html");
  app = await observe("app.html");
  await page.close();
});
afterAll(async () => {
  await browser?.close();
});

test("source and strict tolerance contracts", () => {
  for (const input of [
    "design.html",
    "design.htm",
    "exports",
    "export.v2",
    "..",
    "C:\\designs\\screen.html",
    "./a design/",
    "/tmp/design",
    "https://example.test/prototype?id=a",
  ])
    expect(designSourceSchema.safeParse(input).success).toBe(true);
  for (const input of [
    "",
    "  ",
    "file:///tmp/a.html",
    "https://name:secret@example.test/",
    "https://example.test/x.png",
    "javascript:alert(1)",
    "https://example.test/design.svg",
    "https://example.test/data.json",
  ])
    expect(designSourceSchema.safeParse(input).success).toBe(false);
  expect(designDriftConfigSchema.parse({}).tolerance).toEqual({
    ratio: 0.15,
    px: 1,
    mode: "tighter",
  });
  expect(
    designDriftConfigSchema.safeParse({ size: { extra: 1 } }).success,
  ).toBe(false);
  expect(designDriftConfigSchema.safeParse({ color: -1 }).success).toBe(false);
  const flow = flowSchema.parse({
    id: "x",
    title: "x",
    intent: [],
    setup: [],
    states: [
      {
        id: "a",
        description: "a",
        url: "http://example.test",
        design: "a.html",
        expect: {},
      },
      { id: "b", description: "b", from: "a", expect: {} },
    ],
  });
  expect(flow.states[0]?.design).toBe("a.html");
  expect(flow.states[1]?.design).toBeUndefined();
});

test("seven planted departures and identical reference", () => {
  expect(measureDrift(design, design, checksConfigFrom())).toEqual([]);
  const candidates = measureDrift(design, app, checksConfigFrom());
  const properties = candidates.map((c) => c.designDrift?.property);
  for (const property of [
    "borderTopLeftRadius",
    "gap.x",
    "fontWeight",
    "color",
    "missing",
    "extra",
    "text",
  ])
    expect(properties).toContain(property);
  expect(
    candidates.find((c) => c.designDrift?.property === "missing")?.severity,
  ).toBe("major");
  expect(
    candidates.find((c) => c.designDrift?.property === "text")?.severity,
  ).toBe("minor");
  expect(
    candidates.find((c) => c.designDrift?.property === "text")?.designDrift
      ?.method,
  ).toBe("parent-position");
  const weights = candidates.find(
    (c) => c.designDrift?.property === "fontWeight",
  );
  expect(weights?.designDrift).toMatchObject({
    designValue: "700",
    appValue: "600",
  });
  const matches = matchElements(design, app);
  expect(
    matches.pairs.filter((p) => p.method === "data-node-id").length,
  ).toBeGreaterThan(4);
  expect(new Set(matches.pairs.map((p) => p.app)).size).toBe(
    matches.pairs.length,
  );
  expect(matchElements(design, app)).toEqual(matches);
});

test("numeric strict boundary, overrides, normal line height and normalization", () => {
  expect(numericAllowance(8, { ratio: 0.15, px: 1, mode: "tighter" })).toBe(1);
  expect(numericAllowance(8, { ratio: 0.25, px: 4 })).toBe(4);
  expect(numericAllowance(0, { ratio: 0.15, px: 1, mode: "tighter" })).toBe(0);
  expect(normalizeFamily('"Arial", sans-serif')).toBe(
    normalizeFamily("arial,sans-serif"),
  );
  expect(normalizeColor("#ff000080")).toBe(
    normalizeColor("rgba(255, 0, 0, 0.5019607843137255)"),
  );
  expect(crossesStep(8, 12, [4, 8, 12, 16])).toBe(true);
  expect(crossesStep(8, 11.99, [4, 8, 12, 16])).toBe(false);
  const changed = structuredClone(design),
    card = changed.elements.find((e) => e.signals?.nodeId === "card");
  if (!card) throw new Error("no card");
  card.styles.borderTopLeftRadius = "9px";
  expect(measureDrift(design, changed, checksConfigFrom())).toEqual([]);
  card.styles.borderTopLeftRadius = "9.01px";
  expect(
    measureDrift(design, changed, checksConfigFrom()).map(
      (c) => c.designDrift?.property,
    ),
  ).toEqual(["borderTopLeftRadius"]);
  expect(
    measureDrift(
      design,
      changed,
      checksConfigFrom(
        checksConfigSchema.parse({
          designDrift: { radius: { px: 2, ratio: 1 } },
        }),
      ),
    ),
  ).toEqual([]);
});

test("anchored sibling insertion does not shift stable matches; conflicting IDs cannot fall back", () => {
  const changed = structuredClone(design),
    original = matchElements(design, design);
  const second = changed.elements.find((e) => e.signals?.nodeId === "second");
  if (!second?.signals) throw new Error("no second");
  second.signals.nodeId = "other";
  const matched = matchElements(design, changed);
  expect(matched.unmatchedDesign).toContain(second.selector);
  expect(matched.unmatchedApp).toContain(second.selector);
  for (const pair of original.pairs.filter((p) => p.design !== second.selector))
    expect(matched.pairs.find((p) => p.id === pair.id)?.app).toBe(pair.app);
});

test("immutable capture replay, seven findings and PNG crop evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-design-"));
  const source = await resolveDesignSource(
    join(fixtures, "app.html"),
    directory,
  );
  const reference = join(directory, "design.html");
  await writeFile(reference, await readFile(join(fixtures, "design.html")));
  try {
    const configuration = createQuickConfiguration([source.url], {
      design: reference,
      colorSchemes: ["light"],
    });
    const capture = await captureLiteralPages({
      directory,
      finalDirectory: join(directory, "run"),
      configuration,
      checks: checksConfigFrom(),
      startedAt: new Date(),
      label: "test",
      dependencies: { browserLauncher: createBrowserLauncher() },
    });
    expect(capture.counts).toEqual({ passed: 2, failed: 0, total: 2 });
    await rm(reference);
    await source.close();
    const loaded = await loadCaptureRun({
      runDirectory: capture.runDirectory,
      expectedFlow: configuration.flow.id,
    });
    expect(loaded.tuples).toHaveLength(2);
    for (const tuple of loaded.tuples) {
      expect(tuple.design?.unavailable).toBeUndefined();
      expect(tuple.design?.matches).toBeDefined();
    }
    expect(
      capture.reviewed.coverage
        .filter((entry) => entry.coverage.check === "design-drift")
        .map((entry) => entry.coverage.status),
    ).toEqual(["ran", "ran"]);
    for (const property of [
      "borderTopLeftRadius",
      "gap.x",
      "fontWeight",
      "color",
      "missing",
      "extra",
      "text",
    ])
      expect(
        capture.reviewed.candidates.some(
          (entry) => entry.candidate.designDrift?.property === property,
        ),
      ).toBe(true);
    const drafts = buildDeterministicDrafts({
      runId: "test",
      entries: capture.reviewed.candidates.filter(
        (entry) => entry.candidate.category === "design-drift",
      ),
    });
    const findings = await attachCrops(
      capture.runDirectory,
      finalizeFindings({ runId: "test", drafts }),
      loaded.tuples,
    );
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(
      findings.length,
    );
    for (const finding of findings) {
      expect(finding.fix).toContain("accept");
      expect(finding.evidence.designDrift?.crops).toHaveLength(2);
      for (const crop of finding.evidence.designDrift?.crops ?? [])
        expect(
          PNG.sync.read(await readFile(join(capture.runDirectory, crop.path)))
            .width,
        ).toBeGreaterThan(0);
    }
    const reports = await writeReviewReports(capture.runDirectory, {
      flow: configuration.flow.id,
      commit: "test",
      outcome: { kind: "deterministic-only" },
      tuples: loaded.tuples,
      findings,
      coverage: capture.reviewed.coverage,
      captureCoverage: [],
      suppressed: [],
    });
    const html = await readFile(reports.htmlReportPath, "utf8");
    expect(html).toContain("<figcaption>Design</figcaption>");
    expect(html).toContain("App capture (absent)");
    expect(html).toContain("data:image/png;base64,");
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test.each([
  ["borderTopLeftRadius", "12px"],
  ["borderTopRightRadius", "12px"],
  ["borderBottomRightRadius", "12px"],
  ["borderBottomLeftRadius", "12px"],
  ["borderTopWidth", "4px"],
  ["borderRightWidth", "4px"],
  ["borderBottomWidth", "4px"],
  ["borderLeftWidth", "4px"],
  ["borderTopStyle", "dashed"],
  ["borderRightStyle", "dashed"],
  ["borderBottomStyle", "dashed"],
  ["borderLeftStyle", "dashed"],
  ["borderTopColor", "rgb(255, 0, 0)"],
  ["borderRightColor", "rgb(255, 0, 0)"],
  ["borderBottomColor", "rgb(255, 0, 0)"],
  ["borderLeftColor", "rgb(255, 0, 0)"],
  ["fontSize", "20px"],
  ["fontWeight", "300"],
  ["fontFamily", "Georgia"],
  ["lineHeight", "normal"],
  ["color", "rgba(20,20,20,0.5)"],
  ["backgroundColor", "rgb(255, 0, 0)"],
] as const)("independent measurement of %s", (property, value) => {
  const baseline = structuredClone(design);
  const element = baseline.elements.find((e) => e.signals?.nodeId === "weight");
  if (!element) throw new Error("no text element");
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    element.styles[`border${side}Width`] = "1px";
    element.styles[`border${side}Style`] = "solid";
  }
  const changed = structuredClone(baseline),
    target = changed.elements.find((e) => e.selector === element.selector);
  if (!target) throw new Error("no target");
  target.styles[property] = value;
  const candidates = measureDrift(baseline, changed, checksConfigFrom());
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.designDrift?.property).toBe(property);
  expect(candidates[0]?.designDrift?.appValue).toBe(value);
  expect(candidates[0]?.severity).toBe("minor");
});

test("parent-local positions ignore global translations and use child dimensions for tolerance", () => {
  const moved = structuredClone(design);
  for (const element of moved.elements) {
    element.rect.x += 100;
    element.rect.y += 200;
  }
  expect(measureDrift(design, moved, checksConfigFrom())).toEqual([]);
  const card = moved.elements.find((e) => e.signals?.nodeId === "card");
  if (!card) throw new Error("card");
  card.rect.x += 2;
  const drift = measureDrift(design, moved, checksConfigFrom());
  expect(drift.map((c) => c.designDrift?.property)).toEqual(["position.x"]);
  expect(drift[0]?.designDrift).toMatchObject({
    designValue: 20,
    appValue: 22,
    allowance: 1,
  });
});

test("declared scale steps promote numeric drift, while copy stays minor", () => {
  const changed = structuredClone(design),
    card = changed.elements.find((e) => e.signals?.nodeId === "card");
  if (!card) throw new Error("card");
  card.styles.borderTopLeftRadius = "12px";
  changed.selectorMarks = [
    { purpose: "scale-card", selector: ".card", matches: [card.selector] },
  ];
  const config = checksConfigFrom(
    checksConfigSchema.parse({ scales: { radius: { card: [4, 8, 12, 16] } } }),
  );
  expect(measureDrift(design, changed, config)[0]?.severity).toBe("major");
  card.styles.borderTopLeftRadius = "11px";
  expect(measureDrift(design, changed, config)[0]?.severity).toBe("minor");
});

test("reference evidence is required and unchanged before verification can report a fix", async () => {
  const { evaluateVerification } = await import("../src/verify/evaluate.js");
  const { matchElements } = await import("../src/design/match.js");
  const { designDriftCheck } = await import("../src/checks/design-drift.js");
  const coordinate = {
    state: "home",
    viewport: "desktop",
    width: 500,
    height: 700,
    colorScheme: "light" as const,
  };
  const descriptor = {
    version: 1 as const,
    source: "design.html",
    coordinate,
    runtimeVersion: "test",
    status: "captured" as const,
    artifacts: {
      observations: "design/observations.json",
      screenshot: "design/screenshot.png",
      dom: "design/dom.html",
      console: "design/console.jsonl",
      axe: "design/axe.json",
      source: "design/source.json",
      matches: "design/matches.json",
    },
  };
  const tuple = (observation: ObservationArtifactV2, reference = design) => ({
    ...coordinate,
    flow: "test",
    metadataPath: "home/desktop/metadata.json",
    screenshotPath: "home/desktop/screenshot.png",
    artifactPaths: [],
    commit: "test",
    createdAt: "2026-10-25T12:00:00.000Z",
    observations: observation,
    console: [],
    mismatches: [],
    platform: {
      platform: "test",
      architecture: "test",
      release: "test",
      browserVersion: "test",
    },
    design: {
      descriptor,
      observations: reference,
      screenshotPath: "design/screenshot.png",
      matches: matchElements(reference, observation),
    },
  });
  const baseline = tuple(app),
    current = tuple(design),
    config = checksConfigFrom();
  const candidates = designDriftCheck.run({
    tuple: baseline,
    config,
    narrowViewport: false,
  }).candidates;
  const findings = finalizeFindings({
    runId: "test",
    drafts: buildDeterministicDrafts({
      runId: "test",
      entries: candidates.map((candidate) => ({
        tuple: baseline,
        candidate,
        checkOrder: 0,
      })),
    }),
  });
  const evaluate = (next: typeof current, disabled = false) =>
    evaluateVerification({
      findings,
      baseline: [baseline],
      currentA: [next],
      currentB: [next],
      checksConfig: {
        ...config,
        ...(disabled
          ? { designDrift: designDriftConfigSchema.parse({ enabled: false }) }
          : {}),
      },
    });
  expect(evaluate(current).findings.every((f) => f.status === "fixed")).toBe(
    true,
  );
  expect(
    evaluate(baseline).findings.every((f) => f.status === "reproduced"),
  ).toBe(true);
  const removed = { ...current, design: undefined };
  expect(
    evaluate(removed as unknown as typeof current).findings.every(
      (f) => f.status === "unverifiable",
    ),
  ).toBe(true);
  expect(
    evaluate(current, true).findings.every((f) => f.status === "unverifiable"),
  ).toBe(true);
  expect(
    evaluate(tuple(app, app)).findings.every(
      (f) => f.status === "unverifiable",
    ),
  ).toBe(true);
});

test("duplicate anchors use matched parent scope, then role/name and owned text precede position", async () => {
  const page = await browser.newPage();
  const observe = async (html: string) => {
    await page.setContent(`<style>div,section{min-height:20px}</style>${html}`);
    return (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { designComparison: true },
    )) as ObservationArtifactV2;
  };
  try {
    const reference = await observe(
      '<section role="region" aria-label="Left"><button data-node-id="duplicate">Save</button></section><section role="region" aria-label="Right"><button data-node-id="duplicate">Save</button></section>',
    );
    const captured = await observe(
      '<section role="region" aria-label="Right"><button data-node-id="duplicate">Save</button></section><section role="region" aria-label="Left"><button data-node-id="duplicate">Save</button></section>',
    );
    const matched = matchElements(reference, captured);
    const controls = matched.pairs.filter(
      (p) =>
        reference.elements.find((e) => e.selector === p.design)?.interactive,
    );
    expect(controls).toHaveLength(2);
    expect(controls.every((p) => p.method === "data-node-id")).toBe(true);
    for (const pair of controls) {
      const parent = matched.pairs.find((p) => p.id === pair.parent);
      expect(
        reference.elements.find((e) => e.selector === parent?.design)?.signals
          ?.name,
      ).toBe(
        captured.elements.find((e) => e.selector === parent?.app)?.signals
          ?.name,
      );
    }
    const base = await observe(
      '<main><button data-node-id="a">A</button><button data-node-id="b">B</button><p>Stable text</p><div data-idiom-name="named">Named</div></main>',
    );
    const inserted = await observe(
      '<main><button data-node-id="insert">New</button><button data-node-id="a">A</button><button data-node-id="b">B</button><p>Stable text</p><div data-idiom-name="named">Named</div></main>',
    );
    const aligned = matchElements(base, inserted);
    expect(aligned.unmatchedDesign).toEqual([]);
    expect(aligned.unmatchedApp).toHaveLength(1);
    expect(aligned.pairs.some((p) => p.method === "data-idiom-name")).toBe(
      true,
    );
    expect(
      aligned.pairs.find(
        (p) =>
          base.elements.find((e) => e.selector === p.design)?.directText ===
          "Stable text",
      )?.method,
    ).toBe("text");
    const roles = matchElements(
      await observe(
        '<main><button aria-label="Action">Old copy</button></main>',
      ),
      await observe(
        '<main><a role="button" tabindex="0" aria-label="Action">New copy</a></main>',
      ),
    );
    expect(roles.pairs.some((p) => p.method === "role-name")).toBe(true);
  } finally {
    await page.close();
  }
});

test("the document root background is compared as part of the intended screen", () => {
  const changed = structuredClone(design),
    root = changed.elements.find((e) => e.tag === "html");
  if (!root) throw new Error("root");
  root.styles.backgroundColor = "rgb(0, 0, 255)";
  expect(
    measureDrift(design, changed, checksConfigFrom()).some(
      (c) =>
        c.designDrift?.property === "backgroundColor" &&
        c.designDrift.appSelector === root.selector,
    ),
  ).toBe(true);
});

test("an inserted wrapper keeps the card paired and measures its own drift", async () => {
  const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
  const observe = async (html: string) => {
    await page.setContent(
      `<style>.card{border-radius:8px;padding:8px;background:#eee}</style>${html}`,
    );
    return (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { designComparison: true },
    )) as ObservationArtifactV2;
  };
  const card = (radius: number, title = "Title") =>
    `<section class="card" style="border-radius:${radius}px"><h3>${title}</h3><p>Body</p><button>Go</button></section>`;
  try {
    const config = checksConfigFrom();
    for (const [reference, captured] of [
      [
        `<main>${card(8)}</main>`,
        `<main><div class="w">${card(12)}</div></main>`,
      ],
      // Repeated identical cards carry no unique text, so position must look through.
      [
        `<main>${card(8)}${card(8)}</main>`,
        `<main><div class="w">${card(12)}${card(12)}</div></main>`,
      ],
      [
        `<main>${card(8)}${card(8)}</main>`,
        `<main><div class="w">${card(12)}</div><div class="w">${card(12)}</div></main>`,
      ],
    ] as const) {
      const design = await observe(reference),
        app = await observe(captured);
      const matched = matchElements(design, app);
      const cards = design.elements.filter((e) => e.tag === "section");
      for (const section of cards) {
        const pair = matched.pairs.find((p) => p.design === section.selector);
        expect(app.elements.find((e) => e.selector === pair?.app)?.tag).toBe(
          "section",
        );
      }
      expect(matched.unmatchedDesign).toEqual([]);
      const drift = measureDrift(design, app, config, matched);
      expect(
        drift.filter((c) => c.designDrift?.property === "missing"),
      ).toEqual([]);
      expect(drift.filter((c) => c.severity === "major")).toEqual([]);
      expect(
        drift.filter(
          (c) =>
            c.designDrift?.property === "borderTopLeftRadius" &&
            cards.some((s) => s.selector === c.designDrift?.designSelector),
        ),
      ).toHaveLength(cards.length);
      expect(
        drift.every(
          (c) => c.designDrift?.property !== "extra" || c.severity === "minor",
        ),
      ).toBe(true);
    }
    // A design-side wrapper the app dropped is a minor structural gap, not
    // missing content: everything it held is matched.
    const design = await observe(
        `<main><div class="w">${card(8)}</div></main>`,
      ),
      app = await observe(`<main>${card(8)}</main>`);
    const drift = measureDrift(design, app, config);
    expect(drift.filter((c) => c.severity === "major")).toEqual([]);
    // Content that really is absent stays major.
    const absent = measureDrift(
      await observe(`<main>${card(8)}${card(8, "Second")}</main>`),
      await observe(`<main>${card(8)}</main>`),
      config,
    );
    expect(
      absent.some(
        (c) => c.designDrift?.property === "missing" && c.severity === "major",
      ),
    ).toBe(true);
  } finally {
    await page.close();
  }
});

test("matching stays fast on pages with thousands of elements", async () => {
  const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
  const observe = async (cards: number, wrap: boolean) => {
    const card = (i: number) =>
      `<section class="card"><h3>Card ${i % 50}</h3><p>Body ${i}</p><div><span>Meta</span><button>Open</button></div></section>`;
    const body = Array.from({ length: cards }, (_, i) =>
      wrap ? `<div class="w">${card(i)}</div>` : card(i),
    ).join("");
    await page.setContent(`<main>${body}</main>`);
    return (await observePage(
      page,
      { status: "not-configured" },
      undefined,
      [],
      { designComparison: true },
    )) as ObservationArtifactV2;
  };
  try {
    const design = await observe(400, false),
      app = await observe(400, true);
    expect(design.elements.length).toBeGreaterThan(2000);
    let started = performance.now();
    const self = matchElements(design, design);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(self.unmatchedDesign).toEqual([]);
    started = performance.now();
    const wrapped = matchElements(design, app);
    measureDrift(design, app, checksConfigFrom(), wrapped);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(wrapped.unmatchedDesign).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
