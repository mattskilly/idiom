// Maintainer-only: derive exact templates from immutable release tags, offline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const root = new URL("../templates/skill-history/", import.meta.url);
const check = process.argv.includes("--check");
const tags = git("tag", "--list", "v*", "--sort=version:refname")
  .trim()
  .split("\n")
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
const releases = [];
const blobs = new Map();
for (const tag of tags) {
  const commit = git("rev-parse", `${tag}^{commit}`).trim();
  const init = git("show", `${commit}:src/commands/init.ts`);
  const templates = git("show", `${commit}:src/templates.ts`);
  // Inspect each release's installation contract. Fail closed if its layout
  // changes, rather than inventing files for that release.
  if (
    !init.includes('join(".agents", "skills", "idiom")') ||
    !templates.includes('idiomSkillFileNames = ["SKILL.md", "init.md"]')
  )
    throw new Error(`Review the skill layout in ${tag} before cataloguing it`);
  const paths = ["idiom/SKILL.md", "idiom/init.md"];
  if (init.includes("readAutobuildVerifierSkillTemplate"))
    paths.push("ab-verify-idiom/SKILL.md");
  const available = new Set(
    git("ls-tree", "-r", "--name-only", commit, "templates").trim().split("\n"),
  );
  const files = {};
  for (const path of paths) {
    if (!available.has(`templates/${path}`)) continue;
    const bytes = execFileSync("git", ["show", `${commit}:templates/${path}`]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    blobs.set(digest, bytes);
    files[path] = digest;
  }
  releases.push({
    version: tag.slice(1),
    tag,
    tagObject: git("rev-parse", tag).trim(),
    commit,
    files,
  });
}
const outputs = new Map([
  [
    "catalog.json",
    Buffer.from(`${JSON.stringify({ schema: 1, releases }, null, 2)}\n`),
  ],
  ...[...blobs].map(([digest, bytes]) => [`blobs/${digest}.md`, bytes]),
]);
if (!check) await mkdir(new URL("blobs/", root), { recursive: true });
for (const [path, bytes] of outputs) {
  const destination = new URL(path, root);
  if (check) {
    if (!(await readFile(destination)).equals(bytes))
      throw new Error(`Stale skill history: ${path}`);
  } else await writeFile(destination, bytes);
}
const actual = await readdir(new URL("blobs/", root));
if (actual.some((file) => !outputs.has(join("blobs", file))))
  throw new Error("Unexpected history blobs; review obsolete data");
console.log(
  `Skill history ${check ? "checked" : "generated"}: ${releases.length} releases, ${blobs.size} exact blobs`,
);
