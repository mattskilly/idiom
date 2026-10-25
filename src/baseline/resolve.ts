import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IdiomError } from "../errors.js";
import type { BaselineFile } from "./schema.js";

const exec = promisify(execFile);
export type GitAncestry = {
  head(cwd: string): Promise<string>;
  isAncestor(
    cwd: string,
    commit: string,
    head: string,
  ): Promise<boolean | undefined>;
  distance(cwd: string, commit: string, head: string): Promise<number>;
};
export const gitAncestry: GitAncestry = {
  async head(cwd) {
    try {
      return (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    } catch (error) {
      throw new IdiomError(
        `cannot resolve baseline HEAD: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
  async isAncestor(cwd, commit, head) {
    try {
      await exec("git", ["merge-base", "--is-ancestor", commit, head], { cwd });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code !== 1) return undefined;
      // A shallow boundary can hide an ancestor even when both objects exist.
      const shallow = (
        await exec("git", ["rev-parse", "--is-shallow-repository"], { cwd })
      ).stdout.trim();
      return shallow === "true" ? undefined : false;
    }
  },
  async distance(cwd, commit, head) {
    return Number(
      (
        await exec("git", ["rev-list", "--count", `${commit}..${head}`], {
          cwd,
        })
      ).stdout.trim(),
    );
  },
};
export async function selectBaselineRecord(options: {
  projectDirectory: string;
  file: BaselineFile;
  git?: GitAncestry | undefined;
}) {
  const git = options.git ?? gitAncestry;
  const head = await git.head(options.projectDirectory);
  const reachable = [];
  for (const record of options.file.records) {
    const ancestor = await git.isAncestor(
      options.projectDirectory,
      record.commit,
      head,
    );
    if (ancestor === undefined)
      throw new IdiomError(
        `cannot establish baseline ancestry for ${record.commit}; fetch the missing commit and full Git history (git fetch --unshallow for shallow clones) and retry`,
      );
    if (!ancestor) continue;
    reachable.push({
      record,
      distance: await git.distance(
        options.projectDirectory,
        record.commit,
        head,
      ),
    });
  }
  return reachable.sort(
    (a, b) =>
      a.distance - b.distance ||
      b.record.recordedAt.localeCompare(a.record.recordedAt),
  )[0];
}
