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
import { parse as parseToml } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { setupBaselineAdvance } from "../src/autobuild/setup.js";
import {
  baselineCommand,
  planBaselineFinalize,
} from "../src/autobuild/wiring.js";
import { run } from "../src/cli.js";
import type { InitConfirmationRequest } from "../src/confirmation.js";
import { githubWriter } from "../src/wiring/github.js";
import { planWiring } from "../src/wiring/plan.js";
import { runWiring } from "../src/wiring/run.js";
import type {
  WiringDependencies,
  WiringDetection,
} from "../src/wiring/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function temporary(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-baseline-wiring-")),
  );
  directories.push(directory);
  return directory;
}

const wired = (source: string) => {
  const document = parseToml(planBaselineFinalize(source).candidate) as {
    commands: Record<string, string>;
    finalize: Record<string, unknown> & { steps: string[] };
  };
  expect(document.commands["idiom-baseline"]).toBe(baselineCommand);
  expect(document.finalize["idiom-baseline"]).toEqual({
    kind: "check",
    command: "idiom-baseline",
  });
  return document;
};

test("wires the finalize step with no [finalize] table", () => {
  const source = 'baseBranch = "main"\n\n[commands]\nsetup = "bun install"\n';
  expect(planBaselineFinalize(source).candidate).toBe(
    'baseBranch = "main"\n\n[commands]\nsetup = "bun install"\nidiom-baseline = "idiom baseline advance --fetch"\n\n[finalize]\nsteps = ["idiom-baseline"]\n\n[finalize.idiom-baseline]\nkind = "check"\ncommand = "idiom-baseline"\n',
  );
});

test("an empty steps array gains the step, next to [finalize], before the next section's comment", () => {
  const source =
    '[commands]\nsetup = "x"\n\n[finalize]\nsteps = []\n\n# ── Roles\n[roles.default]\nruntime = "claude"\n';
  const { candidate } = planBaselineFinalize(source);
  expect(candidate).toBe(
    '[commands]\nsetup = "x"\nidiom-baseline = "idiom baseline advance --fetch"\n\n[finalize]\nsteps = ["idiom-baseline"]\n\n[finalize.idiom-baseline]\nkind = "check"\ncommand = "idiom-baseline"\n\n# ── Roles\n[roles.default]\nruntime = "claude"\n',
  );
});

test("existing finalize steps keep their order and the step is appended", () => {
  const source =
    '[commands]\npublish = "npm publish"\n\n[finalize]\nsteps = ["publish"]\n\n[finalize.publish]\nkind = "check"\ncommand = "publish"\n';
  expect(wired(source).finalize.steps).toEqual(["publish", "idiom-baseline"]);
});

test("already wired leaves the source unchanged", () => {
  const source = planBaselineFinalize('[commands]\nsetup = "x"\n').candidate;
  expect(planBaselineFinalize(source).candidate).toBe(source);
});

test("a foreign command or step under the same name is refused", () => {
  expect(() =>
    planBaselineFinalize('[commands]\nidiom-baseline = "rm -rf ."\n'),
  ).toThrow(/\[commands\]\.idiom-baseline is owned by a different command/);
  expect(() =>
    planBaselineFinalize(
      '[finalize]\nsteps = []\n\n[finalize.idiom-baseline]\nkind = "agent"\nskill = "x"\n',
    ),
  ).toThrow(/\[finalize\.idiom-baseline\] is owned by a different/);
});

test("CRLF and a missing final newline are preserved", () => {
  const crlf = '[commands]\r\nsetup = "x"\r\n\r\n[finalize]\r\nsteps = []\r\n';
  const candidate = planBaselineFinalize(crlf).candidate;
  expect(candidate.replaceAll("\r\n", "")).not.toContain("\n");
  expect(candidate.endsWith("\r\n")).toBe(true);
  wired(crlf);
  const bare = '[commands]\nsetup = "x"';
  const result = planBaselineFinalize(bare).candidate;
  expect(result.endsWith("\n")).toBe(false);
  wired(bare);
});

const seams: WiringDependencies = {
  git: async () => {
    throw new Error("not git");
  },
  environment: { PATH: "" },
};
async function autobuildProject(content = '[commands]\nsetup = "x"\n') {
  const root = await temporary();
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "package-lock.json"), "{}");
  await writeFile(join(root, "autobuild.toml"), content);
  return root;
}
const row = (plan: Awaited<ReturnType<typeof planWiring>>, surface: string) =>
  plan.proposals.find((entry) => entry.surface === surface);

test("at a prompt the baseline row is selected with its exact diff; bare --yes never selects it", async () => {
  const root = await autobuildProject();
  const offered = await planWiring(root, { offerGate: true }, seams);
  expect(row(offered, "autobuild-baseline")).toMatchObject({
    selected: true,
    disposition: "update",
  });
  expect(row(offered, "autobuild-baseline")?.preview).toContain(
    '+idiom-baseline = "idiom baseline advance --fetch"',
  );
  // Gate and baseline edits chain into one autobuild.toml write.
  const writes = offered.writes.filter(
    (write) => write.path === "autobuild.toml",
  );
  expect(writes).toHaveLength(1);
  const document = parseToml(writes[0]?.content ?? "") as {
    commands: Record<string, string>;
    verify: Record<string, unknown>;
    finalize: { steps: string[] };
  };
  expect(document.commands["idiom-baseline"]).toBe(baselineCommand);
  expect(document.verify["idiom-check"]).toBeDefined();
  expect(document.finalize.steps).toEqual(["idiom-baseline"]);

  const bare = await planWiring(root, {}, seams);
  expect(row(bare, "autobuild-baseline")?.selected).toBe(false);
  expect(bare.writes.some((write) => write.path === "autobuild.toml")).toBe(
    false,
  );
});

test("an already wired step stays selected on a rerun, unchanged", async () => {
  const root = await autobuildProject(
    planBaselineFinalize('[commands]\nsetup = "x"\n').candidate,
  );
  const plan = await planWiring(root, {}, seams);
  expect(row(plan, "autobuild-baseline")).toMatchObject({
    selected: true,
    disposition: "unchanged",
  });
});

test("init --wire at a prompt writes the finalize step through the single confirmation", async () => {
  const root = await autobuildProject();
  const report = await runWiring(
    root,
    {},
    {
      ...seams,
      select: async ({ defaults }) => ({
        ...defaults,
        selected: ["autobuild-baseline"],
      }),
      confirm: async () => true,
    },
    () => {},
  );
  expect(report.mode).toBe("applied");
  const after = parseToml(
    await readFile(join(root, "autobuild.toml"), "utf8"),
  ) as { commands: Record<string, string> };
  expect(after.commands["idiom-baseline"]).toBe(baselineCommand);
});

test("upgrade offers the finalize step: yes applies, no declines, noninteractive shows the diff", async () => {
  const yes = await autobuildProject();
  const kinds: string[] = [];
  const confirm = vi.fn(async (request: InitConfirmationRequest) => {
    kinds.push(request.kind);
    return true;
  });
  expect(
    await setupBaselineAdvance({
      projectDirectory: yes,
      confirm,
      write: () => {},
    }),
  ).toMatchObject({ kind: "applied" });
  expect(kinds).toEqual(["offer-baseline-advance", "apply-autobuild-config"]);
  expect(await readFile(join(yes, "autobuild.toml"), "utf8")).toContain(
    "[finalize.idiom-baseline]",
  );
  expect(
    (await setupBaselineAdvance({ projectDirectory: yes, confirm })).kind,
  ).toBe("already-wired");

  const no = await autobuildProject();
  const before = await readFile(join(no, "autobuild.toml"), "utf8");
  expect(
    (
      await setupBaselineAdvance({
        projectDirectory: no,
        confirm: async () => false,
      })
    ).kind,
  ).toBe("declined");
  expect(await readFile(join(no, "autobuild.toml"), "utf8")).toBe(before);

  const quiet = await setupBaselineAdvance({
    projectDirectory: no,
    interactive: false,
  });
  expect(quiet.kind).toBe("available-noninteractive");
  expect("diff" in quiet && quiet.diff).toContain("+[finalize.idiom-baseline]");

  const foreign = await autobuildProject(
    '[commands]\nidiom-baseline = "something else"\n',
  );
  const manual = await setupBaselineAdvance({
    projectDirectory: foreign,
    confirm,
  });
  expect(manual).toMatchObject({ kind: "manual" });
  expect("addition" in manual && manual.addition).toContain(
    'idiom-baseline = "idiom baseline advance --fetch"',
  );
});

const detection = {
  signals: {},
  agents: { claude: false, codex: false },
  branchReason: "Default branch main.",
  defaultBranch: "main",
  setup: { manager: "npm", command: "npm ci" },
} as WiringDetection;
type Job = {
  if: string;
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  steps: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }>;
};

test("the GitHub baseline job advances, commits and pushes on default-branch pushes only", () => {
  const candidate = githubWriter("", detection, false, true).candidate;
  const workflow = parse(candidate) as {
    concurrency: Record<string, unknown>;
    jobs: Record<string, Job>;
  };
  const job = workflow.jobs.baseline;
  expect(job?.permissions).toEqual({ contents: "write" });
  expect(job?.if).toContain("github.event_name == 'push'");
  expect(job?.concurrency).toEqual({
    group: "idiom-baseline-${{ github.ref }}",
    "cancel-in-progress": false,
  });
  // Default-branch runs queue instead of cancelling a running advance.
  expect(workflow.concurrency["cancel-in-progress"]).toBe(
    "${{ github.event_name == 'pull_request' }}",
  );
  const script = job?.steps.at(-1)?.run ?? "";
  expect(script).toContain(
    'idiom baseline advance --target "$TARGET" --commit-file',
  );
  expect(script).toContain("git add --all -- .idiom/baselines");
  expect(script).toContain('git push --quiet origin "HEAD:$BRANCH"');
  expect(job?.steps[0]?.with).toEqual({
    ref: "${{ github.ref }}",
    "fetch-depth": 0,
  });
});

test("without the opt-in the workflow is unchanged byte for byte", () => {
  expect(githubWriter("", detection, false, false).candidate).toBe(
    githubWriter("", detection, false).candidate,
  );
  expect(githubWriter("", detection, false).candidate).not.toContain(
    "baseline",
  );
});

test("--advance-baseline conflicts with --skip-wiring github and with --validate", async () => {
  const root = await autobuildProject();
  await expect(
    runWiring(
      root,
      { advanceBaseline: true, skipWiring: ["github"], dryRun: true },
      seams,
      () => {},
    ),
  ).rejects.toThrow("--advance-baseline conflicts with --skip-wiring github");
  const validate: string[] = [];
  expect(
    await run(
      [
        "node",
        "idiom",
        "--project",
        root,
        "init",
        "--validate",
        "--advance-baseline",
      ],
      { stdout: () => {}, stderr: (value) => validate.push(value) },
    ),
  ).not.toBe(0);
  expect(validate.join("")).toContain("cannot be combined with --validate");
});
