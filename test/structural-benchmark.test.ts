import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { checksConfigSchema } from "../src/schemas/project.js";
import { reviewFixture, reviewStates } from "./benchmark-support.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
const load = (name: string) =>
  readFile(join(import.meta.dirname, "fixtures/structural", name), "utf8");
const viewport = (width: number) => ({ width, height: 900 });

async function primaryRegion(name: string, width: number, checks: unknown) {
  const { findings, tuples } = await reviewStates(
    browser,
    [{ state: "plan", html: await load(name) }],
    { viewport: viewport(width), checks },
  );
  const coverage = runDeterministicChecks(
    tuples,
    undefined,
    checksConfigFrom(checksConfigSchema.parse(checks)),
  ).coverage.find(({ coverage }) => coverage.check === "primary-region");
  return {
    findings: findings
      .map(({ candidate }) => candidate)
      .filter((candidate) => candidate.category === "primary-region"),
    reason: coverage?.coverage.reason,
    status: coverage?.coverage.status,
  };
}

const region = { primaryRegion: { selector: "main.frame", minShare: 0.65 } };

test.each([
  [1440, "44%"],
  [1280, "37%"],
])(
  "%ipx: a %s-wide page frame is below the 65% minimum",
  async (width, share) => {
    const before = await primaryRegion(
      "primary-region-before.html",
      width,
      region,
    );
    expect(before.findings).toHaveLength(1);
    expect(before.findings[0]?.explanation).toContain(share);
    expect(before.findings[0]?.rule).toBe("idiom:primary-region-share");
    expect(before.reason).toBe(
      `main.frame is ${share} of ${width}px (minimum 65%)`,
    );

    const after = await primaryRegion(
      "primary-region-after.html",
      width,
      region,
    );
    expect(after.findings).toEqual([]);
    expect(after.status).toBe("ran");
    expect(after.reason).toBe(`main.frame is 75% of ${width}px (minimum 65%)`);
  },
);

test("primaryRegion.minShare can be keyed by viewport", async () => {
  const keyed = await primaryRegion("primary-region-before.html", 1440, {
    primaryRegion: { selector: "main.frame", minShare: { desktop: 0.65 } },
  });
  expect(keyed.findings).toHaveLength(1);
  const other = await primaryRegion("primary-region-before.html", 1440, {
    primaryRegion: { selector: "main.frame", minShare: { mobile: 0.9 } },
  });
  expect(other.findings).toEqual([]);
  expect(other.reason).toBe(
    "main.frame is 44% of 1440px (no minimum for viewport desktop)",
  );
});

const alarmFindings = async (
  name: string,
  options: { state?: string; checks?: unknown } = {},
) =>
  (
    await reviewFixture(browser, await load(name), {
      ...options,
      onObservations: (value) => {
        expect(observationArtifactSchema.parse(value)).toEqual(value);
      },
    })
  )
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "alarm-at-rest");

const flagged = (findings: Awaited<ReturnType<typeof alarmFindings>>) =>
  findings.flatMap((candidate) => {
    const match = candidate.explanation.match(/\(([^)]*)\) with no error/);
    return (match?.[1] ?? "").split(", ");
  });

test("an orange warning icon on a resting Goals tab is reported; the invalid field and the Delete icon are not", async () => {
  const before = await alarmFindings("alarm-before.html");
  const selectors = flagged(before);
  expect(selectors).toContain("svg.tab-icon");
  expect(selectors).toContain("#habits-mark");
  expect(selectors).toContain("#streaks-dot");
  expect(selectors).not.toContain("#email-error-icon");
  expect(selectors).not.toContain("#trash");
  expect(before.map((candidate) => candidate.rule).sort()).toEqual([
    "idiom:alarm-color-at-rest",
    "idiom:alarm-glyph-at-rest",
    "idiom:alarm-glyph-at-rest",
  ]);
  expect(before.every((candidate) => candidate.severity === "minor")).toBe(
    true,
  );

  expect(await alarmFindings("alarm-after.html")).toEqual([]);
});

test("an error state id is warning context", async () => {
  expect(
    await alarmFindings("alarm-before.html", { state: "goals-error" }),
  ).toEqual([]);
});

test("a brand red is exempt unless it is a configured alarm colour", async () => {
  const brand = await alarmFindings("alarm-before.html", {
    checks: { alarm: { brand: ["#e5484d"] } },
  });
  expect(flagged(brand)).not.toContain("#streaks-dot");
  expect(flagged(brand)).toContain("svg.tab-icon");

  const configured = await alarmFindings("alarm-before.html", {
    checks: { alarm: { brand: ["#e5484d"], colors: ["#e5484d"] } },
  });
  expect(flagged(configured)).toContain("#streaks-dot");
});

test("alarm.ignore exempts matched icons", async () => {
  const ignored = await alarmFindings("alarm-before.html", {
    checks: { alarm: { ignore: ["#tab-streaks"] } },
  });
  expect(flagged(ignored)).not.toContain("#streaks-dot");
});

const naming = {
  naming: {
    surfaces: {
      tree: "#tree",
      breadcrumb: "#crumbs",
      chip: "#chip",
      toolbar: "#toolbar",
    },
  },
};

const namingFindings = async (name: string) =>
  (
    await reviewFixture(browser, await load(name), {
      checks: naming,
      onObservations: (value) => {
        expect(observationArtifactSchema.parse(value)).toEqual(value);
      },
    })
  )
    .map(({ candidate }) => candidate)
    .filter((candidate) => candidate.category === "cross-surface-naming");

test("one heading named three ways across surfaces is one finding listing each label", async () => {
  const before = await namingFindings("naming-before.html");
  expect(before).toHaveLength(1);
  expect(before[0]).toMatchObject({
    rule: "idiom:cross-surface-name",
    severity: "minor",
    fingerprintHint: "naming:h1",
  });
  expect(before[0]?.explanation).toBe(
    'Node h1 is named differently across surfaces: tree "Heading", breadcrumb "Stack", chip "Heading", toolbar "Heading 1".',
  );
  expect(before[0]?.verification.params).toEqual({
    nodeId: "h1",
    labels: {
      tree: "Heading",
      breadcrumb: "Stack",
      chip: "Heading",
      toolbar: "Heading 1",
    },
  });

  // Tree rows keep their own labels ("Page", "Stack"), matching their crumbs,
  // and a capitalised "heading" matches "Heading".
  expect(await namingFindings("naming-after.html")).toEqual([]);
});

test("the new checks stay quiet when unconfigured", async () => {
  const found = (await reviewFixture(browser, await load("naming-before.html")))
    .map(({ candidate }) => candidate.category)
    .filter((category) =>
      ["primary-region", "cross-surface-naming"].includes(category),
    );
  expect(found).toEqual([]);
});
