import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  describesError,
  errorTextCheck,
  inDocumentation,
  isExplanatoryProse,
  isFailureSurface,
  longParagraphWords,
  proseSentenceWords,
} from "../src/checks/error-text.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { checksConfigSchema } from "../src/schemas/project.js";

/**
 * file-292: error-text tells help text that explains an error apart from a
 * failure message on screen.
 */
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
        join(import.meta.dirname, "fixtures/noise-defaults/error-prose.html"),
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
afterAll(async () => browser?.close());

function reported(errorPatterns: string[] = []) {
  const tuple: CheckTuple = {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1200,
    height: 800,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-11-08T00:00:00Z",
    console: [],
    mismatches: [],
    observations: observed,
  };
  return errorTextCheck
    .run({
      tuple,
      tuples: [tuple],
      narrowViewport: false,
      config: checksConfigFrom(checksConfigSchema.parse({ errorPatterns })),
    })
    .candidates.map((f) => f.selectorHint)
    .sort();
}

const failing = [
  "#banner",
  "#footer-prose",
  "#form-error",
  "#grid-error",
  "#mixed-leak",
  "#prose-object",
  "#short-embedded",
  "#status-prose",
  "#toast-trace",
  "#trace-dump",
];

test("failure messages report; explanatory prose in documentation does not", () => {
  expect(reported()).toEqual(failing);
});

test("a configured pattern in prose always reports", () => {
  expect(reported(["quota exhausted"])).toEqual(
    [...failing, "#custom-prose"].sort(),
  );
});

test("the reported label and explanation stay those of the first match", () => {
  const tuple: CheckTuple = {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1200,
    height: 800,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-11-08T00:00:00Z",
    console: [],
    mismatches: [],
    observations: observed,
  };
  const found = errorTextCheck.run({
    tuple,
    tuples: [tuple],
    narrowViewport: false,
    config: checksConfigFrom(checksConfigSchema.parse({})),
  }).candidates;
  expect(found.find((f) => f.selectorHint === "#mixed-leak")?.explanation).toBe(
    'A JavaScript exception is visible to people: "The settings panel showed a TypeError and then printed [object Object] where the name belongs." (#mixed-leak).',
  );
  expect(found.find((f) => f.selectorHint === "#banner")?.explanation).toBe(
    'A render failure is visible to people: "Renderer failed" (#banner).',
  );
});

function el(
  path: string,
  attributes: Record<string, string> = {},
  tag = path.split("/").at(-1)?.replace(/\[.*$/, "") ?? "div",
): ObservedElementV2 {
  return { structuralPath: path, attributes, tag } as ObservedElementV2;
}
const at = (text: string, phrase: string) => {
  const match = new RegExp(phrase, "i").exec(text);
  if (match === null) throw new Error(`no ${phrase}`);
  return match;
};

describe("describesError", () => {
  test("a short standalone line is never prose", () => {
    expect(
      describesError(
        "Failed to load images",
        at("Failed to load images", "failed to load"),
      ),
    ).toBe(false);
    expect(
      describesError(
        "Images failed to load.",
        at("Images failed to load.", "failed to load"),
      ),
    ).toBe(false);
  });
  test("a long sentence with the match mid-sentence or quoted is prose", () => {
    const mid =
      "Visible images that failed to load or decode and render as broken images.";
    expect(describesError(mid, at(mid, "failed to load"))).toBe(true);
    const quoted =
      '"Renderer failed" is the label a thumbnail shows when drawing stops.';
    expect(describesError(quoted, at(quoted, "renderer failed"))).toBe(true);
  });
  test("a long sentence that opens with the signature unquoted is not", () => {
    const text =
      "Failed to load the report because the export service timed out again.";
    expect(describesError(text, at(text, "failed to load"))).toBe(false);
  });
  test("only the sentence holding the match counts", () => {
    const text =
      "This page lists every reason a preview can break for you. Failed to load.";
    expect(describesError(text, at(text, "failed to load"))).toBe(false);
    const after =
      "Failed to load. Then a long sentence follows with many more words here.";
    expect(describesError(after, at(after, "failed to load"))).toBe(false);
  });
  test("thresholds are named", () => {
    expect(proseSentenceWords).toBe(8);
    expect(longParagraphWords).toBe(40);
    const long = `Failed to load ${"word ".repeat(40)}`;
    expect(describesError(long, at(long, "failed to load"))).toBe(true);
  });
});

describe("isFailureSurface", () => {
  test("roles, live regions, output and class segments", () => {
    for (const attributes of [
      { role: "alert" },
      { role: "status" },
      { role: "log" },
      { role: "alertdialog" },
      { "aria-live": "polite" },
      { "aria-live": "assertive" },
      { class: "error-banner" },
      { class: "toast" },
      { class: "form__error" },
      { class: "empty-state" },
      { class: "thumb-failed" },
    ])
      expect(
        isFailureSurface(el("body[1]/div[1]", attributes), []),
        JSON.stringify(attributes),
      ).toBe(true);
    expect(isFailureSurface(el("body[1]/output[1]"), [])).toBe(true);
    for (const attributes of [
      { class: "banner" },
      { class: "terror" },
      { "aria-live": "off" },
      { role: "region" },
    ])
      expect(
        isFailureSurface(el("body[1]/div[1]", attributes), []),
        JSON.stringify(attributes),
      ).toBe(false);
  });
  test("an ancestor surface counts", () => {
    expect(
      isFailureSurface(el("body[1]/div[1]/p[1]"), [
        el("body[1]/div[1]", { role: "alert" }),
      ]),
    ).toBe(true);
  });
});

describe("inDocumentation", () => {
  test("by tag in the path or by landmark role", () => {
    expect(inDocumentation(el("html[1]/body[1]/main[1]/p[1]"), [])).toBe(true);
    expect(
      inDocumentation(el("html[1]/body[1]/div[1]/article[2]/p[1]"), []),
    ).toBe(true);
    expect(inDocumentation(el("html[1]/body[1]/footer[1]/p[1]"), [])).toBe(
      false,
    );
    expect(inDocumentation(el("html[1]/body[1]/domain[1]/p[1]"), [])).toBe(
      false,
    );
    expect(
      inDocumentation(el("html[1]/body[1]/div[1]/p[1]"), [
        el("html[1]/body[1]/div[1]", { role: "main" }),
      ]),
    ).toBe(true);
  });
});

describe("isExplanatoryProse", () => {
  const text =
    "Visible images that failed to load and then printed [object Object] for each one.";
  const prose = el("html[1]/body[1]/main[1]/p[1]");
  test("phrase-only describing prose is exempt", () => {
    expect(
      isExplanatoryProse(
        text,
        [{ kind: "phrase", match: at(text, "failed to load") }],
        prose,
        [],
      ),
    ).toBe(true);
  });
  test("a phrase plus a leak or configured match is not", () => {
    expect(
      isExplanatoryProse(
        text,
        [
          { kind: "phrase", match: at(text, "failed to load") },
          { kind: "leak", match: at(text, "\\[object Object\\]") },
        ],
        prose,
        [],
      ),
    ).toBe(false);
  });
  test("a surface or a page outside documentation is not", () => {
    const matches = [
      { kind: "phrase" as const, match: at(text, "failed to load") },
    ];
    expect(
      isExplanatoryProse(
        text,
        matches,
        el("html[1]/body[1]/main[1]/p[1]", { class: "error" }),
        [],
      ),
    ).toBe(false);
    expect(
      isExplanatoryProse(text, matches, el("html[1]/body[1]/div[1]/p[1]"), []),
    ).toBe(false);
  });
});
