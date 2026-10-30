import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error Action helpers are dependency-free Node modules.
import { renderComment } from "../scripts/github-action/comment.mjs";
// @ts-expect-error Action helpers are dependency-free Node modules.
import * as evidenceHelpers from "../scripts/github-action/evidence.mjs";
// @ts-expect-error Action helpers are dependency-free Node modules.
import { presentation } from "../scripts/github-action/presentation.mjs";
// @ts-expect-error Action helpers are dependency-free Node modules.
import { renderIndex } from "../scripts/github-action/report.mjs";
// @ts-expect-error Action helpers are dependency-free Node modules.
import * as resolutionHelpers from "../scripts/github-action/resolution.mjs";

const { stageCurrent, stageFinding, stageImage, tupleImages } = evidenceHelpers;
const { previousHead, resolvedFindings } = resolutionHelpers;

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
const finding = (
  severity = "major",
  basis: string | undefined = "measured",
  id = "issue",
) => ({
  id,
  fingerprint: id,
  severity,
  basis: basis as string | undefined,
  where: "editor/desktop",
  problem: `Problem ${id}`,
  fix: ["Repair the target"],
  acceptance: { version: 1, doneWhen: ["The target passes the rule"] },
});
const report = (findings = [finding()], failOn = "major") => ({
  flow: "studio",
  head: "b".repeat(40),
  baseline: "a".repeat(40),
  failOn,
  operationalErrors: [],
  unavailable: [],
  summary: { findings, fixed: [], preExistingFindings: [] },
});
const artifact = "https://github.com/owner/repo/actions/runs/1/artifacts/2";

test.each(["blocker", "major", "minor", "never"])(
  "tiers are disjoint and preserve every occurrence at %s",
  (threshold) => {
    const findings = ["blocker", "major", "minor"].flatMap((severity) =>
      ["measured", "observed", "judged", undefined].map((basis, index) => ({
        ...finding(severity, basis, `${severity}-${index}`),
        basis,
      })),
    );
    const result = report(findings, threshold);
    const original = JSON.stringify(result);
    const model = presentation(result);
    expect(
      model.tiers.flatMap((tier: { entries: unknown[] }) => tier.entries),
    ).toHaveLength(12);
    for (const [index, tier] of model.tiers.entries())
      for (const entry of tier.entries) {
        const rank = ["blocker", "major", "minor"].indexOf(entry.severity);
        const blocks =
          threshold !== "never" &&
          rank <= ["blocker", "major", "minor"].indexOf(threshold);
        expect(index).toBe(entry.basis === "judged" ? 2 : blocks ? 0 : 1);
      }
    renderComment(result, artifact);
    expect(JSON.stringify(result)).toBe(original);
  },
);

test.each([0, 1, 3, 4, 12])(
  "top-three expansion, tier-local details and exact counts for %s entries per tier",
  (count) => {
    const result = report(
      Array.from({ length: count }, (_, i) => [
        finding("major", "measured", `block-${i}`),
        finding("minor", "observed", `fix-${i}`),
        finding("major", "judged", `idea-${i}`),
      ]).flat(),
    );
    const body = renderComment(result, artifact);
    for (const name of ["Blocks merge", "Should fix", "Opportunities"]) {
      expect(body).toContain(`### ${name} (${count})`);
      if (count > 3) expect(body).toContain(`${count - 3} more in ${name}`);
    }
    expect(body.split("**Problem:**").length - 1).toBe(count * 3);
    expect(body.match(/<details>/g)?.length).toBe(
      body.match(/<\/details>/g)?.length,
    );
    expect(body).not.toContain("![");
  },
);

test("sorting retains source evidence; judged overlap and repeated questions appear once", () => {
  const result = {
    ...report(
      [
        finding("minor", "observed", "minor"),
        finding("major", "measured", "major"),
        finding("minor", "judged", "idea"),
      ],
      "never",
    ),
    crops: [
      { finding: 0, path: "crops/0.png", label: "minor crop" },
      { finding: 1, path: "crops/1.png", label: "major crop" },
    ],
  };
  Object.assign(result.summary, {
    advisory: {
      patterns: [
        {
          findings: [
            finding("minor", "judged", "idea"),
            finding("major", "judged", "other"),
          ],
        },
      ],
    },
    designSystemQuestions: [
      {
        id: "q",
        count: 500,
        suggestedToken: "space.big",
        question: "Add a step?",
      },
      { id: "q", count: 500 },
    ],
  });
  const model = presentation(result);
  expect(
    model.tiers[1].entries.map((entry: { id: string }) => entry.id),
  ).toEqual(["major", "minor"]);
  expect(model.tiers[1].entries[0].evidence.images[0].path).toBe("crops/1.png");
  expect(
    model.tiers[2].entries.map((entry: { id: string }) => entry.id),
  ).toEqual(["other", "idea", "q"]);
  const body = renderComment(result, artifact);
  for (const text of [
    "**Problem:**",
    "**Fix:**",
    "**Done when:**",
    "add\\-step",
    "drift",
    "500 occurrences",
    "space",
    "The target passes the rule",
  ])
    expect(body).toContain(text);
});

test("historical acceptance and empty repair contracts are explicit", () => {
  const result = report();
  Object.assign(result.summary.findings[0] ?? {}, {
    acceptance: ["Historical human acceptance"],
    fix: [],
  });
  let body = renderComment(result, artifact);
  expect(body).toContain("Historical human acceptance");
  expect(body).toContain("Repair instructions unavailable");
  Object.assign(result.summary.findings[0] ?? {}, { acceptance: [] });
  body = renderComment(result, artifact);
  expect(body).toContain("Acceptance criteria unavailable");
  expect(body).toContain("Evidence unavailable");
});

test("UTF-8 budget retains structure, counts, status and footer while HTML preserves omitted text", () => {
  const hostile = '<script>"💥漢字&[x](bad)\\</script>'.repeat(1200);
  const result = {
    ...report(
      Array.from({ length: 2000 }, (_, i) => ({
        ...finding(
          i % 2 ? "major" : "minor",
          i % 3 ? "observed" : "judged",
          `f-${i}`,
        ),
        problem: `${hostile} END-${i}`,
        fix: [hostile],
      })),
    ),
    flow: hostile,
    head: hostile,
    operationalErrors: [hostile, hostile, hostile, hostile],
    unavailable: [hostile],
  };
  const body = renderComment(result, artifact);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(55000);
  expect(body).toContain(artifact);
  expect(body).toContain("Further details omitted");
  expect(body).toContain("Operational status: 4 error(s)");
  expect(body).toContain("index.html, summary.json, comparison.json");
  expect(body.match(/<details>/g)?.length).toBe(
    body.match(/<\/details>/g)?.length,
  );
  expect(body).not.toContain("<script>");
  expect(body).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
  const html = renderIndex({
    ...report([{ ...finding(), problem: `${hostile} OMITTED-END` }]),
    unavailable: [hostile],
  });
  expect(html).toContain("OMITTED-END");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  const longUrl = renderComment(
    report(),
    `https://github.com/${"x".repeat(60000)}`,
  );
  expect(Buffer.byteLength(longUrl)).toBeLessThanOrEqual(55000);
  expect(longUrl).toContain("Further details omitted");
  expect(longUrl).toContain("index.html");
});

async function evidenceFixture() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-presentation-"));
  directories.push(directory);
  const runDirectory = join(directory, "run"),
    evidence = join(directory, "evidence");
  await mkdir(runDirectory);
  await mkdir(evidence);
  const png = PNG.sync.write(new PNG({ width: 5, height: 5 }));
  for (const name of ["crop.png", "film.png", "question.png"])
    await writeFile(join(runDirectory, name), png);
  return { directory, capture: { project: directory, runDirectory }, evidence };
}

test("filmstrips win, partial reasons persist, static fallbacks and run-relative question examples are labelled", async () => {
  const { directory, capture, evidence } = await evidenceFixture();
  const temporal = {
    ...finding(),
    timeline: { id: "click-1" },
    screenshot: "run/crop.png",
    filmstrip: "run/film.png",
  };
  const stored = [
    {
      id: temporal.id,
      fingerprint: temporal.fingerprint,
      evidence: { filmstrip: { status: "partial", reason: "frame missed" } },
    },
  ];
  let staged = await stageFinding(
    temporal,
    capture,
    evidence,
    "current",
    1,
    stored,
  );
  expect(staged.images[0].path).toBe("filmstrips/current/1.png");
  expect(staged.reasons.join()).toContain("frame missed");
  staged = await stageFinding(
    { ...temporal, filmstrip: "run/missing.png" },
    capture,
    evidence,
    "current",
    2,
  );
  expect(staged.images[0].label).toContain("Static fallback");
  expect(staged.reasons.join()).toContain("Filmstrip unavailable");
  await writeFile(
    join(capture.runDirectory, "unruled-decisions.json"),
    JSON.stringify([
      {
        id: "q",
        scaleCluster: {
          examples: [{ crop: "question.png" }, { crop: "missing.png" }],
        },
      },
    ]),
  );
  const result = { ...report([temporal]), crops: [] };
  Object.assign(result.summary, {
    designSystemQuestions: [
      { id: "q", question: "Scale?", count: 10, suggestedToken: "space.large" },
    ],
  });
  await stageCurrent(result, capture, evidence);
  const model = presentation(result);
  expect(model.tiers[2].entries[0].evidence.images[0].path).toBe(
    "crops/questions/1-1.png",
  );
  expect(model.tiers[2].entries[0].evidence.reasons.join()).toContain(
    "example 2 unavailable",
  );
  const html = renderIndex(result);
  expect(html).toContain('src="filmstrips/current/1.png"');
  expect(html).toContain('src="crops/questions/1-1.png"');
  for (const match of html.matchAll(/src="([^"]+)"/g))
    expect(
      PNG.sync.read(await readFile(join(evidence, match[1] ?? ""))).width,
    ).toBe(5);
  await stageImage(
    capture.runDirectory,
    "crop.png",
    evidence,
    "crops/other/1.png",
    "other",
  );
  await symlink(
    join(directory, "private.png"),
    join(capture.runDirectory, "escape.png"),
  );
  await writeFile(join(directory, "private.png"), "private");
  await expect(
    stageImage(
      capture.runDirectory,
      "escape.png",
      evidence,
      "crops/unsafe.png",
      "unsafe",
    ),
  ).rejects.toThrow("escapes");
  await expect(
    stageImage(
      capture.runDirectory,
      "crop.png",
      evidence,
      "../unsafe.png",
      "unsafe",
    ),
  ).rejects.toThrow("escapes");
});

test("history hashes and provenance are validated without guessing", async () => {
  const a = "a".repeat(40),
    b = "b".repeat(40);
  expect(previousHead({ action: "opened" })).toBeUndefined();
  expect(
    previousHead({
      action: "synchronize",
      before: a,
      after: b,
      pull_request: { head: { sha: b } },
    }),
  ).toBe(a);
  for (const before of [undefined, "bad", "0".repeat(40)])
    expect(() =>
      previousHead({ action: "synchronize", before, after: b }),
    ).toThrow();
  expect(() =>
    previousHead({
      action: "synchronize",
      before: a,
      after: b,
      pull_request: { head: { sha: a } },
    }),
  ).toThrow("does not match");
  const { capture } = await evidenceFixture();
  for (const name of ["one", "two"]) {
    await mkdir(join(capture.runDirectory, name));
    await writeFile(
      join(capture.runDirectory, name, "metadata.json"),
      JSON.stringify({
        flow: { id: "studio" },
        source: { commit: a },
        state: { id: "editor" },
        viewport: { name: "desktop" },
        failure: null,
      }),
    );
  }
  const tuples = await tupleImages(capture, "studio", a);
  expect(tuples.get("editor/desktop").failure).toContain("ambiguous");
  await expect(tupleImages(capture, "studio", b)).rejects.toThrow("provenance");
});

test("resolution joins fingerprints and coordinates and refuses stale, uncovered and one-sided evidence", () => {
  const previous = {
    findings: [finding(), { ...finding(), where: "editor/mobile" }],
  };
  const secondary = {
    fixed: [
      finding(),
      { ...finding(), where: "editor/mobile" },
      finding("major", "measured", "pre-existing"),
    ],
    baseline: { uncoveredTuples: [] },
  };
  const comparison = {
    changed: [{ key: "editor/desktop" }],
    unchanged: [],
    onlyBefore: [],
    onlyAfter: [],
    notComparable: [],
  };
  const tuples = new Map([
    ["editor/desktop", { failure: null }],
    ["editor/mobile", { failure: null }],
  ]);
  let result = resolvedFindings(
    previous,
    secondary,
    comparison,
    tuples,
    tuples,
  );
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0].where).toBe("editor/desktop");
  expect(result.notices.join()).toContain("editor/mobile");
  result = resolvedFindings(
    previous,
    { ...secondary, baseline: { stale: { reason: "changed checks" } } },
    comparison,
    tuples,
    tuples,
  );
  expect(result.findings).toEqual([]);
  expect(result.notices.join()).toContain("stale");
  expect(
    resolvedFindings(
      previous,
      { ...secondary, baseline: { uncoveredTuples: ["editor/desktop"] } },
      comparison,
      tuples,
      tuples,
    ).findings,
  ).toEqual([]);
  expect(
    resolvedFindings(previous, secondary, comparison, tuples, new Map())
      .findings,
  ).toEqual([]);
  expect(
    resolvedFindings(
      { findings: [{ ...finding(), fingerprint: undefined }] },
      secondary,
      comparison,
      tuples,
      tuples,
    ).notices.join(),
  ).toContain("matching candidate npm package");
});

test("comment and artifact keep tier precedence and incoming equal-severity order", () => {
  const result = report(
    [
      finding("minor", "measured", "minorfirst"),
      finding("major", "measured", "majorfirst"),
      finding("blocker", "measured", "blockerfirst"),
      finding("major", "measured", "majorsecond"),
    ],
    "never",
  );
  const ids = ["blockerfirst", "majorfirst", "majorsecond", "minorfirst"];
  expect(
    presentation(result).tiers[1].entries.map((e: { id: string }) => e.id),
  ).toEqual(ids);
  for (const output of [renderComment(result, artifact), renderIndex(result)]) {
    const positions = ids.map((id) => output.indexOf(`Problem ${id}`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  }
});
