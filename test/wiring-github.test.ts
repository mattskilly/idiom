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
  FULL_CHECK,
  githubWriter,
  NIGHTLY_COMMAND,
} from "../src/wiring/github.js";
import type { WiringDetection } from "../src/wiring/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function temporary(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-wiring-github-")),
  );
  directories.push(directory);
  return directory;
}

const detection = (
  extra: { [K in keyof WiringDetection]?: WiringDetection[K] | undefined } = {},
): WiringDetection =>
  ({
    signals: {},
    agents: { claude: false, codex: false },
    branchReason: "No local remote default-branch hint.",
    setup: { manager: "npm", command: "npm ci" },
    ...extra,
  }) as WiringDetection;
type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  id?: string;
  if?: string;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    { if: string; permissions: Record<string, string>; steps: Step[] }
  >;
};
const workflow = (candidate: string) => parse(candidate) as Workflow;
const script = (step: Step | undefined) =>
  /<<'IDIOM_NODE'\n([\s\S]*)\nIDIOM_NODE$/.exec(step?.run ?? "")?.[1] ?? "";

test("PR, default-branch push and optional nightly triggers", () => {
  const known = workflow(
    githubWriter("", detection({ defaultBranch: "trunk" }), false).candidate,
  );
  expect(known.on).toEqual({
    pull_request: {},
    push: { branches: ["trunk"] },
  });
  const unknown = workflow(githubWriter("", detection(), true).candidate);
  // No local hint: never assume main; guard at runtime instead.
  expect(unknown.on).toEqual({
    pull_request: {},
    push: {},
    schedule: [{ cron: "17 3 * * *" }],
  });
  const full = unknown.jobs["full-check"];
  expect(full?.if).toContain("github.event.repository.default_branch");
  // The schedule runs the nightly job; pushes keep the full check.
  expect(full?.if).not.toContain("schedule");
  expect(unknown.jobs.nightly?.if).toBe("github.event_name == 'schedule'");
  expect(known.jobs.nightly).toBeUndefined();
  expect(unknown.jobs["pull-request"]?.if).toBe(
    "github.event_name == 'pull_request'",
  );
  expect(JSON.stringify(unknown)).not.toContain("pull_request_target");
});

test("the nightly job runs idiom nightly between a ledger restore and save, and uploads reports", () => {
  const parsed = workflow(githubWriter("", detection(), true).candidate);
  const steps = parsed.jobs.nightly?.steps ?? [];
  const index = (match: (step: (typeof steps)[number]) => boolean) =>
    steps.findIndex(match);
  const restore = index((step) => step.uses === "actions/cache/restore@v4");
  const run = index((step) => step.run === NIGHTLY_COMMAND);
  const save = index((step) => step.uses === "actions/cache/save@v4");
  const upload = index(
    (step) => step.uses?.startsWith("actions/upload-artifact") === true,
  );
  expect(NIGHTLY_COMMAND).toBe(
    "idiom nightly --tracker directory --out .idiom/reports/nightly",
  );
  expect([restore, run, save, upload].every((at) => at >= 0)).toBe(true);
  expect(restore).toBeLessThan(run);
  expect(run).toBeLessThan(save);
  expect(steps[restore]?.with).toEqual({
    path: ".idiom/filed-tickets.json",
    key: "idiom-filed-${{ github.run_id }}",
    "restore-keys": "idiom-filed-",
  });
  expect(steps[save]).toMatchObject({
    if: "always()",
    with: {
      path: ".idiom/filed-tickets.json",
      key: "idiom-filed-${{ github.run_id }}",
    },
  });
  expect(steps[upload]).toMatchObject({
    if: "always()",
    with: { path: ".idiom/reports/" },
  });
  expect(parsed.jobs.nightly?.permissions).toEqual({ contents: "read" });
  // Pushes to the default branch still run the full check.
  expect(
    parsed.jobs["full-check"]?.steps.some((step) =>
      step.run?.includes(FULL_CHECK),
    ),
  ).toBe(true);
});

test("only the PR job uses the PR-only Action, with PR-write permission", () => {
  const parsed = workflow(githubWriter("", detection(), true).candidate);
  expect(parsed.permissions).toEqual({ contents: "read" });
  const pr = parsed.jobs["pull-request"];
  const action = pr?.steps.find((step) =>
    step.uses?.startsWith("mattskilly/idiom"),
  );
  expect(action?.uses).toBe("mattskilly/idiom@main");
  expect(action?.with).toEqual({
    flow: "${{ steps.flow.outputs.flow }}",
    project: ".",
    version: "latest",
    "fail-on": "major",
    "setup-command": "npm ci",
  });
  expect(pr?.permissions["pull-requests"]).toBe("write");
  expect(pr?.steps[0]?.with).toMatchObject({
    ref: "${{ github.event.pull_request.head.sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });
  const full = parsed.jobs["full-check"];
  expect(full?.permissions).toEqual({ contents: "read" });
  expect(
    full?.steps.some((step) => step.uses?.startsWith("mattskilly/idiom")),
  ).toBe(false);
  expect(
    full?.steps.find((step) => step.uses?.startsWith("actions/upload-artifact"))
      ?.if,
  ).toBe("always()");
});

test("package-manager setup is reviewed, not assumed to be npm", () => {
  const bun = workflow(
    githubWriter(
      "",
      detection({
        setup: {
          manager: "bun",
          version: "1.2.3",
          command: "bun install --frozen-lockfile",
        },
      }),
      false,
    ).candidate,
  );
  const steps = bun.jobs["full-check"]?.steps ?? [];
  expect(
    steps.find((step) => step.uses === "oven-sh/setup-bun@v2")?.with,
  ).toEqual({
    "bun-version": "1.2.3",
  });
  expect(
    steps.find((step) => step.run === "bun install --frozen-lockfile"),
  ).toBeDefined();
  const pnpm = githubWriter(
    "",
    detection({
      setup: {
        manager: "pnpm",
        version: "9.1.0",
        command: "pnpm install --frozen-lockfile",
      },
    }),
    false,
  ).candidate;
  expect(pnpm).toContain("corepack prepare pnpm@9.1.0 --activate");
  expect(() =>
    githubWriter(
      "",
      detection({ setup: undefined, setupReason: "Cannot determine" }),
      false,
    ),
  ).toThrow("Cannot determine");
});

test("reruns are stable and an unmarked workflow is protected", () => {
  const first = githubWriter("", detection(), false).candidate;
  expect(githubWriter(first, detection(), false).candidate).toBe(first);
  const nightly = githubWriter(first, detection(), true).candidate;
  expect(workflow(nightly).on.schedule).toBeDefined();
  expect(() => githubWriter("name: theirs\n", detection(), false)).toThrow(
    /Unmarked reserved destination/,
  );
});

async function fixture(flows: Record<string, unknown>): Promise<string> {
  const root = await temporary();
  await mkdir(join(root, ".idiom", "flows"), { recursive: true });
  for (const [name, flow] of Object.entries(flows))
    await writeFile(join(root, ".idiom", "flows", name), JSON.stringify(flow));
  const bin = join(root, "bin");
  await mkdir(bin);
  // Logs each call; fails for the flow named in IDIOM_FAIL.
  await writeFile(
    join(bin, "idiom"),
    '#!/bin/sh\necho "$@" >> "$IDIOM_LOG"\n[ "$2" = "$IDIOM_FAIL" ] && exit 1\nexit 0\n',
  );
  await chmod(join(bin, "idiom"), 0o755);
  return root;
}
function runScript(
  root: string,
  source: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, ["-e", source], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      IDIOM_LOG: join(root, "calls.log"),
      GITHUB_OUTPUT: join(root, "output"),
      ...environment,
    },
  });
}

test("generated discovery passes the first sorted flow to the PR Action", async () => {
  const parsed = workflow(githubWriter("", detection(), false).candidate);
  const discover = script(
    parsed.jobs["pull-request"]?.steps.find((step) => step.id === "flow"),
  );
  const root = await fixture({
    "zeta.json": { id: "zeta", states: [{}] },
    "alpha.json": { id: "alpha", states: [{}] },
  });
  expect(runScript(root, discover).status).toBe(0);
  expect(await readFile(join(root, "output"), "utf8")).toBe("flow=alpha\n");
  const empty = await fixture({});
  const result = runScript(empty, discover);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("No flows");
});

test("the full check runs every flow, fails on any, and rejects injected ids", async () => {
  const parsed = workflow(githubWriter("", detection(), true).candidate);
  const full = script(
    parsed.jobs["full-check"]?.steps.find((step) =>
      step.run?.includes("IDIOM_NODE"),
    ),
  );
  const root = await fixture({
    "a.json": { id: "a", states: [{}] },
    "b.json": { id: "b", states: [{}] },
    "c.json": { id: "c", states: [{}] },
  });
  const failed = runScript(root, full, { IDIOM_FAIL: "b" });
  expect(failed.status).toBe(1);
  expect(
    (await readFile(join(root, "calls.log"), "utf8")).trim().split("\n"),
  ).toEqual([
    "check a --all --fail-on major",
    "check b --all --fail-on major",
    "check c --all --fail-on major",
  ]);
  const injected = await fixture({
    "x.json": { id: "x;touch pwned", states: [{}] },
  });
  const refused = runScript(injected, full);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("Invalid or empty flow");
  await expect(readFile(join(injected, "calls.log"))).rejects.toThrow();
});
