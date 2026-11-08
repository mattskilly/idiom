import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { run } from "../src/cli.js";
import {
  type InitConfirmationRequest,
  initProject,
  initSummaryLines,
} from "../src/commands/init.js";
import { DESIGN_QA_BODY } from "../src/wiring/instructions.js";
import { planWiring } from "../src/wiring/plan.js";
import { renderWiringPlan, runWiring } from "../src/wiring/run.js";
import type { WiringDependencies } from "../src/wiring/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function temporary(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-wiring-plan-")),
  );
  directories.push(directory);
  return directory;
}
const seams: WiringDependencies = {
  git: async () => {
    throw new Error("not git");
  },
  environment: { PATH: "" },
};

/** Every signal except hooks, which tests add as needed. */
async function project(): Promise<string> {
  const root = await temporary();
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, "CLAUDE.md"), "# Claude\n");
  await mkdir(join(root, ".cursor"));
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(
    join(root, "autobuild.toml"),
    '[[landing]]\nfrom = "leaf"\nmode = "auto"\n',
  );
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

test("the plan lists every surface with its default and reason", async () => {
  const root = await project();
  await mkdir(join(root, ".husky"));
  const plan = await planWiring(root, {}, seams);
  expect(
    plan.proposals.map((row) => [row.surface, row.selected, row.disposition]),
  ).toEqual([
    ["agents", true, "create"],
    ["claude", true, "update"],
    ["cursor", true, "create"],
    ["github", true, "create"],
    ["husky", false, "skipped"],
    ["lefthook", false, "unavailable"],
    ["autobuild-gate", false, "skipped"],
    ["autobuild-verifier", false, "skipped"],
    ["autobuild-landing", false, "skipped"],
    ["autobuild-plan", false, "unavailable"],
    ["autobuild-implement", false, "unavailable"],
    ["autobuild-code-review", false, "unavailable"],
  ]);
  const text = renderWiringPlan(plan);
  expect(text).toContain(
    "Detected: autobuild.toml, .github/workflows, .husky, CLAUDE.md, .cursor.",
  );
  expect(text).toContain("claude absent; codex absent (not launched)");
  expect(text).toContain(
    "[ ] husky: skipped .husky/pre-push — Default off; select it explicitly. Pre-push: idiom check --gate --fail-on blocker",
  );
  expect(text).toContain(
    "Tickets labelled design-review wait for a person before merging.",
  );
  expect(text).toContain("+++ b/.github/workflows/idiom.yml");
});

test("declining the single confirmation writes nothing", async () => {
  const root = await project();
  const before = await snapshot(root);
  const confirm = vi.fn(async () => false);
  const report = await runWiring(root, {}, { ...seams, confirm }, () => {});
  expect(report.mode).toBe("declined");
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(await snapshot(root)).toEqual(before);
});

test("--yes applies the safe defaults only, and reruns change nothing", async () => {
  const root = await project();
  await mkdir(join(root, ".husky"));
  const report = await runWiring(root, { yes: true }, seams, () => {});
  expect(report.mode).toBe("applied");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
    DESIGN_QA_BODY,
  );
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toContain(
    DESIGN_QA_BODY,
  );
  expect(
    await readFile(join(root, ".cursor/rules/idiom.mdc"), "utf8"),
  ).toContain("alwaysApply: true");
  const workflow = await readFile(
    join(root, ".github/workflows/idiom.yml"),
    "utf8",
  );
  expect(parse(workflow).on.schedule).toBeUndefined();
  // Hooks, nightly, landing and the older gate stay off under bare --yes.
  await expect(lstat(join(root, ".husky/pre-push"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(root, "autobuild.toml"), "utf8")).toBe(
    '[[landing]]\nfrom = "leaf"\nmode = "auto"\n',
  );
  const after = await snapshot(root);
  const again = await runWiring(root, { yes: true }, seams, () => {});
  expect(
    again.proposals.filter((row) => row.selected).map((row) => row.disposition),
  ).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
  expect(await snapshot(root)).toEqual(after);
});

test("the plan offers a local cron line and the launchd command for idiom nightly, and writes neither", async () => {
  const root = await project();
  const before = await snapshot(root);
  let printed = "";
  const report = await runWiring(root, { dryRun: true }, seams, (message) => {
    printed += message;
  });
  const cron = `17 3 * * * cd '${root}' && PATH='/usr/bin:/bin' idiom nightly >> .idiom/reports/nightly.log 2>&1`;
  expect(report.schedule).toEqual({
    cron,
    launchd: "idiom nightly --print-schedule launchd",
  });
  expect(printed).toContain(`  ${cron}\n`);
  expect(printed).toContain("idiom nightly --print-schedule launchd");
  expect(await snapshot(root)).toEqual(before);
  const applied = await runWiring(root, { yes: true }, seams, () => {});
  expect(applied.schedule?.cron).toBe(cron);
  const files = Object.keys(await snapshot(root));
  expect(files.some((path) => /cron|launchd|plist/i.test(path))).toBe(false);
});

test("explicit opt-ins wire the hook, nightly and landing rule", async () => {
  const root = await project();
  await mkdir(join(root, ".husky"));
  await runWiring(
    root,
    { yes: true, gitHook: true, nightly: true, designReview: true },
    seams,
    () => {},
  );
  const hook = join(root, ".husky/pre-push");
  expect(await readFile(hook, "utf8")).toContain(
    "idiom check --gate --fail-on blocker",
  );
  expect((await stat(hook)).mode & 0o111).not.toBe(0);
  expect(
    await readFile(join(root, ".github/workflows/idiom.yml"), "utf8"),
  ).toContain("schedule");
  expect(await readFile(join(root, "autobuild.toml"), "utf8")).toMatch(
    /^# idiom:wiring:autobuild-landing:begin\n\[\[landing\]\]\nlabel = "design-review"\nmode = "consent"\n/,
  );
  // Managed opt-ins keep updating on ordinary reruns without the flags.
  const again = await planWiring(root, {}, seams);
  expect(
    again.proposals.filter((row) => row.selected).map((row) => row.surface),
  ).toEqual([
    "agents",
    "claude",
    "cursor",
    "github",
    "husky",
    "autobuild-landing",
  ]);
  expect(again.writes).toEqual([]);
});

test("each surface can be skipped individually and stays byte-identical", async () => {
  for (const surface of ["agents", "claude", "cursor", "github"] as const) {
    const root = await project();
    const before = await snapshot(root);
    const report = await runWiring(
      root,
      { yes: true, skipWiring: [surface] },
      seams,
      () => {},
    );
    const row = report.proposals.find((entry) => entry.surface === surface);
    expect(row?.disposition).toBe("skipped");
    const after = await snapshot(root);
    for (const path of Object.keys(after))
      if (
        (surface === "agents" && path === "AGENTS.md") ||
        (surface === "claude" && path === "CLAUDE.md") ||
        (surface === "cursor" && path.startsWith(".cursor/")) ||
        (surface === "github" && path.startsWith(".github/"))
      )
        expect(after[path]).toBe(before[path]);
  }
  await expect(
    runWiring(await project(), { skipWiring: ["bogus"] }, seams, () => {}),
  ).rejects.toThrow(/Unknown wiring surface "bogus"/);
});

test("two hook managers need a choice; never both silently", async () => {
  const root = await project();
  await mkdir(join(root, ".husky"));
  await writeFile(join(root, "lefthook.yml"), "");
  await expect(
    runWiring(root, { yes: true, gitHook: true }, seams, () => {}),
  ).rejects.toThrow(/Both husky and lefthook/);
  await runWiring(
    root,
    { yes: true, gitHook: true, skipWiring: ["lefthook"] },
    seams,
    () => {},
  );
  expect(await readFile(join(root, ".husky/pre-push"), "utf8")).toContain(
    "idiom check",
  );
  expect(await readFile(join(root, "lefthook.yml"), "utf8")).toBe("");
  const none = await project();
  await expect(
    runWiring(none, { yes: true, gitHook: true }, seams, () => {}),
  ).rejects.toThrow(/--git-hook requires/);
});

test("a protected destination does not block other surfaces", async () => {
  const root = await project();
  const outside = await temporary();
  await writeFile(join(outside, "CLAUDE.md"), "foreign");
  await rm(join(root, "CLAUDE.md"));
  await symlink(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"));
  await writeFile(join(root, ".github/workflows/idiom.yml"), "name: theirs\n");
  const report = await runWiring(root, { yes: true }, seams, () => {});
  const rows = Object.fromEntries(
    report.proposals.map((row) => [row.surface, row.disposition]),
  );
  expect(rows).toMatchObject({
    agents: "create",
    claude: "protected",
    github: "protected",
  });
  expect(await readFile(join(outside, "CLAUDE.md"), "utf8")).toBe("foreign");
  expect(
    await readFile(join(root, ".github/workflows/idiom.yml"), "utf8"),
  ).toBe("name: theirs\n");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
    DESIGN_QA_BODY,
  );
});

test("a CLAUDE.md alias to AGENTS.md is written once through AGENTS.md", async () => {
  const root = await temporary();
  await writeFile(join(root, "AGENTS.md"), "# Agents\n");
  await symlink("AGENTS.md", join(root, "CLAUDE.md"));
  const report = await runWiring(root, { yes: true }, seams, () => {});
  expect(
    report.proposals.find((row) => row.surface === "claude")?.reason,
  ).toContain("covered");
  expect((await lstat(join(root, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
  const text = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(text.match(/idiom:wiring:design-qa:begin/g)).toHaveLength(1);
});

test("a file changed after the preview is never overwritten", async () => {
  const root = await project();
  const report = runWiring(
    root,
    {},
    {
      ...seams,
      confirm: async () => {
        await writeFile(join(root, "CLAUDE.md"), "edited meanwhile\n");
        return true;
      },
    },
    () => {},
  );
  await expect(report).rejects.toThrow(/Rerun idiom init --wire/);
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(
    "edited meanwhile\n",
  );
  await expect(lstat(join(root, "AGENTS.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a failed write rolls back earlier writes", async () => {
  const root = await project();
  const before = await snapshot(root);
  await expect(
    runWiring(
      root,
      { yes: true },
      {
        ...seams,
        apply: {
          beforeRename: async (path) => {
            if (path === ".github/workflows/idiom.yml")
              throw new Error("disk full");
          },
        },
      },
      () => {},
    ),
  ).rejects.toThrow(/disk full/);
  expect(await snapshot(root)).toEqual(before);
});

test("init --dry-run creates nothing, not even scaffold or flows", async () => {
  const parent = await temporary();
  const root = join(parent, "new-app");
  const generateFlows = vi.fn();
  const confirm = vi.fn(async () => true);
  const output: string[] = [];
  const result = await initProject({
    project: root,
    flows: true,
    generateFlows,
    confirm,
    wiring: { dryRun: true },
    wiringDependencies: seams,
    write: (message) => output.push(message),
  });
  expect(result.mode).toBe("dry-run");
  expect(result.wiring?.mode).toBe("preview");
  expect(output.join("")).toContain("Idiom wiring plan:");
  expect(generateFlows).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(initSummaryLines(result).at(-1)).toBe(
    "Dry run: nothing was created or changed.",
  );
});

test("init --wire needs an initialized project and touches only wiring", async () => {
  const root = await project();
  await expect(
    initProject({
      project: root,
      yes: true,
      wiring: { wire: true },
      wiringDependencies: seams,
      write: () => {},
    }),
  ).rejects.toThrow(/Run idiom init first/);
  await initProject({
    project: root,
    yes: true,
    wiring: { skipWiring: ["agents", "claude", "cursor", "github"] },
    wiringDependencies: seams,
    write: () => {},
  });
  await writeFile(join(root, "PRODUCT.md"), "edited product\n");
  const before = await snapshot(root);
  const kinds: string[] = [];
  const result = await initProject({
    project: root,
    wiring: { wire: true },
    wiringDependencies: seams,
    confirm: async (request: InitConfirmationRequest) => {
      kinds.push(request.kind);
      return true;
    },
    write: () => {},
  });
  expect(kinds).toEqual(["apply-wiring"]);
  expect(result.mode).toBe("wire");
  const after = await snapshot(root);
  // At a prompt the existing gate is offered too; scaffold bytes stay put.
  for (const [path, content] of Object.entries(before))
    if (path.endsWith(".idiom-pristine/manifest.json"))
      expect(JSON.parse(after[path] ?? "{}")).toMatchObject(
        JSON.parse(content),
      );
    else if (path !== "CLAUDE.md" && path !== "autobuild.toml")
      expect(after[path]).toBe(content);
  expect(after["AGENTS.md"]).toContain(DESIGN_QA_BODY);
  expect(result.autobuild.kind).toBe("applied");
  expect(initSummaryLines(result).at(-1)).toContain("Wiring only");
});

async function cli(root: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", "init", ...args], {
    cwd: root,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
    wiring: seams,
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("CLI: dry-run previews; invalid combinations and ids are refused", async () => {
  const root = await project();
  const before = await snapshot(root);
  const dry = await cli(root, ["--dry-run", "--yes", "--nightly"]);
  expect(dry.code).toBe(0);
  expect(dry.stdout).toContain(
    "[x] github: create .github/workflows/idiom.yml",
  );
  expect(await snapshot(root)).toEqual(before);
  const bogus = await cli(root, ["--skip-wiring", "bogus"]);
  expect(bogus.code).not.toBe(0);
  expect(bogus.stderr).toContain("Allowed choices are agents");
  const validate = await cli(root, ["--validate", "--wire"]);
  expect(validate.code).not.toBe(0);
  expect(validate.stderr).toContain("cannot be combined with --validate");
  const flows = await cli(root, ["--wire", "--flows"]);
  expect(flows.code).not.toBe(0);
  expect(flows.stderr).toContain("--wire only wires");
});
