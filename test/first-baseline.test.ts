import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type FirstBaselineDependencies,
  firstBaselineLines,
  recordFirstBaselines,
} from "../src/autobuild/first-baseline.js";
import { initProject, initSummaryLines } from "../src/commands/init.js";
import { renderUpgrade, upgradeCommand } from "../src/commands/upgrade.js";
import type { WiringDependencies } from "../src/wiring/types.js";

// Vitest's stdin is not a TTY: these are runs with no terminal.
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const quiet = () => {};
const seams: WiringDependencies = {
  git: async () => {
    throw new Error("not git");
  },
  environment: { PATH: "" },
};
const ORIGINAL_TOML =
  '[commands]\ntest = "bun run test"\n[verify]\nsteps = ["test"]\n';
const FLOW = {
  id: "home",
  title: "Home",
  setup: [],
  intent: ["A guest can see the landing page."],
  states: [
    {
      id: "home",
      description: "Landing",
      url: "/",
      expect: { textPresent: ["Welcome"] },
    },
  ],
};

const git = (root: string, args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );

/** An initialized project with one flow and autobuild.toml, all committed. */
async function fixture(options: { git?: boolean } = {}): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-first-baseline-")),
  );
  directories.push(root);
  await initProject({
    project: root,
    yes: true,
    write: quiet,
    wiringDependencies: seams,
  });
  await mkdir(join(root, ".idiom", "flows"), { recursive: true });
  await writeFile(
    join(root, ".idiom", "flows", "home.json"),
    JSON.stringify(FLOW),
  );
  await writeFile(join(root, "autobuild.toml"), ORIGINAL_TOML);
  if (options.git !== false) {
    git(root, ["init", "--quiet", "-b", "main"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "init"]);
  }
  return root;
}

/** A stub record that writes the baseline file and notes the tree it saw. */
function stubRecord(root: string) {
  const calls: { flow: string; toml: string }[] = [];
  const dependencies: FirstBaselineDependencies = {
    record: async ({ flow }) => {
      calls.push({
        flow,
        toml: await readFile(join(root, "autobuild.toml"), "utf8"),
      });
      const path = join(root, ".idiom", "baselines", `${flow}.json`);
      await mkdir(join(root, ".idiom", "baselines"), { recursive: true });
      await writeFile(path, "{}\n");
      return { path };
    },
  };
  return { calls, dependencies };
}

describe("recordFirstBaselines", () => {
  test("records each flow with no committed baseline at clean HEAD", async () => {
    const root = await fixture();
    const { calls, dependencies } = stubRecord(root);
    const outcome = await recordFirstBaselines(root, dependencies);
    expect(calls.map((call) => call.flow)).toContain("home");
    expect(outcome).toMatchObject({
      kind: "recorded",
      directory: ".idiom/baselines",
    });
    if (outcome?.kind !== "recorded") throw new Error("not recorded");
    expect(outcome.paths).toContain(".idiom/baselines/home.json");
    expect(firstBaselineLines(outcome).join("\n")).toContain(
      "Commit .idiom/baselines",
    );
  });

  test("a baseline committed at HEAD is present; nothing is recorded", async () => {
    const root = await fixture();
    const { calls, dependencies } = stubRecord(root);
    await recordFirstBaselines(root, dependencies);
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "baseline"]);
    calls.length = 0;
    const outcome = await recordFirstBaselines(root, dependencies);
    expect(outcome?.kind).toBe("present");
    expect(firstBaselineLines(outcome)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a dirty HEAD records nothing and names the exact command", async () => {
    const root = await fixture();
    await writeFile(join(root, "autobuild.toml"), `${ORIGINAL_TOML}# edit\n`);
    const { calls, dependencies } = stubRecord(root);
    const outcome = await recordFirstBaselines(root, dependencies);
    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({
      kind: "next-step",
      commands: expect.arrayContaining(["idiom baseline record home"]),
    });
    const lines = firstBaselineLines(outcome).join("\n");
    expect(lines).toContain("HEAD is not clean (autobuild.toml)");
    expect(lines).toContain("  idiom baseline record home");
    expect(lines).toContain("then commit .idiom/baselines.");
  });

  test("a failed recording becomes the command as the next step", async () => {
    const root = await fixture();
    const outcome = await recordFirstBaselines(root, {
      record: async () => {
        throw new Error("app could not start\nmore detail");
      },
    });
    expect(outcome).toMatchObject({
      kind: "next-step",
      commands: expect.arrayContaining(["idiom baseline record home"]),
    });
    if (outcome?.kind !== "next-step") throw new Error("not next-step");
    expect(outcome.reason).toContain("home: app could not start");
  });

  test("outside Git it names the command", async () => {
    const root = await fixture({ git: false });
    const { calls, dependencies } = stubRecord(root);
    const outcome = await recordFirstBaselines(root, dependencies);
    expect(calls).toEqual([]);
    expect(outcome?.kind).toBe("next-step");
  });
});

describe("noninteractive wiring records the first baseline", () => {
  test("upgrade --yes records at clean HEAD before writing the wiring", async () => {
    const root = await fixture();
    const { calls, dependencies } = stubRecord(root);
    const report = await upgradeCommand({
      project: root,
      agent: false,
      yes: true,
      write: quiet,
      firstBaseline: dependencies,
    });
    expect(report.autobuild?.kind).toBe("applied");
    // The capture saw the tree before the wiring wrote autobuild.toml.
    expect(calls.find((call) => call.flow === "home")?.toml).toBe(
      ORIGINAL_TOML,
    );
    expect(report.firstBaseline?.kind).toBe("recorded");
    expect(renderUpgrade(report)).toContain(
      "Recorded the gate's first baseline at clean HEAD: .idiom/baselines/home.json",
    );
  });

  test("upgrade --yes on a dirty HEAD wires the gate and prints the command", async () => {
    const root = await fixture();
    await writeFile(join(root, "README.md"), "dirty\n");
    const { calls, dependencies } = stubRecord(root);
    const report = await upgradeCommand({
      project: root,
      agent: false,
      yes: true,
      write: quiet,
      firstBaseline: dependencies,
    });
    expect(report.autobuild?.kind).toBe("applied");
    expect(calls).toEqual([]);
    expect(renderUpgrade(report)).toContain("  idiom baseline record home");
  });

  test("without --yes, --dry-run or an already-wired gate, nothing is recorded", async () => {
    const root = await fixture();
    const { calls, dependencies } = stubRecord(root);
    const noYes = await upgradeCommand({
      project: root,
      agent: false,
      firstBaseline: dependencies,
    });
    expect(noYes.autobuild?.kind).toBe("available-noninteractive");
    const dryRun = await upgradeCommand({
      project: root,
      agent: false,
      yes: true,
      dryRun: true,
      firstBaseline: dependencies,
    });
    expect(dryRun.firstBaseline).toBeUndefined();
    expect(calls).toEqual([]);
    await upgradeCommand({
      project: root,
      agent: false,
      yes: true,
      write: quiet,
      firstBaseline: dependencies,
    });
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "wire"]);
    calls.length = 0;
    await rm(join(root, ".idiom", "baselines"), {
      recursive: true,
      force: true,
    });
    const rerun = await upgradeCommand({
      project: root,
      agent: false,
      yes: true,
      write: quiet,
      firstBaseline: dependencies,
    });
    expect(rerun.autobuild?.kind).toBe("already-wired");
    expect(rerun.firstBaseline).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("--skip-wiring autobuild-gate records nothing", async () => {
    const root = await fixture();
    const { calls, dependencies } = stubRecord(root);
    const report = await upgradeCommand({
      project: root,
      agent: false,
      yes: true,
      write: quiet,
      skipWiring: ["autobuild-gate"],
      firstBaseline: dependencies,
    });
    expect(report.autobuild?.kind).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("init --wire --yes records at clean HEAD before writing the wiring", async () => {
    const root = await fixture();
    const { calls, dependencies } = stubRecord(root);
    const result = await initProject({
      project: root,
      yes: true,
      write: quiet,
      wiring: { wire: true },
      wiringDependencies: seams,
      firstBaseline: dependencies,
    });
    expect(result.autobuild.kind).toBe("applied");
    expect(calls.find((call) => call.flow === "home")?.toml).toBe(
      ORIGINAL_TOML,
    );
    expect(result.firstBaseline?.kind).toBe("recorded");
    expect(initSummaryLines(result).join("\n")).toContain(
      "Commit .idiom/baselines so builds compare against it.",
    );
  });

  test("init --wire --yes --skip-wiring autobuild-gate records nothing", async () => {
    const root = await fixture();
    const { calls, dependencies } = stubRecord(root);
    const result = await initProject({
      project: root,
      yes: true,
      write: quiet,
      wiring: { wire: true, skipWiring: ["autobuild-gate"] },
      wiringDependencies: seams,
      firstBaseline: dependencies,
    });
    expect(result.firstBaseline).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
