#!/usr/bin/env node
// Dependency-free release guard: usable before installing build dependencies.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const releaseUrl = (version) =>
  `https://github.com/mattskilly/idiom/releases/download/v${version}/mattskilly-idiom-${version}.tgz`;

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// Models plugin skill discovery conservatively: the union of the default
// skills/ scan and any explicit manifest entries (Claude Code 2.1.312 lists both).
export function discoverSkills(directory, manifest, errors, path) {
  const found = [];
  const collect = (folder) => {
    if (isFile(join(folder, "SKILL.md"))) return found.push(folder);
    if (!isDirectory(folder)) return;
    for (const child of readdirSync(folder).sort())
      if (isFile(join(folder, child, "SKILL.md")))
        found.push(join(folder, child));
  };
  collect(join(directory, "skills"));
  if (manifest.skills !== undefined) {
    const entries =
      typeof manifest.skills === "string" ? [manifest.skills] : manifest.skills;
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => typeof entry !== "string")
    )
      errors.push(`${path}: skills must be a string or an array of strings`);
    else
      for (const entry of entries) {
        const target = resolve(directory, entry);
        if (!isDirectory(target))
          errors.push(`${path}: skills entry ${entry} does not exist`);
        else collect(target);
      }
  }
  const seen = new Set();
  const skills = [];
  for (const folder of found) {
    const real = realpathSync(folder);
    if (seen.has(real)) continue;
    seen.add(real);
    const text = readFileSync(join(folder, "SKILL.md"), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter)?.[1];
    skills.push({
      path: relative(directory, folder),
      name: name ?? folder.split(/[\\/]/).at(-1),
    });
  }
  return skills;
}

export function checkPlugins(directory = root) {
  const errors = [];
  const check = (condition, path, field, expected) => {
    if (!condition) errors.push(`${path}: ${field} must be ${expected}`);
  };
  const read = (path) => {
    try {
      const value = JSON.parse(readFileSync(join(directory, path), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected a JSON object");
      return value;
    } catch (error) {
      errors.push(`${path}: ${error.message}`);
      return {};
    }
  };
  const pkg = read("package.json");
  const version = pkg.version;
  // SemVer 2.0: numeric prerelease identifiers cannot have leading zeros.
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const semver = new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  );
  check(
    pkg.name === "@mattskilly/idiom",
    "package.json",
    "name",
    "@mattskilly/idiom",
  );
  check(
    typeof version === "string" && semver.test(version),
    "package.json",
    "version",
    "a semantic version",
  );
  const claudePath = ".claude-plugin/plugin.json";
  const claude = read(claudePath);
  const portable = read("plugin.json");
  for (const [path, manifest] of [
    [claudePath, claude],
    ["plugin.json", portable],
  ]) {
    check(manifest.name === "idiom", path, "name", "idiom");
    check(
      manifest.version === version,
      path,
      "version",
      `package.json.version (${version})`,
    );
    check(
      typeof manifest.description === "string" &&
        manifest.description.length > 0,
      path,
      "description",
      "nonempty",
    );
  }
  check(
    portable.$schema ===
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    "plugin.json",
    "$schema",
    "the Agent Plugins 1.0.0 plugin schema",
  );
  check(
    JSON.stringify(portable.extensions?.["com.openai"]?.hooks) ===
      '{"hooks":{}}',
    "plugin.json",
    "extensions.com.openai.hooks",
    'an explicit empty configuration {"hooks":{}}',
  );
  for (const [path, manifest] of [
    [claudePath, claude],
    ["plugin.json", portable],
  ]) {
    check(
      manifest.skills === undefined,
      path,
      "skills",
      "absent (default skills/ discovery)",
    );
    const skills = discoverSkills(directory, manifest, errors, path);
    if (skills.length !== 1 || skills[0].name !== "idiom")
      errors.push(
        `${path}: skills must resolve to exactly one "idiom" skill (found: ${
          skills.map((skill) => skill.path).join(", ") || "none"
        })`,
      );
  }
  check(
    claude.hooks === undefined,
    claudePath,
    "hooks",
    "absent (default discovery)",
  );
  const claudeCatalogPath = ".claude-plugin/marketplace.json";
  const claudeCatalog = read(claudeCatalogPath);
  check(claudeCatalog.name === "idiom", claudeCatalogPath, "name", "idiom");
  check(
    typeof claudeCatalog.owner?.name === "string" &&
      claudeCatalog.owner.name.length > 0,
    claudeCatalogPath,
    "owner.name",
    "nonempty",
  );
  check(
    claudeCatalog.metadata?.version === version,
    claudeCatalogPath,
    "metadata.version",
    `package.json.version (${version})`,
  );
  const singleEntry = (catalog, path) => {
    check(
      Array.isArray(catalog.plugins) && catalog.plugins.length === 1,
      path,
      "plugins",
      "exactly one Idiom entry",
    );
    const entry = catalog.plugins?.[0];
    check(entry?.name === "idiom", path, "plugins[0].name", "idiom");
    return entry;
  };
  const claudeEntry = singleEntry(claudeCatalog, claudeCatalogPath);
  check(
    claudeEntry?.source === "./",
    claudeCatalogPath,
    "plugins[0].source",
    '"./" (repository root)',
  );
  if (claudeEntry?.version !== undefined)
    check(
      claudeEntry.version === version,
      claudeCatalogPath,
      "plugins[0].version",
      `absent or ${version}`,
    );
  const codexPath = ".agents/plugins/marketplace.json";
  const codex = read(codexPath);
  check(codex.name === "idiom", codexPath, "name", "idiom");
  check(
    codex.interface?.displayName === "Idiom",
    codexPath,
    "interface.displayName",
    "Idiom",
  );
  const codexEntry = singleEntry(codex, codexPath);
  check(
    codexEntry?.source?.source === "local" && codexEntry.source.path === "./",
    codexPath,
    "plugins[0].source",
    'local with path "./" (root plugin.json)',
  );
  check(
    codexEntry?.policy?.installation === "AVAILABLE" &&
      codexEntry.policy.authentication === "ON_INSTALL",
    codexPath,
    "plugins[0].policy",
    "AVAILABLE / ON_INSTALL",
  );
  check(
    codexEntry?.category === "Developer tools",
    codexPath,
    "plugins[0].category",
    "Developer tools",
  );
  // Codex starts plugin MCP servers in the plugin directory, never the project;
  // Codex users register the server with `codex mcp add` instead.
  check(
    !existsSync(join(directory, "mcp.json")),
    "mcp.json",
    "file",
    "absent (Codex plugin servers cannot bind to the project)",
  );
  for (const [path, manifest] of [[claudePath, claude]]) {
    const server = manifest.mcpServers?.idiom;
    check(server?.type === "stdio", path, "mcpServers.idiom.type", "stdio");
    check(server?.command === "npx", path, "mcpServers.idiom.command", "npx");
    check(
      JSON.stringify(server?.args) ===
        JSON.stringify([
          "-y",
          `--package=${releaseUrl(version)}`,
          "idiom",
          "mcp",
        ]),
      path,
      "mcpServers.idiom.args",
      `-y --package=${releaseUrl(version)} idiom mcp`,
    );
    check(
      server?.cwd === undefined,
      path,
      "mcpServers.idiom.cwd",
      "absent (inherit application directory)",
    );
  }
  for (const path of [
    "templates/idiom/SKILL.md",
    "templates/idiom/init.md",
    "skills/idiom/SKILL.md",
    "skills/idiom/references/init.md",
    "hooks/hooks.json",
    "hooks/lib.mjs",
    "hooks/post-tool-use.mjs",
    "hooks/stop.mjs",
  ]) {
    try {
      check(
        statSync(join(directory, path)).isFile() &&
          statSync(join(directory, path)).size > 0,
        path,
        "file",
        "present and nonempty",
      );
    } catch {
      errors.push(`${path}: required plugin file is missing`);
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  const errors = checkPlugins(process.argv[2]);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log("Plugin identities, catalogs and release launchers agree.");
}
