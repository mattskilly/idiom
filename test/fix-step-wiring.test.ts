import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { setupFixStep } from "../src/autobuild/setup.js";
import {
  createAutobuildDiff,
  fixSkillLine,
  planAutobuildWiring,
  planFixStep,
} from "../src/autobuild/wiring.js";
import type { InitConfirmationRequest } from "../src/confirmation.js";
import { readAutobuildTemplate } from "../src/templates.js";
import { planWiring } from "../src/wiring/plan.js";
import { runWiring } from "../src/wiring/run.js";
import type { WiringDependencies } from "../src/wiring/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function temporary(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-fix-wiring-")),
  );
  directories.push(directory);
  return directory;
}

const gated = `[commands]
setup = "bun install"
# The UI gate.
idiom-check = "idiom check --gate --fail-on major --deferred warn"

[verify]
steps = ["test", "idiom-check"]

[verify.test]
kind = "check"
command = "setup"

# Idiom's step; keep this comment.
[verify.idiom-check]
kind = "agent"
skill = "idiom-verify"
# No paths: the gate detects UI changes itself.
`;

test("an idiom-verify gate becomes the fix step with a one-line diff, comments kept", async () => {
  const plan = planFixStep(gated, await readAutobuildTemplate());
  expect(plan.kind).toBe("ready");
  expect(plan.candidate).toBe(
    gated.replace('skill = "idiom-verify"', fixSkillLine),
  );
  expect(
    plan.diff.split("\n").filter((line) => /^[-+][^-+]/.test(line)),
  ).toEqual(['-skill = "idiom-verify"', `+${fixSkillLine}`]);
  const document = parseToml(plan.candidate) as {
    verify: Record<string, { kind?: string; skill?: string }> & {
      steps: string[];
    };
    commands: Record<string, string>;
  };
  expect(document.verify["idiom-check"]).toEqual({
    kind: "agent",
    skill: "idiom-fix",
  });
  expect(document.verify.steps).toEqual(["test", "idiom-check"]);
  // The gate plan treats a fix-step gate as wired, so the two never fight.
  const gate = planAutobuildWiring(
    plan.candidate,
    await readAutobuildTemplate(),
  );
  expect(gate).toMatchObject({ kind: "ready", complete: true });
  // Already the fix step: unchanged.
  expect(
    planFixStep(plan.candidate, await readAutobuildTemplate()),
  ).toMatchObject({
    kind: "ready",
    complete: true,
    diff: "",
  });
});

test("no gate wired: the gate is wired with the fix skill and added to steps", async () => {
  const plan = planFixStep(
    '[commands]\nsetup = "x"\n\n[verify]\nsteps = ["test"]\n',
    await readAutobuildTemplate(),
  );
  expect(plan.kind).toBe("ready");
  const document = parseToml(plan.candidate) as {
    verify: Record<string, unknown> & { steps: string[] };
    commands: Record<string, string>;
  };
  expect(document.commands["idiom-check"]).toBe(
    "idiom check --gate --fail-on major --deferred warn",
  );
  expect(document.verify.steps).toEqual(["test", "idiom-check"]);
  expect(document.verify["idiom-check"]).toEqual({
    kind: "agent",
    skill: "idiom-fix",
  });
});

test("a custom idiom-check step is never rewritten", async () => {
  const template = await readAutobuildTemplate();
  const check = planFixStep(
    '[commands]\nidiom-check = "idiom check --gate --fail-on major"\n\n[verify]\nsteps = ["idiom-check"]\n\n[verify.idiom-check]\nkind = "check"\ncommand = "idiom-check"\n',
    template,
  );
  expect(check).toMatchObject({ kind: "manual" });
  expect(check.kind === "manual" && check.reason).toContain(
    "a custom idiom-check step is not rewritten",
  );
  expect(check.manualAddition).toContain(fixSkillLine);
  const other = planFixStep(
    '[verify]\nsteps = ["idiom-check"]\n\n[verify.idiom-check]\nkind = "agent"\nskill = "my-review"\n',
    template,
  );
  expect(other.kind).toBe("manual");
  expect(other.candidate).toBe(other.original);
});

const seams: WiringDependencies = {
  git: async () => {
    throw new Error("not git");
  },
  environment: { PATH: "" },
};
async function autobuildProject(content = gated) {
  const root = await temporary();
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, "autobuild.toml"), content);
  return root;
}
const row = (plan: Awaited<ReturnType<typeof planWiring>>, surface: string) =>
  plan.proposals.find((entry) => entry.surface === surface);

test("init offers the fix row default off; it stays selected once a project runs it", async () => {
  const root = await autobuildProject();
  const offered = await planWiring(root, { offerGate: true }, seams);
  expect(row(offered, "autobuild-fix")).toMatchObject({
    selected: false,
    disposition: "skipped",
  });
  expect(row(offered, "autobuild-fix")?.reason).toContain(
    "Fix new major UI findings inside the build at verify time",
  );
  const chosen = await planWiring(root, { offerGate: true }, seams, {
    selected: ["autobuild-gate", "autobuild-fix"],
    nightly: false,
  });
  expect(row(chosen, "autobuild-fix")).toMatchObject({
    selected: true,
    disposition: "update",
  });
  expect(row(chosen, "autobuild-fix")?.preview).toContain(
    "Create .agents/skills/idiom-fix/SKILL.md",
  );
  const running = await autobuildProject(
    gated.replace('skill = "idiom-verify"', fixSkillLine),
  );
  expect(
    row(await planWiring(running, {}, seams), "autobuild-fix")?.selected,
  ).toBe(true);
});

test("one init confirmation wires the gate and the fix step and installs both skills", async () => {
  const root = await autobuildProject('[commands]\nsetup = "x"\n');
  const report = await runWiring(
    root,
    { offerGate: true },
    {
      ...seams,
      interactive: true,
      confirm: async () => true,
      select: async ({ defaults }) => ({
        ...defaults,
        selected: [...defaults.selected, "autobuild-fix"],
      }),
    },
    () => {},
  );
  expect(report.mode).toBe("applied");
  const config = await readFile(join(root, "autobuild.toml"), "utf8");
  expect(config).toContain(fixSkillLine);
  for (const skill of ["idiom-verify", "idiom-fix"]) {
    expect(
      await readFile(join(root, `.agents/skills/${skill}/SKILL.md`), "utf8"),
    ).toContain(`name: ${skill}`);
    expect(await readlink(join(root, `.claude/skills/${skill}`))).toBe(
      `../../.agents/skills/${skill}`,
    );
  }
  const manifest = JSON.parse(
    await readFile(
      join(root, ".agents/skills/.idiom-pristine/manifest.json"),
      "utf8",
    ),
  );
  expect(Object.keys(manifest.files).sort()).toEqual([
    "idiom-fix/SKILL.md",
    "idiom-verify/SKILL.md",
  ]);
});

test("install refuses a protected fix-skill destination", async () => {
  const root = await autobuildProject();
  await mkdir(join(root, ".agents/skills/idiom-fix"), { recursive: true });
  await writeFile(
    join(root, ".agents/skills/idiom-fix/SKILL.md"),
    "---\nname: something-else\n---\nbody\n",
  );
  const outcome = await setupFixStep({
    projectDirectory: root,
    confirm: async () => true,
    write: () => {},
  });
  expect(outcome).toMatchObject({ kind: "manual" });
  expect(outcome.kind === "manual" && outcome.reason).toContain(
    "Protected fix-step skill destination",
  );
  expect(await readFile(join(root, "autobuild.toml"), "utf8")).toBe(gated);
});

test("upgrade offers the fix step: yes applies, no declines, noninteractive shows the diff", async () => {
  const yes = await autobuildProject();
  const confirm = vi.fn(async (_request: InitConfirmationRequest) => true);
  const written: string[] = [];
  const applied = await setupFixStep({
    projectDirectory: yes,
    confirm,
    write: (message) => written.push(message),
  });
  expect(applied.kind).toBe("applied");
  expect(confirm.mock.calls.map(([request]) => request.kind)).toEqual([
    "offer-fix-step",
    "apply-autobuild-config",
  ]);
  expect(written.join("")).toContain(`+${fixSkillLine}`);
  expect(
    (await lstat(join(yes, ".claude/skills/idiom-fix"))).isSymbolicLink(),
  ).toBe(true);
  expect((await setupFixStep({ projectDirectory: yes, confirm })).kind).toBe(
    "already-wired",
  );

  const no = await autobuildProject();
  expect(
    (
      await setupFixStep({
        projectDirectory: no,
        confirm: async () => false,
      })
    ).kind,
  ).toBe("declined");
  expect(await readFile(join(no, "autobuild.toml"), "utf8")).toBe(gated);

  const quiet = await autobuildProject();
  const preview = await setupFixStep({
    projectDirectory: quiet,
    interactive: false,
  });
  expect(preview.kind).toBe("available-noninteractive");
  const diff = "diff" in preview ? (preview.diff ?? "") : "";
  // The spec's wiring-diff evidence, pinned.
  expect(diff).toMatchSnapshot();
  expect(diff).toBe(
    createAutobuildDiff(
      gated,
      gated.replace('skill = "idiom-verify"', fixSkillLine),
    ) +
      [
        "Create .agents/skills/idiom-fix/SKILL.md",
        "Seed .agents/skills/.idiom-pristine/idiom-fix/SKILL.md and .agents/skills/.idiom-pristine/manifest.json",
        "Create .claude/skills/idiom-fix → ../../.agents/skills/idiom-fix",
        "",
      ].join("\n"),
  );
});

test("idiom upgrade reports the fix-step offer with its diff once the gate is wired", async () => {
  const { renderUpgrade, upgradeCommand } = await import(
    "../src/commands/upgrade.js"
  );
  const root = await autobuildProject();
  await mkdir(join(root, ".idiom"));
  const report = await upgradeCommand({ project: root, dryRun: true });
  expect(report.fixStep?.kind).toBe("available-noninteractive");
  const text = renderUpgrade(report);
  expect(text).toContain("Autobuild fix step: available-noninteractive");
  expect(text).toContain(`+${fixSkillLine}`);
  // A declined gate is never followed by a fix-step offer.
  const bare = await autobuildProject('[commands]\nsetup = "x"\n');
  const declined = await upgradeCommand({
    project: bare,
    confirm: async () => false,
    write: () => {},
  });
  expect(declined.autobuild?.kind).toBe("declined");
  expect(declined.fixStep).toBeUndefined();
});

test("--yes never applies or prompts for the fix step; --skip-wiring autobuild-fix leaves it alone", async () => {
  const root = await autobuildProject();
  const confirm = vi.fn(async (_request: InitConfirmationRequest) => true);
  const offered = await setupFixStep({
    projectDirectory: root,
    yes: true,
    confirm,
  });
  expect(offered.kind).toBe("available-noninteractive");
  expect(confirm).not.toHaveBeenCalled();
  expect(
    (await setupFixStep({ projectDirectory: root, skip: true, confirm })).kind,
  ).toBe("skipped");
  expect(confirm).not.toHaveBeenCalled();
  expect(await readFile(join(root, "autobuild.toml"), "utf8")).toBe(gated);
});
