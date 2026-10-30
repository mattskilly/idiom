import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { renderUpgrade, upgradeCommand } from "../src/commands/upgrade.js";
import {
  distribution,
  put,
  read,
  runUpgrade,
  skill,
  temporary,
  tree,
} from "./skill-support.js";

test("help exposes upgrade and all three flags", async () => {
  const stdout = vi.fn();
  expect(await run(["node", "idiom", "--help"], { stdout })).toBe(0);
  expect(stdout.mock.calls.flat().join("")).toContain("upgrade");
  stdout.mockClear();
  expect(await run(["node", "idiom", "upgrade", "--help"], { stdout })).toBe(0);
  const help = stdout.mock.calls.flat().join("");
  for (const option of ["--no-agent", "--dry-run", "--json"])
    expect(help).toContain(option);
});
test("JSON report is complete before exit 1 and no-agent never creates a model", async () => {
  const root = await temporary();
  await runUpgrade(root);
  await put(root, ".agents/skills/idiom/init.md", "local");
  const createResolver = vi.fn();
  const stdout = vi.fn();
  const stderr = vi.fn();
  expect(
    await run(
      ["node", "idiom", "--project", root, "upgrade", "--json", "--no-agent"],
      {
        stdout,
        stderr,
        upgrade: {
          distribution: distribution("2.0.0", {
            "SKILL.md": skill(),
            "init.md": "upstream",
          }),
          history: { schema: 1, releases: [] },
          createResolver,
        },
      },
    ),
  ).toBe(1);
  expect(stdout).toHaveBeenCalledOnce();
  const report = JSON.parse(stdout.mock.calls[0]?.[0] as string);
  expect(report.installedVersion).toBe("2.0.0");
  expect(report.previous).toEqual({ kind: "known", version: "1.0.0" });
  expect(report.files[1]).toMatchObject({
    action: "conflicted",
    needsResolution: true,
    pristinePath: ".agents/skills/.idiom-pristine/idiom/init.md",
    incomingPath: "/installed/templates/idiom/init.md",
  });
  expect(stderr).not.toHaveBeenCalled();
  expect(createResolver).not.toHaveBeenCalled();
});
test("dry-run resolves initialized ancestors and leaves a complete project tree untouched", async () => {
  const root = await temporary();
  await initProject({ project: root, yes: true });
  await mkdir(join(root, "nested/deep"), { recursive: true });
  const before = await tree(root);
  const createResolver = vi.fn();
  const stdout = vi.fn();
  expect(
    await run(["node", "idiom", "upgrade", "--dry-run", "--json"], {
      cwd: join(root, "nested/deep"),
      stdout,
      upgrade: { createResolver },
    }),
  ).toBe(0);
  expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toMatchObject({
    projectDirectory: root,
    dryRun: true,
  });
  expect(await tree(root)).toEqual(before);
  expect(createResolver).not.toHaveBeenCalled();
});
test("explicit relative project wins and uninitialized fallback works without configuration", async () => {
  const root = await temporary();
  const nested = join(root, "project");
  await mkdir(nested);
  const report = await upgradeCommand(
    { project: "project", cwd: root, agent: false },
    {
      distribution: distribution("1.0.0"),
      history: { schema: 1, releases: [] },
    },
  );
  expect(report.projectDirectory).toBe(nested);
  expect(report.files.every((file) => file.action === "installed")).toBe(true);
  expect(renderUpgrade(report)).toContain("unknown → 1.0.0");
  expect(renderUpgrade(report)).toContain(
    "installed: .agents/skills/idiom/SKILL.md",
  );
  const stdout = vi.fn();
  expect(
    await run(["node", "idiom", "upgrade", "--no-agent"], {
      cwd: nested,
      stdout,
    }),
  ).toBe(0);
  expect(await read(nested, ".agents/skills/idiom/SKILL.md")).toContain(
    "name: idiom",
  );
});
