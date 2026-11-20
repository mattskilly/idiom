import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { baselineMissing } from "../src/unattended/condition.js";
import {
  conditionStorePath,
  openConditions,
  recordConditions,
} from "../src/unattended/store.js";
import { baseFixture, cli, page } from "./support/base-gate-fixture.js";

const exec = promisify(execFile);

const EXPECTATION_A =
  /^idiom gate: expectation: site\/s1: expect no longer matches at wide\/light: selector-present "#a"(; selector-present "#b")? — fix: /m;

type Finding = { rule?: string; selector?: string; problem: string };
const missing = (findings: Finding[], selector: string) =>
  findings.some(
    (finding) =>
      finding.rule === "idiom:expectation-selector-present" &&
      finding.problem.includes(JSON.stringify(selector)),
  );

test("the gate judges findings against the build's base, not a baseline main has moved past", async () => {
  const f = await baseFixture();
  try {
    // A baseline recorded on main, then main adds a blocker after it.
    const baselineCommit = await f.git("rev-parse", "HEAD");
    const recorded = await cli(f.directory, ["baseline", "record", "site"]);
    expect(recorded.status, recorded.err).toBe(0);
    await f.commit("record baseline");
    await f.write("app/r1/page.tsx", page('<h1>Detail</h1><p id="b">B</p>'));
    const base = await f.commit("main drops #a");
    // A later, unrelated branch touches the same page.
    await f.git("checkout", "--quiet", "-b", "feature");
    await f.write(
      "app/r1/page.tsx",
      page('<h1>Detail</h1><p id="b">B</p><p>New copy</p>'),
    );
    await f.commit("feature: new copy");
    // Nightly saw site's recorded baseline as unusable and left it open.
    const store = await conditionStorePath({ projectDirectory: f.directory });
    await recordConditions({
      path: store,
      mode: "nightly",
      observed: [
        baselineMissing({ mode: "nightly", flow: "site", what: "expired" }),
      ],
      cleared: [],
      now: new Date(),
    });
    const baselineOpen = async () =>
      (await openConditions(store)).some(
        (entry) => entry.key === "baseline:site",
      );

    const first = await cli(f.directory, [
      "check",
      "--gate",
      "--fail-on",
      "major",
      "--json",
    ]);
    // A base capture compares fine but is not the recorded baseline: the
    // open baseline condition stays open.
    expect(await baselineOpen()).toBe(true);
    // #a's expectation broke at the base, so the comparison holds it as
    // pre-existing; it is still broken coverage, never a pass.
    expect(first.status, first.err).toBe(2);
    expect(first.err).toMatch(EXPECTATION_A);
    const output = JSON.parse(first.out);
    expect(output.gate.comparisons.site).toMatchObject({
      mode: "base-capture",
      base,
      missingTuples: 1,
      baseCaptureMs: expect.any(Number),
    });
    const summary = output.checks[0].summary;
    expect(summary.baseline).toMatchObject({ source: "base-capture", base });
    expect(missing(summary.preExistingFindings, "#a")).toBe(true);
    expect(missing(summary.findings, "#a")).toBe(false);
    expect(first.err).toContain(
      `site: judged against base ${base.slice(0, 12)} (base capture, 1 tuple`,
    );
    // The committed baseline is untouched; the cache is in the Git dir.
    // (finding-names.json is the head check's own, as for any check.)
    expect(await f.git("status", "--porcelain", "--", ".idiom/baselines")).toBe(
      "",
    );
    const cachePath = (
      await exec("find", [
        join(f.directory, ".git", "idiom", "base-cache"),
        "-name",
        "site.json",
      ])
    ).stdout.trim();
    expect(cachePath).not.toBe("");

    // Again: the cached base capture, no worktree, same verdict.
    const second = await cli(f.directory, ["check", "--gate", "--json"]);
    expect(second.status, second.err).toBe(2);
    expect(second.err).toMatch(EXPECTATION_A);
    const again = JSON.parse(second.out);
    expect(again.gate.comparisons.site.mode).toBe("base-cache");
    expect(await baselineOpen()).toBe(true);
    expect(again.gate.comparisons.site.baseCaptureMs).toBeUndefined();
    expect(second.err).toContain("(cached base capture)");
    expect(missing(again.checks[0].summary.preExistingFindings, "#a")).toBe(
      true,
    );

    // check --changed shares the base comparison.
    const changed = await cli(f.directory, [
      "check",
      "site",
      "--changed",
      "--json",
      "--fail-on",
      "major",
    ]);
    expect(changed.status, changed.err).toBe(0);
    const changedSummary = JSON.parse(changed.out).checks[0].summary;
    expect(changedSummary.baseline.source).toBe("base-cache");
    expect(missing(changedSummary.preExistingFindings, "#a")).toBe(true);

    // Budget honesty: without the cache and with no time to capture the
    // base, the gate says so and charges what the old baseline lacks.
    const cached = await readFile(cachePath, "utf8");
    await rm(cachePath);
    const tight = await cli(f.directory, [
      "check",
      "--gate",
      "--budget",
      "1s",
      "--fail-on",
      "major",
      "--json",
    ]);
    expect(tight.status, tight.err).toBe(2);
    expect(tight.err).toContain(
      `comparing with baseline ${baselineCommit.slice(0, 12)}, 2 commit(s) behind base ${base.slice(0, 12)}`,
    );
    expect(tight.err).toMatch(/warning: base capture skipped \(~/);
    expect(JSON.parse(tight.out).gate.comparisons.site.mode).toBe("fallback");
    await writeFile(cachePath, cached);

    // A branch that introduces a finding still fails.
    await f.write("app/r1/page.tsx", page("<h1>Detail</h1><p>New copy</p>"));
    await f.commit("feature: drops #b");
    const introduced = await cli(f.directory, [
      "check",
      "--gate",
      "--fail-on",
      "major",
      "--json",
    ]);
    // Broken coverage outranks findings: exit 2 names both expectations.
    expect(introduced.status, introduced.err).toBe(2);
    expect(introduced.err).toMatch(EXPECTATION_A);
    const failing = JSON.parse(introduced.out).checks[0].summary;
    expect(missing(failing.findings, "#b")).toBe(true);
    expect(missing(failing.findings, "#a")).toBe(false);
    expect(missing(failing.preExistingFindings, "#a")).toBe(true);

    // baseline advance records main's tip (the cache, and the file on ask).
    const advanced = await cli(f.directory, [
      "baseline",
      "advance",
      "site",
      "--commit-file",
      "--json",
    ]);
    expect(advanced.status, advanced.err).toBe(0);
    expect(JSON.parse(advanced.out)).toMatchObject({
      target: "refs/heads/main",
      commit: base,
      flows: [
        { flow: "site", status: "advanced", tupleCount: 2, failedTuples: [] },
      ],
    });
    const file = JSON.parse(
      await readFile(join(f.directory, ".idiom/baselines/site.json"), "utf8"),
    );
    expect(file.records[0].commit).toBe(base);
  } finally {
    await f.cleanup();
  }
}, 240_000);
