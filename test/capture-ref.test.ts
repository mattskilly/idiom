import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import {
  dependencyInstall,
  withRefWorktree,
} from "../src/capture/ref-worktree.js";
import { sourceStatus } from "../src/capture/resolve.js";
import { captureCommand } from "../src/commands/capture.js";
import { checkCommand } from "../src/commands/check.js";
import { decideCommand } from "../src/commands/decide.js";
import { loadRunTuples } from "../src/review/artifacts.js";
import { loadReviewCatalog } from "../src/review/catalog.js";
import { validateProject } from "../src/validation.js";
import { baselineProject, commit, git } from "./baseline-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(nested = false) {
  const created = await baselineProject();
  roots.push(created.project);
  const root = await realpath(created.project);
  const config = JSON.parse(await readFile(created.configPath, "utf8"));
  config.server = {
    build: "node build.mjs",
    start: fixtureCommand("server.mjs"),
    reuse: true,
    port: 3123,
    readyUrl: "http://127.0.0.1:3123",
    env: {},
  };
  config.capture = { settleMs: 0, maxMinutes: 1 };
  config.checks = { probe: { enabled: false } };
  await writeFile(created.configPath, JSON.stringify(config));
  let project = root;
  if (nested) {
    project = join(root, "apps/site");
    await mkdir(project, { recursive: true });
    await rename(join(root, ".idiom"), join(project, ".idiom"));
  }
  await writeFile(
    join(root, ".gitignore"),
    ".idiom/reports/\n.idiom/cache/\n**/built.html\n**/node_modules/\n",
  );
  await writeFile(
    join(project, "build.mjs"),
    'import {copyFileSync} from "node:fs"; copyFileSync("page.html", "built.html");',
  );
  await writeFile(
    join(project, "server.mjs"),
    'import http from "node:http"; import {readFileSync} from "node:fs"; http.createServer((q,r)=>{ r.setHeader("Content-Type","text/html"); r.end(readFileSync("built.html")); }).listen(Number(process.env.PORT),"127.0.0.1");',
  );
  await writeFile(
    join(project, "page.html"),
    '<!doctype html><html lang="en"><title>Older revision</title><h1 id="required">Older revision</h1></html>',
  );
  const old = await commit(root, "old app");
  await writeFile(
    join(project, "page.html"),
    '<!doctype html><html lang="en"><title>New revision</title><h1 id="required">New revision</h1></html>',
  );
  await commit(root, "new app");
  return { root, project, old };
}
async function registered(root: string) {
  return (await git(root, "worktree", "list", "--porcelain")).replace(
    /^HEAD .*\n/gm,
    "",
  );
}
async function missing(path: string) {
  await expect(access(path)).rejects.toThrow();
}

test("capture and default check build the older commit and persist state after cleanup", async () => {
  const { root, project, old } = await fixture();
  const before = await registered(root);
  const status = await git(root, "status", "--porcelain");
  const result = await captureCommand({
    project,
    flow: "studio",
    ref: "HEAD~1",
  });
  expect(result.scope?.source).toMatchObject({ commit: old, dirty: false });
  expect(
    await readFile(
      join(result.runDirectory, "editor/desktop/dom.html"),
      "utf8",
    ),
  ).toContain("Older revision");
  expect(await registered(root)).toBe(before);
  expect(await git(root, "status", "--porcelain")).toBe(status);
  const checked = await checkCommand({
    project,
    flow: "studio",
    ref: "HEAD~1",
  });
  expect(checked.baselineRecorded).toMatchObject({
    commit: old,
    path: join(project, ".idiom/baselines/studio.json"),
  });
  const validated = await validateProject({ project, flow: "studio" });
  expect(
    (
      await loadRunTuples(
        validated,
        validated.flows[0]?.flow as import("../src/schemas/flow.js").Flow,
        checked.runDirectory,
      )
    ).commit,
  ).toBe(old);
  expect((await loadReviewCatalog({ project })).runs.length).toBeGreaterThan(0);
  const second = await checkCommand({ project, flow: "studio", ref: old });
  expect(second.baselineRecorded).toBeUndefined();
  expect(second.baseline?.commit).toBe(old);
  expect(await registered(root)).toBe(before);
}, 60_000);

test("a nested project uses original-cwd --out and remains pinned while invocation HEAD advances", async () => {
  const { root, project, old } = await fixture(true);
  const before = await registered(root);
  let invoked = false;
  const result = await captureCommand({
    project,
    cwd: root,
    out: ".idiom/reports/explicit",
    ref: "HEAD~1",
    flow: "studio",
    dependencies: {
      onActivity: (activity) => {
        if (activity.step === "source snapshot" && !invoked) invoked = true;
      },
      snapshotSource: async (directory, options) => {
        if (invoked) {
          invoked = false;
          await writeFile(
            join(project, "page.html"),
            "concurrent committed version",
          );
          await commit(root, "concurrent merge");
          await writeFile(
            join(project, "page.html"),
            "concurrent uncommitted edit",
          );
        }
        const { dirtyPaths: _paths, ...source } = await sourceStatus(
          directory,
          options,
        );
        return source;
      },
    },
  });
  expect(result.scope?.source).toMatchObject({ commit: old, dirty: false });
  expect(result.runDirectory).toBe(join(root, ".idiom/reports/explicit"));
  expect(
    await readFile(
      join(result.runDirectory, "editor/desktop/dom.html"),
      "utf8",
    ),
  ).toContain("Older revision");
  expect(await registered(root)).toBe(before);
  await expect(
    captureCommand({
      project,
      cwd: root,
      out: "unsafe",
      ref: old,
      flow: "studio",
    }),
  ).rejects.toThrow(/repo-internal --out/);
  expect(await registered(root)).toBe(before);
}, 60_000);

test("the bundled CLI forwards --ref HEAD~1", async () => {
  const { root, old } = await fixture();
  const { stdout } = await exec(
    process.execPath,
    [
      resolve("dist/cli.js"),
      "capture",
      "studio",
      "--ref",
      "HEAD~1",
      "--out",
      ".idiom/reports/cli",
    ],
    {
      cwd: root,
      env: { ...process.env, IDIOM_NO_UPDATE_CHECK: "1" },
      timeout: 60_000,
    },
  );
  expect(stdout).toContain("Captured studio");
  const record = JSON.parse(
    await readFile(join(root, ".idiom/reports/cli/run.json"), "utf8"),
  );
  expect(record.source).toMatchObject({ commit: old, dirty: false });
}, 60_000);

test("invalid refs and missing committed flow/configuration clean their exact registration", async () => {
  const { root } = await fixture();
  const before = await registered(root);
  for (const ref of ["missing-ref", "--help", "HEAD:page.html"]) {
    await expect(
      captureCommand({ project: root, flow: "studio", ref }),
    ).rejects.toThrow(/cannot resolve --ref/);
    expect(await registered(root)).toBe(before);
  }
  await git(root, "rm", ".idiom/flows/studio.json");
  await commit(root, "remove flow");
  await expect(
    captureCommand({ project: root, flow: "studio", ref: "HEAD" }),
  ).rejects.toThrow(/configuration\/flow validation failed/);
  expect(await registered(root)).toBe(before);
  await git(root, "rm", ".idiom/project.json");
  await commit(root, "remove config");
  // Invocation still has configuration, while the target commit does not.
  await writeFile(
    join(root, ".idiom/project.json"),
    await git(root, "show", "HEAD~1:.idiom/project.json"),
  );
  await expect(
    captureCommand({ project: root, flow: "studio", ref: "HEAD" }),
  ).rejects.toThrow(/has no.*\.idiom\/project.json/);
  expect(await registered(root)).toBe(before);
});

test("check rejects incompatible selectors before project discovery", async () => {
  for (const conflict of [
    { from: "saved" },
    { latest: true },
    { changed: true as const },
    { gate: true },
    { reuseServer: true },
  ])
    await expect(
      checkCommand({
        project: "/missing",
        flow: "studio",
        ref: "HEAD",
        ...conflict,
      }),
    ).rejects.toThrow(/--ref cannot be combined/);
});

test("errors, already-aborted signals and concurrent owners leave no worktrees", async () => {
  const { root } = await fixture();
  const before = await registered(root);
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await expect(
    captureCommand({
      project: root,
      flow: "studio",
      ref: "HEAD",
      dependencies: { signal: controller.signal },
    }),
  ).rejects.toThrow("already cancelled");
  await expect(
    withRefWorktree(
      { project: root, flow: "studio", ref: "HEAD" },
      async (context) => {
        const tree = dirname(context.sourceProjectDirectory);
        await withRefWorktree(
          { project: root, flow: "studio", ref: "HEAD~1" },
          async (inner) => {
            expect(inner.sourceProjectDirectory).not.toBe(
              context.sourceProjectDirectory,
            );
            expect(await registered(root)).toContain(
              context.sourceProjectDirectory,
            );
            return true;
          },
        );
        expect(await registered(root)).toContain(
          context.sourceProjectDirectory,
        );
        expect(tree).toContain("capture-");
        throw new Error("controlled failure");
      },
    ),
  ).rejects.toThrow("controlled failure");
  expect(await registered(root)).toBe(before);
});

for (const [lock, manager, expected] of [
  ["bun.lock", "bun@1.3.0", "bun install --frozen-lockfile"],
  ["pnpm-lock.yaml", "pnpm@10.0.0", "pnpm install --frozen-lockfile"],
  ["package-lock.json", "npm@11.0.0", "npm ci"],
  ["yarn.lock", "yarn@1.22.0", "yarn install --frozen-lockfile"],
  ["yarn.lock", "yarn@4.0.0", "yarn install --immutable"],
  ["", "", "npm install --package-lock=false"],
]) {
  test(`dependency preparation selects ${expected} from committed metadata`, async () => {
    const { root } = await fixture();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: manager,
        dependencies: { example: "1" },
      }),
    );
    if (lock) await writeFile(join(root, lock), "");
    expect(await dependencyInstall(root, root)).toEqual({
      cwd: root,
      command: expected,
    });
  });
}

test("dependency setup uses the owned process seam; installation failure cleans up", async () => {
  const { root } = await fixture();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { example: "1" } }),
  );
  await writeFile(join(root, "package-lock.json"), "{}");
  await commit(root, "dependencies");
  const before = await registered(root);
  const install = vi.fn(
    (_command: string, options: import("node:child_process").SpawnOptions) =>
      spawn(
        process.execPath,
        [
          "-e",
          "process.stderr.write('controlled install failure');process.exit(1)",
        ],
        { ...options, shell: false },
      ),
  );
  await expect(
    captureCommand({
      project: root,
      flow: "studio",
      ref: "HEAD",
      dependencies: { process: { spawn: install as typeof spawn } },
    }),
  ).rejects.toThrow(
    /ref dependency installation failed.*controlled install failure/,
  );
  expect(install.mock.calls[0]?.[0]).toBe("npm ci");
  expect(await registered(root)).toBe(before);
});

test("build/browser failures and capture abort remove worktrees after server teardown", async () => {
  const { root } = await fixture();
  const before = await registered(root);
  await expect(
    captureCommand({
      project: root,
      flow: "studio",
      ref: "HEAD",
      dependencies: {
        browserLauncher: async () => {
          throw new Error("controlled browser failure");
        },
      },
    }),
  ).rejects.toThrow(/controlled browser failure/);
  expect(await registered(root)).toBe(before);
  const controller = new AbortController();
  await expect(
    captureCommand({
      project: root,
      flow: "studio",
      ref: "HEAD",
      dependencies: {
        signal: controller.signal,
        onActivity: (activity) => {
          if (activity.step === "browser launch")
            controller.abort(new Error("controlled capture abort"));
        },
      },
    }),
  ).rejects.toThrow();
  expect(await registered(root)).toBe(before);
});

// Synchronize on a preparation command, so the interrupt covers a live owned
// process group rather than racing an arbitrary timer.
test("SIGINT during ref preparation joins the child before removing the worktree", async () => {
  const { root } = await fixture();
  const before = await registered(root);
  const configPath = join(root, ".idiom/project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.server.build =
    "node -e \"require('fs').writeFileSync('built.html','ready');setInterval(()=>{},1000)\"";
  await writeFile(configPath, JSON.stringify(config));
  await commit(root, "interruptible build");
  const child = spawn(
    process.execPath,
    [resolve("dist/cli.js"), "capture", "studio", "--ref", "HEAD"],
    {
      cwd: root,
      env: { ...process.env, IDIOM_NO_UPDATE_CHECK: "1" },
      stdio: "ignore",
    },
  );
  let closed = false;
  const completion = new Promise<void>((accept) =>
    child.once("close", () => {
      closed = true;
      accept();
    }),
  );
  let tree: string | undefined;
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      const list = await registered(root);
      const path = list
        .split("\n")
        .find(
          (line) => line.startsWith("worktree ") && line.includes("/capture-"),
        )
        ?.slice(9);
      if (
        path &&
        (await access(join(path, "built.html")).then(
          () => true,
          () => false,
        ))
      ) {
        tree = path;
        break;
      }
      if (closed) throw new Error("CLI exited before build readiness");
      await new Promise((accept) => setTimeout(accept, 25));
    }
    expect(tree).toBeDefined();
    child.kill("SIGINT");
    await completion;
    await missing(tree as string);
    expect(await registered(root)).toBe(before);
  } finally {
    if (!closed) {
      child.kill("SIGKILL");
      await completion;
    }
  }
}, 30_000);

test("ref reports remain decidable and invocation-only rule decisions suppress later ref runs", async () => {
  const { root } = await fixture();
  await writeFile(
    join(root, "page.html"),
    '<!doctype html><html lang="en"><title>Broken</title><h1 id="required">Broken</h1><button></button></html>',
  );
  const broken = await commit(root, "broken button");
  const first = await checkCommand({
    project: root,
    flow: "studio",
    ref: broken,
    all: true,
  });
  const finding = first.findings.find((item) => item.category === "a11y-label");
  expect(finding).toBeDefined();
  // The temporary source is already gone when decide reads this report.
  await decideCommand({
    project: root,
    finding: finding?.id,
    reject: true,
    scope: "rule",
    reason: "fixture suppression",
  });
  await commit(root, "invocation-only decision");
  const decisions = await readFile(
    join(root, ".idiom/decisions.jsonl"),
    "utf8",
  );
  const second = await checkCommand({
    project: root,
    flow: "studio",
    ref: broken,
    all: true,
  });
  expect(
    second.findings.some((item) => item.fingerprint === finding?.fingerprint),
  ).toBe(false);
  expect(await readFile(join(root, ".idiom/decisions.jsonl"), "utf8")).toBe(
    decisions,
  );
  expect(
    await readFile(join(root, ".idiom/finding-names.json"), "utf8"),
  ).toContain(finding?.id);
}, 60_000);

test("aborting dependency installation joins its process group before worktree cleanup", async () => {
  const { root } = await fixture();
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { example: "1" } }),
  );
  await writeFile(join(root, "package-lock.json"), "{}");
  await commit(root, "dependency cancellation");
  const before = await registered(root);
  const controller = new AbortController();
  let pid: number | undefined;
  const install = vi.fn(
    (_command: string, options: import("node:child_process").SpawnOptions) => {
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
        { ...options, shell: false },
      );
      pid = child.pid;
      child.stdout?.once("data", () =>
        controller.abort(new Error("cancel preparation")),
      );
      return child;
    },
  );
  await expect(
    captureCommand({
      project: root,
      flow: "studio",
      ref: "HEAD",
      dependencies: {
        signal: controller.signal,
        process: { spawn: install as typeof spawn, teardownTimeoutMs: 50 },
      },
    }),
  ).rejects.toThrow(/cancel preparation/);
  expect(() => process.kill(pid as number, 0)).toThrow();
  expect(await registered(root)).toBe(before);
});

test("a worktree add that finishes after cancellation is still removed", async () => {
  const { root } = await fixture();
  const before = await registered(root);
  const controller = new AbortController();
  let owned: string | undefined;
  await expect(
    withRefWorktree(
      {
        project: root,
        flow: "studio",
        ref: "HEAD",
        dependencies: { signal: controller.signal },
      },
      async () => {
        throw new Error("must not run");
      },
      {
        addWorktree: async (cwd, tree, sha) => {
          owned = tree;
          controller.abort(new Error("cancel while git is running"));
          await git(cwd, "worktree", "add", "--detach", tree, sha);
        },
      },
    ),
  ).rejects.toThrow(/cancel while git is running/);
  await missing(owned as string);
  expect(await registered(root)).toBe(before);
});

test("ref preparation and installation share capture.maxMinutes", async () => {
  const { root } = await fixture();
  const configPath = join(root, ".idiom/project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.capture.maxMinutes = 0.03;
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { example: "1" } }),
  );
  await writeFile(join(root, "package-lock.json"), "{}");
  await commit(root, "total preparation budget");
  const before = await registered(root);
  let pid: number | undefined;
  const install = vi.fn(
    (_command: string, options: import("node:child_process").SpawnOptions) => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { ...options, shell: false },
      );
      pid = child.pid;
      return child;
    },
  );
  await expect(
    captureCommand({
      project: root,
      flow: "studio",
      ref: "HEAD",
      dependencies: {
        process: { spawn: install as typeof spawn, teardownTimeoutMs: 50 },
      },
    }),
  ).rejects.toThrow(/capture.maxMinutes=0.03/);
  expect(install).toHaveBeenCalledOnce();
  expect(() => process.kill(pid as number, 0)).toThrow();
  expect(await registered(root)).toBe(before);
}, 15_000);

test("abort during Git worktree creation stops a live checkout hook before cleanup", async () => {
  const { root } = await fixture();
  const before = await registered(root);
  const ready = join(root, "hook-ready");
  await writeFile(
    join(root, ".git/hooks/post-checkout"),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));setInterval(()=>{},1000);\n`,
    { mode: 0o755 },
  );
  const controller = new AbortController();
  const pending = captureCommand({
    project: root,
    flow: "studio",
    ref: "HEAD",
    dependencies: {
      signal: controller.signal,
      process: { teardownTimeoutMs: 100 },
    },
  });
  // Attach the rejection handler before the asynchronously delivered abort.
  const rejected = expect(pending).rejects.toThrow(/cancel Git creation/);
  let pid: number | undefined;
  let hookStopped = false;
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      const text = await readFile(ready, "utf8").catch(() => undefined);
      if (text) {
        pid = Number(text);
        break;
      }
      await new Promise((accept) => setTimeout(accept, 25));
    }
    expect(pid).toBeDefined();
    controller.abort(new Error("cancel Git creation"));
    await rejected;
    expect(() => process.kill(pid as number, 0)).toThrow();
    hookStopped = true;
    expect(await registered(root)).toBe(before);
  } finally {
    // A regression must fail without leaving its intentionally hung fixture alive.
    if (!hookStopped && pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The fixture may already have exited during normal cancellation.
      }
    }
    controller.abort(new Error("cancel Git creation"));
    await pending.catch(() => undefined);
  }
}, 20_000);

test("an invoking linked checkout keeps its own state and its worktree registration", async () => {
  const { root, old } = await fixture();
  const linked = `${root}-caller`;
  await git(root, "worktree", "add", "--detach", linked, "HEAD");
  try {
    const before = await registered(root);
    const result = await checkCommand({
      project: linked,
      flow: "studio",
      ref: old,
    });
    expect(
      result.runDirectory.startsWith(join(linked, ".idiom/reports/")),
    ).toBe(true);
    expect(result.baselineRecorded?.path).toBe(
      join(linked, ".idiom/baselines/studio.json"),
    );
    await missing(join(root, ".idiom/baselines/studio.json"));
    expect(await registered(root)).toBe(before);
  } finally {
    await git(root, "worktree", "remove", "--force", linked);
  }
}, 60_000);
