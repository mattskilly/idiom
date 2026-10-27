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
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  try {
    await page.setContent(
      await readFile(
        join(import.meta.dirname, "fixtures/noise-defaults/locale-titles.html"),
        "utf8",
      ),
    );
    observed = (await observePage(page, {
      status: "not-configured",
    })) as ObservationArtifactV2;
  } finally {
    await page.close();
  }
});
afterAll(async () => browser.close());

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
const locale = (artifact = observed, copy: unknown = {}) =>
  run(artifact, copy).filter((f) => f.rule === "idiom:mixed-locale-spelling");
const flagged = (artifact = observed, copy: unknown = {}) =>
  [...new Set(locale(artifact, copy).map((f) => f.selectorHint))].sort();
function at(id: string, artifact = observed) {
  const element = artifact.elements.find((e) => e.selector === `#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}

const exempt = [
  "#titled",
  "#cited",
  "#redirect",
  "#split",
  "#split-head",
  "#split-tail",
];
const ui = ["#ui-button", "#nav-single", "#nav-untitled", "#nav-mismatch"];
const hidden = [
  "#collapsed",
  "#collapsed-two",
  "#collapsed-three",
  "#in-details",
  "#hidden-attr",
];

test("captured titled links carry page metadata; collapsed copy is unpainted", () => {
  expect(at("titled").signals).toMatchObject({
    href: "/wiki/Design_for_behaviour_change",
    title: "Design for behaviour change",
  });
  expect(at("redirect").signals?.title).toBe("Royal Colour Society (UK)");
  expect(at("cited").signals?.href).toBe("https://example.org/p");
  for (const id of ["titled", "cited", "redirect", "split-head", "ui-button"])
    expect(at(id).painted?.value).toBe(true);
  for (const id of ["collapsed", "collapsed-two", "collapsed-three"])
    expect(at(id).painted?.value).toBe(false);
  for (const id of ["in-details", "hidden-attr"])
    expect(at(id).painted?.value ?? false).toBe(false);
});

test("majority path: titled links and hidden copy neither report nor vote; UI strings still report", () => {
  const found = flagged();
  for (const selector of [...exempt, ...hidden])
    expect(found).not.toContain(selector);
  for (const selector of ui) expect(found).toContain(selector);
  expect(found).toContain("#pompidou");
  expect(found).toContain("#plain-centre");
  for (const finding of locale())
    expect(finding.explanation).toContain(
      "while the product is en-US (by majority of observed spellings)",
    );
});

test("configured locale: same exemptions, same reported UI strings", () => {
  const found = flagged(observed, { locale: "en-US" });
  for (const selector of [...exempt, ...hidden])
    expect(found).not.toContain(selector);
  for (const selector of ui) expect(found).toContain(selector);
  expect(
    locale(observed, { locale: "en-US" }).find(
      (f) => f.selectorHint === "#ui-button",
    )?.explanation,
  ).toBe(
    `"Analyse traffic" (#ui-button) uses "Analyse"; en-US prefers "Analyze".`,
  );
});

test.each([
  ["majority", {}],
  ["configured", { locale: "en-US" }],
])("declared proper nouns keep their spelling: %s", (_name, copy) => {
  const found = flagged(observed, {
    ...copy,
    properNouns: ["Centre Pompidou"],
  });
  expect(found).not.toContain("#pompidou");
  expect(found).toContain("#plain-centre");
  for (const selector of ui) expect(found).toContain(selector);
});

test("proper-noun masking leaves the reported text whole", () => {
  const finding = locale(observed, { locale: "en-US" }).find(
    (f) => f.selectorHint === "#pompidou",
  );
  expect(finding?.explanation).toBe(
    `"Visit the Centre Pompidou today." (#pompidou) uses "Centre"; en-US prefers "Center".`,
  );
});

function retitled(
  id: string,
  edit: (anchor: ObservationArtifactV2["elements"][number]) => void,
) {
  const artifact = structuredClone(observed);
  const anchor = artifact.elements.find((e) => e.selector === `#${id}`);
  if (!anchor) throw new Error(`Missing #${id}`);
  edit(anchor);
  return artifact;
}

test.each([
  [
    "title from attributes only",
    "titled",
    (a: ObservationArtifactV2["elements"][number]) => {
      if (a.signals) delete a.signals.title;
      a.attributes.title = "Design for behaviour change";
    },
    false,
  ],
  [
    "fragment href is not a page",
    "titled",
    (a: ObservationArtifactV2["elements"][number]) => {
      if (a.signals) a.signals.href = "#behaviour";
    },
    true,
  ],
  [
    "case-insensitive title match",
    "titled",
    (a: ObservationArtifactV2["elements"][number]) => {
      if (a.signals) a.signals.title = "Design For Behaviour Change";
    },
    false,
  ],
  [
    "one-word title match",
    "nav-single",
    (_a: ObservationArtifactV2["elements"][number]) => {},
    true,
  ],
  [
    "mismatched title on a sentence-case label",
    "titled",
    (a: ObservationArtifactV2["elements"][number]) => {
      if (a.signals) a.signals.title = "Behavioural design";
    },
    true,
  ],
])("anchor evidence: %s", (_name, id, edit, reported) => {
  const artifact = retitled(id, edit);
  expect(flagged(artifact, { locale: "en-US" }).includes(`#${id}`)).toBe(
    reported,
  );
});
