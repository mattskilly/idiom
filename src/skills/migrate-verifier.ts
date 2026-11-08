import { mkdir, readdir, rename, rm, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { readHistory } from "./distribution.js";
import { skillIdentity } from "./merge.js";
import {
  type ApplyDependencies,
  applyWrites,
  inspect,
  unchanged,
  type Write,
} from "./paths.js";
import {
  digest,
  loadPristine,
  manifestBytes,
  manifestPath,
  pristinePath,
} from "./pristine.js";

const oldName = "ab-verify-idiom";
const newName = "idiom-verify";
const canonical = (name: string) => `.agents/skills/${name}`;
const discovery = (name: string) => `.claude/skills/${name}`;
const target = (name: string) => `../../.agents/skills/${name}`;
export function renamedIdentity(content: string): string {
  return content.replace(
    /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/,
    (_match, start: string, frontmatter: string, end: string) =>
      start +
      frontmatter.replace(
        /^([ \t]*name:[ \t]*)(["']?)ab-verify-idiom\2([ \t]*\r?)$/m,
        "$1$2idiom-verify$2$3",
      ) +
      end,
  );
}
export type VerifierMigration = {
  preview: string;
  apply(configWrites: Write[], dependencies?: ApplyDependencies): Promise<void>;
};
/** A bounded rename transaction; no released history or baseline bytes are rewritten. */
export async function planVerifierMigration(
  root: string,
): Promise<VerifierMigration | undefined> {
  const snapshots = new Map<string, string>();
  // A gate-only project need not expose a skill tree. Do not follow a
  // protected ancestor to infer a legacy install through someone else's tree.
  for (const parent of [".agents", ".agents/skills"]) {
    const state = await inspect(root, parent, snapshots);
    if (state.kind !== "directory") return undefined;
  }
  const old = await inspect(root, canonical(oldName), snapshots);
  if (old.kind === "absent") return undefined;
  if (old.kind !== "directory")
    throw new Error("Protected legacy verifier directory");
  const main = await inspect(root, `${canonical(oldName)}/SKILL.md`, snapshots);
  if (main.kind !== "file" || skillIdentity(main.content) !== oldName)
    throw new Error("Legacy verifier has no recognized identity");
  const manifest = await loadPristine(root, snapshots);
  const link = await inspect(root, discovery(oldName), snapshots);
  if (
    link.kind !== "absent" &&
    !(link.kind === "symlink" && link.target === target(oldName))
  )
    throw new Error("Protected legacy discovery entry");
  for (const path of [
    canonical(newName),
    discovery(newName),
    pristinePath(newName),
  ])
    if ((await inspect(root, path, snapshots)).kind !== "absent")
      throw new Error(`Migration destination is occupied: ${path}`);
  if (Object.keys(manifest.files).some((key) => key.startsWith(`${newName}/`)))
    throw new Error("Migration destination already has pristine ownership");
  const oldBase = await inspect(root, pristinePath(oldName), snapshots);
  if (oldBase.kind !== "directory" && oldBase.kind !== "absent")
    throw new Error("Protected legacy pristine directory");
  const listings = new Map<string, string>();
  async function snapshotTree(path: string): Promise<void> {
    const state = await inspect(root, path, snapshots);
    if (state.kind === "directory") {
      const names = (await readdir(join(root, path))).sort();
      listings.set(path, JSON.stringify(names));
      for (const name of names) await snapshotTree(`${path}/${name}`);
    }
  }
  await snapshotTree(canonical(oldName));
  if (oldBase.kind === "directory") await snapshotTree(pristinePath(oldName));
  const next = { schema: 1 as const, files: { ...manifest.files } };
  for (const [key, record] of Object.entries(manifest.files)) {
    if (!key.startsWith(`${oldName}/`)) continue;
    const base = await inspect(root, pristinePath(key), snapshots);
    if (base.kind !== "file" || digest(base.content) !== record.digest)
      throw new Error(`Invalid legacy pristine bytes: ${key}`);
    delete next.files[key];
    next.files[key.replace(`${oldName}/`, `${newName}/`)] = record;
  }
  // Recover exact released ownership before changing the live identity.
  const mainKey = `${newName}/SKILL.md`;
  let recovered: string | undefined;
  if (!next.files[mainKey] && oldBase.kind === "absent") {
    const release = (await readHistory()).releases.find(
      (value) => value.files[`${oldName}/SKILL.md`] === digest(main.content),
    );
    if (release) {
      recovered = main.content;
      next.files[mainKey] = {
        version: release.version,
        digest: digest(main.content),
      };
    }
  }
  return {
    preview: [
      `${canonical(oldName)}/ → ${canonical(newName)}/ (preserve local files; rename frontmatter identity)`,
      link.kind === "symlink"
        ? `${discovery(oldName)} → ${discovery(newName)} (owned relative discovery link)`
        : `Create ${discovery(newName)} → ${target(newName)}`,
      oldBase.kind === "directory"
        ? `${pristinePath(oldName)}/ → ${pristinePath(newName)}/ (preserve baseline bytes, versions and digests)`
        : recovered !== undefined
          ? `Recover exact released baseline at ${pristinePath(mainKey)} (preserve baseline bytes, version and digest)`
          : "Unknown local content: move without inventing pristine provenance.",
      manifestBytes(next) !== manifestBytes(manifest)
        ? "Rename/recover legacy pristine manifest keys."
        : "Pristine manifest unchanged.",
      "",
    ].join("\n"),
    async apply(configWrites, dependencies) {
      await unchanged(root, snapshots);
      for (const [path, names] of listings)
        if (JSON.stringify((await readdir(join(root, path))).sort()) !== names)
          throw new Error(`${path} changed during upgrade`);
      const moved: Array<[string, string]> = [];
      const created: string[] = [];
      let removedLink = false;
      let newLink = false;
      try {
        await rename(
          join(root, canonical(oldName)),
          join(root, canonical(newName)),
        );
        moved.push([canonical(oldName), canonical(newName)]);
        if (oldBase.kind === "directory") {
          await rename(
            join(root, pristinePath(oldName)),
            join(root, pristinePath(newName)),
          );
          moved.push([pristinePath(oldName), pristinePath(newName)]);
        }
        if (link.kind === "symlink") {
          await rm(join(root, discovery(oldName)));
          removedLink = true;
        }
        for (const path of [".claude", ".claude/skills"]) {
          if ((await inspect(root, path)).kind === "absent") {
            await mkdir(join(root, path));
            created.push(path);
          }
        }
        await symlink(target(newName), join(root, discovery(newName)), "dir");
        newLink = true;
        const writes: Write[] = [
          {
            path: `${canonical(newName)}/SKILL.md`,
            content: renamedIdentity(main.content),
          },
          ...configWrites,
        ];
        if (recovered !== undefined)
          writes.push({ path: pristinePath(mainKey), content: recovered });
        if (manifestBytes(next) !== manifestBytes(manifest))
          writes.push({ path: manifestPath, content: manifestBytes(next) });
        await applyWrites(root, writes, dependencies);
      } catch (error) {
        if (newLink) await rm(join(root, discovery(newName)));
        if (removedLink)
          await symlink(target(oldName), join(root, discovery(oldName)), "dir");
        for (const [from, to] of moved.reverse())
          await rename(join(root, to), join(root, from));
        for (const path of created.reverse()) await rmdir(join(root, path));
        throw error;
      }
    },
  };
}
