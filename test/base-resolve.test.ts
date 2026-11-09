import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  comparisonWithCapture,
  composeBaseRecord,
  type PlannedTuple,
  resolveBaseComparison,
  settleBaseComparison,
} from "../src/baseline/base.js";
import {
  baseCachePath,
  engineIdentity,
  readBaseCache,
  writeBaseCacheRecord,
} from "../src/baseline/base-cache.js";
import { checksConfigHash } from "../src/baseline/config-hash.js";
import type { GitAncestry } from "../src/baseline/resolve.js";
import type { BaselineRecord } from "../src/baseline/schema.js";
import type { GitRead } from "../src/changed/git.js";
import type { ValidationResult } from "../src/validation.js";

const sha = (digit: string) => digit.repeat(40);
const BASE = sha("b");
const OLD = sha("a");
const BRANCH = sha("c");
const checks = { probe: { enabled: false } };
const currentHash = checksConfigHash(checks as never);

let directory: string;
let diffs: Record<string, string[]>;
let ancestors: Record<string, boolean | undefined>;
const git: GitRead = async (_cwd, args) => {
  if (args.join(" ") === "rev-parse --show-toplevel") return `${directory}\n`;
  if (args.join(" ") === "rev-parse --git-common-dir")
    return `${join(directory, ".git")}\n`;
  if (args[0] === "diff") {
    const from = args[4] as string;
    return (diffs[from] ?? []).map((path) => `${path}\0`).join("");
  }
  throw new Error(`unexpected git ${args.join(" ")}`);
};
const ancestry: GitAncestry = {
  head: async () => sha("f"),
  isAncestor: async (_cwd, commit) => ancestors[commit],
  distance: async (_cwd, commit) => (commit === BASE ? 0 : 3),
};
const validated = () =>
  ({
    projectDirectory: directory,
    project: { checks },
    flows: [],
  }) as unknown as ValidationResult;

const record = (
  commit: string,
  tuples: Array<{ state: string; findings?: string[] }>,
  configHash = currentHash,
): BaselineRecord => ({
  commit,
  recordedAt: "2026-11-01T00:00:00.000Z",
  idiomVersion: "0.0.0",
  configHash,
  tuples: tuples.map(({ state, findings = [] }) => ({
    state,
    viewport: "desktop",
    findings: findings.map((fingerprint) => ({
      fingerprint,
      aliases: [],
      category: "missing-state",
      rule: "idiom:expectation-selector-present",
      severity: "blocker",
      selector: "#x",
    })),
  })),
});
const planned = (...states: string[]): PlannedTuple[] =>
  states.map((state) => ({ state, viewport: "desktop", scheme: "light" }));
async function commitBaseline(...records: BaselineRecord[]) {
  await mkdir(join(directory, ".idiom/baselines"), { recursive: true });
  await writeFile(
    join(directory, ".idiom/baselines/site.json"),
    JSON.stringify({ version: 1, flow: "site", records }),
  );
}
const resolveFor = (tuples: PlannedTuple[]) =>
  resolveBaseComparison({
    validated: validated(),
    flow: "site",
    base: BASE,
    tuples,
    nonUi: ["src/**"],
    git,
    ancestry,
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "idiom-base-resolve-"));
  await mkdir(join(directory, ".git"));
  diffs = {};
  ancestors = { [BASE]: true, [OLD]: true, [BRANCH]: false };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("a baseline recorded at the base covers the gate with no capture", async () => {
  await commitBaseline(record(BASE, [{ state: "s1" }, { state: "s2" }]));
  const resolution = await resolveFor(planned("s1"));
  expect(resolution.missing).toEqual([]);
  expect(resolution.covering.map((entry) => entry.source)).toEqual([
    "baseline",
  ]);
  const settled = await settleBaseComparison({
    resolution,
    flow: "site",
    configHash: currentHash,
  });
  expect(settled.comparison).toMatchObject({ source: "baseline", base: BASE });
  expect(settled.comparison?.baselineCommit).toBeUndefined();
  // The whole record, so tuples the head did not capture read as uncovered.
  expect(settled.comparison?.record.tuples).toHaveLength(2);
});

test("a baseline behind the base is current when only non-UI paths changed since", async () => {
  diffs[OLD] = ["src/a.ts", "docs/x.md", ".idiom/baselines/site.json"];
  await commitBaseline(record(OLD, [{ state: "s1" }]));
  const resolution = await resolveFor(planned("s1"));
  expect(resolution.missing).toEqual([]);
  const settled = await settleBaseComparison({
    resolution,
    flow: "site",
    configHash: currentHash,
  });
  expect(settled.comparison).toMatchObject({
    source: "baseline",
    baselineCommit: OLD,
    behindBase: 3,
  });
  expect(settled.comparison?.record.commit).toBe(BASE);
});

test("a UI change since the baseline needs a base capture; the baseline is the fallback", async () => {
  diffs[OLD] = ["app/r1/page.tsx"];
  await commitBaseline(record(OLD, [{ state: "s1", findings: ["aa"] }]));
  const resolution = await resolveFor(planned("s1", "s2"));
  expect(resolution.missing).toEqual(planned("s1", "s2"));
  expect(resolution.covering).toEqual([]);
  expect(resolution.fallback).toMatchObject({
    source: "baseline",
    behindBase: 3,
  });
  const skipped = await settleBaseComparison({
    resolution,
    flow: "site",
    configHash: currentHash,
    skipped: "base capture skipped (~1m over the 3m budget)",
  });
  expect(skipped.warning).toBe(
    `warning: base capture skipped (~1m over the 3m budget); comparing with baseline ${OLD.slice(0, 12)}, 3 commit(s) behind base ${BASE.slice(0, 12)} — findings already at the base may be counted as new; run idiom baseline advance site`,
  );
  expect(skipped.comparison).toMatchObject({ source: "fallback" });
});

test("records not reachable from the base (a squash-merged branch) are ignored", async () => {
  await commitBaseline(record(BRANCH, [{ state: "s1" }]));
  const resolution = await resolveFor(planned("s1"));
  expect(resolution.missing).toHaveLength(1);
  expect(resolution.fallback).toBeUndefined();
  const settled = await settleBaseComparison({
    resolution,
    flow: "site",
    configHash: currentHash,
    skipped: "base capture skipped",
  });
  expect(settled.comparison).toBeUndefined();
  expect(settled.unavailable).toBe(
    `no baseline reachable from base ${BASE.slice(0, 12)}; gating open findings`,
  );
  expect(settled.warning).toContain("run idiom baseline advance site");
});

test("a stale-config baseline never covers but still serves as fallback", async () => {
  await commitBaseline(
    record(BASE, [{ state: "s1" }], `sha256:${"0".repeat(64)}`),
  );
  const resolution = await resolveFor(planned("s1"));
  expect(resolution.missing).toHaveLength(1);
  expect(resolution.fallback?.record.commit).toBe(BASE);
});

test("the base cache covers what it holds; only missing tuples are captured", async () => {
  const path = await baseCachePath(directory, "site", git);
  expect(path.startsWith(join(directory, ".git", "idiom", "base-cache"))).toBe(
    true,
  );
  await writeBaseCacheRecord(path, "site", record(BASE, [{ state: "s1" }]));
  const partial = await resolveFor(planned("s1", "s2"));
  expect(partial.missing).toEqual(planned("s2"));
  expect(partial.covering.map((entry) => entry.source)).toEqual(["base-cache"]);
  await writeBaseCacheRecord(path, "site", record(BASE, [{ state: "s2" }]));
  const full = await resolveFor(planned("s1", "s2"));
  expect(full.missing).toEqual([]);
  const settled = await settleBaseComparison({
    resolution: full,
    flow: "site",
    configHash: currentHash,
  });
  expect(settled.comparison?.source).toBe("base-cache");
  // A different Idiom build never reuses the entry.
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      flow: "site",
      records: (await readBaseCache(path, "site")).map((entry) => ({
        ...entry,
        engine: "0.0.0+elsewhere",
      })),
    }),
  );
  expect((await resolveFor(planned("s1"))).missing).toHaveLength(1);
});

test("the cache merges tuples per key, caps records and reads corruption as empty", async () => {
  const path = join(directory, "cache", "site.json");
  await writeBaseCacheRecord(path, "site", record(BASE, [{ state: "s1" }]));
  await writeBaseCacheRecord(
    path,
    "site",
    record(BASE, [{ state: "s1", findings: ["ab"] }, { state: "s2" }]),
  );
  const [merged, ...others] = await readBaseCache(path, "site");
  expect(others).toEqual([]);
  expect(merged?.engine).toBe(engineIdentity());
  expect(merged?.tuples.map((tuple) => tuple.state)).toEqual(["s1", "s2"]);
  expect(merged?.tuples[0]?.findings).toHaveLength(1);
  await writeBaseCacheRecord(
    path,
    "site",
    record(BASE, [{ state: "s1" }], `sha256:${"1".repeat(64)}`),
  );
  expect(await readBaseCache(path, "site")).toHaveLength(2);
  for (let index = 0; index < 25; index++)
    await writeBaseCacheRecord(
      path,
      "site",
      record(index.toString(16).padStart(40, "0"), [{ state: "s1" }]),
    );
  expect(await readBaseCache(path, "site")).toHaveLength(20);
  await writeFile(path, "{not json");
  expect(await readBaseCache(path, "site")).toEqual([]);
  expect(await readBaseCache(join(directory, "missing.json"), "site")).toEqual(
    [],
  );
});

test("a base capture overrides stored tuples; a failed one falls back per coordinate", async () => {
  diffs[OLD] = ["app/r1/page.tsx"];
  await commitBaseline(
    record(OLD, [
      { state: "s1", findings: ["aa"] },
      { state: "s2", findings: ["bb"] },
    ]),
  );
  const resolution = await resolveFor(planned("s1", "s2"));
  const comparison = comparisonWithCapture(
    resolution,
    {
      record: record(BASE, [{ state: "s1", findings: ["cc"] }]),
      failedTupleKeys: ["s2/desktop"],
    },
    currentHash,
  );
  expect(comparison.source).toBe("base-capture");
  const byState = Object.fromEntries(
    comparison.record.tuples.map((tuple) => [
      tuple.state,
      tuple.findings.map((finding) => finding.fingerprint),
    ]),
  );
  expect(byState).toEqual({ s1: ["cc"], s2: ["bb"] });
  expect(comparison.notes.join("\n")).toContain(
    `judged s2/desktop against baseline ${OLD.slice(0, 12)}`,
  );
  expect(
    composeBaseRecord(BASE, [record(BASE, []), record(OLD, [{ state: "s3" }])])
      .tuples,
  ).toHaveLength(1);
});

test("a base capture that throws degrades to the fallback; cancellation propagates", async () => {
  diffs[OLD] = ["app/r1/page.tsx"];
  await commitBaseline(record(OLD, [{ state: "s1" }]));
  const resolution = await resolveFor(planned("s1"));
  const failed = await settleBaseComparison({
    resolution,
    flow: "site",
    configHash: currentHash,
    capture: async () => {
      throw new Error("bun install failed");
    },
  });
  expect(failed.comparison?.source).toBe("fallback");
  expect(failed.warning).toMatch(
    /^warning: base capture failed \(bun install failed\); comparing with baseline/,
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(
    settleBaseComparison({
      resolution,
      flow: "site",
      configHash: currentHash,
      signal: controller.signal,
      capture: async () => {
        throw new Error("cancelled");
      },
    }),
  ).rejects.toThrow("cancelled");
});
