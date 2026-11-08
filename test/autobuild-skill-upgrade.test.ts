import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { skillIdentity } from "../src/skills/merge.js";
import {
  AUTOBUILD_SKILLS,
  autobuildSkillWriter,
} from "../src/wiring/autobuild-skills.js";
import { runWiring } from "../src/wiring/run.js";
import { markers } from "../src/wiring/sections.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
type UpgradeReport = {
  exitCode: number;
  discoveryConflicts: unknown[];
  skills: { skill: string; action: string }[];
};
async function upgrade(
  targetRepo: string,
  distRoot: string,
): Promise<UpgradeReport> {
  const provider = fileURLToPath(
    new URL(
      "../node_modules/@defrex/autobuild/packages/core/src/cli/upgrade.ts",
      import.meta.url,
    ),
  );
  const helper = fileURLToPath(
    new URL("./support/autobuild-upgrade.mjs", import.meta.url),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("AB_")),
  );
  return new Promise((resolve, reject) => {
    execFile(
      "bun",
      [helper, provider, targetRepo, distRoot],
      {
        env,
        cwd: targetRepo,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `Autobuild upgrade failed: ${error.message.slice(0, 1000)}\n${stderr.slice(-4000)}`,
            ),
          );
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(
              new Error(
                `Invalid upgrade report: ${stdout.slice(-4000)}\n${stderr.slice(-4000)}`,
              ),
            );
          }
        }
      },
    );
  });
}

test("real Autobuild upgrade preserves Idiom and independent local edits with incoming-only pristine", async () => {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-provider-upgrade-")),
  );
  directories.push(temporary);
  const root = join(temporary, "repo");
  const dist = join(temporary, "dist");
  await mkdir(root);
  await writeFile(
    join(root, "autobuild.toml"),
    `baseBranch = "main"
landing = []
[commands]
[verify]
steps = []
[finalize]
steps = []
[roles.default]
runtime = "codex"
[tickets]
source = "file"
readyState = "ready"
`,
  );
  const incoming = new Map<string, string>();
  for (const target of AUTOBUILD_SKILLS) {
    const path = join(
      dist,
      "skills",
      target.identity.replace(/^ab-/, ""),
      "SKILL.md",
    );
    await mkdir(dirname(path), { recursive: true });
    const source = await readFile(
      new URL(
        `./fixtures/autobuild-skills/${target.identity}.md`,
        import.meta.url,
      ),
      "utf8",
    );
    // Provider normalizes the namespace and invocation flag at installation.
    await writeFile(path, source);
    incoming.set(target.identity, source);
  }
  const installed = await upgrade(root, dist);
  expect(installed.exitCode).toBe(0);
  expect(installed.discoveryConflicts).toEqual([]);
  expect(installed.skills).toHaveLength(3);
  expect(installed.skills.every((r) => r.action === "installed")).toBe(true);
  const pristine = (identity: string) =>
    join(root, ".agents/skills/.ab-pristine", identity, "SKILL.md");
  const pristineBefore = new Map<string, string>();
  for (const target of AUTOBUILD_SKILLS) {
    const source = await readFile(pristine(target.identity), "utf8");
    pristineBefore.set(target.identity, source);
    await writeFile(
      join(root, target.path),
      source.replace(
        "Repository-local guidance: use the shared adapter.",
        "Repository-local guidance: use the shared adapter and local errors.",
      ),
    );
  }
  await runWiring(
    root,
    { skipWiring: ["agents", "autobuild-gate"] },
    {
      environment: { PATH: "" },
      git: async () => {
        throw new Error("not git");
      },
      confirm: async () => true,
    },
    () => {},
  );
  for (const target of AUTOBUILD_SKILLS) {
    expect(await readFile(pristine(target.identity), "utf8")).toBe(
      pristineBefore.get(target.identity),
    );
    const path = join(
      dist,
      "skills",
      target.identity.replace(/^ab-/, ""),
      "SKILL.md",
    );
    const original = incoming.get(target.identity);
    if (original === undefined) throw new Error("Missing distribution fixture");
    await writeFile(
      path,
      original.replace(
        "Upstream opening instructions v1.",
        "Upstream opening instructions v2.",
      ),
    );
  }
  const merged = await upgrade(root, dist);
  expect(merged.exitCode).toBe(0);
  expect(merged.discoveryConflicts).toEqual([]);
  expect(merged.skills).toHaveLength(3);
  expect(merged.skills.every((r) => r.action === "merged")).toBe(true);
  const liveAfter = new Map<string, string>();
  const pristineAfter = new Map<string, string>();
  for (const target of AUTOBUILD_SKILLS) {
    const live = await readFile(join(root, target.path), "utf8");
    const base = await readFile(pristine(target.identity), "utf8");
    expect(live).toContain("Upstream opening instructions v2.");
    expect(live).toContain("shared adapter and local errors.");
    expect(live.split(markers(target.surface, "html")[0])).toHaveLength(2);
    expect(autobuildSkillWriter(live, target).candidate).toBe(live);
    expect(skillIdentity(live)).toBe(target.identity);
    const originalBase = pristineBefore.get(target.identity);
    if (originalBase === undefined) throw new Error("Missing pristine fixture");
    expect(base).toBe(
      originalBase.replace(
        "Upstream opening instructions v1.",
        "Upstream opening instructions v2.",
      ),
    );
    expect(base).not.toContain("idiom:wiring:");
    expect(base).not.toContain("local errors");
    liveAfter.set(target.identity, live);
    pristineAfter.set(target.identity, base);
  }
  const unchanged = await upgrade(root, dist);
  expect(unchanged.skills.every((r) => r.action === "current")).toBe(true);
  for (const target of AUTOBUILD_SKILLS) {
    expect(await readFile(join(root, target.path), "utf8")).toBe(
      liveAfter.get(target.identity),
    );
    expect(await readFile(pristine(target.identity), "utf8")).toBe(
      pristineAfter.get(target.identity),
    );
  }
}, 120_000);
