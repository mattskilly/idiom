import { type GitRead, readGit } from "../changed/git.js";

/** Read-only queries over a first-seen range; every git call is injectable. */

/** The full SHA of a commit, or undefined (`unknown`, a missing object, no repository). */
export async function resolveCommit(
  repository: string,
  sha: string,
  git: GitRead = readGit,
): Promise<string | undefined> {
  if (sha === "" || sha === "unknown") return undefined;
  try {
    const resolved = (
      await git(repository, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${sha}^{commit}`,
      ])
    ).trim();
    return resolved === "" ? undefined : resolved;
  } catch {
    return undefined;
  }
}

/** Whether `from` is an ancestor of `to`; a failing query is false. */
export async function isAncestor(
  repository: string,
  from: string,
  to: string,
  git: GitRead = readGit,
): Promise<boolean> {
  try {
    await git(repository, ["merge-base", "--is-ancestor", from, to]);
    return true;
  } catch {
    return false;
  }
}

/** The first-parent commits in from..to, oldest first. */
export async function firstParentCommits(
  repository: string,
  from: string,
  to: string,
  git: GitRead = readGit,
): Promise<string[]> {
  return (
    await git(repository, [
      "rev-list",
      "--first-parent",
      "--reverse",
      `${from}..${to}`,
    ])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export type CommitInfo = {
  commit: string;
  parents: string[];
  subject: string;
  body: string;
  merge: boolean;
  /** For a merge named `Merge pull request`/`Merge branch`, the PR title. */
  shownSubject: string;
};

const mergeSubject = /^Merge (?:pull request|branch)\b/;

export async function commitInfo(
  repository: string,
  sha: string,
  git: GitRead = readGit,
): Promise<CommitInfo> {
  const [commit = sha, parentText = "", subject = "", ...rest] = (
    await git(repository, ["log", "-1", "--format=%H%x00%P%x00%s%x00%b", sha])
  ).split("\0");
  const body = rest.join("\0").trim();
  const parents = parentText.trim().split(/\s+/).filter(Boolean);
  const merge = parents.length > 1;
  const title = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return {
    commit: commit.trim(),
    parents,
    subject: subject.trim(),
    body,
    merge,
    shownSubject:
      merge && mergeSubject.test(subject) && title !== undefined
        ? title
        : subject.trim(),
  };
}

/** Repository-relative paths a commit changed against its first parent. */
export async function commitFiles(
  repository: string,
  info: Pick<CommitInfo, "commit" | "parents">,
  git: GitRead = readGit,
): Promise<string[]> {
  const parent = info.parents[0];
  const args =
    parent === undefined
      ? [
          "diff-tree",
          "--root",
          "-r",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "-z",
          info.commit,
        ]
      : [
          "diff-tree",
          "-r",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "-z",
          parent,
          info.commit,
        ];
  return (await git(repository, args)).split("\0").filter(Boolean);
}

/** The repository top level, or undefined outside Git. */
export async function repositoryRoot(
  directory: string,
  git: GitRead = readGit,
): Promise<string | undefined> {
  try {
    const root = (
      await git(directory, ["rev-parse", "--show-toplevel"])
    ).trim();
    return root === "" ? undefined : root;
  } catch {
    return undefined;
  }
}
