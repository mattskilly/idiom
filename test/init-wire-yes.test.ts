import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import {
  INIT_WIRE_HINT_LINE,
  initProject,
  initSummaryLines,
} from "../src/commands/init.js";
import type { WiringDependencies } from "../src/wiring/types.js";

// Vitest's stdin is not a TTY: omitting `confirm` is a run with no terminal.
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const seams: WiringDependencies = {
  git: async () => {
    throw new Error("not git");
  },
  environment: { PATH: "" },
};
const quiet = () => {};
const PLAN_SKILL = "---\nname: ab-plan\ndescription: plan\n---\n# Plan\n";

async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-init-wire-yes-")),
  );
  directories.push(root);
  await initProject({
    project: root,
    yes: true,
    write: quiet,
    wiringDependencies: seams,
  });
  await writeFile(
    join(root, "autobuild.toml"),
    '[commands]\ntest = "bun run test"\n[verify]\nsteps = ["test"]\n',
  );
  await mkdir(join(root, ".agents/skills/ab-plan"), { recursive: true });
  await writeFile(join(root, ".agents/skills/ab-plan/SKILL.md"), PLAN_SKILL);
  return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(relative: string) {
    for (const name of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const entry = await lstat(join(root, path));
      if (entry.isDirectory()) await walk(path);
      else
        files[path] = entry.isFile()
          ? await readFile(join(root, path), "utf8")
          : "link";
    }
  }
  await walk("");
  return files;
}

const read = (root: string, path: string) => readFile(join(root, path), "utf8");

test("init --wire --yes applies the gate, skill, baseline step and phase skill section", async () => {
  const root = await fixture();
  let preview = "";
  const result = await initProject({
    project: root,
    yes: true,
    wiring: { wire: true },
    wiringDependencies: seams,
    write: (message) => {
      preview += message;
    },
  });
  expect(result.autobuild.kind).toBe("applied");
  expect(preview).toContain("[x] autobuild-gate");
  const config = await read(root, "autobuild.toml");
  expect(config).toContain("idiom-check");
  expect(config).toContain('skill = "idiom-verify"');
  expect(config).toContain("[finalize.idiom-baseline]");
  const files = await snapshot(root);
  expect(files[".agents/skills/idiom-verify/SKILL.md"]).toContain(
    "name: idiom-verify",
  );
  expect(files[".claude/skills/idiom-verify"]).toBe("link");
  expect(files[".agents/skills/ab-plan/SKILL.md"]).not.toBe(PLAN_SKILL);
  expect(files[".agents/skills/ab-plan/SKILL.md"]).toContain("idiom context");
  expect(initSummaryLines(result)).not.toContain(INIT_WIRE_HINT_LINE);
});

test("--skip-wiring leaves a surface alone under --wire --yes", async () => {
  const gate = await fixture();
  await initProject({
    project: gate,
    yes: true,
    wiring: { wire: true, skipWiring: ["autobuild-gate"] },
    wiringDependencies: seams,
    write: quiet,
  });
  expect(await read(gate, "autobuild.toml")).not.toContain("idiom-check");
  const plan = await fixture();
  await initProject({
    project: plan,
    yes: true,
    wiring: { wire: true, skipWiring: ["autobuild-plan"] },
    wiringDependencies: seams,
    write: quiet,
  });
  expect(await read(plan, ".agents/skills/ab-plan/SKILL.md")).toBe(PLAN_SKILL);
  expect(await read(plan, "autobuild.toml")).toContain("idiom-check");
});

test("init --wire with no terminal and no --yes writes nothing and ends with the hint", async () => {
  const root = await fixture();
  const before = await snapshot(root);
  const result = await initProject({
    project: root,
    wiring: { wire: true },
    wiringDependencies: seams,
    write: quiet,
  });
  expect(await snapshot(root)).toEqual(before);
  expect(result.autobuild.kind).toBe("available-noninteractive");
  const lines = initSummaryLines(result);
  expect(lines.at(-1)).toBe(INIT_WIRE_HINT_LINE);
  expect(lines.filter((line) => line === INIT_WIRE_HINT_LINE)).toHaveLength(1);
});

test("init --dry-run --yes previews the gate diff and writes nothing", async () => {
  const root = await fixture();
  const before = await snapshot(root);
  let preview = "";
  const result = await initProject({
    project: root,
    yes: true,
    wiring: { dryRun: true },
    wiringDependencies: seams,
    write: (message) => {
      preview += message;
    },
  });
  expect(await snapshot(root)).toEqual(before);
  expect(preview).toContain("[x] autobuild-gate");
  expect(preview).toContain("idiom-check");
  expect(initSummaryLines(result)).not.toContain(INIT_WIRE_HINT_LINE);
});

test("report-only --wire --yes (MCP) still writes nothing", async () => {
  const root = await fixture();
  const before = await snapshot(root);
  await initProject({
    project: root,
    yes: true,
    wiring: { wire: true },
    wiringApplication: "report-only",
    wiringDependencies: seams,
    write: quiet,
  });
  expect(await snapshot(root)).toEqual(before);
});

test("CLI: init --wire --yes exits 0 and wires the gate", async () => {
  const root = await fixture();
  const stdout: string[] = [];
  const code = await run(["node", "idiom", "init", "--wire", "--yes"], {
    cwd: root,
    stdout: (message) => stdout.push(message),
    stderr: quiet,
    wiring: seams,
  });
  expect(code).toBe(0);
  expect(await read(root, "autobuild.toml")).toContain("idiom-check");
  expect(stdout.join("")).not.toContain(INIT_WIRE_HINT_LINE);
});
