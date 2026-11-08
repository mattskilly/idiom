import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { sourceStatus } from "../src/capture/resolve.js";
import { checkCommand } from "../src/commands/check.js";
import { projectSchema } from "../src/schemas/project.js";
import { validateProject } from "../src/validation.js";
import { baselineProject, commit, git } from "./baseline-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(patterns = ["tickets/**", ".ab/**"]) {
  const created = await baselineProject();
  roots.push(created.project);
  const { project, configPath } = created;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.baselines = { ignoreDirty: patterns };
  config.server.build = "node -e 0";
  config.server.start = fixtureCommand("server.mjs");
  config.server.env = {};
  config.capture = { settleMs: 0, maxMinutes: 1 };
  config.checks = { probe: { enabled: false } };
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(join(project, "tickets"));
  await mkdir(join(project, "src"));
  await writeFile(join(project, "tickets/x.md"), "ticket\n");
  await writeFile(join(project, "src/app.ts"), "export {};\n");
  await writeFile(
    join(project, "server.mjs"),
    'import http from "node:http"; http.createServer((q,r) => { r.end("<!doctype html><html lang=\\"en\\"><title>Test</title><h1 id=\\"required\\">Hello</h1></html>"); }).listen(Number(process.env.PORT), "127.0.0.1");',
  );
  await commit(project, "policy");
  return { ...created, config };
}
test("optional baseline directory and old configurations retain their shape", async () => {
  const { config } = await fixture();
  expect(projectSchema.parse(config).baselines).toEqual({
    ignoreDirty: ["tickets/**", ".ab/**"],
  });
  expect(
    projectSchema.parse({ ...config, baselines: { directory: "custom" } })
      .baselines,
  ).toEqual({ directory: "custom" });
  expect(
    projectSchema.parse({ ...config, baselines: undefined }).baselines,
  ).toBeUndefined();
});
for (const pattern of [
  ".",
  "./",
  "**",
  "**/*",
  "**/?*",
  "**/*?*",
  "./**/**",
  "/tickets/**",
  "../tickets/**",
  "!src/**",
  "{tickets,docs}/**",
  "@(tickets)/**",
]) {
  test(`rejects unsupported or universal exclusion ${pattern}`, async () => {
    const { config } = await fixture();
    expect(() =>
      projectSchema.parse({ ...config, baselines: { ignoreDirty: [pattern] } }),
    ).toThrow(/repository-relative/);
  });
}
test("real run ignores dirty tickets, records the audit and bootstraps a baseline", async () => {
  const { project } = await fixture();
  await writeFile(join(project, "tickets/x.md"), "agent moved this\n");
  const result = await checkCommand({ project, flow: "studio" });
  expect(result.baselineRecorded?.path).toBe(
    join(project, ".idiom/baselines/studio.json"),
  );
  const run = JSON.parse(
    await readFile(join(result.runDirectory, "run.json"), "utf8"),
  );
  expect(run.source).toMatchObject({
    dirty: false,
    ignoredDirtyPaths: ["tickets/x.md"],
  });
  await writeFile(join(project, "src/app.ts"), "changed\n");
  // Remove the just-created baseline: this check would otherwise compare only.
  await rm(join(project, ".idiom/baselines"), { recursive: true });
  const spawn = vi.fn(() => {
    throw new Error("must not start");
  });
  await expect(
    checkCommand({
      project,
      flow: "studio",
      dependencies: { capture: { process: { spawn: spawn as never } } },
    }),
  ).rejects.toThrow(/tree dirty: src\/app.ts/);
  expect(spawn).not.toHaveBeenCalled();
}, 60_000);
test("status audits staged, untracked, deleted, Unicode and rename boundaries", async () => {
  const { project } = await fixture();
  await writeFile(join(project, "tickets/new space é.md"), "new");
  await rm(join(project, "tickets/x.md"));
  await git(project, "add", "tickets/x.md");
  let status = await sourceStatus(project, { ignoreDirty: ["tickets/**"] });
  expect(status.dirty).toBe(false);
  expect(status.ignoredDirtyPaths).toEqual([
    "tickets/new space é.md",
    "tickets/x.md",
  ]);
  await git(project, "reset", "--hard", "HEAD");
  await rename(join(project, "src/app.ts"), join(project, "tickets/app.ts"));
  await git(project, "add", "src/app.ts", "tickets/app.ts");
  status = await sourceStatus(project, { ignoreDirty: ["tickets/**"] });
  expect(status.dirty).toBe(true);
  expect(status.ignoredDirtyPaths).toContain("tickets/app.ts");
});
test("repository-root patterns also apply from nested projects", async () => {
  const { project } = await fixture();
  const nested = join(project, "nested");
  await mkdir(nested);
  await writeFile(join(project, "tickets/x.md"), "changed");
  expect(
    await sourceStatus(nested, { ignoreDirty: ["tickets/**"] }),
  ).toMatchObject({ dirty: false, ignoredDirtyPaths: ["tickets/x.md"] });
});
for (const [pattern, build, files, example] of [
  ["src/**", "node -e 0", {}, "src"],
  [
    "tickets/**",
    "npm run build",
    {
      "package.json": JSON.stringify({
        scripts: { build: "node scripts/build.mjs tickets" },
      }),
      "scripts/build.mjs": "",
    },
    "tickets",
  ],
  [
    "tickets/**",
    "pnpm --dir apps/site run build",
    {
      "apps/site/package.json": JSON.stringify({
        scripts: { build: "node ../../scripts/build.mjs ../../tickets" },
      }),
      "scripts/build.mjs": "",
    },
    "tickets",
  ],
  [
    "tickets/**",
    "bun --cwd apps/site run build",
    {
      "apps/site/package.json": JSON.stringify({
        scripts: { build: "node ../../scripts/build.mjs ../../tickets" },
      }),
      "scripts/build.mjs": "",
    },
    "tickets",
  ],
  [
    "tickets/**",
    "node -e 0",
    {
      "app/page.tsx":
        "import content from '../tickets/x.md'; export default content;",
    },
    "tickets/x.md",
  ],
  [
    "content/future.md",
    "node scripts/build.mjs content",
    { "scripts/build.mjs": "", "content/current.md": "input" },
    "content",
  ],
] as const) {
  test(`validation protects ${example} through ${build}`, async () => {
    const { project, config, configPath } = await fixture([pattern]);
    config.server.build = build;
    await writeFile(configPath, JSON.stringify(config));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(project, path, ".."), { recursive: true });
      await writeFile(join(project, path), content);
    }
    await expect(validateProject({ project, flow: "studio" })).rejects.toThrow(
      /baselines.ignoreDirty\[0\].*protected input/,
    );
  });
}

for (const mutation of ["excluded", "source", "commit"] as const) {
  test(`final provenance and baseline guard detect ${mutation} changes during capture`, async () => {
    const { project } = await fixture();
    let mutated = false;
    const result = await checkCommand({
      project,
      flow: "studio",
      all: true,
      dependencies: {
        capture: {
          onActivity: (activity) => {
            if (activity.step === "runtime teardown") mutated = true;
          },
          snapshotSource: async (directory, options) => {
            if (mutated) {
              mutated = false;
              if (mutation === "excluded")
                await writeFile(
                  join(project, "tickets/new.md"),
                  "changed during capture",
                );
              else if (mutation === "source")
                await writeFile(
                  join(project, "src/app.ts"),
                  "changed during capture",
                );
              else await commit(project, "advanced during capture");
            }
            const { dirtyPaths: _paths, ...source } = await sourceStatus(
              directory,
              options,
            );
            return source;
          },
        },
      },
    });
    const run = JSON.parse(
      await readFile(join(result.runDirectory, "run.json"), "utf8"),
    );
    const tuple = JSON.parse(
      await readFile(
        join(result.runDirectory, "editor/desktop/metadata.json"),
        "utf8",
      ),
    );
    expect(run.source.dirty).toBe(mutation !== "excluded");
    expect(tuple.source).toEqual(run.source);
    if (mutation === "excluded")
      expect(run.source.ignoredDirtyPaths).toContain("tickets/new.md");
    if (mutation === "commit")
      expect(run.source.changedDuringCapture).toBe(true);
    if (mutation !== "excluded")
      await expect(
        checkCommand({
          project,
          flow: "studio",
          from: basename(result.runDirectory),
        }),
      ).rejects.toThrow(/captured tree was dirty/);
  }, 60_000);
}

test("the union of exclusions cannot cover the full index, including deleted entries", async () => {
  const { project, config, configPath } = await fixture();
  const files = (await git(project, "ls-files")).split("\n");
  config.baselines.ignoreDirty = files;
  await writeFile(configPath, JSON.stringify(config));
  await rm(join(project, "src/app.ts"));
  await expect(validateProject({ project, flow: "studio" })).rejects.toThrow(
    /union excludes the entire repository/,
  );
});

for (const build of [
  "node build.mjs",
  "sh build.sh",
  "node -e \"const fs=require('fs');fs.readFileSync('tickets/x.md')\"",
  "cat *.md",
]) {
  test(`validation follows indexed and literal inputs through ${build}`, async () => {
    const { project, config, configPath } = await fixture(
      build === "cat *.md" ? ["README.md"] : ["tickets/**"],
    );
    config.server.build = build;
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(
      join(project, "build.mjs"),
      "import text from './tickets/x.md';",
    );
    await writeFile(join(project, "build.sh"), "#!/bin/sh\ncat tickets/x.md\n");
    await writeFile(join(project, "README.md"), "input");
    await commit(project, "literal inputs");
    await rm(join(project, "tickets/x.md"));
    await expect(validateProject({ project, flow: "studio" })).rejects.toThrow(
      /protected input/,
    );
  });
}

test("a conventional asset tree protects its symlink target", async () => {
  const { project } = await fixture();
  await symlink("tickets", join(project, "public"), "dir");
  await expect(validateProject({ project, flow: "studio" })).rejects.toThrow(
    /protected input tickets \(.*symlink target of public/,
  );
});

test("local design directories without suffixes are protected inputs", async () => {
  const { project, config, configPath } = await fixture(["reference/**"]);
  await mkdir(join(project, "reference"));
  await writeFile(join(project, "reference/index.html"), "design");
  const flowFile = join(project, ".idiom/flows/studio.json");
  const flow = JSON.parse(await readFile(flowFile, "utf8"));
  flow.states[0].design = "reference";
  await writeFile(flowFile, JSON.stringify(flow));
  await writeFile(configPath, JSON.stringify(config));
  await expect(validateProject({ project, flow: "studio" })).rejects.toThrow(
    /protected input reference \(configured local reference/,
  );
});

test("workspace dependencies protect entrypoints outside conventional source trees", async () => {
  const { project, configPath, config } = await fixture([
    "packages/ui/entry.mjs",
  ]);
  config.server.build = "node -e 0";
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(join(project, "packages/ui"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      workspaces: ["packages/*"],
      dependencies: { "@fixture/ui": "workspace:*" },
    }),
  );
  await writeFile(
    join(project, "packages/ui/package.json"),
    JSON.stringify({ name: "@fixture/ui", exports: "./entry.mjs" }),
  );
  await writeFile(
    join(project, "packages/ui/entry.mjs"),
    "export default 'input';",
  );
  await expect(validateProject({ project, flow: "studio" })).rejects.toThrow(
    /protected input packages\/ui \(local workspace dependency/,
  );
});
