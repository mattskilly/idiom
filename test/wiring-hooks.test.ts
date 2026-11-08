import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
import {
  HOOK_COMMAND,
  huskyWriter,
  lefthookWriter,
} from "../src/wiring/hooks.js";
import { markers, sectionSpan } from "../src/wiring/sections.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function temporary(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-wiring-hooks-")),
  );
  directories.push(directory);
  return directory;
}

/** Runs a hook script with a fake idiom that exits with IDIOM_STATUS. */
async function runHook(script: string, status: number) {
  const root = await temporary();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "idiom"),
    `#!/bin/sh\necho "idiom $*" >> "${join(root, "log")}"\nexit ${status}\n`,
  );
  await chmod(join(bin, "idiom"), 0o755);
  await writeFile(join(root, "hook"), script);
  const result = spawnSync("sh", [join(root, "hook")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const log = await readFile(join(root, "log"), "utf8").catch(() => "");
  return { status: result.status, stdout: result.stdout, log };
}

test("husky: the gate runs first, propagates failure and keeps existing commands", async () => {
  const original =
    '#!/usr/bin/env sh\n. "$(dirname "$0")/_/husky.sh"\n\necho existing\nexit 0\n';
  const candidate = huskyWriter(original).candidate;
  expect(
    candidate.startsWith(
      '#!/usr/bin/env sh\n. "$(dirname "$0")/_/husky.sh"\n\n# idiom:wiring:husky:begin',
    ),
  ).toBe(true);
  expect(candidate.endsWith("echo existing\nexit 0\n")).toBe(true);
  expect(huskyWriter(candidate).candidate).toBe(candidate);
  const body = candidate.replace(/^\. .*husky\.sh.*$/m, "");
  const passed = await runHook(body, 0);
  expect(passed.status).toBe(0);
  expect(passed.log.trim()).toBe(
    `idiom ${HOOK_COMMAND.slice("idiom ".length)}`,
  );
  expect(passed.stdout).toBe("existing\n");
  const failed = await runHook(body, 3);
  expect(failed.status).toBe(3);
  expect(failed.stdout).toBe("");
  // Manual reversal restores the hook.
  const span = sectionSpan(candidate, markers("husky"));
  expect(span).toBeDefined();
  if (span)
    expect(
      candidate.slice(0, span.start) +
        candidate.slice(span.end).replace(/^\n/, ""),
    ).toBe(original);
});

test("husky: a new hook contains only the marked gate", () => {
  expect(huskyWriter("").candidate).toBe(
    `# idiom:wiring:husky:begin\n${HOOK_COMMAND} || exit $?\n# idiom:wiring:husky:end\n`,
  );
});

test("lefthook: absent pre-push gets a marked, removable container", () => {
  const original =
    "# team hooks\npre-commit:\n  commands:\n    lint:\n      run: bun lint\n";
  const candidate = lefthookWriter(original).candidate;
  expect(candidate.startsWith(original)).toBe(true);
  const parsed = parse(candidate);
  expect(parsed["pre-push"]).toEqual({
    commands: { idiom: { run: HOOK_COMMAND } },
  });
  expect(parsed["pre-commit"]).toEqual(parse(original)["pre-commit"]);
  expect(lefthookWriter(candidate).candidate).toBe(candidate);
});

test("lefthook: existing commands and options are merged, not duplicated", () => {
  const original =
    "pre-push:\n  parallel: true\n  commands:\n    test:\n      run: bun test # keep\n";
  const candidate = lefthookWriter(original).candidate;
  const parsed = parse(candidate);
  expect(parsed["pre-push"]).toEqual({
    parallel: true,
    commands: { test: { run: "bun test" }, idiom: { run: HOOK_COMMAND } },
  });
  expect(candidate).toContain("bun test # keep");
  expect(candidate.match(/pre-push:/g)).toHaveLength(1);
});

test("lefthook: existing jobs receive a named run job", () => {
  const original =
    "pre-push:\n  jobs:\n    - name: test\n      run: bun test\n";
  const parsed = parse(lefthookWriter(original).candidate);
  expect(parsed["pre-push"].jobs).toEqual([
    { name: "test", run: "bun test" },
    { name: "idiom", run: HOOK_COMMAND },
  ]);
});

test("lefthook: collisions and unsupported shapes need a manual addition", () => {
  for (const [source, message] of [
    ["pre-push:\n  commands:\n    idiom:\n      run: theirs\n", /occupied/],
    ["pre-push:\n  jobs:\n    - name: idiom\n      run: theirs\n", /occupied/],
    ["pre-push: { commands: {} }\n", /Unsupported/],
    ["pre-push:\n  commands: [\n", /Invalid lefthook YAML/],
    ["base: &b\n  x: 1\npre-push:\n  <<: *b\n", /Unsupported/],
  ] as const)
    expect(() => lefthookWriter(source)).toThrow(message);
});
