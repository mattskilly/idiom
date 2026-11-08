import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  applyBriefInstruction,
  planBriefInstruction,
} from "../src/brief/instruction.js";
import { run } from "../src/cli.js";
import { initProject, initSummaryLines } from "../src/commands/init.js";
import { DESIGN_QA_LINES } from "../src/wiring/instructions.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-brief-instruction-")),
  );
  directories.push(directory);
  return directory;
}

const original = "# Project\n\nUse bun.\n";

const block = [
  "<!-- idiom:wiring:design-qa:begin -->",
  ...DESIGN_QA_LINES,
  "<!-- idiom:wiring:design-qa:end -->",
  "",
].join("\n");

test("--yes writes the Design QA block to CLAUDE.md and a new AGENTS.md", async () => {
  const project = await temporary();
  await writeFile(join(project, "CLAUDE.md"), original);
  const confirm = vi.fn(async () => true);
  const result = await initProject({
    project,
    yes: true,
    confirm,
    write: () => {},
  });
  expect(result.briefInstruction).toEqual([
    { kind: "added", path: "AGENTS.md" },
    { kind: "added", path: "CLAUDE.md" },
  ]);
  expect(confirm).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "apply-wiring" }),
  );
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe(
    `${original}${block}`,
  );
  expect(await readFile(join(project, "AGENTS.md"), "utf8")).toBe(block);
  expect(initSummaryLines(result).join("\n")).toContain(
    "claude: wired — Existing Claude instructions receive Design QA too.",
  );
});

test("an accepted plan writes once; a rerun finds it present", async () => {
  const project = await temporary();
  await writeFile(join(project, "CLAUDE.md"), original);
  const confirm = vi.fn(
    async (request: { kind: string }) => request.kind === "apply-wiring",
  );
  const result = await initProject({ project, confirm, write: () => {} });
  expect(result.briefInstruction).toEqual([
    { kind: "added", path: "AGENTS.md" },
    { kind: "added", path: "CLAUDE.md" },
  ]);
  expect(
    confirm.mock.calls.filter(([request]) => request.kind === "apply-wiring"),
  ).toHaveLength(1);
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe(
    `${original}${block}`,
  );
  const again = await initProject({ project, confirm, write: () => {} });
  expect(again.briefInstruction).toEqual([
    { kind: "present", path: "AGENTS.md" },
    { kind: "present", path: "CLAUDE.md" },
  ]);
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe(
    `${original}${block}`,
  );
});

test("a declined offer changes nothing", async () => {
  const project = await temporary();
  await writeFile(join(project, "AGENTS.md"), "no trailing newline");
  const result = await initProject({ project, confirm: async () => false });
  expect(result.briefInstruction).toEqual([
    { kind: "declined", path: "AGENTS.md" },
  ]);
  expect(await readFile(join(project, "AGENTS.md"), "utf8")).toBe(
    "no trailing newline",
  );
});

test("a CLAUDE.md link to AGENTS.md counts once; an @AGENTS.md import targets AGENTS.md", async () => {
  const linked = await temporary();
  await writeFile(join(linked, "AGENTS.md"), original);
  await symlink("AGENTS.md", join(linked, "CLAUDE.md"));
  const plan = await planBriefInstruction(linked);
  expect(plan.kind === "targets" && plan.targets.map((t) => t.path)).toEqual([
    "CLAUDE.md",
  ]);
  const imported = await temporary();
  await writeFile(join(imported, "AGENTS.md"), original);
  await writeFile(join(imported, "CLAUDE.md"), "@AGENTS.md\n");
  const importPlan = await planBriefInstruction(imported);
  expect(
    importPlan.kind === "targets" && importPlan.targets.map((t) => t.path),
  ).toEqual(["AGENTS.md"]);
});

test("an outside CLAUDE.md link is unsafe for the legacy upgrade offer", async () => {
  const outside = await temporary();
  await writeFile(join(outside, "CLAUDE.md"), original);
  const linked = await temporary();
  await symlink(join(outside, "CLAUDE.md"), join(linked, "CLAUDE.md"));
  const plan = await planBriefInstruction(linked);
  expect(plan).toEqual({
    kind: "targets",
    targets: [
      { path: "CLAUDE.md", unsafe: "CLAUDE.md resolves outside the project" },
    ],
  });
});

test("a file changed after preview is not written", async () => {
  const project = await temporary();
  await writeFile(join(project, "CLAUDE.md"), original);
  const plan = await planBriefInstruction(project);
  if (plan.kind !== "targets") throw new Error("expected targets");
  const target = plan.targets[0];
  if (target === undefined || !("content" in target))
    throw new Error("expected a safe target");
  await writeFile(join(project, "CLAUDE.md"), `${original}edited\n`);
  expect(await applyBriefInstruction(target)).toBe("changed");
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe(
    `${original}edited\n`,
  );
});

async function upgrade(
  project: string,
  args: string[],
  confirm?: () => Promise<boolean>,
) {
  const stdout: string[] = [];
  const code = await run(["node", "idiom", "upgrade", "--no-agent", ...args], {
    cwd: project,
    stdout: (message) => stdout.push(message),
    stderr: () => {},
    ...(confirm === undefined ? {} : { confirm }),
  });
  return { code, stdout: stdout.join("") };
}

test("upgrade offers the instruction; --json and --dry-run never prompt or write", async () => {
  const project = await temporary();
  await initProject({
    project,
    yes: true,
    wiring: { skipWiring: ["agents"] },
    write: () => {},
  });
  await writeFile(join(project, "CLAUDE.md"), original);
  const confirm = vi.fn(async () => true);
  const json = await upgrade(project, ["--json"], confirm);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout).briefInstruction).toEqual([
    expect.objectContaining({ kind: "available", path: "CLAUDE.md" }),
  ]);
  const dry = await upgrade(project, ["--dry-run"], confirm);
  expect(dry.stdout).toContain("Optional: add these two lines to CLAUDE.md");
  expect(confirm).not.toHaveBeenCalled();
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe(original);
  const applied = await upgrade(project, [], confirm);
  expect(applied.code).toBe(0);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(applied.stdout).toContain(
    "Added the idiom brief instruction to CLAUDE.md.",
  );
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toContain(
    "idiom brief triage",
  );
});
