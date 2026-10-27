import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { copyLintCheck } from "../src/checks/copy-lint.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { CheckTuple, ObservationArtifactV2 } from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

let browser: Browser;
let observed: ObservationArtifactV2;
beforeAll(async () => {
  browser = await chromium.launch();
  observed = await capture(
    await readFile(
      join(import.meta.dirname, "fixtures/noise-defaults/linked-titles.html"),
      "utf8",
    ),
  );
});
afterAll(async () => browser.close());

async function capture(html: string) {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  try {
    await page.setContent(html);
    return (await observePage(page, {
      status: "not-configured",
    })) as ObservationArtifactV2;
  } finally {
    await page.close();
  }
}

function run(observations = observed, copy: unknown = {}) {
  const tuple: CheckTuple = {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1200,
    height: 800,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-10-26T00:00:00Z",
    console: [],
    mismatches: [],
    axe: { violations: [] },
    observations,
  };
  return copyLintCheck.run({
    tuple,
    tuples: [tuple],
    narrowViewport: false,
    config: checksConfigFrom(checksConfigSchema.parse({ copy })),
  }).candidates;
}
const casing = (artifact = observed) =>
  run(artifact).filter((f) => f.rule === "idiom:mixed-label-casing");
function at(id: string, artifact = observed) {
  const element = artifact.elements.find((e) => e.selector === `#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

test("captured linked titles leave both sides of comparison; ordinary labels still report", () => {
  expect(at("forum").signals).toMatchObject({
    href: "/wiki/International_Forum_Design",
    title: "International Forum Design",
  });
  expect(at("forum").painted?.value).toBe(true);
  expect(at("forum").stableIslandPath).toBe(
    at("plain-design").stableIslandPath,
  );
  expect(at("forum").styles.fontSize).toBe(at("plain-design").styles.fontSize);
  expect(at("publication").text).toBe("“Digital Typography at Stanford”");
  expect(at("publication").signals?.title).toBeUndefined();
  expect(at("split-title").directText).toBe("");
  expect(at("split-name").directText).toBe("International Forum");
  expect(at("split-title").text).toBe("International Forum Design");
  expect(at("split-name").structuralPath).toContain(
    `${at("split-title").structuralPath}/`,
  );
  expect(
    casing()
      .map((f) => f.selectorHint)
      .sort(),
  ).toEqual(["#ordinary-upper", "#outside-anchor"]);
  expect(
    casing().find((f) => f.selectorHint === "#ordinary-upper")?.explanation,
  ).toContain('"settings" capitalised');
  // Without metadata/citation evidence these exact observations reproduce the defects.
  const baseline = structuredClone(observed);
  for (const e of baseline.elements) {
    delete e.attributes.title;
    if (e.signals) delete e.signals.title;
    if (e.tag === "cite") e.tag = "i";
  }
  const before = casing(baseline);
  for (const id of [
    "plain-design",
    "split-name",
    "publication",
    "unicode-title",
  ])
    expect(
      before.some((f) => f.selectorHint === `#${id}`),
      id,
    ).toBe(true);
});

test("linked-name exemption does not suppress glossary policy", () => {
  expect(
    run(observed, { glossary: [{ term: "Leads", preferred: "Contacts" }] }),
  ).toContainEqual(
    expect.objectContaining({
      rule: "idiom:glossary-term",
      selectorHint: "#glossary-title",
    }),
  );
});

function signals() {
  const value = at("forum").signals;
  if (!value) throw new Error("Missing fixture signals");
  return value;
}

// Clone actual captured labels so small evidence cases retain realistic signals/styles.
function pair(label = "Account Settings") {
  const artifact = structuredClone(observed);
  const upper = structuredClone(at("forum"));
  Object.assign(upper, {
    selector: "#upper",
    text: label,
    directText: label,
    structuralPath: "html[0]/body[0]/a[0]",
    stableIslandPath: "html[0]/body[0]",
  });
  const lower = structuredClone(upper);
  Object.assign(lower, {
    selector: "#lower",
    text: "Privacy settings",
    directText: "Privacy settings",
    structuralPath: "html[0]/body[0]/a[1]",
    signals: { ...lower.signals, href: "/privacy", title: undefined },
    attributes: {},
  });
  artifact.elements = [upper, lower];
  return { artifact, upper, lower };
}

test.each([
  ["no title", "/settings", undefined],
  ["empty title", "/settings", ""],
  ["unrelated title", "/settings", "Other Settings"],
  ["case mismatch", "/settings", "Account settings"],
  ["fragment", "#settings", "Account Settings"],
  ["empty destination", " ", "Account Settings"],
  ["missing destination", undefined, "Account Settings"],
  ["script", "javascript:void(0)", "Account Settings"],
  ["mail", "mailto:settings@example.org", "Account Settings"],
  ["telephone", "tel:123", "Account Settings"],
  ["data", "data:text/html,test", "Account Settings"],
])("ordinary links remain eligible: %s", (_name, href, title) => {
  const { artifact, upper } = pair();
  upper.signals = { ...signals(), href, title };
  upper.attributes = title === undefined ? {} : { title };
  expect(casing(artifact).map((f) => f.selectorHint)).toEqual(["#upper"]);
});

test.each([
  "/page",
  "../page",
  "https://example.org/page",
  "http://example.org/page",
  "//example.org/page",
])("matching title with page destination %s is exempt", (href) => {
  const { artifact, upper } = pair();
  upper.signals = { ...signals(), href, title: "Account Settings" };
  expect(casing(artifact)).toEqual([]);
});

test.each([
  "École NASA Settings",
  "Mary-Jane O’Neill Settings",
  "Institute of Settings",
  "“Account   Settings Institute”",
])("capitalised name shape and normalized matching: %s", (label) => {
  const { artifact, upper } = pair(label);
  upper.signals = {
    ...signals(),
    title: label.replace(/[“”]/g, "").replace(/\s+/g, " "),
  };
  expect(casing(artifact)).toEqual([]);
  delete upper.signals.title;
  expect(casing(artifact)).toHaveLength(1);
});

test.each(["Account settings", "Account new Settings", "Settings"])(
  "sentence-case, lowercase words and single words do not gain exemption: %s",
  (label) => {
    const { artifact, upper, lower } = pair(label);
    upper.signals = { ...signals(), title: label };
    lower.directText =
      label === "Account new Settings"
        ? "Privacy settings"
        : "Privacy Settings";
    // Single words cannot contribute a noninitial word; inspect through a nested label.
    if (label === "Settings") {
      const child = structuredClone(lower);
      Object.assign(child, {
        selector: "#child",
        tag: "span",
        directText: "Account settings",
        structuralPath: `${upper.structuralPath}/span[0]`,
      });
      lower.tag = "span";
      artifact.elements.push(child);
    }
    expect(casing(artifact)).toHaveLength(1);
  },
);

test("non-link titles, missing optional metadata and transformed text keep established behavior", () => {
  const { artifact, upper, lower } = pair();
  upper.tag = "button";
  lower.tag = "button";
  upper.signals = { ...signals(), title: "Account Settings" };
  expect(casing(artifact)).toHaveLength(1);
  upper.tag = "a";
  lower.tag = "a";
  delete upper.signals.title;
  delete upper.painted;
  delete lower.painted;
  expect(casing(artifact)).toHaveLength(1);
  upper.styles.textTransform = "uppercase";
  expect(casing(artifact)).toEqual([]);
});

test("anchor attributes can supply title; non-signalled cite ancestors still resolve", () => {
  const artifact = structuredClone(observed);
  for (const e of artifact.elements) {
    if (e.signals) delete e.signals.title;
    if (e.tag === "cite") delete e.signals;
  }
  expect(
    casing(artifact)
      .map((f) => f.selectorHint)
      .sort(),
  ).toEqual(["#ordinary-upper", "#outside-anchor"]);
});

test.each([
  ["closed disclosure", "<details><summary>Open</summary>", "</details>"],
  ["collapsed navbox", '<div style="content-visibility:hidden">', "</div>"],
  ["display", '<div style="display:none">', "</div>"],
  ["visibility", '<div style="visibility:hidden">', "</div>"],
  ["opacity", '<div style="opacity:0">', "</div>"],
  [
    "clip",
    '<div style="height:1px;overflow:hidden"><div style="margin-top:50px">',
    "</div></div>",
  ],
])(
  "hidden labels cannot report or skew the majority: %s",
  async (_name, start, end) => {
    for (const hidden of ["Account Settings", "Privacy settings"]) {
      const artifact = await capture(
        `<style>button {font:16px/24px sans-serif}</style><main>${start}<button id="hidden">${hidden}</button><button id="hidden-two">${hidden}</button>${end}<button id="visible">Account Settings</button><button id="peer">Privacy settings</button></main>`,
      );
      expect(at("hidden", artifact).painted?.value).toBe(false);
      expect(at("visible", artifact).painted?.value).toBe(true);
      expect(casing(artifact).map((f) => f.selectorHint)).toEqual(["#visible"]);
    }
  },
);

test("opening details restores comparison; below-fold and partly clipped labels remain eligible", async () => {
  const artifact =
    await capture(`<style>button {font:16px/24px sans-serif}</style>
    <section><details open><summary>Open</summary><button id="opened">Account Settings</button></details><button id="open-peer">Privacy settings</button></section>
    <section><div style="height:10px;overflow:hidden"><button id="partial">Account Settings</button></div><button>Privacy settings</button></section>
    <section style="margin-top:1000px"><button id="below">Account Settings</button><button>Privacy settings</button></section>`);
  for (const id of ["opened", "partial", "below"])
    expect(at(id, artifact).painted?.value).toBe(true);
  expect(at("below", artifact).rect.y).toBeGreaterThan(800);
  expect(
    casing(artifact)
      .map((f) => f.selectorHint)
      .sort(),
  ).toEqual(["#below", "#opened", "#partial"]);
});
