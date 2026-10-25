import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { checksConfigFrom } from "../src/checks/registry.js";
import {
  buildDeterministicDrafts,
  finalizeFindingSelection,
} from "../src/review/findings.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { fixture, reviewFixture, reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const terminology = {
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
};
const isNew = (rule: string) =>
  ["idiom:retired-term", "idiom:jargon-in-copy"].includes(rule);

test("legacy glossary already matches embedded phrases and real visible labels", async () => {
  const findings = await reviewFixture(
    browser,
    await fixture("../retired-jargon/before.html"),
    {
      checks: {
        copy: { glossary: [...terminology.retired, ...terminology.jargon] },
      },
    },
  );
  for (const [selector, preferred] of [
    ["#history", "Brand"],
    ["#history-case", "Brand"],
    ["#highlight", "items"],
    ["#disclosure", "Expand"],
  ]) {
    expect(
      findings.some(
        ({ candidate: c }) =>
          c.rule === "idiom:glossary-term" &&
          c.selectorHint === selector &&
          c.explanation.includes(preferred ?? ""),
      ),
    ).toBe(true);
  }
});

test("new terminology is opt-in and forwarded through the registry", async () => {
  const plain = await reviewFixture(
    browser,
    await fixture("../retired-jargon/before.html"),
  );
  expect(plain.filter(({ candidate }) => isNew(candidate.rule))).toEqual([]);
  const settings = checksConfigSchema.parse({ copy: terminology });
  expect(checksConfigFrom(settings).copy).toEqual(settings.copy);
  const before = await reviewFixture(
    browser,
    await fixture("../retired-jargon/before.html"),
    { checks: settings },
  );
  for (const selector of [
    "#history",
    "#history-case",
    "#follow",
    "#highlight",
    "#inherited",
    "#disclosure",
    "#language",
  ]) {
    const hits = before.filter(
      ({ candidate: c }) => isNew(c.rule) && c.selectorHint === selector,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.candidate.verification.params).toEqual(
      expect.objectContaining({
        selector,
        term: expect.any(String),
        preferred: expect.any(String),
      }),
    );
  }
  expect(
    before.some(
      ({ candidate: c }) =>
        c.selectorHint === "#colors" && c.explanation.includes("Colours"),
    ),
  ).toBe(true);
  expect(
    before.filter(({ candidate: c }) => c.selectorHint === "#canadian"),
  ).toEqual([]);
  const after = await reviewFixture(
    browser,
    await fixture("../retired-jargon/after.html"),
    { checks: settings },
  );
  expect(
    after.filter(
      ({ candidate: c }) =>
        isNew(c.rule) || c.rule === "idiom:mixed-locale-spelling",
    ),
  ).toEqual([]);
});

test("Canadian and Australian locales accept distinct verb spellings", async () => {
  for (const [locale, correct, incorrect] of [
    ["en-CA", "Organize", "Organise"],
    ["en-AU", "Organise", "Organize"],
  ]) {
    const found = await reviewFixture(
      browser,
      `<p id="correct">${correct} items</p><p id="wrong">${incorrect} items</p>`,
      { checks: { copy: { locale } } },
    );
    const spellings = found.filter(
      ({ candidate }) => candidate.rule === "idiom:mixed-locale-spelling",
    );
    expect(spellings).toHaveLength(1);
    expect(spellings[0]?.candidate.selectorHint).toBe("#wrong");
    expect(spellings[0]?.candidate.explanation).toContain(correct ?? "");
  }
});

test("policies normalize literal phrases, enforce jargon boundaries and retain distinct finalized terms", async () => {
  const { findings, tuples } = await reviewStates(
    browser,
    [
      {
        state: "editor",
        html: `
    <button id="multi" title="Style GUIDE nodes nodes" aria-label="Style GUIDE nodes nodes">Style GUIDE nodes nodes</button>
    <p id="embedded">OldStyle guidebook</p><p id="space">STYLE\n GUIDE: colour</p>
    <p id="literal">C++ (legacy)</p><p id="punctuation">(NODES), en!</p>
    <p id="safe">enabled énodes nodesé 2nodes nodes2 Cxx legacy</p>
    <p hidden id="hidden">nodes</p><p style="opacity:0" id="transparent">nodes</p>
    <p style="position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden" id="sr">nodes</p>
    <code id="code">nodes</code><pre><span id="nested-code">nodes</span></pre>
    <textarea id="input">nodes</textarea><p translate="no" id="translation">nodes</p>
    <p id="meta" title="nodes" aria-label="nodes">Items</p>
  `,
      },
    ],
    {
      checks: {
        copy: {
          retired: [
            { term: " style   guide ", preferred: "Old brand" },
            { term: "STYLE GUIDE", preferred: "Brand" },
            { term: "C++ (legacy)", preferred: "Modern" },
          ],
          jargon: [
            { term: "nodes", preferred: "Old items" },
            { term: "NODES", preferred: "items" },
            { term: "en", preferred: "English" },
            { term: "style guide", preferred: "Wrong duplicate" },
          ],
          glossary: [
            { term: "nodes", preferred: "Wrong legacy" },
            { term: "Style guide", preferred: "Wrong legacy" },
          ],
        },
      },
    },
  );
  const terms = findings.filter(({ candidate }) => isNew(candidate.rule));
  expect(terms.map(({ candidate: c }) => c.selectorHint).sort()).toEqual(
    [
      "#multi",
      "#multi",
      "#embedded",
      "#space",
      "#literal",
      "#punctuation",
      "#punctuation",
    ].sort(),
  );
  expect(
    findings.filter(({ candidate: c }) => c.rule === "idiom:glossary-term"),
  ).toEqual([]);
  expect(
    terms.every(
      ({ candidate: c }) =>
        !c.explanation.includes("Old items") &&
        !c.explanation.includes("Old brand") &&
        !c.explanation.includes("Wrong"),
    ),
  ).toBe(true);
  const tuple = tuples[0];
  if (!tuple) throw new Error("fixture did not produce a tuple");
  const drafts = buildDeterministicDrafts({
    runId: "terms",
    entries: terms.map(({ candidate }) => ({
      candidate,
      tuple,
      checkOrder: 0,
    })),
  });
  const final = finalizeFindingSelection({
    runId: "terms",
    drafts,
    maxFindings: 100,
  }).material;
  expect(final).toHaveLength(7);
  expect(new Set(final.map((f) => f.fingerprint)).size).toBe(7);
  expect(new Set(final.map((f) => f.groupKey)).size).toBe(7);
  expect(
    drafts.every(
      (d) =>
        d.selectorHint.startsWith("#") &&
        d.finding.verification.kind === "deterministic-check" &&
        d.finding.verification.params?.selector === d.selectorHint,
    ),
  ).toBe(true);
});

const spellingCases = [
  ["colour", "color", "colour"],
  ["colours", "colors", "colours"],
  ["organise", "organize", "organize"],
  ["organised", "organized", "organized"],
  ["favourite", "favorite", "favourite"],
  ["favourites", "favorites", "favourites"],
  ["behaviour", "behavior", "behaviour"],
  ["centre", "center", "centre"],
  ["centred", "centered", "centred"],
  ["grey", "gray", "grey"],
  ["customise", "customize", "customize"],
  ["customised", "customized", "customized"],
  ["optimise", "optimize", "optimize"],
  ["optimised", "optimized", "optimized"],
  ["recognise", "recognize", "recognize"],
  ["analyse", "analyze", "analyze"],
  ["catalogue", "catalog", "catalogue"],
  ["cancelled", "canceled", "cancelled"],
  ["modelling", "modeling", "modelling"],
  ["labelled", "labeled", "labelled"],
  ["synchronise", "synchronize", "synchronize"],
  ["prioritise", "prioritize", "prioritize"],
  ["summarise", "summarize", "summarize"],
  ["visualise", "visualize", "visualize"],
  ["personalise", "personalize", "personalize"],
];

test.each(["en-CA", "en-AU", "en-US", "en-GB"])(
  "%s has concrete per-word preferences on single-variant pages",
  async (locale) => {
    const cases = [
      ...spellingCases,
      ...(locale === "en-US" || locale === "en-GB"
        ? [["licence", "license", "licence"]]
        : []),
    ];
    for (const wrong of [false, true]) {
      const html =
        cases
          .map(([gb = "", us = "", ca = ""], i) => {
            const preferred =
              locale === "en-CA" ? ca : locale === "en-US" ? us : gb;
            const term = wrong ? (preferred === gb ? us : gb) : preferred;
            return `<p id="word-${i}">${i % 2 ? term.toUpperCase() : term[0]?.toUpperCase() + term.slice(1)}</p>`;
          })
          .join("") +
        (locale === "en-CA" || locale === "en-AU"
          ? '<p id="ambiguous">licence license</p>'
          : "");
      const found = (
        await reviewFixture(browser, html, {
          checks: { copy: { locale } },
          viewport: { width: 1440, height: 2000 },
        })
      ).filter(({ candidate: c }) => c.rule === "idiom:mixed-locale-spelling");
      expect(found).toHaveLength(wrong ? cases.length : 0);
      for (const { candidate: c } of found) {
        const i = Number(c.selectorHint.replace("#word-", ""));
        const row = cases[i] ?? [];
        const preferred =
          row[locale === "en-CA" ? 2 : locale === "en-US" ? 1 : 0] ?? "";
        const replacement =
          i % 2
            ? preferred.toUpperCase()
            : preferred[0]?.toUpperCase() + preferred.slice(1);
        expect(c.explanation).toContain(`"${replacement}"`);
        expect(c.acceptance.join(" ")).toContain(replacement);
        expect(c.verification.params).toEqual(
          expect.objectContaining({ preferred: replacement, locale }),
        );
      }
    }
  },
);

test("unconfigured locale preserves the legacy majority heuristic", async () => {
  const quiet = await reviewFixture(browser, "<p>Colors</p><p>Organize</p>");
  expect(
    quiet.filter(
      ({ candidate: c }) => c.rule === "idiom:mixed-locale-spelling",
    ),
  ).toEqual([]);
  const mixed = await reviewFixture(
    browser,
    '<p>Colours</p><p>Organise</p><p id="minority">Color</p>',
  );
  const hits = mixed.filter(
    ({ candidate: c }) => c.rule === "idiom:mixed-locale-spelling",
  );
  expect(hits).toHaveLength(1);
  expect(hits[0]?.candidate.selectorHint).toBe("#minority");
  expect(hits[0]?.candidate.explanation).toContain("en-GB (by majority");
});
