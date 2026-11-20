import { access, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { runOwnedCommand } from "../capture/process.js";
import { dependencyInstall } from "../capture/ref-worktree.js";
import { IdiomError } from "../errors.js";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export type PrepareTreeOptions = {
  /** The repository's top level (any worktree of it). */
  repository: string;
  /** The watch state directory; the tree lives at `<watchDir>/tree`. */
  watchDir: string;
  commit: string;
  /** The project's path inside the repository ("" at the root). */
  projectRelative: string;
  signal?: AbortSignal | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
};

/**
 * Check the watch-owned linked worktree out at a merge, reusing it between
 * merges: ignored files (dependencies, run reports a filed ticket points at)
 * survive, untracked leftovers do not. Returns the project inside it.
 */
export async function prepareTree(
  options: PrepareTreeOptions,
): Promise<{ tree: string; treeProject: string }> {
  const tree = join(options.watchDir, "tree");
  const git = (cwd: string, args: string[], label: string) =>
    runOwnedCommand({
      command: "git",
      args,
      cwd,
      label,
      signal: options.signal,
      environment: options.environment,
    });
  let ready = false;
  if (await exists(join(tree, ".git"))) {
    try {
      await git(
        tree,
        ["checkout", "--quiet", "--detach", "--force", options.commit],
        "watch tree checkout",
      );
      await git(
        tree,
        ["clean", "-ffdq", "-e", "**/.idiom/reports/"],
        "watch tree clean",
      );
      ready = true;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // A broken or unregistered tree is rebuilt below.
    }
  }
  if (!ready) {
    await rm(tree, { recursive: true, force: true });
    await mkdir(options.watchDir, { recursive: true });
    await git(options.repository, ["worktree", "prune"], "watch tree prune");
    await git(
      options.repository,
      ["worktree", "add", "--quiet", "--detach", tree, options.commit],
      "watch tree creation",
    );
  }
  const root = await realpath(tree);
  const treeProject = join(root, options.projectRelative);
  if (!(await exists(join(treeProject, ".idiom/project.json"))))
    throw new IdiomError(
      `merge ${options.commit.slice(0, 12)} has no .idiom/project.json at ${options.projectRelative || "the repository root"}`,
    );
  const install = await dependencyInstall(treeProject, root);
  options.signal?.throwIfAborted();
  if (install)
    await runOwnedCommand({
      ...install,
      label: "watch tree dependency installation",
      signal: options.signal,
      environment: options.environment,
    }).catch((error: unknown) => {
      if (options.signal?.aborted) throw error;
      throw new IdiomError(
        `watch tree dependency installation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  return { tree: root, treeProject };
}
