import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { IdiomError } from "../errors.js";

const exec = promisify(execFile);
export type GitRead = (cwd: string, args: string[]) => Promise<string>;
export const readGit: GitRead = async (cwd, args) =>
  (await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
export type ChangeSet = {
  repository: string;
  head: string;
  requestedBase: string | null;
  resolvedBase: string;
  baseReason: string;
  fallbackReason?: string;
  files: Array<{ path: string; absolute: string }>;
};

/** Read-only Git queries; compare immutable commit IDs and retain index-only edits. */
export async function collectChanges(
  project: string,
  base?: string,
  git: GitRead = readGit,
): Promise<ChangeSet> {
  let repository: string;
  let head: string;
  try {
    repository = (
      await git(project, ["rev-parse", "--show-toplevel"])
    ).trimEnd();
    head = (
      await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
  } catch {
    throw new IdiomError(
      "--changed requires a Git repository with a committed HEAD",
    );
  }
  const optional = async (args: string[]) => {
    try {
      return (await git(repository, args)).trim();
    } catch {
      return undefined;
    }
  };
  let resolvedBase: string | undefined;
  let fallbackReason: string | undefined;
  let baseReason = "explicit base";
  if (base !== undefined) {
    resolvedBase = await optional([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${base}^{commit}`,
    ]);
    if (!resolvedBase)
      throw new IdiomError(
        `invalid --changed base ${JSON.stringify(base)}; supply a commit or ref`,
      );
  } else {
    const remotes = (
      await git(repository, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes",
      ])
    )
      .trim()
      .split("\n")
      .filter((ref) => ref.endsWith("/HEAD"))
      .sort(
        (a, b) =>
          Number(b.startsWith("refs/remotes/origin/")) -
            Number(a.startsWith("refs/remotes/origin/")) || a.localeCompare(b),
      );
    let branch: string | undefined;
    for (const ref of remotes) {
      branch = await optional(["symbolic-ref", "--quiet", ref]);
      if (branch) break;
    }
    if (!branch)
      for (const ref of ["refs/heads/main", "refs/heads/master"]) {
        if (await optional(["rev-parse", "--verify", ref])) {
          branch = ref;
          break;
        }
      }
    if (branch) resolvedBase = await optional(["merge-base", "HEAD", branch]);
    baseReason = branch ? `merge base with ${branch}` : "HEAD";
    if (!resolvedBase) {
      fallbackReason = branch
        ? `no merge base with ${branch}; using HEAD`
        : "no local default branch found; using HEAD";
      resolvedBase = head;
    }
  }
  const paths = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "--no-renames", "-z", resolvedBase, head, "--"],
    ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"],
    ["diff", "--name-only", "--no-renames", "-z", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ])
    for (const path of (await git(repository, args)).split("\0"))
      if (path) paths.add(path);
  return {
    repository,
    head,
    requestedBase: base ?? null,
    resolvedBase,
    baseReason,
    ...(fallbackReason ? { fallbackReason } : {}),
    files: [...paths]
      .sort()
      .map((path) => ({ path, absolute: resolve(repository, path) })),
  };
}
