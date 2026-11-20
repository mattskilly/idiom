import { type GitRead, readGit } from "../changed/git.js";
import { IdiomError } from "../errors.js";

/** One first-parent commit on the watched branch: one merge. */
export type Merge = {
  commit: string;
  /** Its first parent: the branch tip before it landed. */
  parent: string;
  subject: string;
  committedAt: string;
};

export type PendingMerges = Merge[] | { rewritten: true };

export const short = (commit: string) => commit.slice(0, 12);

/** The watched ref's commit. */
export async function resolveTip(
  repository: string,
  target: string,
  git: GitRead = readGit,
): Promise<string> {
  try {
    return (
      await git(repository, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${target}^{commit}`,
      ])
    ).trim();
  } catch {
    throw new IdiomError(
      `cannot resolve --target ${JSON.stringify(target)} to a local commit; fetch it or pass --target <ref>`,
    );
  }
}

/**
 * Every first-parent commit after the cursor, oldest first. A squash merge
 * and a `--no-ff` merge each appear once; a merged branch's own commits are
 * never visited. A cursor that is no longer an ancestor of the tip means the
 * branch was rewritten.
 */
export async function pendingMerges(
  repository: string,
  cursor: string,
  tip: string,
  git: GitRead = readGit,
): Promise<PendingMerges> {
  if (cursor === tip) return [];
  const ancestor = await git(repository, [
    "merge-base",
    "--is-ancestor",
    cursor,
    tip,
  ]).then(
    () => true,
    () => false,
  );
  if (!ancestor) return { rewritten: true };
  const commits = (
    await git(repository, [
      "rev-list",
      "--first-parent",
      "--reverse",
      `${cursor}..${tip}`,
    ])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const merges: Merge[] = [];
  for (const commit of commits) {
    const parent = (
      await git(repository, ["rev-parse", "--verify", `${commit}^1`])
    ).trim();
    const [subject = "", committedAt = ""] = (
      await git(repository, ["show", "-s", "--format=%s%x00%cI", commit])
    )
      .trim()
      .split("\0");
    merges.push({ commit, parent, subject, committedAt });
  }
  return merges;
}

/** A remote-tracking target (`origin/main`, `refs/remotes/...`) to fetch. */
export async function isRemoteTarget(
  repository: string,
  target: string,
  git: GitRead = readGit,
): Promise<boolean> {
  if (target.startsWith("refs/remotes/")) return true;
  if (target.startsWith("refs/")) return false;
  const remotes = (await git(repository, ["remote"]).catch(() => ""))
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  return remotes.some((remote) => target.startsWith(`${remote}/`));
}
