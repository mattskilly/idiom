import { readFile } from "node:fs/promises";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ObservationArtifact } from "../src/checks/types.js";
import { type ReviewOptions, reviewFixture } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const desktop = { width: 1280, height: 800 };
const mobile = { width: 390, height: 844 };
const rules = new Set(["idiom:control-gap", "idiom:negative-spacing"]);
const html = (name: string) =>
  readFile(
    new URL(`./fixtures/control-gap/${name}.html`, import.meta.url),
    "utf8",
  );
async function review(name: string, options: ReviewOptions = {}) {
  const found = await reviewFixture(browser, await html(name), {
    viewport: desktop,
    ...options,
  });
  return found
    .map((f) => f.candidate)
    .filter((candidate) => rules.has(candidate.rule));
}
const summary = (found: Awaited<ReturnType<typeof review>>) =>
  found.map((c) => [c.rule, c.selectorHint]).sort();
const evidence = (found: Awaited<ReturnType<typeof review>>) =>
  found
    .map((c) => ({
      rule: c.rule,
      selector: c.selectorHint,
      fingerprint: c.fingerprintHint,
      params: c.verification.params,
    }))
    .sort((a, b) => (a.fingerprint ?? "").localeCompare(b.fingerprint ?? ""));
async function passes(name: string, options: ReviewOptions = {}) {
  for (const viewport of [desktop, mobile])
    expect(
      summary(await review(name, { viewport, ...options })),
      `${name} at ${viewport.width}`,
    ).toEqual([]);
}

test("a chip with gap 0 and word-spacing -2px is a control gap twice and negative spacing once", async () => {
  const found = await review("chip-cramped");
  const gaps = found.filter((c) => c.rule === "idiom:control-gap");
  const spacing = found.filter((c) => c.rule === "idiom:negative-spacing");
  expect(gaps.map((c) => c.selectorHint)).toEqual(["span.chip", "span.chip"]);
  const pairs = gaps.map((c) => [
    c.verification.params?.first,
    c.verification.params?.second,
  ]);
  expect(pairs).toHaveLength(2);
  expect(gaps[0]?.verification.params?.second).toBe(
    gaps[1]?.verification.params?.first,
  );
  expect(gaps[1]?.verification.params?.second).toBe(
    'button[aria-label="Reset offset"]',
  );
  for (const gap of gaps) {
    expect(gap.verification.params?.gap).toBeLessThan(4);
    expect(gap.verification.params?.min).toBe(4);
    expect(gap.explanation).toContain("px apart");
  }
  expect(gaps[1]?.explanation).toContain("text and control");
  expect(spacing).toHaveLength(1);
  expect(spacing[0]?.selectorHint).toBe("span.chip");
  expect(spacing[0]?.verification.params).toMatchObject({
    property: "word-spacing",
    value: -2,
  });
  expect(spacing[0]?.explanation).toContain("word-spacing: -2px");
});

test("two captures of the cramped chip produce identical findings", async () => {
  const first = evidence(await review("chip-cramped"));
  const second = evidence(await review("chip-cramped"));
  expect(first.length).toBe(3);
  expect(second).toEqual(first);
});

test("the same chip with gap 4px and normal spacing produces neither finding", async () => {
  await passes("chip-spaced");
});

test("a 4px icon gap, segmented tabs, a shared track, keycaps, affixes, one-run labels and prose are not control gaps", async () => {
  await passes("control-gap-near-miss");
});

test("the configured minimum is a check-time setting", async () => {
  // At min 0 nothing measured can be under it.
  expect(
    summary(
      await review("chip-cramped", { checks: { controlGap: { min: 0 } } }),
    ).filter(([rule]) => rule === "idiom:control-gap"),
  ).toEqual([]);
  // The spaced chip's 4px gaps fall under a 6px minimum.
  expect(
    summary(
      await review("chip-spaced", { checks: { controlGap: { min: 6 } } }),
    ),
  ).toEqual([
    ["idiom:control-gap", "span.chip"],
    ["idiom:control-gap", "span.chip"],
  ]);
});

test("negative spacing judges interface text by default and follows scope, include and ignore", async () => {
  expect(summary(await review("negative-spacing-scope"))).toEqual([
    ["idiom:negative-spacing", "a.home"],
    ["idiom:negative-spacing", "label.tight"],
  ]);
  expect(
    summary(
      await review("negative-spacing-scope", {
        checks: { negativeSpacing: { ignore: [".filters"] } },
      }),
    ),
  ).toEqual([["idiom:negative-spacing", "a.home"]]);
  const lede = ["idiom:negative-spacing", "p.lede"];
  expect(
    summary(
      await review("negative-spacing-scope", {
        checks: { negativeSpacing: { include: ["p.lede"] } },
      }),
    ),
  ).toContainEqual(lede);
  expect(
    summary(
      await review("negative-spacing-scope", {
        checks: { negativeSpacing: { scope: "all" } },
      }),
    ),
  ).toContainEqual(lede);
  // Content in the near-miss fixture fires only when scope widens.
  const widened = summary(
    await review("control-gap-near-miss", {
      checks: { negativeSpacing: { scope: "all" } },
    }),
  );
  expect(widened).toContainEqual(["idiom:negative-spacing", "p.story"]);
  // The heading is display-size (24px) tracking within -0.03em: exempt.
  expect(widened).not.toContainEqual(["idiom:negative-spacing", "h2.title"]);
});

test("negative letter-spacing on display-size text within the tracking range is not reported", async () => {
  const expected = [
    ["idiom:negative-spacing", "a.display-over"],
    ["idiom:negative-spacing", "a.display-words"],
    ["idiom:negative-spacing", "a.mini"],
    ["idiom:negative-spacing", "a.small-tight"],
    ["idiom:negative-spacing", "label.label-tight"],
  ];
  for (const viewport of [desktop, mobile])
    expect(
      summary(await review("negative-spacing-display", { viewport })),
      `at ${viewport.width}`,
    ).toEqual(expected);
  const found = await review("negative-spacing-display");
  // The small anchor inside the tight heading is judged at its own size.
  const mini = found.find((c) => c.selectorHint === "a.mini");
  expect(mini?.verification.params).toMatchObject({
    property: "letter-spacing",
    em: -0.04,
  });
  const words = found.find((c) => c.selectorHint === "a.display-words");
  expect(words?.verification.params).toMatchObject({
    property: "word-spacing",
    value: -2,
  });
});

test("displayTracking and displaySize configure the display exemption", async () => {
  const displayIn = ["idiom:negative-spacing", "a.display-in"];
  expect(
    summary(
      await review("negative-spacing-display", {
        checks: { negativeSpacing: { displayTracking: 0 } },
      }),
    ),
  ).toContainEqual(displayIn);
  expect(
    summary(
      await review("negative-spacing-display", {
        checks: { negativeSpacing: { displaySize: 30 } },
      }),
    ),
  ).toContainEqual(displayIn);
  expect(
    summary(
      await review("negative-spacing-display", {
        checks: { negativeSpacing: { displayTracking: -0.06 } },
      }),
    ),
  ).not.toContainEqual(["idiom:negative-spacing", "a.display-over"]);
});

test("disabled scans record no field", async () => {
  let observations: ObservationArtifact | undefined;
  await review("chip-cramped", {
    checks: {
      controlGap: { enabled: false },
      negativeSpacing: { enabled: false },
    },
    onObservations: (value) => {
      observations = value;
    },
  });
  expect(observations?.version).toBe(2);
  if (observations?.version !== 2) return;
  expect(observations.controlGaps).toBeUndefined();
  expect(observations.negativeSpacings).toBeUndefined();
});

test("a scoped minimum fires inside its surface only; without scopes nothing changes", async () => {
  // The spaced chip (gap 4px) inside the toolbar, and a copy outside it.
  const spaced = await html("chip-spaced");
  const chip = /<span class="chip"[\s\S]*?<\/button><\/span>/.exec(spaced)?.[0];
  if (chip === undefined) throw new Error("fixture changed");
  const both = spaced.replace(
    "</div>",
    `</div><p>${chip.replace('class="chip"', 'class="chip loose"')}</p>`,
  );
  const scoped = await reviewFixture(browser, both, {
    viewport: desktop,
    checks: {
      controlGap: {
        scopes: [
          {
            name: "Nothing in a toolbar sits closer than 6px.",
            selector: '[role="toolbar"]',
            min: 6,
          },
        ],
      },
    },
  });
  const gaps = scoped
    .map((f) => f.candidate)
    .filter((c) => c.rule === "idiom:control-gap");
  // Both gaps are in the toolbar's chip; the identical chip outside passes.
  expect(gaps.map((c) => c.selectorHint)).toEqual([
    "body > div > span",
    "body > div > span",
  ]);
  for (const gap of gaps) {
    expect(gap.verification.params).toMatchObject({
      min: 6,
      scope: '[role="toolbar"]',
    });
    expect(gap.explanation).toContain(
      'law: "Nothing in a toolbar sits closer than 6px.", in [role="toolbar"]',
    );
  }
  expect(summary(await review("chip-spaced"))).toEqual([]);
});
