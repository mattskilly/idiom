import { execFile } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  createBudget,
  DEFAULT_UI_GLOBS,
  initialChanges,
  matchesUI,
  mutateState,
  normalizePath,
  publishCheck,
  readState,
  recordEdit,
  resolveContext,
  snapshot,
  validGlob,
} from "../hooks/lib.mjs";
import { initProject } from "../src/commands/init.js";
import { projectSchema } from "../src/schemas/project.js";
import { commit, git } from "./baseline-support.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "idiom-hooks-")));
  roots.push(path);
  return path;
}
async function fixture(gitTree = true) {
  const root = await temporary();
  await initProject({ project: root, yes: true });
  await mkdir(join(root, "src/components"), { recursive: true });
  await writeFile(
    join(root, "src/components/Card.tsx"),
    "export const Card = 'before';",
  );
  if (gitTree) {
    await git(root, "init", "-q", "-b", "main");
    await commit(root, "fixture");
  }
  return root;
}
async function configure(root: string, agent: unknown) {
  const path = join(root, ".idiom/project.json");
  const project = JSON.parse(await readFile(path, "utf8"));
  project.agent = agent;
  await writeFile(path, JSON.stringify(project));
}
async function context(root: string) {
  const budget = createBudget(5000);
  try {
    const result = await resolveContext(root, budget);
    if (!result) throw new Error("missing context");
    return result;
  } finally {
    budget.close();
  }
}
async function evidence(root: string) {
  const ctx = await context(root);
  const budget = createBudget(5000);
  try {
    const state = await readState(ctx, budget);
    return await snapshot(
      ctx,
      budget,
      state.pending.map((entry) => entry.path),
      state.overflow,
    );
  } finally {
    budget.close();
  }
}
async function checked(root: string, startedAt = Date.now()) {
  const ctx = await context(root);
  const budget = createBudget(5000);
  try {
    const state = await readState(ctx, budget);
    const tree = await snapshot(
      ctx,
      budget,
      state.pending.map((entry) => entry.path),
      state.overflow,
    );
    expect(
      await publishCheck(
        ctx,
        tree,
        tree,
        { startedAt, editId: state.editId, flow: "studio" },
        budget,
      ),
    ).toBe(true);
  } finally {
    budget.close();
  }
}
async function state(root: string) {
  return JSON.parse(
    await readFile(join(root, ".idiom/agent-hooks/state.json"), "utf8"),
  );
}
async function hook(
  root: string,
  entry: "post-tool-use" | "stop",
  input: unknown,
  env = process.env,
) {
  const start = performance.now();
  const result = await new Promise<{ stdout: string; stderr: string }>(
    (accept, reject) => {
      const child = execFile(
        process.execPath,
        [join(import.meta.dirname, `../hooks/${entry}.mjs`)],
        { cwd: root, env },
        (error, stdout, stderr) =>
          error ? reject(error) : accept({ stdout, stderr }),
      );
      child.stdin?.end(
        typeof input === "string"
          ? input
          : JSON.stringify({
              cwd: root,
              session_id: "one",
              ...(input as object),
            }),
      );
    },
  );
  expect(result.stderr).toBe("");
  return {
    elapsed: performance.now() - start,
    output: result.stdout.trim() ? JSON.parse(result.stdout) : undefined,
  };
}
const stop = (root: string, session_id = "one", extra = {}) =>
  hook(root, "stop", { session_id, ...extra });
const edit = (
  root: string,
  tool_name = "Edit",
  file_path = "src/components/Card.tsx",
) => hook(root, "post-tool-use", { tool_name, tool_input: { file_path } });

test.each([
  "Card.tsx",
  "src/components/Card.tsx",
  "packages/web/pages/index.ts",
  "components/Icon.js",
  "pages/home.js",
  "src/app/page.ts",
  "app/users/[id]/layout.ts",
  "styles/main.scss",
  "src/templates/page.hbs",
  "view.html",
  "src/View.vue",
  "view.svelte",
  "view.astro",
  "page.mdx",
  "view.handlebars",
  "view.ejs",
  "view.liquid",
  "view.pug",
  "src\\components\\Card.tsx",
])("defaults match %s", (path) => expect(matchesUI(path)).toBe(true));

test("globs are segment-aware, escape literal route brackets and replace defaults", () => {
  expect(matchesUI("Card.tsx", ["**/*.tsx"])).toBe(true);
  expect(matchesUI("pages/[id]/page.ts", ["pages/[id]/p?ge.ts"])).toBe(true);
  expect(matchesUI("pages/id/page.ts", ["pages/[id]/*.ts"])).toBe(false);
  expect(matchesUI("app/(private)/page.ts", ["app/(private)/*.ts"])).toBe(true);
  expect(matchesUI("a/b/c.css", ["a/*.css"])).toBe(false);
  expect(matchesUI("src/server.ts")).toBe(false);
  expect(matchesUI("node_modules/x/Card.tsx")).toBe(false);
  expect(matchesUI(".idiom/reports/page.html")).toBe(false);
  expect(matchesUI("dist/page.html")).toBe(false);
  expect(matchesUI("Card.tsx", [])).toBe(false);
  expect(matchesUI("view.custom", ["**/*.custom"])).toBe(true);
  expect(matchesUI("Card.tsx", ["**/*.custom"])).toBe(false);
  for (const glob of [
    "",
    " ",
    "../*.tsx",
    "/abs/*.tsx",
    "C:\\abs\\*.tsx",
    "**/*.{jsx,tsx}",
    "!foo",
    "@(foo)",
  ])
    expect(validGlob(glob)).toBe(false);
  expect(DEFAULT_UI_GLOBS).toContain("**/app/**/layout.ts");
});

test("strict project config and lightweight parser agree on agent configuration", async () => {
  const root = await fixture();
  const original = JSON.parse(
    await readFile(join(root, ".idiom/project.json"), "utf8"),
  );
  for (const agent of [
    {},
    { hooks: false },
    { uiGlobs: [] },
    { uiGlobs: ["**/views/*.custom"] },
  ]) {
    expect(projectSchema.safeParse({ ...original, agent }).success).toBe(true);
  }
  for (const agent of [
    null,
    { hooks: "no" },
    { extra: true },
    { uiGlobs: ["../*.tsx"] },
    { uiGlobs: ["**/*.{tsx,jsx}"] },
  ]) {
    expect(projectSchema.safeParse({ ...original, agent }).success).toBe(false);
    await configure(root, agent);
    expect((await edit(root)).output).toBeUndefined();
  }
});

test.each(["Edit", "Write", "MultiEdit"])(
  "%s emits provider context with all configured flows/states",
  async (tool) => {
    const root = await fixture();
    await writeFile(
      join(root, ".idiom/flows/checkout.json"),
      JSON.stringify({ id: "checkout" }),
    );
    await writeFile(
      join(root, ".idiom/flows/account.json"),
      JSON.stringify({ id: "account" }),
    );
    const result = (await edit(root, tool)).output;
    expect(result.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(result.hookSpecificOutput.additionalContext).toContain(
      "src/components/Card.tsx",
    );
    expect(result.hookSpecificOutput.additionalContext).toContain(
      "checkout (all states)",
    );
    expect(result.hookSpecificOutput.additionalContext).toContain(
      "account (all states)",
    );
    expect((await state(root)).pending[0].path).toBe("src/components/Card.tsx");
  },
);

test("flow lists are explicitly bounded and missing flows direct configuration", async () => {
  const root = await fixture();
  for (const file of (
    await exec("git", ["ls-files", ".idiom/flows"], { cwd: root })
  ).stdout
    .trim()
    .split("\n"))
    if (file) await rm(join(root, file));
  expect(
    (await edit(root)).output.hookSpecificOutput.additionalContext,
  ).toContain("idiom_flows or idiom init");
  for (let index = 0; index < 12; index++)
    await writeFile(
      join(root, `.idiom/flows/flow-${index}.json`),
      JSON.stringify({ id: `flow-${index}` }),
    );
  const message = (await edit(root)).output.hookSpecificOutput
    .additionalContext;
  expect(message).toContain("and all remaining configured flows/states");
  expect(message.length).toBeLessThan(1300);
});

test("non-UI, unrelated tools, malformed input, uninitialized and opt-out are silent and don't write state", async () => {
  const root = await fixture();
  expect((await edit(root, "Bash")).output).toBeUndefined();
  expect((await edit(root, "Edit", "src/server.ts")).output).toBeUndefined();
  expect((await hook(root, "stop", "bad json")).output).toBeUndefined();
  expect(
    (await stop(root, "one", { stop_hook_active: "invalid" })).output,
  ).toBeUndefined();
  expect((await hook(root, "post-tool-use", "null")).output).toBeUndefined();
  const configPath = join(root, ".idiom/project.json");
  const originalConfig = await readFile(configPath, "utf8");
  await writeFile(configPath, "{}");
  expect((await edit(root)).output).toBeUndefined();
  expect((await stop(root)).output).toBeUndefined();
  await writeFile(configPath, originalConfig);
  await configure(root, { hooks: false });
  expect((await edit(root)).output).toBeUndefined();
  expect((await stop(root)).output).toBeUndefined();
  await expect(state(root)).rejects.toThrow();
  const empty = await temporary();
  expect((await edit(empty)).output).toBeUndefined();
  expect((await stop(empty)).output).toBeUndefined();
});

test("custom and empty globs replace defaults in actual hooks", async () => {
  const root = await fixture();
  await configure(root, { uiGlobs: ["**/*.custom"] });
  expect((await edit(root)).output).toBeUndefined();
  await writeFile(join(root, "view.custom"), "custom");
  expect((await edit(root, "Write", "view.custom")).output).toBeDefined();
  await configure(root, { uiGlobs: [] });
  expect((await edit(root)).output).toBeUndefined();
  expect((await stop(root)).output).toBeUndefined();
});

test("outside paths and escaping symlinks are rejected, including missing children", async () => {
  const root = await fixture();
  const outside = await temporary();
  await writeFile(join(outside, "Card.tsx"), "external");
  await symlink(outside, join(root, "escape"));
  const ctx = await context(root);
  const budget = createBudget(5000);
  try {
    for (const path of [
      join(outside, "Card.tsx"),
      "../Card.tsx",
      "escape/Card.tsx",
      "escape/New.tsx",
    ]) {
      expect(await normalizePath(ctx, path, budget)).toBeUndefined();
      expect((await edit(root, "Write", path)).output).toBeUndefined();
    }
    expect(await normalizePath(ctx, "src\\components\\Card.tsx", budget)).toBe(
      "src/components/Card.tsx",
    );
  } finally {
    budget.close();
  }
});

test("nested cwd and Git subprojects use project-relative evidence, including canonical path aliases", async () => {
  const root = await fixture();
  expect(
    (
      await hook(root, "post-tool-use", {
        cwd: join(root, "src/components"),
        tool_name: "Edit",
        tool_input: { file_path: "Card.tsx" },
      })
    ).output.hookSpecificOutput.additionalContext,
  ).toContain("src/components/Card.tsx");
  const project = join(root, "packages/web");
  await initProject({ project, yes: true });
  await writeFile(join(project, "Page.tsx"), "before");
  await commit(root, "subproject");
  expect((await stop(project)).output).toBeUndefined();
  await writeFile(join(project, "Page.tsx"), "after");
  expect((await stop(project)).output.decision).toBe("block");
  expect((await context(project)).root).toBe(project);
});

test("initial clean tree allows; tracked differences and untracked UI each block", async () => {
  const root = await fixture();
  expect((await stop(root)).output).toBeUndefined();
  await writeFile(join(root, "server.ts"), "backend");
  expect((await stop(root)).output).toBeUndefined();
  await writeFile(join(root, "src/components/Card.tsx"), "changed");
  expect((await stop(root)).output.decision).toBe("block");
  const other = await fixture();
  await writeFile(join(other, "new.tsx"), "new");
  expect((await stop(other)).output.decision).toBe("block");
});

test("single-block Stop persists across edits and commits, with independent sessions and successful-check epochs", async () => {
  const root = await fixture();
  await edit(root);
  expect(
    (await stop(root, "one", { stop_hook_active: true })).output,
  ).toBeUndefined();
  expect((await stop(root)).output).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("explain why"),
  });
  expect((await state(root)).sessions.one.epoch).toBe("initial");
  expect((await stop(root)).output).toBeUndefined();
  await writeFile(join(root, "src/components/Card.tsx"), "more");
  await edit(root);
  await commit(root, "commit observed work");
  expect((await stop(root)).output).toBeUndefined();
  expect((await stop(root, "two")).output.decision).toBe("block");
  await checked(root);
  expect((await stop(root, "two")).output).toBeUndefined();
  await writeFile(join(root, "src/components/Card.tsx"), "new epoch");
  expect((await stop(root)).output.decision).toBe("block");
  expect((await stop(root)).output).toBeUndefined();
});

test("successful check on a dirty file invalidates on another edit, but staging, mtime and backend edits don't", async () => {
  const root = await fixture();
  const path = join(root, "src/components/Card.tsx");
  await writeFile(path, "dirty checked");
  await checked(root);
  const digest = (await evidence(root)).digest;
  await utimes(path, new Date(1000), new Date(1000));
  await git(root, "add", "src/components/Card.tsx");
  await writeFile(join(root, "server.ts"), "backend");
  expect((await evidence(root)).digest).toBe(digest);
  expect((await stop(root)).output).toBeUndefined();
  await writeFile(path, "dirty again");
  expect((await evidence(root)).digest).not.toBe(digest);
  expect((await stop(root)).output.decision).toBe("block");
});

test.each(["add", "delete", "rename"])(
  "%s invalidates the UI digest",
  async (operation) => {
    const root = await fixture();
    await checked(root);
    const old = (await evidence(root)).digest;
    if (operation === "add") await writeFile(join(root, "New.tsx"), "new");
    if (operation === "delete") await rm(join(root, "src/components/Card.tsx"));
    if (operation === "rename")
      await rename(
        join(root, "src/components/Card.tsx"),
        join(root, "src/components/New.tsx"),
      );
    expect((await evidence(root)).digest).not.toBe(old);
    expect((await stop(root)).output.decision).toBe("block");
  },
);

test("a first-check rename from a UI extension to a backend filename still owes a check", async () => {
  const root = await fixture();
  await git(root, "mv", "src/components/Card.tsx", "src/server.ts");
  expect((await stop(root)).output.decision).toBe("block");
});

test("corrupt evidence is never a successful check and ignore updates preserve existing lines", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".idiom/.gitignore"),
    "# custom\nreports/\nextra/",
  );
  await checked(root);
  await writeFile(join(root, ".idiom/agent-hooks/state.json"), "{broken");
  await writeFile(join(root, "src/components/Card.tsx"), "new");
  expect((await stop(root)).output.decision).toBe("block");
  await edit(root);
  expect(await readFile(join(root, ".idiom/.gitignore"), "utf8")).toBe(
    "# custom\nreports/\nextra/\n/agent-hooks/\n",
  );
  expect(
    await git(
      root,
      "check-ignore",
      ".idiom/agent-hooks/state.json",
      ".idiom/agent-hooks/lock",
      ".idiom/agent-hooks/foo.tmp",
    ),
  ).toContain("state.json");
});

test("Git-ignored observed files remain in subsequent successful-check fingerprints", async () => {
  const root = await fixture();
  await writeFile(join(root, ".gitignore"), "ignored.tsx\n");
  await writeFile(join(root, "ignored.tsx"), "before");
  await edit(root, "Write", "ignored.tsx");
  await checked(root);
  expect((await stop(root)).output).toBeUndefined();
  await writeFile(join(root, "ignored.tsx"), "after");
  expect((await stop(root)).output.decision).toBe("block");
});

test("non-Git trees need observed edits before their first check", async () => {
  const root = await fixture(false);
  expect((await stop(root)).output).toBeUndefined();
  await edit(root);
  expect((await stop(root)).output.decision).toBe("block");
  await checked(root);
  expect((await stop(root, "two")).output).toBeUndefined();
  await writeFile(join(root, "src/components/Card.tsx"), "changed");
  expect((await stop(root, "two")).output.decision).toBe("block");
});

test("linked worktrees have independent evidence and cannot borrow configuration across their boundary", async () => {
  const root = await fixture();
  const container = await temporary();
  const linked = join(container, "linked");
  await git(root, "worktree", "add", "--detach", linked);
  await checked(root);
  expect((await context(root)).identity).not.toBe(
    (await context(linked)).identity,
  );
  await writeFile(join(linked, "src/components/Card.tsx"), "linked change");
  expect((await stop(linked)).output.decision).toBe("block");
  expect((await stop(root)).output).toBeUndefined();
  // Place another linked tree inside an initialized parent to prove the boundary.
  const nested = join(root, "nested");
  await git(root, "worktree", "add", "--detach", nested);
  await rm(join(nested, ".idiom"), { recursive: true });
  expect((await edit(nested)).output).toBeUndefined();
});

test("state mutations fail open under contention or persistence failure, without a block or lost acknowledgment", async () => {
  const root = await fixture();
  await edit(root);
  await writeFile(join(root, ".idiom/agent-hooks/lock"), "held");
  expect((await stop(root)).output).toBeUndefined();
  expect(await readFile(join(root, ".idiom/agent-hooks/lock"), "utf8")).toBe(
    "held",
  );
  expect((await state(root)).sessions.one).toBeUndefined();
  await rm(join(root, ".idiom/agent-hooks/lock"));
  expect((await stop(root)).output.decision).toBe("block");
  const broken = await fixture();
  await writeFile(join(broken, ".idiom/agent-hooks"), "not a directory");
  await writeFile(join(broken, "src/components/Card.tsx"), "changed");
  expect((await stop(broken)).output).toBeUndefined();
});

test("aged orphan locks recover edit recording, single-block Stop and successful-check publication", async () => {
  const root = await fixture();
  const ctx = await context(root);
  const lockPath = join(ctx.directory, "lock");
  await mkdir(ctx.directory);
  const orphan = async () => {
    await writeFile(lockPath, "");
    const age = new Date(Date.now() - 10000);
    await utimes(lockPath, age, age);
  };
  await orphan();
  expect(
    (await edit(root)).output.hookSpecificOutput.additionalContext,
  ).toContain("Card.tsx");
  expect((await state(root)).pending[0].path).toBe("src/components/Card.tsx");
  await expect(readFile(lockPath)).rejects.toThrow();
  await orphan();
  expect((await stop(root)).output.decision).toBe("block");
  expect((await state(root)).sessions.one.epoch).toBe("initial");
  expect((await stop(root)).output).toBeUndefined();
  await orphan();
  await checked(root);
  expect((await state(root)).check.digest).toBe((await evidence(root)).digest);
  expect((await stop(root, "after-recovery")).output).toBeUndefined();
  await expect(readFile(lockPath)).rejects.toThrow();
});

test("a hook killed while holding its mutation lock cannot disable later Stop reminders", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/components/Card.tsx"), "unchecked");
  const runtime = pathToFileURL(
    join(import.meta.dirname, "../hooks/lib.mjs"),
  ).href;
  await expect(
    exec(process.execPath, [
      "--input-type=module",
      "-e",
      `
    import {createBudget, resolveContext, mutateState} from ${JSON.stringify(runtime)};
    const budget = createBudget();
    const context = await resolveContext(process.argv[1], budget);
    await mutateState(context, budget, () => { process.kill(process.pid, 'SIGKILL'); return true; });
  `,
      root,
    ]),
  ).rejects.toMatchObject({ signal: "SIGKILL" });
  const lockPath = join(root, ".idiom/agent-hooks/lock");
  expect(await readFile(lockPath, "utf8")).toBe("");
  const age = new Date(Date.now() - 10000);
  await utimes(lockPath, age, age);
  expect((await stop(root)).output.decision).toBe("block");
  expect((await stop(root)).output).toBeUndefined();
  await expect(readFile(lockPath)).rejects.toThrow();
});

test("a displaced writer cannot publish or remove its successor's lock", async () => {
  const root = await fixture();
  const ctx = await context(root);
  const budget = createBudget(5000);
  const lockPath = join(ctx.directory, "lock");
  try {
    expect(
      await mutateState(ctx, budget, () => {
        renameSync(lockPath, join(ctx.directory, "old-lock"));
        writeFileSync(lockPath, "successor");
        return true;
      }),
    ).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe("successor");
    await expect(state(root)).rejects.toThrow();
  } finally {
    budget.close();
  }
});

test("concurrent checks preserve newer evidence and intervening edits; expired updates publish nothing and release locks", async () => {
  const root = await fixture();
  const ctx = await context(root);
  const budget = createBudget(5000);
  try {
    const tree = await snapshot(ctx, budget);
    await checked(root, 200);
    expect(
      await publishCheck(
        ctx,
        tree,
        tree,
        { startedAt: 100, flow: "studio" },
        budget,
      ),
    ).toBe(false);
    const prior = await state(root);
    await recordEdit(ctx, "src/components/Card.tsx", budget);
    expect(
      await publishCheck(
        ctx,
        tree,
        tree,
        { startedAt: 300, flow: "studio" },
        budget,
      ),
    ).toBe(false);
    expect((await state(root)).check).toEqual(prior.check);
    const expired = createBudget(0);
    expect(await mutateState(ctx, expired, () => true)).toBe(false);
    expired.close();
    const interrupted = createBudget(5000);
    expect(
      await mutateState(ctx, interrupted, () => {
        interrupted.close();
        return true;
      }),
    ).toBe(false);
    await expect(readFile(join(ctx.directory, "lock"))).rejects.toThrow();
    // A leftover partial temporary file cannot replace the last atomic state.
    await writeFile(join(ctx.directory, "interrupted.tmp"), "{broken");
    expect((await readState(ctx, budget)).check).toEqual(prior.check);
    expect(await initialChanges(ctx, tree, budget)).toBe(false);
  } finally {
    budget.close();
  }
});

test("bounded pending/session metadata stays readable and retains the newest acknowledgment", async () => {
  const root = await fixture(false);
  const ctx = await context(root);
  const budget = createBudget(5000);
  try {
    for (let i = 0; i < 66; i++) await recordEdit(ctx, `Page-${i}.tsx`, budget);
    expect((await readState(ctx, budget)).pending).toHaveLength(64);
    expect((await readState(ctx, budget)).overflow).toBe(true);
    await checked(root);
    expect((await readState(ctx, budget)).pending).toHaveLength(0);
    expect((await readState(ctx, budget)).overflow).toBe(false);
    expect((await stop(root)).output).toBeUndefined();
    expect(
      await mutateState(ctx, budget, (state) => {
        state.sessions = Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [
            `session-${i}`,
            { at: Date.now(), epoch: "initial" },
          ]),
        );
        return true;
      }),
    ).toBe(true);
    const saved = await readState(ctx, budget);
    expect(Object.keys(saved.sessions)).toHaveLength(64);
    expect(saved.sessions["session-64"]).toBeDefined();
  } finally {
    budget.close();
  }
});

test("whole Node edit and Stop invocations remain below 200ms on a modest monorepo", async () => {
  const root = await fixture();
  await mkdir(join(root, "packages/backend"), { recursive: true });
  await Promise.all(
    Array.from({ length: 1500 }, (_, i) =>
      writeFile(join(root, `packages/backend/file-${i}.ts`), "backend"),
    ),
  );
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      writeFile(join(root, `src/components/Card-${i}.tsx`), "ui"),
    ),
  );
  await commit(root, "monorepo");
  const timings = [];
  for (let i = 0; i < 3; i++) {
    timings.push((await edit(root)).elapsed);
    const result = await stop(root, `timing-${i}`);
    expect(result.output.decision).toBe("block");
    timings.push(result.elapsed);
  }
  console.log(
    `Node hook wall times (ms): ${timings.map((value) => value.toFixed(1)).join(", ")}`,
  );
  expect(Math.max(...timings)).toBeLessThan(200);
});

test("slow Git is killed by the internal deadline without publishing evidence or stranding a lock", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/components/Card.tsx"), "changed");
  const bin = await temporary();
  await writeFile(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 5\n");
  await chmod(join(bin, "git"), 0o755);
  const result = await hook(root, "stop", {}, { ...process.env, PATH: bin });
  expect(result.output).toBeUndefined();
  // The fake Git sleeps 5s; the hook's 140ms budget plus Node startup and the
  // SIGKILL round trip sits near 200ms on a loaded machine, so bound well
  // below the sleep rather than at the budget's edge.
  expect(result.elapsed).toBeLessThan(1000);
  await expect(state(root)).rejects.toThrow();
  await expect(
    readFile(join(root, ".idiom/agent-hooks/lock")),
  ).rejects.toThrow();
});
