import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { fixtureCommand } from "./support/fixture-server.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const LAW =
  "Nothing in a toolbar sits closer than 4px, glyph to glyph or glyph to button";
const fixtures = join(import.meta.dirname, "fixtures", "offset-chip");

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd })).stdout.trim();
}
async function commit(cwd: string, message: string) {
  await git(cwd, "add", "-A");
  await git(
    cwd,
    "-c",
    "user.name=Law test",
    "-c",
    "user.email=law@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    message,
  );
}

async function idiom(project: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", ...args, "--project", project], {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

type StoredFinding = {
  rule?: string;
  verification: { params?: Record<string, unknown> };
};

async function controlGaps(project: string) {
  const checked = await idiom(project, [
    "check",
    "offset-chip",
    "--json",
    "--fail-on",
    "never",
  ]);
  expect(checked.stderr).not.toContain("check failed");
  expect(checked.code).toBe(0);
  const summary = JSON.parse(checked.stdout) as { runDirectory: string };
  const findings = JSON.parse(
    await readFile(join(summary.runDirectory, "findings.json"), "utf8"),
  ) as StoredFinding[] | { findings: StoredFinding[] };
  return {
    text: checked.stdout,
    gaps: (Array.isArray(findings) ? findings : findings.findings).filter(
      (finding) => finding.rule === "idiom:control-gap",
    ),
  };
}

test("a toolbar law learned with --yes flags the chip reached through steps, and fixing the chip clears it", async () => {
  const project = await mkdtemp(join(tmpdir(), "idiom-law-"));
  roots.push(project);
  await initProject({ project, yes: true });
  const configPath = join(project, ".idiom", "project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.viewports = [{ name: "desktop", width: 1024, height: 700 }];
  config.colorSchemes = ["light"];
  config.server.build = "node -e 0";
  config.server.start = fixtureCommand("server.mjs");
  config.server.env = {};
  config.capture = { settleMs: 0, maxMinutes: 2 };
  config.checks = { probe: { enabled: false } };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  await mkdir(join(project, ".idiom", "flows"), { recursive: true });
  await copyFile(
    join(fixtures, "offset-chip.flow.json"),
    join(project, ".idiom", "flows", "offset-chip.json"),
  );
  await copyFile(join(fixtures, "server.mjs"), join(project, "server.mjs"));
  await copyFile(join(fixtures, "index.html"), join(project, "index.html"));
  await git(project, "init", "-q", "-b", "main");
  await commit(project, "canvas");

  // 1. Learn the director's sentence; the diff names the check and scope.
  const learned = await idiom(project, ["learn", LAW, "--yes"]);
  expect(learned.stderr).toBe("");
  expect(learned.code).toBe(0);
  expect(learned.stdout).toContain(
    'Compiles to control-gap: parts inside a control keep at least 4px apart, scoped to the toolbar ([role="toolbar"]).',
  );
  expect(learned.stdout).toContain("+++ b/.idiom/project.json");
  expect(
    JSON.parse(await readFile(configPath, "utf8")).checks.controlGap,
  ).toEqual({
    scopes: [{ name: `${LAW}.`, selector: '[role="toolbar"]', min: 4 }],
  });
  await commit(project, "learn the toolbar law");

  // 2. Check: the chip, reached by clicking the block, fails the law.
  const failing = await controlGaps(project);
  expect(failing.gaps.length).toBeGreaterThan(0);
  for (const gap of failing.gaps) {
    expect(gap.verification.params).toMatchObject({
      selector: "span.chip",
      min: 4,
      scope: '[role="toolbar"]',
    });
    expect(gap.verification.params?.gap).toBeLessThan(4);
  }
  await commit(project, "baseline");

  // 3. Fix the chip: room between its parts and normal word spacing.
  const page = await readFile(join(project, "index.html"), "utf8");
  await writeFile(
    join(project, "index.html"),
    page.replace('<html lang="en">', '<html lang="en" data-fixed>'),
  );
  await commit(project, "fix the chip");
  const fixed = await controlGaps(project);
  expect(fixed.gaps).toEqual([]);

  // 4. Agents see the law before writing UI.
  const context = await idiom(project, ["context"]);
  expect(context.code).toBe(0);
  expect(context.stdout).toContain(
    `- ${LAW}: inside [role="toolbar"], parts of a control keep at least 4px apart (control-gap).`,
  );

  // Evidence for the build: the learn diff and both checks.
  const evidence = process.env.IDIOM_LAW_EVIDENCE;
  if (evidence !== undefined)
    await writeFile(
      evidence,
      [
        "$ idiom learn <toolbar law> --yes",
        learned.stdout,
        "$ idiom check offset-chip (cramped chip): control-gap findings",
        JSON.stringify(failing.gaps, null, 2),
        "$ idiom check offset-chip (fixed chip): control-gap findings",
        JSON.stringify(fixed.gaps, null, 2),
        "$ idiom context (excerpt)",
        context.stdout
          .split("\n")
          .filter((line) => line.includes("(control-gap)"))
          .join("\n"),
        "",
      ].join("\n"),
    );
}, 180_000);
