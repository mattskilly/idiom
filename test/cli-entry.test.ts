import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { IDIOM_VERSION } from "../src/version.js";

const repositoryRoot = join(import.meta.dirname, "..");
const buildCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const builtEntry = join(repositoryRoot, "dist", "cli.js");
let temporaryBin: string;
let linkedEntry: string;

type Invocation = {
  code: number;
  stdout: string;
  stderr: string;
};

async function invoke(
  entry: string,
  args: string[],
  closeStdin = false,
): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [entry, ...args],
      { cwd: repositoryRoot, ...(closeStdin ? { timeout: 5000 } : {}) },
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
    if (closeStdin) child.stdin?.end();
  });
}

beforeAll(async () => {
  temporaryBin = await mkdtemp(join(tmpdir(), "idiom-cli-entry-"));
  linkedEntry = join(temporaryBin, "idiom");
  await symlink(builtEntry, linkedEntry, "file");
});

afterAll(async () => {
  await rm(temporaryBin, { recursive: true, force: true });
});

test.each([
  "init",
  "validate",
  "capture",
  "reference",
  "review",
  "explore",
  "report",
  "decide",
  "ruling",
  "instruction",
  "tickets",
  "verify",
  "compare",
  "context",
  "system",
])(
  "linked %s --help reaches the command",
  async (command) => {
    const result = await invoke(linkedEntry, [command, "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Usage: idiom ${command}`);
    expect(result.stderr).toBe("");
  },
  60_000,
);

test("linked invocation propagates Commander's failure status", async () => {
  const result = await invoke(linkedEntry, ["validate", "--invalid-option"]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("unknown option '--invalid-option'");
}, 60_000);

test.each([
  { kind: "direct", flag: "--version" },
  { kind: "direct", flag: "-V" },
  { kind: "linked", flag: "--version" },
  { kind: "linked", flag: "-V" },
])(
  "$kind $flag reports the build source",
  async ({ kind, flag }) => {
    const result = await invoke(kind === "direct" ? builtEntry : linkedEntry, [
      flag,
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `${IDIOM_VERSION} (${buildCommit.slice(0, 7)})\n`,
    );
    expect(result.stderr).toBe("");
  },
  60_000,
);

test.each(["direct", "linked"])(
  "%s init with closed non-TTY stdin completes without a flow offer",
  async (kind) => {
    const project = join(temporaryBin, `plain-init-${kind}`);
    const result = await invoke(
      kind === "direct" ? builtEntry : linkedEntry,
      ["init", "--project", project],
      true,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Initialized ${project}: 11 created`);
    expect(result.stdout).not.toContain("Generate a site flow");
    expect(result.stderr).toBe("");
  },
  15_000,
);
