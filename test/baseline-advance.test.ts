import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { advanceBaselines } from "../src/baseline/advance.js";
import type {
  BaseCaptureOptions,
  BaseCaptureResult,
} from "../src/baseline/base.js";
import {
  baseCachePath,
  readBaseCache,
  writeBaseCacheRecord,
} from "../src/baseline/base-cache.js";
import { checksConfigHash } from "../src/baseline/config-hash.js";
import type { BaselineRecord } from "../src/baseline/schema.js";
import { run } from "../src/cli.js";
import { validateProject } from "../src/validation.js";

const exec = promisify(execFile);

let directory: string;
const git = async (...args: string[]) =>
  (await exec("git", args, { cwd: directory })).stdout.trim();
const write = async (path: string, content: string) => {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), content);
};
const commit = async (message: string) => {
  await git("add", "-A");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};

const project = (viewports = [{ name: "wide", width: 800, height: 600 }]) =>
  JSON.stringify({
    version: 1,
    app: { name: "Advance fixture", framework: "nextjs" },
    server: {
      build: "node -e 0",
      start: "node -e 0",
      port: 4999,
      readyUrl: "http://127.0.0.1:4999/ready",
      env: {},
    },
    viewports,
    colorSchemes: ["light"],
    checks: { probe: { enabled: false } },
    capture: { settleMs: 0 },
    design: {},
    model: { provider: "anthropic", model: "unused" },
  });
const flow = (states = ["s0", "s1"], viewports?: string[]) =>
  JSON.stringify({
    id: "site",
    title: "Site",
    setup: [],
    intent: [],
    ...(viewports === undefined ? {} : { viewports }),
    states: states.map((id) => ({
      id,
      description: id,
      url: `/${id}`,
      expect: {},
    })),
  });

let configHash: string;
let cachePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "idiom-advance-"));
  await git("init", "--quiet", "--initial-branch=main");
  await write(".gitignore", ".idiom/reports/\n.idiom/cache/\n");
  await write(".idiom/project.json", project());
  await write(".idiom/flows/site.json", flow());
  await write("app/page.tsx", "export default 1;\n");
  await commit("initial");
  const validated = await validateProject({ project: directory });
  configHash = checksConfigHash(validated.project.checks);
  cachePath = await baseCachePath(directory, "site");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

type CaptureCall = BaseCaptureOptions;
/** Records every call; captures each scoped tuple with no finding. */
function fakeCapture(
  options: { failed?: string[]; gate?: Promise<void>; throws?: string } = {},
) {
  const calls: CaptureCall[] = [];
  const capture = async (
    call: BaseCaptureOptions,
  ): Promise<BaseCaptureResult> => {
    calls.push(call);
    await options.gate;
    if (options.throws) throw new Error(options.throws);
    const states = call.scope.states?.split(",") ?? [];
    const viewports = call.scope.viewports?.split(",") ?? [];
    const tuples = states.flatMap((state) =>
      viewports
        .filter((viewport) => !options.failed?.includes(`${state}/${viewport}`))
        .map((viewport) => ({ state, viewport, findings: [] })),
    );
    return {
      record: {
        commit: call.base,
        recordedAt: new Date().toISOString(),
        idiomVersion: "test",
        configHash,
        tuples,
      },
      failedTupleKeys: options.failed ?? [],
      ms: 1,
    };
  };
  return { calls, capture };
}

const advance = (
  capture: ReturnType<typeof fakeCapture>["capture"],
  extra: Partial<Parameters<typeof advanceBaselines>[0]> = {},
) =>
  advanceBaselines({
    project: directory,
    target: "main",
    ...extra,
    dependencies: {
      capture,
      lock: { pollMs: 5 },
      ...extra.dependencies,
    },
  });

const cacheCommits = async () =>
  (await readBaseCache(cachePath, "site")).map((record) => record.commit);

test("a failed or partial capture writes nothing and keeps the previous baseline", async () => {
  const first = await advance(fakeCapture().capture);
  expect(first.flows[0]?.status).toBe("advanced");
  const previous = first.commit;
  await write("app/page.tsx", "export default 2;\n");
  const next = await commit("ui change");
  const before = await readFile(cachePath, "utf8");

  const partial = fakeCapture({ failed: ["s1/wide"] });
  const result = await advance(partial.capture);
  expect(result.commit).toBe(next);
  expect(result.flows[0]).toMatchObject({
    flow: "site",
    status: "failed",
    failedTuples: ["s1/wide"],
    previous,
  });
  expect(await readFile(cachePath, "utf8")).toBe(before);

  const thrown = await advance(
    fakeCapture({ throws: "server never ready" }).capture,
  );
  expect(thrown.flows[0]).toMatchObject({
    status: "failed",
    previous,
  });
  expect(thrown.flows[0]?.reason).toContain("server never ready");
  expect(await readFile(cachePath, "utf8")).toBe(before);
});

test("the CLI exits 2 and says so on stderr when a capture fails", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const status = await run(
    [
      "node",
      "idiom",
      "--project",
      directory,
      "baseline",
      "advance",
      "--target",
      "main",
    ],
    {
      stdout: (value) => out.push(value),
      stderr: (value) => err.push(value),
      baselineAdvance: {
        capture: fakeCapture({ failed: ["s1/wide"] }).capture,
        lock: { pollMs: 5 },
      },
    },
  );
  expect(status).toBe(2);
  expect(err.join("")).toContain("baseline advance failed for site at");
  expect(err.join("")).toContain("the previous baseline is unchanged");
  expect(out.join("")).toMatch(
    /FAILED site at [0-9a-f]{12}: 1 tuple\(s\) failed: s1\/wide; no baseline recorded yet/,
  );
  await expect(readFile(cachePath, "utf8")).rejects.toThrow();
});

test("advances are serialised, and an older target never overwrites a newer one", async () => {
  const a = await git("rev-parse", "HEAD");
  await write("app/page.tsx", "export default 2;\n");
  const b = await commit("b");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const slow = fakeCapture({ gate });
  const quick = fakeCapture();
  const forB = advance(slow.capture, { target: b });
  // Let B take the lock and reach its capture.
  while (slow.calls.length === 0)
    await new Promise((done) => setTimeout(done, 5));
  const forA = advance(quick.capture, { target: a });
  await new Promise((done) => setTimeout(done, 60));
  expect(quick.calls).toHaveLength(0);
  release();
  const [resultB, resultA] = await Promise.all([forB, forA]);
  expect(resultB.flows[0]?.status).toBe("advanced");
  expect(resultA.flows[0]).toMatchObject({
    status: "superseded",
    supersededBy: b,
  });
  expect(quick.calls).toHaveLength(0);
  expect(await cacheCommits()).toEqual([b]);
});

test("in order, each advance is recorded, newest first", async () => {
  const a = await git("rev-parse", "HEAD");
  await write("app/page.tsx", "export default 2;\n");
  const b = await commit("b");
  expect(
    (await advance(fakeCapture().capture, { target: a })).flows[0]?.status,
  ).toBe("advanced");
  expect(
    (await advance(fakeCapture().capture, { target: b })).flows[0]?.status,
  ).toBe("advanced");
  expect(await cacheCommits()).toEqual([b, a]);
});

test("a stored record that already speaks for the target is current: no capture", async () => {
  await advance(fakeCapture().capture);
  const again = fakeCapture();
  expect((await advance(again.capture)).flows[0]?.status).toBe("current");
  expect(again.calls).toHaveLength(0);
  // A non-UI commit leaves the previous capture current under the gate's rule.
  await write("docs/x.md", "notes\n");
  const c = await commit("docs only");
  const docs = fakeCapture();
  const result = await advance(docs.capture);
  expect(result.commit).toBe(c);
  expect(result.flows[0]?.status).toBe("current");
  expect(docs.calls).toHaveLength(0);
});

test("a flow that is not on the target yet is absent, not a failure", async () => {
  await write(
    ".idiom/flows/extra.json",
    flow().replace('"id":"site"', '"id":"extra"'),
  );
  const result = await advance(fakeCapture().capture);
  expect(result.flows.find((entry) => entry.flow === "extra")).toMatchObject({
    status: "absent",
    reason: "not on main yet",
  });
  expect(result.flows.find((entry) => entry.flow === "site")?.status).toBe(
    "advanced",
  );
});

test("a branch ahead of the target captures only what the target declares", async () => {
  // As in a finalize step: the working tree adds a state and a viewport.
  await write(
    ".idiom/project.json",
    project([
      { name: "wide", width: 800, height: 600 },
      { name: "narrow", width: 375, height: 700 },
    ]),
  );
  await write(".idiom/flows/site.json", flow(["s0", "s1", "s2"]));
  const spy = fakeCapture();
  const first = await advance(spy.capture);
  expect(first.flows[0]?.status).toBe("advanced");
  expect(spy.calls).toHaveLength(1);
  expect(spy.calls[0]?.scope.states?.split(",").sort()).toEqual(["s0", "s1"]);
  expect(spy.calls[0]?.scope.viewports).toBe("wide");
  const [stored] = await readBaseCache(cachePath, "site");
  expect(stored?.tuples.map((tuple) => tuple.state).sort()).toEqual([
    "s0",
    "s1",
  ]);
  const second = fakeCapture();
  expect((await advance(second.capture)).flows[0]?.status).toBe("current");
  expect(second.calls).toHaveLength(0);
});

test("a broken target configuration fails loudly, naming the file", async () => {
  await write(".idiom/project.json", "{ not json");
  await commit("broken");
  // The working tree is repaired; the target is still broken.
  await write(".idiom/project.json", project());
  const result = await advance(fakeCapture().capture);
  expect(result.flows[0]?.status).toBe("failed");
  expect(result.flows[0]?.reason).toContain(".idiom/project.json at main");
});

test("--commit-file with cache-only coverage writes the file without a capture", async () => {
  await advance(fakeCapture().capture);
  const spy = fakeCapture();
  const result = await advance(spy.capture, { commitFile: true });
  expect(result.flows[0]).toMatchObject({
    status: "advanced",
    reason: "from the base cache",
    capturedTuples: 0,
  });
  expect(spy.calls).toHaveLength(0);
  const file = JSON.parse(
    await readFile(join(directory, ".idiom/baselines/site.json"), "utf8"),
  );
  expect(file.records[0].commit).toBe(result.commit);
});

test("concurrent base-cache writes for different commits both survive", async () => {
  const record = (digit: string): BaselineRecord => ({
    commit: digit.repeat(40),
    recordedAt: new Date().toISOString(),
    idiomVersion: "test",
    configHash,
    tuples: [{ state: "s0", viewport: "wide", findings: [] }],
  });
  await Promise.all(
    ["a", "b", "c", "d"].map((digit) =>
      writeBaseCacheRecord(cachePath, "site", record(digit)),
    ),
  );
  expect((await cacheCommits()).sort()).toEqual(
    ["a", "b", "c", "d"].map((digit) => digit.repeat(40)),
  );
});
