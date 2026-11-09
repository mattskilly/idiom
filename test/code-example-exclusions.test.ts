import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { copyLintCheck } from "../src/checks/copy-lint.js";
import { errorTextCheck } from "../src/checks/error-text.js";
import { observePage } from "../src/checks/observe.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type {
  CheckTuple,
  DeterministicCheck,
  ObservationArtifactV2,
} from "../src/checks/types.js";
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
        join(import.meta.dirname, "fixtures/noise-defaults/code-examples.html"),
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
const policy = {
  glossary: [{ term: "leverage" }],
  retired: [{ term: "legacy", preferred: "current" }],
  jargon: [{ term: "synergy", preferred: "cooperation" }],
  schemaWords: ["entity"],
};
function run(
  check: DeterministicCheck,
  observations = observed,
  copy: unknown = policy,
) {
  const tuple: CheckTuple = {
    flow: "f",
    state: "s",
    viewport: "desktop",
    width: 1200,
    height: 800,
    metadataPath: "m.json",
    artifactPaths: [],
    commit: "fixture",
    createdAt: "2026-11-07T00:00:00Z",
    console: [],
    mismatches: [],
    observations,
  };
  return check.run({
    tuple,
    tuples: [tuple],
    narrowViewport: false,
    config: checksConfigFrom(
      checksConfigSchema.parse({ copy, errorPatterns: ["CUSTOM_FAILURE"] }),
    ),
  });
}
function at(id: string, artifact = observed) {
  const element = artifact.elements.find(
    (element) => element.selector === `#${id}`,
  );
  if (!element) throw new Error(`Missing #${id}`);
  return element;
}
const repeated = (artifact = observed) =>
  run(copyLintCheck, artifact)
    .candidates.filter((f) => f.rule === "idiom:repeated-words")
    .map((f) => f.selectorHint)
    .sort();

test("code samples and explanatory prose are excluded; real leaks retain their format", () => {
  const found = run(errorTextCheck).candidates;
  expect(found.map((f) => f.selectorHint).sort()).toEqual([
    "#custom-copy",
    "#object",
    "#toast",
  ]);
  // Grouping remains by text; identical object leaks are grouped at the first owner.
  expect(
    found.find((f) => f.selectorHint === "#object")?.explanation,
  ).toContain("3 places");
  expect(found.find((f) => f.selectorHint === "#toast")).toEqual({
    category: "error-text",
    severity: "major",
    rule: "idiom:visible-error-text",
    selectorHint: "#toast",
    explanation: 'Raw JSON is visible to people: "{"failure":true}" (#toast).',
    acceptance: [
      "No engineering error text is visible; failures render a designed fallback with a recovery action.",
    ],
    verification: { check: "error-text", params: { selector: "#toast" } },
  });
});

test("only quoted stutters and artificial inline-code adjacency disappear", () => {
  expect(repeated()).toEqual([
    "#caption-copy",
    "#empty-inline",
    "#escaped",
    "#identical-unquoted",
    "#inline-mono",
    "#long-copy",
    "#mixed-after",
    "#mixed-before",
    "#mixed-owner-child",
    "#mono-control",
    "#object",
    "#overlap",
    "#real-and",
    "#real-stutter",
    "#separate-block",
    "#unbalanced",
  ]);
  expect(
    run(copyLintCheck).candidates.find(
      (f) => f.selectorHint === "#real-stutter",
    ),
  ).toMatchObject({
    category: "copy-lint",
    severity: "major",
    rule: "idiom:repeated-words",
    explanation: '"Save save" (#real-stutter) repeats itself ("Save save").',
    verification: {
      check: "copy-lint",
      params: { selector: "#real-stutter", rule: "idiom:repeated-words" },
    },
  });
});

test("segments retain DOM positions and serialization without changing directText", () => {
  expect(at("from-code").directText).toBe("from from");
  expect(at("from-code").copyTextSegments).toEqual([
    { text: "from ", quoted: false },
    { text: " from ", quoted: false },
  ]);
  expect(at("quoted-child").copyTextSegments).toEqual([
    { text: "Save save", quoted: true },
  ]);
  expect(at("identical-unquoted").copyTextSegments).toEqual([
    { text: "Save save", quoted: false },
  ]);
  const parsed = observationArtifactSchema.parse(
    JSON.parse(JSON.stringify(observed)),
  ) as ObservationArtifactV2;
  expect(repeated(parsed)).toEqual(repeated());
  expect(at("quoted-child", parsed).copyTextSegments).toEqual(
    at("quoted-child").copyTextSegments,
  );
  const legacy = structuredClone(observed);
  for (const element of legacy.elements) delete element.copyTextSegments;
  expect(observationArtifactSchema.safeParse(legacy).success).toBe(true);
  const fallback = repeated(legacy);
  expect(fallback).not.toContain("#q-child");
  expect(fallback).not.toContain("#blockquote-child");
  expect(fallback).not.toContain("#straight");
  expect(fallback).toContain("#mixed-after");
  // Older captures cannot recover quote context from a different node or inline boundaries.
  expect(fallback).toContain("#quoted-child");
  expect(fallback).toContain("#from-code");
});

test("all copy branches exclude code before locale/casing votes; quoted policies still apply", () => {
  for (const locale of [undefined, "en-US"]) {
    const found = run(copyLintCheck, observed, {
      ...policy,
      locale,
    }).candidates;
    expect(
      found.some((f) => /#(?:code-|copy-code|mono-copy)/.test(f.selectorHint)),
    ).toBe(false);
    for (const [id, rule] of [
      ["ordinary-token", "engineering-token-in-copy"],
      ["ordinary-dotted", "engineering-token-in-copy"],
      ["ordinary-slash", "engineering-token-in-copy"],
      ["ordinary-schema", "schema-word-in-copy"],
      ["quoted-policy", "glossary-term"],
      ["quoted-policy", "retired-term"],
      ["quoted-policy", "jargon-in-copy"],
      ["quoted-policy", "mixed-locale-spelling"],
      ["case-upper", "mixed-label-casing"],
    ])
      expect(
        found.some(
          (f) => f.selectorHint === `#${id}` && f.rule === `idiom:${rule}`,
        ),
        `${id}/${rule}`,
      ).toBe(true);
    expect(found.some((f) => f.selectorHint === "#case-control")).toBe(false);
  }
});

test("signals coverage still discloses legacy observations", () => {
  const legacy = structuredClone(observed);
  for (const element of legacy.elements) delete element.signals;
  for (const check of [copyLintCheck, errorTextCheck]) {
    expect(run(check, legacy).coverage.status).toBe("unavailable");
    expect(
      run(check, { ...legacy, version: 1 } as unknown as ObservationArtifactV2)
        .coverage.status,
    ).toBe("unavailable");
  }
});
