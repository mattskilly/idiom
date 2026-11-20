import { describe, expect, test, vi } from "vitest";
import { prepareAutobuild, setupAutobuild } from "../src/autobuild/setup.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { UPGRADE_HINT_LINE } from "../src/commands/upgrade.js";
import { put, read, temporary, tree } from "./skill-support.js";

// Vitest's stdin is not a TTY: omitting `confirm` is a run with no terminal.
const original =
  '[commands]\ntest = "bun run test"\n[verify]\nsteps = ["test"]\n';

async function fixture(): Promise<string> {
  const root = await temporary();
  await initProject({ project: root, yes: true, write: () => {} });
  await put(root, "autobuild.toml", original);
  return root;
}

async function upgrade(
  root: string,
  flags: string[],
  confirm?: import("../src/confirmation.js").Confirmation,
): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const code = await run(
    [
      "node",
      "idiom",
      "upgrade",
      "--project",
      root,
      "--no-self-update",
      "--no-agent",
      ...flags,
    ],
    {
      stdout: (value) => {
        stdout += value;
      },
      stderr: () => {},
      ...(confirm ? { confirm } : {}),
    },
  );
  return { code, stdout };
}

const lastLine = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1);

async function expectWired(root: string) {
  const config = await read(root, "autobuild.toml");
  expect(config).toContain("idiom-check");
  expect(config).toMatch(/steps = \[[^\]]*"idiom-check"/);
  expect(config).toContain('skill = "idiom-verify"');
  expect(config).toContain("[finalize.idiom-baseline]");
  const files = await tree(root);
  expect(files[".agents/skills/idiom-verify/SKILL.md"]).toContain(
    "name: idiom-verify",
  );
  expect(files[".claude/skills/idiom-verify"]).toBe(
    "link:../../.agents/skills/idiom-verify",
  );
  expect(
    files[".agents/skills/.idiom-pristine/idiom-verify/SKILL.md"],
  ).toBeDefined();
}

describe("idiom upgrade --yes", () => {
  test("applies every offered Autobuild change with no terminal, printing the same diffs", async () => {
    const root = await fixture();
    const prepared = await prepareAutobuild(root);
    if (!prepared) throw new Error("autobuild not detected");
    const { code, stdout } = await upgrade(root, ["--yes"]);
    expect(code).toBe(0);
    await expectWired(root);
    expect(stdout).toContain(prepared.preview);
    expect(stdout).toContain("+[finalize.idiom-baseline]");
    expect(stdout).toContain("Autobuild: applied");
    expect(stdout).toContain("Autobuild baseline advance: applied");
    expect(stdout).not.toContain(UPGRADE_HINT_LINE);
  });

  test("never prompts", async () => {
    const root = await fixture();
    const confirm = vi.fn(async () => {
      throw new Error("prompted");
    });
    expect((await upgrade(root, ["--yes"], confirm)).code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    await expectWired(root);
  });

  test("--dry-run wins: prints both diffs and writes nothing", async () => {
    const root = await fixture();
    const before = await tree(root);
    const { code, stdout } = await upgrade(root, ["--yes", "--dry-run"]);
    expect(code).toBe(0);
    expect(await tree(root)).toEqual(before);
    expect(stdout).toContain("idiom-check");
    expect(stdout).toContain("+[finalize.idiom-baseline]");
    expect(stdout).not.toContain(UPGRADE_HINT_LINE);
  });

  test("--json stays one JSON document while applying", async () => {
    const root = await fixture();
    const { code, stdout } = await upgrade(root, ["--yes", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.autobuild.kind).toBe("applied");
    expect(report.autobuild.diff).toContain("idiom-check");
    expect(report.baselineAdvance.kind).toBe("applied");
    await expectWired(root);
  });

  test("setupAutobuild under yes with no writer prints nothing", async () => {
    const root = await fixture();
    const spy = vi.spyOn(process.stdout, "write");
    try {
      const outcome = await setupAutobuild({
        projectDirectory: root,
        yes: true,
      });
      expect(outcome.kind).toBe("applied");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("--skip-wiring autobuild-gate leaves the gate and keeps the baseline step", async () => {
    const root = await fixture();
    const { code, stdout } = await upgrade(root, [
      "--yes",
      "--skip-wiring",
      "autobuild-gate",
    ]);
    expect(code).toBe(0);
    const config = await read(root, "autobuild.toml");
    expect(config).not.toContain("idiom-check");
    expect(config).toContain("[finalize.idiom-baseline]");
    expect(
      (await tree(root))[".agents/skills/idiom-verify/SKILL.md"],
    ).toBeUndefined();
    expect(stdout).toContain("Autobuild: skipped");
  });

  test("--skip-wiring autobuild-baseline leaves the finalize step and wires the gate", async () => {
    const root = await fixture();
    const { code, stdout } = await upgrade(root, [
      "--yes",
      "--skip-wiring",
      "autobuild-baseline",
    ]);
    expect(code).toBe(0);
    const config = await read(root, "autobuild.toml");
    expect(config).toContain("idiom-check");
    expect(config).not.toContain("[finalize.idiom-baseline]");
    expect(stdout).toContain("Autobuild baseline advance: skipped");
  });

  test("--skip-wiring agents leaves AGENTS.md without the brief instruction", async () => {
    const root = await fixture();
    await put(root, "AGENTS.md", "# Agents\n");
    await upgrade(root, ["--yes", "--skip-wiring", "agents"]);
    expect(await read(root, "AGENTS.md")).toBe("# Agents\n");
    await upgrade(root, ["--yes"]);
    expect(await read(root, "AGENTS.md")).toContain("idiom brief");
  });

  test("a rerun on a wired project changes nothing", async () => {
    const root = await fixture();
    await upgrade(root, ["--yes"]);
    const before = await tree(root);
    const { code, stdout } = await upgrade(root, ["--yes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Autobuild: already-wired");
    expect(await tree(root)).toEqual(before);
  });
});

describe("idiom upgrade without --yes and with no terminal", () => {
  test("writes nothing and ends with the --yes command", async () => {
    const root = await fixture();
    const before = await tree(root);
    const { code, stdout } = await upgrade(root, []);
    expect(code).toBe(0);
    expect(await tree(root)).toEqual(before);
    expect(lastLine(stdout)).toBe(UPGRADE_HINT_LINE);
    expect(stdout.split(UPGRADE_HINT_LINE)).toHaveLength(2);
  });

  test("--json and --dry-run carry no hint", async () => {
    const root = await fixture();
    const json = await upgrade(root, ["--json"]);
    expect(JSON.parse(json.stdout).autobuild.kind).toBe(
      "available-noninteractive",
    );
    const dry = await upgrade(root, ["--dry-run"]);
    expect(dry.stdout).not.toContain(UPGRADE_HINT_LINE);
  });
});
