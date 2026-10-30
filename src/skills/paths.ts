import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export function safeRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export type Entry =
  | { kind: "absent" }
  | { kind: "file"; content: string; mode: number; token: string }
  | { kind: "directory"; token: string }
  | { kind: "symlink"; target: string }
  | { kind: "other" };
export async function entry(path: string): Promise<Entry> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      return { kind: "symlink", target: await readlink(path) };
    const token = `${stat.dev}:${stat.ino}:${stat.mode}`;
    if (stat.isDirectory()) return { kind: "directory", token };
    if (stat.isFile())
      return {
        kind: "file",
        token: `${stat.dev}:${stat.mode}`,
        mode: stat.mode,
        content: await readFile(path, "utf8"),
      };
    return { kind: "other" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "absent" };
    throw error;
  }
}
export const fingerprint = (value: Entry): string => JSON.stringify(value);
export async function inspect(
  root: string,
  relative: string,
  snapshots?: Map<string, string>,
): Promise<Entry> {
  if (!safeRelative(relative))
    throw new Error(`Unsafe relative path: ${relative}`);
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    const value = await entry(join(root, path));
    snapshots?.set(path, fingerprint(value));
    if (value.kind !== "directory" && value.kind !== "absent")
      throw new Error(`Protected ancestor: ${path || root}`);
  }
  const value = await entry(join(root, relative));
  snapshots?.set(relative, fingerprint(value));
  return value;
}
export async function unchanged(
  root: string,
  snapshots: Map<string, string>,
): Promise<void> {
  for (const [path, expected] of snapshots) {
    // Reinspect ancestors before reading the leaf, so a newly swapped symlink
    // cannot turn a comparison into a read outside the owned tree.
    const current = path === "" ? await entry(root) : await inspect(root, path);
    if (fingerprint(current) !== expected)
      throw new Error(`${path || root} changed during upgrade`);
  }
}
export type Write = { path: string; content: string | undefined };
export type ApplyDependencies = {
  beforeRename?: (path: string) => Promise<void>;
};
/** A bounded per-file transaction, including its shared manifest entry. */
export async function applyWrites(
  root: string,
  writes: Write[],
  dependencies: ApplyDependencies = {},
): Promise<void> {
  const originals = new Map<string, Entry>();
  const staged = new Map<string, string>();
  const backups = new Map<string, string>();
  const applied: string[] = [];
  const createdDirectories: string[] = [];
  async function parents(relative: string) {
    const parts = relative.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      const state = await inspect(root, path);
      if (state.kind === "absent") {
        await mkdir(join(root, path));
        createdDirectories.push(path);
      } else if (state.kind !== "directory")
        throw new Error(`Protected directory: ${path}`);
    }
  }
  async function stage(
    relative: string,
    content: string,
    mode: number | undefined,
    target = staged,
  ) {
    await parents(relative);
    const temporary = join(
      root,
      dirname(relative),
      `.idiom-${randomUUID()}.tmp`,
    );
    target.set(relative, temporary);
    await writeFile(temporary, content, { flag: "wx", encoding: "utf8" });
    if (mode !== undefined) await chmod(temporary, mode);
  }
  try {
    for (const write of writes) {
      const state = await inspect(root, write.path);
      if (state.kind !== "absent" && state.kind !== "file")
        throw new Error(`Protected file: ${write.path}`);
      originals.set(write.path, state);
      // Allocate rollback bytes before changing any destination. Restoring a
      // prior file then needs only a rename, even when staging ran out of space.
      if (state.kind === "file")
        await stage(write.path, state.content, state.mode, backups);
      if (write.content !== undefined)
        await stage(
          write.path,
          write.content,
          state.kind === "file" ? state.mode : undefined,
        );
    }
    for (const write of writes) {
      await dependencies.beforeRename?.(write.path);
      const original = originals.get(write.path);
      if (
        fingerprint(await inspect(root, write.path)) !==
        fingerprint(original ?? { kind: "absent" })
      )
        throw new Error(`${write.path} changed before application`);
      if (write.content === undefined)
        await rm(join(root, write.path), { force: true });
      else
        await rename(staged.get(write.path) as string, join(root, write.path));
      applied.push(write.path);
    }
  } catch (error) {
    for (const path of applied.reverse()) {
      const original = originals.get(path);
      await inspect(root, path);
      if (original?.kind === "file")
        await rename(backups.get(path) as string, join(root, path));
      else await rm(join(root, path), { force: true });
    }
    throw error;
  } finally {
    for (const temporary of [...staged.values(), ...backups.values()])
      await rm(temporary, { force: true });
    for (const directory of createdDirectories.reverse()) {
      try {
        await rmdir(join(root, directory));
      } catch {
        /* Only remove empty directories. */
      }
    }
  }
}
