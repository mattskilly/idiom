import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { isPortOpen } from "../src/capture/process.js";
import { run } from "../src/cli.js";
import {
  type InitValidateReport,
  initValidateProblem,
  renderInitValidate,
} from "../src/commands/init-validate.js";
import type { SurfacesReport } from "../src/doctor/surfaces.js";
import { RUN_FAILURE_EXIT_CODE } from "../src/errors.js";
import { neverReadyProject, passingProject } from "./doctor-support.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function initValidate(cwd: string, ...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["node", "idiom", "init", ...args], {
    cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function tree(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true })).sort();
}

test("a ready project exits 0, ends with ready and creates nothing", async () => {
  const { directory, port } = await passingProject(directories);
  const before = await tree(directory);
  const result = await initValidate(directory, "--validate");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines[0]).toBe("validate: 1 flow(s) valid (home)");
  expect(lines).toContain("idiom doctor home: ok");
  expect(lines.at(-1)).toBe("ready");
  expect(await tree(directory)).toEqual(before);
  expect(await isPortOpen(port)).toBe(false);
});

test("--json prints { ready, validate, doctor, surfaces } for a ready project", async () => {
  const { directory } = await passingProject(directories);
  const result = await initValidate(directory, "--validate", "--json");
  expect(result.code).toBe(0);
  const json = JSON.parse(result.stdout) as InitValidateReport;
  expect(Object.keys(json)).toEqual([
    "interfaceVersion",
    "ready",
    "validate",
    "doctor",
    "surfaces",
  ]);
  expect(json.ready).toBe(true);
  // Computed once, at the top level, not inside the doctor report.
  expect(json.doctor?.surfaces).toBeUndefined();
  expect(json.surfaces.initialized).toBe(true);
  expect(json.surfaces.entries.map((entry) => entry.id)).toContain("github");
  if (!json.validate.ok) throw new Error("validate failed");
  expect(json.validate.flows[0]?.id).toBe("home");
  expect(json.doctor?.flow).toBe("home");
});

test("a validation error is not ready with the validate fix", async () => {
  const { directory } = await passingProject(directories);
  await writeFile(
    join(directory, ".idiom", "flows", "home.json"),
    JSON.stringify({ id: "home", title: "Home", states: "nope" }),
  );
  const result = await initValidate(directory, "--validate");
  expect(result.code).toBe(RUN_FAILURE_EXIT_CODE);
  const out = result.stdout.trimEnd().split("\n");
  expect(out[0]).toBe("validate: failed");
  expect(out).toContain("Where Idiom runs:");
  const [headline, fix, ...rest] = result.stderr.trimEnd().split("\n");
  expect(headline).toMatch(/^not ready: \.idiom\/flows\/home\.json: /);
  expect(fix).toBe("Fix: run idiom validate <flow> and fix the reported file");
  expect(rest).toEqual([]);

  const json = await initValidate(directory, "--validate", "--json");
  expect(json.code).toBe(RUN_FAILURE_EXIT_CODE);
  const report = JSON.parse(json.stdout) as InitValidateReport;
  expect(report).toMatchObject({
    ready: false,
    validate: { ok: false },
    doctor: null,
  });
});

test("a server that never becomes ready is not ready with the readiness hint", async () => {
  const { directory, port } = await neverReadyProject(directories);
  const result = await initValidate(directory, "--validate");
  expect(result.code).toBe(RUN_FAILURE_EXIT_CODE);
  const [headline, fix] = result.stderr.trimEnd().split("\n");
  expect(headline).toMatch(/^not ready: server failed to start/);
  expect(fix).toMatch(/^Fix: .*server\.readyUrl/);
  expect(result.stdout).not.toContain("\nready");
  expect(await isPortOpen(port)).toBe(false);

  const json = await initValidate(directory, "--validate", "--json");
  const report = JSON.parse(json.stdout) as InitValidateReport;
  expect(report.ready).toBe(false);
  expect(report.doctor?.ok).toBe(false);
  expect(report.doctor?.failure?.stage).toBe("server");
});

test("an uninitialized directory points to idiom init and stays empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-init-validate-"));
  directories.push(directory);
  const result = await initValidate(directory, "--validate");
  expect(result.code).toBe(RUN_FAILURE_EXIT_CODE);
  expect(result.stderr.trimEnd().split("\n")).toEqual([
    expect.stringMatching(
      /^not ready: Idiom is not initialized here \(no \.idiom\/project\.json in .+ or any parent directory\)$/,
    ),
    "Fix: run idiom init",
  ]);
  // Honest about silence: nothing fires until init runs.
  expect(result.stdout).toContain("Where Idiom runs:");
  expect(result.stdout).toContain(
    "! No .idiom/project.json: Claude Code hooks and the Autobuild gate are inactive until you run idiom init.",
  );
  expect(await readdir(directory)).toEqual([]);
});

test("--flow boots the named flow and names a missing one", async () => {
  const { directory } = await passingProject(directories);
  const result = await initValidate(
    directory,
    "--validate",
    "--flow",
    "missing",
  );
  expect(result.code).toBe(RUN_FAILURE_EXIT_CODE);
  expect(result.stderr.split("\n")[0]).toMatch(/^not ready: .*missing/);
});

test("--validate refuses scaffold flags, and --flow/--json need --validate", async () => {
  const { directory } = await passingProject(directories);
  const before = await tree(directory);
  const combined = await initValidate(directory, "--validate", "--yes");
  expect(combined.code).toBe(1);
  expect(combined.stderr).toContain(
    "--validate cannot be combined with --yes, --flows, --surface, --agent, --no-agent or --print-setup-prompt",
  );
  expect(await tree(directory)).toEqual(before);

  const json = await initValidate(directory, "--json");
  expect(json.code).toBe(1);
  expect(json.stderr).toContain("--flow and --json apply only with --validate");
  expect(await tree(directory)).toEqual(before);
});

test("rendering and the first problem for hand-built reports", () => {
  const surfaces: SurfacesReport = {
    root: "/app",
    initialized: true,
    ms: 0,
    entries: [
      {
        id: "github",
        label: "GitHub workflow",
        status: "missing",
        detail: "no workflow runs Idiom",
        fix: "idiom init --wire",
      },
    ],
  };
  const surfaceLines = [
    "",
    "Where Idiom runs:",
    "  ✗ missing         GitHub workflow  no workflow runs Idiom",
    "                    fix: idiom init --wire",
  ];
  const noFlows: InitValidateReport = {
    ready: false,
    validate: {
      ok: false,
      failure: {
        stage: "preflight",
        cause: "invalid-config",
        message: "config invalid: .idiom/flows: no flow manifests found",
        hint: "generate a flow with idiom init --flows --yes, or author .idiom/flows/<id>.json",
      },
    },
    doctor: null,
    surfaces,
  };
  // The section is printed even when validation failed.
  expect(renderInitValidate(noFlows)).toEqual([
    "validate: failed",
    ...surfaceLines,
  ]);
  expect(initValidateProblem(noFlows)).toEqual({
    headline: "not ready: .idiom/flows: no flow manifests found",
    hint: "generate a flow with idiom init --flows --yes, or author .idiom/flows/<id>.json",
    stage: "preflight",
    cause: "invalid-config",
  });

  const ready: InitValidateReport = {
    ready: true,
    validate: {
      ok: true,
      projectDirectory: "/app",
      flows: [
        { id: "home", file: "/app/.idiom/flows/home.json" },
        { id: "site", file: "/app/.idiom/flows/site.json" },
      ],
    },
    doctor: { flow: "home", ok: true, steps: [] },
    surfaces,
  };
  expect(renderInitValidate(ready)).toEqual([
    "validate: 2 flow(s) valid (home, site)",
    "idiom doctor home: ok",
    ...surfaceLines,
    "ready",
  ]);
  expect(initValidateProblem(ready)).toBeUndefined();
});

test("a project with no flow manifests gets the generate-a-flow hint", async () => {
  const { directory } = await passingProject(directories);
  await rm(join(directory, ".idiom", "flows", "home.json"));
  const result = await initValidate(directory, "--validate");
  expect(result.code).toBe(RUN_FAILURE_EXIT_CODE);
  expect(result.stderr.trimEnd().split("\n")).toEqual([
    "not ready: .idiom/flows: no flow manifests found",
    "Fix: generate a flow with idiom init --flows --yes, or author .idiom/flows/<id>.json",
  ]);
});
