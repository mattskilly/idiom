import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { manifestPath, pristinePath } from "../src/skills/pristine.js";
import type { Distribution, SkillName } from "../src/skills/types.js";
import {
  type UpgradeDependencies,
  upgradeSkills,
} from "../src/skills/upgrade.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
export async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "idiom-skills-test-"));
  roots.push(root);
  return root;
}
export const skill = (
  body = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n",
  name = "idiom",
) => `---\nname: ${name}\ndescription: Test\n---\n${body}`;
export function distribution(
  version: string,
  files: Record<string, string> = {
    "SKILL.md": skill(),
    "init.md": "a\nb\nc\nd\ne\nf\ng\n",
  },
  name: SkillName = "idiom",
): Distribution {
  return {
    version,
    skills: {
      [name]: Object.fromEntries(
        Object.entries(files).map(([key, content]) => [
          key,
          { content, incomingPath: `/installed/templates/${name}/${key}` },
        ]),
      ),
    },
  };
}
export async function put(root: string, path: string, content: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
export const read = (root: string, path: string) =>
  readFile(join(root, path), "utf8");
export const base = (root: string, path = "idiom/SKILL.md") =>
  read(root, pristinePath(path));
export const metadata = async (root: string) =>
  JSON.parse(await read(root, manifestPath));
export async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(path: string) {
    for (const name of (await readdir(join(root, path))).sort()) {
      const relative = path ? `${path}/${name}` : name;
      const state = await lstat(join(root, relative));
      if (state.isSymbolicLink())
        result[relative] = `link:${await readlink(join(root, relative))}`;
      else if (state.isDirectory()) {
        result[relative] = "directory";
        await visit(relative);
      } else result[relative] = `file:${await read(root, relative)}`;
    }
  }
  await visit("");
  return result;
}
export async function runUpgrade(
  root: string,
  incoming = distribution("1.0.0"),
  options: { agent?: boolean; dryRun?: boolean } = {},
  dependencies: UpgradeDependencies = {},
) {
  return upgradeSkills(
    { projectDirectory: root, ...options },
    {
      distribution: incoming,
      history: { schema: 1, releases: [] },
      ...dependencies,
    },
  );
}
