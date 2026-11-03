import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Only the init reference's location separates the portable skill from the
// project template. Keep the finite output map reviewable and stable.
// Each plugin root carries an identical copy: skills/idiom for the portable
// and Codex plugin, plugins/claude/skills/idiom for the Claude plugin.
export async function renderSkill() {
  const source = await readFile(join(root, "templates/idiom/SKILL.md"), "utf8");
  const boundary = source.indexOf("\n---\n", 4);
  if (!source.startsWith("---\n") || boundary < 0)
    throw new Error("Canonical skill has no frontmatter");
  const frontmatter = source.slice(0, boundary);
  const body = source
    .slice(boundary)
    .replace(
      "`init.md` beside this file",
      "`references/init.md` relative to this file",
    );
  const init = await readFile(join(root, "templates/idiom/init.md"), "utf8");
  const files = {};
  for (const base of ["skills/idiom", "plugins/claude/skills/idiom"]) {
    files[`${base}/SKILL.md`] = frontmatter + body;
    files[`${base}/references/init.md`] = init;
  }
  return files;
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error("usage: generate-skill.mjs [--check]");
  const check = process.argv.includes("--check");
  for (const [path, content] of Object.entries(await renderSkill())) {
    if (check) {
      const actual = await readFile(join(root, path), "utf8").catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (actual !== content) {
        console.error(
          `Portable skill drift: ${path}; run bun run generate:skill`,
        );
        process.exitCode = 1;
      }
    } else {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }
}

if (
  process.argv[1] &&
  (await realpath(resolve(process.argv[1]))) === fileURLToPath(import.meta.url)
)
  await main();
