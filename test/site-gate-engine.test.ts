// The self-gate's base comparison across builds: this repository's
// out-of-tree CLI keys shared base records by a fingerprint of its check and
// capture code, so builds with identical code reuse one base capture.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error The local CLI builder is a dependency-free Node module.
import { engineFingerprint } from "../scripts/idiom-local.mjs";
import {
  type PlannedTuple,
  resolveBaseComparison,
  settleBaseComparison,
} from "../src/baseline/base.js";
import {
  engineIdentity,
  readBaseCache,
  writeBaseCacheRecord,
} from "../src/baseline/base-cache.js";
import { checksConfigHash } from "../src/baseline/config-hash.js";
import type { GitAncestry } from "../src/baseline/resolve.js";
import type { BaselineRecord } from "../src/baseline/schema.js";
import type { GitRead } from "../src/changed/git.js";
import type { ValidationResult } from "../src/validation.js";
import { IDIOM_BUILD_COMMIT, IDIOM_VERSION } from "../src/version.js";

const sha = (digit: string) => digit.repeat(40);
const M0 = sha("a");
const M1 = sha("b");
const HEAD_A = sha("c");
const checks = { probe: { enabled: false } };
const currentHash = checksConfigHash(checks as never);

// ── Fixture source trees, one per build branch ──────────────────────────────
const branchFiles: Record<string, string> = {
  "src/baseline/base.ts":
    'import { rule } from "../checks/rule.ts";\nimport { build } from "./record.ts";\nexport const base = () => build(rule());\n',
  "src/baseline/record.ts": "export const build = (x: number) => ({ x });\n",
  "src/checks/rule.ts": "export const rule = () => 1;\n",
  "src/commands/help.ts": 'export const help = "help";\n',
  "site/index.html": "<h1>Idiom</h1>\n",
  "package.json": JSON.stringify({ dependencies: { zod: "4.0.0" } }),
  "bun.lock": "lock v1\n",
};
const trees: string[] = [];
async function branch(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "idiom-engine-"));
  trees.push(root);
  for (const [path, content] of Object.entries({
    ...branchFiles,
    ...overrides,
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
afterAll(async () => {
  await Promise.all(
    trees.map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("the fingerprint covers check and capture code, not unrelated code", async () => {
  const a = await engineFingerprint({ root: await branch() });
  expect(a).toMatch(/^source:[0-9a-f]{20}$/);
  const b = await engineFingerprint({
    root: await branch({
      "src/commands/help.ts": 'export const help = "more help";\n',
      "site/index.html": "<h1>Idiom, changed</h1>\n",
    }),
  });
  expect(b).toBe(a);
  for (const changed of [
    { "src/checks/rule.ts": "export const rule = () => 2;\n" },
    {
      "src/baseline/record.ts":
        "export const build = (y: number) => ({ y });\n",
    },
    { "package.json": JSON.stringify({ dependencies: { zod: "4.0.1" } }) },
    { "bun.lock": "lock v2\n" },
  ])
    expect(await engineFingerprint({ root: await branch(changed) })).not.toBe(
      a,
    );
});

test("installed CLIs keep keying records by version and build commit", () => {
  expect(engineIdentity()).toBe(`${IDIOM_VERSION}+${IDIOM_BUILD_COMMIT}`);
  vi.stubGlobal("__IDIOM_ENGINE_IDENTITY__", "");
  expect(engineIdentity()).toBe(`${IDIOM_VERSION}+${IDIOM_BUILD_COMMIT}`);
  vi.stubGlobal("__IDIOM_ENGINE_IDENTITY__", "source:0123456789abcdef0123");
  expect(engineIdentity()).toBe("source:0123456789abcdef0123");
});

// ── Stubbed Git and capture, shared by every simulated self-gate run ───────
let directory: string;
let diffs: Record<string, string[]>;
let ancestors: Record<string, boolean>;
const git: GitRead = async (_cwd, args) => {
  if (args.join(" ") === "rev-parse --show-toplevel") return `${directory}\n`;
  if (args.join(" ") === "rev-parse --git-common-dir")
    return `${join(directory, ".git")}\n`;
  if (args[0] === "diff")
    return (diffs[args[4] as string] ?? []).map((path) => `${path}\0`).join("");
  throw new Error(`unexpected git ${args.join(" ")}`);
};
const ancestry: GitAncestry = {
  head: async () => sha("f"),
  isAncestor: async (_cwd, commit) => ancestors[commit] ?? false,
  distance: async () => 1,
};
const validated = () =>
  ({
    projectDirectory: directory,
    project: { checks },
    flows: [],
  }) as unknown as ValidationResult;
const tuples: PlannedTuple[] = [
  { state: "home", viewport: "desktop", scheme: "light" },
];
const record = (commit: string): BaselineRecord => ({
  commit,
  recordedAt: "2026-11-16T00:00:00.000Z",
  idiomVersion: "0.0.0",
  configHash: currentHash,
  tuples: [{ state: "home", viewport: "desktop", findings: [] }],
});

/** One self-gate run at `base` with the CLI built from `root`. */
async function selfGate(root: string, base: string) {
  vi.stubGlobal("__IDIOM_ENGINE_IDENTITY__", await engineFingerprint({ root }));
  const resolution = await resolveBaseComparison({
    validated: validated(),
    flow: "site",
    base,
    tuples,
    nonUi: ["src/**"],
    git,
    ancestry,
  });
  // What captureBaseRecords does after a real base capture.
  const capture = vi.fn(async () => {
    const captured = record(base);
    await writeBaseCacheRecord(resolution.cachePath, "site", captured);
    return { record: captured, failedTupleKeys: [], ms: 1 };
  });
  const settled = await settleBaseComparison({
    resolution,
    flow: "site",
    configHash: currentHash,
    capture,
  });
  return { resolution, settled, capture };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "idiom-engine-gate-"));
  await mkdir(join(directory, ".git"));
  diffs = {};
  ancestors = { [M0]: true, [M1]: true };
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

test("two builds with identical check code share one base capture; changed check code captures its own", async () => {
  const branchA = await branch({
    "site/index.html": "<h1>Branch A</h1>\n",
  });
  const branchB = await branch({
    "src/commands/help.ts": 'export const help = "branch B";\n',
  });
  const branchC = await branch({
    "src/checks/rule.ts": "export const rule = () => 3;\n",
  });

  const first = await selfGate(branchA, M0);
  expect(first.capture).toHaveBeenCalledOnce();
  expect(first.settled.comparison?.source).toBe("base-capture");

  const second = await selfGate(branchB, M0);
  expect(second.resolution.missing).toEqual([]);
  expect(second.capture).not.toHaveBeenCalled();
  expect(second.settled.comparison?.source).toBe("base-cache");
  const cached = await readBaseCache(first.resolution.cachePath, "site");
  expect(cached).toHaveLength(1);
  expect(cached[0]?.engine).toBe(await engineFingerprint({ root: branchA }));

  const third = await selfGate(branchC, M0);
  expect(third.resolution.missing).toEqual(tuples);
  expect(third.capture).toHaveBeenCalledOnce();
  expect(third.settled.comparison?.source).toBe("base-capture");
  expect(
    (await readBaseCache(first.resolution.cachePath, "site"))
      .map((entry) => entry.engine)
      .sort(),
  ).toEqual(
    [
      await engineFingerprint({ root: branchA }),
      await engineFingerprint({ root: branchC }),
    ].sort(),
  );
});

test("after a site-changing merge, the next build reuses the finalize's head record", async () => {
  const branchA = await branch({
    "site/index.html": "<h1>Branch A</h1>\n",
  });
  const first = await selfGate(branchA, M0);
  expect(first.capture).toHaveBeenCalledOnce();

  // Branch A's finalize advances its own head; then A squash-merges as M1.
  vi.stubGlobal(
    "__IDIOM_ENGINE_IDENTITY__",
    await engineFingerprint({ root: branchA }),
  );
  await writeBaseCacheRecord(
    first.resolution.cachePath,
    "site",
    record(HEAD_A),
  );
  ancestors[HEAD_A] = false;
  diffs[M0] = ["site/index.html"];
  diffs[HEAD_A] = [];

  const next = await selfGate(branchA, M1);
  expect(next.resolution.missing).toEqual([]);
  expect(next.resolution.covering[0]?.record.commit).toBe(HEAD_A);
  expect(next.capture).not.toHaveBeenCalled();
  expect(next.settled.comparison?.source).toBe("base-cache");
});
