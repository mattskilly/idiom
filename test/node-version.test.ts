import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { renderDoctorReport, runDoctor } from "../src/commands/doctor.js";
import {
  MINIMUM_NODE_MAJOR,
  MINIMUM_NODE_MINOR,
  nodeVersionProblem,
} from "../src/node-version.js";
import { IDIOM_VERSION } from "../src/version.js";

const repositoryRoot = join(import.meta.dirname, "..");
const builtEntry = join(repositoryRoot, "dist", "cli.js");

const message = (version: string) =>
  `Idiom needs Node 22.12 or newer; this is Node ${version}. Install Node 22.12+ (https://nodejs.org) and run again.`;

describe("nodeVersionProblem", () => {
  test("names the exact floor", () => {
    expect(nodeVersionProblem("22.4.0")).toBe(
      "Idiom needs Node 22.12 or newer; this is Node 22.4.0. Install Node 22.12+ (https://nodejs.org) and run again.",
    );
  });

  test.each([
    "20.11.1",
    "21.7.0",
    "21.7.0-nightly20240101abcdef",
    "22.0.0",
    "22.4.0",
    "22.11.0",
    "22.11.0-pre",
  ])("names both versions and the upgrade on %s", (version) => {
    expect(nodeVersionProblem(version)).toBe(message(version));
  });

  test.each([
    "22.12.0",
    "22.12.0-rc.1",
    "23.0.0",
    "24.4.0",
    "24.0.0-rc.1",
    "25.0.0",
  ])("passes %s", (version) => {
    expect(nodeVersionProblem(version)).toBeUndefined();
  });

  test.each(["", "garbage", "22"])(
    "lets an unreadable version %j through rather than refuse to start",
    (version) => {
      expect(nodeVersionProblem(version)).toBeUndefined();
    },
  );
});

type Invocation = { code: number; stdout: string; stderr: string };

// Simulates an older or newer Node by redefining process.versions before the entry loads.
function simulating(version: string): string[] {
  const preload = `Object.defineProperty(process,"versions",{value:{...process.versions,node:${JSON.stringify(version)}}})`;
  return ["--import", `data:text/javascript,${encodeURIComponent(preload)}`];
}

function invoke(
  entry: string,
  args: string[],
  nodeArgs: string[] = [],
): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [...nodeArgs, entry, ...args],
      { cwd: repositoryRoot, timeout: 5000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error.code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

describe("the built launcher", () => {
  let isolated: string;

  beforeAll(async () => {
    isolated = await mkdtemp(join(tmpdir(), "idiom-node-version-"));
    await copyFile(builtEntry, join(isolated, "cli.js"));
  });

  afterAll(async () => {
    await rm(isolated, { recursive: true, force: true });
  });

  test.each(["20.11.1", "21.7.0", "22.4.0"])(
    "exits 2 on Node %s with the message on stderr only",
    async (version) => {
      const result = await invoke(
        builtEntry,
        ["--version"],
        simulating(version),
      );
      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr: `${message(version)}\n`,
      });
    },
  );

  test("keeps MCP stdout clean on an old Node", async () => {
    const result = await invoke(builtEntry, ["mcp"], simulating("22.4.0"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${message("22.4.0")}\n`);
  });

  test("decides before loading anything else", async () => {
    const old = await invoke(
      join(isolated, "cli.js"),
      ["--version"],
      simulating("20.11.1"),
    );
    expect(old).toEqual({
      code: 2,
      stdout: "",
      stderr: `${message("20.11.1")}\n`,
    });
    const current = await invoke(
      join(isolated, "cli.js"),
      ["--version"],
      simulating("22.12.0"),
    );
    expect(current.code).not.toBe(0);
    expect(current.stderr).toContain("main.js");
  });

  test.each([
    ["Node 22.12.0", simulating("22.12.0")],
    ["the running Node", []],
  ])("runs the program on %s", async (_label, nodeArgs) => {
    const result = await invoke(builtEntry, ["--version"], nodeArgs);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith(IDIOM_VERSION)).toBe(true);
  });
});

describe("doctor's node step", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "idiom-doctor-node-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("fails first on an old Node and skips every other step", async () => {
    const report = await runDoctor({
      cwd: directory,
      dependencies: { nodeVersion: "20.11.1" },
    });
    expect(report.ok).toBe(false);
    expect(report.steps[0]).toMatchObject({
      id: "node",
      status: "fail",
      detail: message("20.11.1"),
    });
    expect(report.steps.length).toBeGreaterThan(1);
    for (const step of report.steps.slice(1))
      expect(step.status, step.id).toBe("skip");
    expect(report.failure?.cause).toBe("node-version");
    const lines = renderDoctorReport(report).split("\n");
    const index = lines.findIndex((line) => line.startsWith("✗  node"));
    expect(index).toBeGreaterThan(0);
    expect(lines[index + 1]?.trim()).toBe(
      "fix: Install Node 22.12+ (https://nodejs.org) and run again.",
    );
  });

  test("fails on Node 22 below the 22.12 floor", async () => {
    const report = await runDoctor({
      cwd: directory,
      dependencies: { nodeVersion: "22.11.0" },
    });
    expect(report.steps[0]).toMatchObject({
      id: "node",
      status: "fail",
      detail: message("22.11.0"),
    });
  });

  test("passes on a supported Node and names the floor", async () => {
    const report = await runDoctor({
      cwd: directory,
      dependencies: { nodeVersion: "24.4.0" },
    });
    expect(report.steps[0]).toMatchObject({
      id: "node",
      status: "pass",
      detail: "Node 24.4.0; Idiom needs Node 22.12 or newer",
    });
  });
});

// The lowest major.minor.patch any comparator in a range names; missing parts count as 0.
function rangeMinimum(range: string): [number, number, number] {
  const versions = [...range.matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)].map(
    (match): [number, number, number] => [
      Number(match[1]),
      Number(match[2] ?? 0),
      Number(match[3] ?? 0),
    ],
  );
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const lowest = versions[0];
  if (lowest === undefined) throw new Error(`no version in range ${range}`);
  return lowest;
}

test("no production dependency needs a newer Node than Idiom's floor", async () => {
  const packageMetadata = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const floor: [number, number, number] = [
    MINIMUM_NODE_MAJOR,
    MINIMUM_NODE_MINOR,
    0,
  ];
  const checked: string[] = [];
  const tooNew: string[] = [];
  for (const name of Object.keys(packageMetadata.dependencies)) {
    const installed = JSON.parse(
      await readFile(
        join(repositoryRoot, "node_modules", name, "package.json"),
        "utf8",
      ),
    ) as { engines?: { node?: string } };
    const range = installed.engines?.node;
    if (range === undefined) continue;
    checked.push(name);
    const minimum = rangeMinimum(range);
    const above =
      minimum[0] - floor[0] || minimum[1] - floor[1] || minimum[2] - floor[2];
    if (above > 0) tooNew.push(`${name}: ${range}`);
  }
  expect(tooNew).toEqual([]);
  expect(checked).toContain("commander");
});

async function markdownUnder(directory: string): Promise<string[]> {
  const entries = await readdir(join(repositoryRoot, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) =>
      relative(repositoryRoot, join(entry.parentPath, entry.name)),
    );
}

test("no user-facing doc still promises Node 20", async () => {
  const docs = (await readdir(join(repositoryRoot, "docs")))
    .filter((name) => name.endsWith(".md") && name !== "CHANGELOG.md")
    .map((name) => join("docs", name));
  const siteDocs = (await readdir(join(repositoryRoot, "site", "docs")))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join("site", "docs", name));
  const files = [
    "README.md",
    "site/index.html",
    ...docs,
    ...siteDocs,
    ...(await markdownUnder("skills")),
    ...(await markdownUnder("templates")),
    ...(await markdownUnder("plugins/claude/skills")),
  ];
  const stale: string[] = [];
  for (const file of files) {
    const lines = (await readFile(join(repositoryRoot, file), "utf8")).split(
      "\n",
    );
    lines.forEach((line, index) => {
      if (
        /\bNode(?:\.js)?\s*(?:20\b|≥\s*20\b|>=\s*20\b|20\+)/i.test(line) ||
        /node20\b/.test(line)
      )
        stale.push(`${file}:${index + 1}`);
    });
  }
  expect(stale).toEqual([]);
  for (const file of [
    "README.md",
    "docs/mcp.md",
    "site/index.html",
    "site/docs/getting-started.md",
  ])
    expect(await readFile(join(repositoryRoot, file), "utf8"), file).toContain(
      "Node 22",
    );
});

// An explicit list: elsewhere (an internal script, history, a competitor's requirement) "Node 22" is correct.
test("Idiom's own surfaces name the Node 22.12 floor", async () => {
  const surfaces = [
    "README.md",
    "CLAUDE.md",
    "site/index.html",
    "docs/mcp.md",
    "docs/risks.md",
    "docs/troubleshooting.md",
    "docs/upgrading.md",
    "docs/architecture.md",
    "docs/distribution.md",
    "docs/commands.md",
    "site/docs/getting-started.md",
    "site/docs/design-qa-for-claude-code.md",
    "site/docs/testing-loading-empty-error-states.md",
  ];
  const stale: string[] = [];
  for (const file of surfaces) {
    const lines = (await readFile(join(repositoryRoot, file), "utf8")).split(
      "\n",
    );
    lines.forEach((line, index) => {
      if (/\bNode(?:\.js)?\s*(?:≥\s*|>=\s*)?22(?![.\d])\+?/.test(line))
        stale.push(`${file}:${index + 1}`);
    });
  }
  expect(stale).toEqual([]);
  for (const file of [
    "README.md",
    "docs/mcp.md",
    "docs/troubleshooting.md",
    "docs/upgrading.md",
    "site/index.html",
    "site/docs/getting-started.md",
    "site/docs/design-qa-for-claude-code.md",
    "site/docs/testing-loading-empty-error-states.md",
  ])
    expect(await readFile(join(repositoryRoot, file), "utf8"), file).toContain(
      "Node 22.12",
    );
});
