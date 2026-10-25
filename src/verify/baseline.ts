import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { IdiomError } from "../errors.js";
import { type Finding, findingSchema } from "../schemas/finding.js";

const execFileAsync = promisify(execFile);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type GitTopology = (
  projectDirectory: string,
) => Promise<string | undefined>;

export async function primaryCheckout(
  projectDirectory: string,
): Promise<string | undefined> {
  try {
    const [{ stdout: commonOutput }, { stdout: worktreeOutput }] =
      await Promise.all([
        execFileAsync(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          { cwd: projectDirectory, encoding: "utf8" },
        ),
        execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], {
          cwd: projectDirectory,
          encoding: "utf8",
        }),
      ]);
    const common = resolve(commonOutput.trim());
    const worktrees = worktreeOutput
      .split("\0")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length)));
    const topologyCandidate = common.endsWith(`${sep}.git`)
      ? dirname(common)
      : worktrees[0];
    return topologyCandidate !== undefined &&
      worktrees.includes(topologyCandidate)
      ? topologyCandidate
      : worktrees[0];
  } catch (error) {
    throw new IdiomError(
      `cannot discover Git common-worktree topology: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findingsAt(
  runDirectory: string,
): Promise<Finding[] | undefined> {
  const path = join(runDirectory, "findings.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new IdiomError(
      `cannot read baseline findings ${path}: ${String(error)}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new IdiomError(`invalid baseline findings ${path}: ${String(error)}`);
  }
  if (!Array.isArray(value))
    throw new IdiomError(
      `invalid baseline findings ${path}: expected an array`,
    );
  return value.map((item, index) => {
    const parsed = findingSchema.safeParse(item);
    if (!parsed.success)
      throw new IdiomError(
        `invalid baseline finding ${path}[${index}]: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    return parsed.data;
  });
}

function matchesAll(candidates: Finding[], expected: Finding[]): boolean {
  return expected.every((finding) =>
    candidates.some((candidate) => {
      const expectedIds = new Set([finding.id, ...(finding.idAliases ?? [])]);
      const identityMatches = [
        candidate.id,
        ...(candidate.idAliases ?? []),
      ].some((id) => expectedIds.has(id));
      return (
        identityMatches &&
        candidate.fingerprint === finding.fingerprint &&
        candidate.flow === finding.flow &&
        candidate.state === finding.state &&
        candidate.viewport === finding.viewport &&
        candidate.colorScheme === finding.colorScheme &&
        candidate.commit === finding.commit
      );
    }),
  );
}

async function runsBelow(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => join(root, entry.name));
}

async function validateBaseline(
  runDirectory: string,
  findings: Finding[],
): Promise<string> {
  const resolved = resolve(runDirectory);
  const stored = await findingsAt(resolved);
  if (stored === undefined)
    throw new IdiomError(`baseline capture has no findings.json: ${resolved}`);
  if (!matchesAll(stored, findings))
    throw new IdiomError(
      `baseline capture ${resolved} does not contain every embedded finding id and fingerprint`,
    );
  return resolved;
}

export async function resolveBaseline(options: {
  projectDirectory: string;
  findings: Finding[];
  against?: string | undefined;
  gitTopology?: GitTopology | undefined;
}): Promise<{ runDirectory: string; searchedRoots: string[] }> {
  const currentRoot = resolve(options.projectDirectory, ".idiom", "reports");
  if (options.against !== undefined) {
    const projectRelative = resolve(options.projectDirectory, options.against);
    const directoryLike =
      isAbsolute(options.against) ||
      options.against.includes("/") ||
      options.against.includes("\\") ||
      (await exists(projectRelative));
    if (directoryLike)
      return {
        runDirectory: await validateBaseline(projectRelative, options.findings),
        searchedRoots: [currentRoot],
      };
  }
  const primary = await (options.gitTopology ?? primaryCheckout)(
    options.projectDirectory,
  );
  const roots = [
    currentRoot,
    ...(primary === undefined ||
    resolve(primary) === resolve(options.projectDirectory)
      ? []
      : [resolve(primary, ".idiom", "reports")]),
  ];
  if (options.against !== undefined) {
    if (
      !SAFE_RUN_ID.test(options.against) ||
      options.against === "." ||
      options.against === ".."
    )
      throw new IdiomError(
        "--against run ID must be path-safe, or provide an explicit capture directory",
      );
    const candidates = roots
      .map((root) => resolve(root, options.against as string))
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .filter((candidate) => {
        const escaped = relative(
          roots.find((root) => candidate.startsWith(root)) ?? "",
          candidate,
        );
        return !escaped.startsWith("..") && !isAbsolute(escaped);
      });
    const existing: string[] = [];
    for (const candidate of candidates)
      if (await exists(candidate)) existing.push(candidate);
    if (existing.length !== 1)
      throw new IdiomError(
        `--against run ${JSON.stringify(options.against)} resolved to ${existing.length} captures across ${roots.join(", ")}`,
      );
    return {
      runDirectory: await validateBaseline(
        existing[0] as string,
        options.findings,
      ),
      searchedRoots: roots,
    };
  }

  const matches: string[] = [];
  for (const root of roots) {
    for (const run of await runsBelow(root)) {
      const candidates = await findingsAt(run);
      if (candidates !== undefined && matchesAll(candidates, options.findings))
        matches.push(run);
    }
  }
  const unique = [...new Set(matches.map((match) => resolve(match)))];
  if (unique.length !== 1)
    throw new IdiomError(
      `found ${unique.length} baseline captures matching every embedded finding across ${roots.join(", ")}; retain or copy the original capture and pass its directory with --against`,
    );
  return { runDirectory: unique[0] as string, searchedRoots: roots };
}
