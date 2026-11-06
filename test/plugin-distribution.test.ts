import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
// @ts-expect-error Release helpers run directly in Node without dependencies.
import { checkPlugins } from "../scripts/check-plugins.mjs";

const root = join(import.meta.dirname, "..");
// The workshop exporter is intentionally absent from public snapshots. Its seam
// tests stay private; release-checker tests still run in the public repository.
const exporter = join(root, "scripts/public-snapshot.mjs");
const snapshot = existsSync(exporter) ? await import(exporter) : null;
const directories: string[] = [];
const claude = "plugins/claude/.claude-plugin/plugin.json";
const manifests = [
  "package.json",
  claude,
  ".claude-plugin/marketplace.json",
  "plugin.json",
  ".agents/plugins/marketplace.json",
];
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "idiom-plugin-"));
  directories.push(path);
  for (const file of [
    ...manifests,
    "scripts/check-plugins.mjs",
    ...(snapshot ? ["scripts/public-snapshot.mjs"] : []),
    "templates/idiom/SKILL.md",
    "templates/idiom/init.md",
    "skills/idiom/SKILL.md",
    "skills/idiom/references/init.md",
    "plugins/claude/skills/idiom/SKILL.md",
    "plugins/claude/skills/idiom/references/init.md",
    "plugins/claude/hooks/hooks.json",
    "plugins/claude/hooks/lib.mjs",
    "plugins/claude/hooks/post-tool-use.mjs",
    "plugins/claude/hooks/stop.mjs",
  ]) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await cp(join(root, file), join(path, file));
  }
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { force: true, recursive: true });
});
async function mutate(
  path: string,
  file: string,
  field: string,
  value: unknown,
) {
  const data = JSON.parse(await readFile(join(path, file), "utf8"));
  const parts = field
    .replace("com.openai", "com~openai")
    .split(".")
    .map((part) => part.replace("com~openai", "com.openai"));
  let cursor = data;
  for (const part of parts.slice(0, -1)) cursor = cursor[part];
  cursor[parts.at(-1) ?? ""] = value;
  await writeFile(join(path, file), JSON.stringify(data));
}
function cli(path: string, script: string, args: string[]) {
  return spawnSync(process.execPath, [join(path, script), ...args], {
    cwd: path,
    encoding: "utf8",
  });
}

test("committed metadata and a coherent second release both pass", async () => {
  expect(checkPlugins(root)).toEqual([]);
  const path = await fixture();
  const { version } = JSON.parse(
    await readFile(join(path, "package.json"), "utf8"),
  );
  for (const file of manifests) {
    const content = await readFile(join(path, file), "utf8");
    await writeFile(
      join(path, file),
      content.replaceAll(version, "2.3.4-rc.1"),
    );
  }
  expect(checkPlugins(path)).toEqual([]);
  const result = cli(path, "scripts/check-plugins.mjs", []);
  expect(result.status, result.stderr).toBe(0);
});

test.each([
  ["package.json", "version", "01.2.3"],
  ["package.json", "name", "another-package"],
  [claude, "version", "0.0.1"],
  ["plugin.json", "version", "0.0.1"],
  [".claude-plugin/marketplace.json", "metadata.version", "0.0.1"],
  [".claude-plugin/marketplace.json", "plugins.0.version", "0.0.1"],
  [".claude-plugin/marketplace.json", "plugins.0.source", "./elsewhere"],
  [".claude-plugin/marketplace.json", "plugins.0.source", "./"],
  [".claude-plugin/marketplace.json", "plugins.0.name", "other"],
  [".claude-plugin/marketplace.json", "owner.name", ""],
  [".agents/plugins/marketplace.json", "name", "other"],
  [".agents/plugins/marketplace.json", "plugins.0.source.path", "../../"],
  [".agents/plugins/marketplace.json", "plugins.0.source.source", "url"],
  [
    ".agents/plugins/marketplace.json",
    "plugins.0.policy.installation",
    "NOT_AVAILABLE",
  ],
  [
    ".agents/plugins/marketplace.json",
    "plugins.0.policy.authentication",
    "ON_USE",
  ],
  ["plugin.json", "$schema", "https://example.com/wrong"],
  ["plugin.json", "extensions.com.openai.hooks", {}],
  [claude, "name", "other"],
  ["plugin.json", "name", "other"],
  [claude, "mcpServers.idiom.command", "idiom"],
  [claude, "mcpServers.idiom.type", "sse"],
  [claude, "mcpServers.idiom.cwd", "./"],
])("rejects drift in %s %s", async (file, field, value) => {
  const path = await fixture();
  await mutate(path, file, field, value);
  expect(checkPlugins(path).join("\n")).toContain(`${file}:`);
  const result = cli(path, "scripts/check-plugins.mjs", []);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`${file}:`);
});

test.each([claude])(
  "rejects every URL/version and argument drift in %s",
  async (file) => {
    const path = await fixture();
    const data = JSON.parse(await readFile(join(path, file), "utf8"));
    const original: string[] = data.mcpServers.idiom.args;
    const selector = original[1] ?? "";
    for (const args of [
      ["-y", selector.replace(/\/v[^/]+\//, "/v0.0.1/"), "idiom", "mcp"],
      [
        "-y",
        selector.replace(/idiom-[^/]+\.tgz/, "idiom-0.0.1.tgz"),
        "idiom",
        "mcp",
      ],
      [
        "-y",
        selector.replace("mattskilly/idiom/", "another/repository/"),
        "idiom",
        "mcp",
      ],
      ["-y", "@mattskilly/idiom", "mcp"],
      ["-y", "--package=@mattskilly/idiom@latest", "idiom", "mcp"],
      ["idiom", "mcp", selector],
    ]) {
      await mutate(path, file, "mcpServers.idiom.args", args);
      expect(checkPlugins(path).join("\n")).toContain(
        `${file}: mcpServers.idiom.args`,
      );
    }
  },
);

test("a root mcp.json fails because Codex would start it in the plugin directory", async () => {
  const path = await fixture();
  await writeFile(
    join(path, "mcp.json"),
    JSON.stringify({ mcpServers: { idiom: { command: "npx" } } }),
  );
  expect(checkPlugins(path).join("\n")).toContain(
    "mcp.json: file must be absent",
  );
});

test.each(manifests)(
  "missing or invalid %s fails with its path",
  async (file) => {
    const path = await fixture();
    for (const content of ["{", "null", "[]"]) {
      await writeFile(join(path, file), content);
      expect(checkPlugins(path).join("\n")).toContain(`${file}:`);
    }
    await rm(join(path, file));
    expect(checkPlugins(path).join("\n")).toContain(`${file}:`);
  },
);

test.each([
  "skills/idiom/SKILL.md",
  "templates/idiom/init.md",
  "skills/idiom/references/init.md",
  "plugins/claude/skills/idiom/SKILL.md",
  "plugins/claude/skills/idiom/references/init.md",
  "plugins/claude/hooks/hooks.json",
  "plugins/claude/hooks/stop.mjs",
])("missing required %s fails", async (file) => {
  const path = await fixture();
  await rm(join(path, file));
  expect(checkPlugins(path).join("\n")).toContain(`${file}:`);
});

test.each([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "node_modules",
])(
  "%s in the Claude plugin directory fails because Claude Code would install dependencies",
  async (name) => {
    const path = await fixture();
    if (name === "node_modules")
      await mkdir(join(path, "plugins/claude", name));
    else
      await cp(join(root, "package.json"), join(path, "plugins/claude", name));
    expect(checkPlugins(path).join("\n")).toContain(
      `plugins/claude/${name}: file must be absent`,
    );
    expect(cli(path, "scripts/check-plugins.mjs", []).status).toBe(1);
  },
);

test("a root Claude plugin manifest fails so the marketplace root is never a plugin", async () => {
  const path = await fixture();
  await mkdir(join(path, ".claude-plugin"), { recursive: true });
  await cp(join(root, claude), join(path, ".claude-plugin/plugin.json"));
  expect(checkPlugins(path).join("\n")).toContain(
    ".claude-plugin/plugin.json: file must be absent",
  );
});

test.each([
  ["lib.mjs", 'import { z } from "zod";\n'],
  ["stop.mjs", 'const lib = await import("../../../dist/cli.js");\n'],
])("a hook importing a non-built-in from %s fails", async (file, line) => {
  const path = await fixture();
  const target = join(path, "plugins/claude/hooks", file);
  await writeFile(target, line + (await readFile(target, "utf8")));
  expect(checkPlugins(path).join("\n")).toContain(
    `plugins/claude/hooks/${file}: import`,
  );
});

test.each([
  [claude, "../../templates/idiom"],
  ["plugin.json", "./templates/idiom"],
])(
  "an explicit skills field in %s fails even when it names the default tree",
  async (file, templates) => {
    for (const skills of [[templates], ["./skills/idiom"]]) {
      const path = await fixture();
      await mutate(path, file, "skills", skills);
      const errors = checkPlugins(path).join("\n");
      expect(errors).toContain(`${file}: skills must be absent`);
      if (skills[0] === templates)
        expect(errors).toContain(
          `${file}: skills must resolve to exactly one "idiom" skill (found: skills/idiom, ${templates.replace(/^\.\//, "")})`,
        );
      const result = cli(path, "scripts/check-plugins.mjs", []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${file}:`);
    }
  },
);

test.each([
  [claude, "plugins/claude", "plugin.json"],
  ["plugin.json", ".", claude],
])(
  "a second discoverable idiom skill fails for %s only",
  async (file, base, other) => {
    const path = await fixture();
    await mkdir(join(path, base, "skills/idiom-copy"), { recursive: true });
    await cp(
      join(path, base, "skills/idiom/SKILL.md"),
      join(path, base, "skills/idiom-copy/SKILL.md"),
    );
    const errors: string[] = checkPlugins(path);
    expect(errors).toContain(
      `${file}: skills must resolve to exactly one "idiom" skill (found: skills/idiom, skills/idiom-copy)`,
    );
    expect(
      errors.filter((error) => error.startsWith(`${other}: skills`)),
    ).toEqual([]);
    expect(cli(path, "scripts/check-plugins.mjs", []).status).toBe(1);
  },
);

test.each([
  [claude, "plugins/claude"],
  ["plugin.json", "."],
])(
  "removing the skill tree of %s leaves it no idiom skill",
  async (file, base) => {
    const path = await fixture();
    await rm(join(path, base, "skills"), { force: true, recursive: true });
    const errors = checkPlugins(path).join("\n");
    expect(errors).toContain(
      `${join(base, "skills/idiom/SKILL.md")}: required plugin file`,
    );
    expect(errors).toContain(
      `${file}: skills must resolve to exactly one "idiom" skill (found: none)`,
    );
  },
);

test.skipIf(!snapshot)(
  "public selection admits only the Codex catalog from internal agent files",
  async () => {
    const allowed = [
      ...manifests,
      "dist/cli.js",
      "dist/main.js",
      "plugins/claude/hooks/hooks.json",
      "plugins/claude/skills/idiom/SKILL.md",
      "skills/idiom/SKILL.md",
      "skills/idiom/references/init.md",
      "scripts/check-plugins.mjs",
    ];
    const excluded = [
      ".agents/skills/internal/SKILL.md",
      ".agents/plugins/extra.json",
      ".claude/settings.json",
      "CLAUDE.md",
      "docs/session-handoff.md",
      "autobuild.toml",
    ];
    expect(snapshot.selectPublicFiles([...allowed, ...excluded])).toEqual(
      allowed,
    );
    const path = await fixture();
    execFileSync("git", ["init", "-q"], { cwd: path });
    for (const file of [...allowed, ...excluded]) {
      await mkdir(dirname(join(path, file)), { recursive: true });
      await writeFile(join(path, file), "fixture\n");
    }
    execFileSync("git", ["add", "."], { cwd: path });
    expect(snapshot.publicFiles(path)).toEqual(expect.arrayContaining(allowed));
    expect(
      snapshot
        .publicFiles(path)
        .filter((file: string) => excluded.includes(file)),
    ).toEqual([]);
  },
);

test.skipIf(!snapshot).each(["--check", "--out"])(
  "snapshot %s rejects metadata drift before success or copy",
  async (flag) => {
    const path = await fixture();
    execFileSync("git", ["init", "-q"], { cwd: path });
    execFileSync("git", ["add", "."], { cwd: path });
    await mutate(path, "plugin.json", "version", "0.0.1");
    const output = join(path, "export");
    const result = cli(path, "scripts/public-snapshot.mjs", [
      flag,
      ...(flag === "--out" ? [output] : []),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin.json: version");
    await expect(readFile(join(output, "package.json"))).rejects.toThrow();
  },
);
