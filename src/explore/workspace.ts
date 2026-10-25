import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { IdiomError } from "../errors.js";
import type { ExplorationEdit } from "../schemas/exploration.js";

const execFileAsync = promisify(execFile);
const EVIDENCE = ".idiom-explore-evidence";
const EXCLUDED_ROOTS = new Set([".git", "node_modules/.cache"]);
const SECRET_NAME =
  /^(?:\.env(?:\..*)?|.*(?:credentials?|secrets?|private[-_.]?key).*)$/i;
const TOKEN_SECRET_NAME =
  /^(?:token(?:[-_.].*)?|.*\.token|.*[-_.]token(?:[-_.].*)?|(?:access|api|auth|bearer|refresh|session|service)[-_.]?tokens?(?:[-_.].*)?)$/i;
const DESIGN_TOKEN_NAME =
  /^design[-_.]?tokens?(?:\.(?:css|pcss|scss|sass|less|styl|[cm]?[jt]sx?|json))?$/i;

function secretName(name: string): boolean {
  return (
    SECRET_NAME.test(name) ||
    (!DESIGN_TOKEN_NAME.test(name) && TOKEN_SECRET_NAME.test(name))
  );
}

function excludedRuntime(path: string): boolean {
  const normalized = path.split(sep).join("/");
  return (
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".idiom/reports" ||
    normalized.startsWith(".idiom/reports/") ||
    normalized === ".autobuild/worktrees" ||
    normalized.startsWith(".autobuild/worktrees/")
  );
}

function excludedMirror(path: string): boolean {
  const normalized = path.split(sep).join("/");
  const parts = normalized.split("/");
  return (
    excludedRuntime(normalized) ||
    normalized === EVIDENCE ||
    normalized.startsWith(`${EVIDENCE}/`) ||
    parts.some(secretName) ||
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes("build") ||
    normalized.startsWith(".autobuild/tickets/")
  );
}

async function reflink(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE);
  } catch {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

async function copyTree(
  source: string,
  target: string,
  root = source,
): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const relativePath = relative(root, from);
    if (excludedRuntime(relativePath) || EXCLUDED_ROOTS.has(relativePath))
      continue;
    const to = join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, root);
    else if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
    else if (entry.isFile()) await reflink(from, to);
  }
}

async function trackedFiles(projectDirectory: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: projectDirectory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch (error) {
    throw new IdiomError(
      `cannot enumerate source files for exploration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function makeMirror(
  projectDirectory: string,
  directory: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const path of await trackedFiles(projectDirectory)) {
    if (excludedMirror(path)) continue;
    const source = join(projectDirectory, path);
    const status = await lstat(source);
    if (!status.isFile()) continue;
    await reflink(source, join(directory, path));
  }
}

function assertEditPath(path: string): void {
  if (
    path === "" ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    excludedMirror(path)
  )
    throw new IdiomError(
      `unsafe exploration edit path ${JSON.stringify(path)}`,
    );
}

async function containedRegular(root: string, path: string): Promise<string> {
  assertEditPath(path);
  const realRoot = await realpath(root);
  const target = resolve(realRoot, path);
  let status: Stats;
  try {
    status = await lstat(target);
  } catch {
    throw new IdiomError(`exploration edit target does not exist: ${path}`);
  }
  if (!status.isFile() || status.isSymbolicLink())
    throw new IdiomError(
      `exploration edit target is not a regular file: ${path}`,
    );
  const realTarget = await realpath(target);
  const escaped = relative(realRoot, realTarget);
  if (isAbsolute(escaped) || escaped === ".." || escaped.startsWith(`..${sep}`))
    throw new IdiomError(
      `exploration edit target escapes its workspace: ${path}`,
    );
  return realTarget;
}

async function atomicReplace(path: string, source: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.idiom-${process.pid}-${Date.now()}`,
  );
  await writeFile(temporary, source, "utf8");
  await rename(temporary, path);
}

export async function readExplorationEditSources(options: {
  mirrorDirectory: string;
  edits: ExplorationEdit[];
}): Promise<Array<{ path: string; source: string }>> {
  return Promise.all(
    options.edits.map(async (edit) => ({
      path: edit.path,
      source: await readFile(
        await containedRegular(options.mirrorDirectory, edit.path),
        "utf8",
      ),
    })),
  );
}

export async function applyExplorationEdits(options: {
  cloneDirectory: string;
  mirrorDirectory: string;
  edits: ExplorationEdit[];
}): Promise<void> {
  const seen = new Set<string>();
  for (const edit of options.edits) {
    if (seen.has(edit.path))
      throw new IdiomError(`duplicate exploration edit path ${edit.path}`);
    seen.add(edit.path);
    const [clonePath, mirrorPath] = await Promise.all([
      containedRegular(options.cloneDirectory, edit.path),
      containedRegular(options.mirrorDirectory, edit.path),
    ]);
    const [cloneSource, mirrorSource] = await Promise.all([
      readFile(clonePath, "utf8"),
      readFile(mirrorPath, "utf8"),
    ]);
    if (cloneSource !== mirrorSource)
      throw new IdiomError(
        `exploration mirror and runtime clone disagree before editing ${edit.path}`,
      );
    const occurrences = cloneSource.split(edit.oldText).length - 1;
    if (occurrences !== 1)
      throw new IdiomError(
        `exploration edit oldText must occur exactly once in ${edit.path}; found ${occurrences}`,
      );
    const completed = cloneSource.replace(edit.oldText, () => edit.newText);
    await Promise.all([
      atomicReplace(clonePath, completed),
      atomicReplace(mirrorPath, completed),
    ]);
  }
}

export type ExplorationWorkspace = {
  root: string;
  runtimeBase: string;
  mirrorBase: string;
  readablePaths: string[];
  createCandidate(
    label: string,
    bases?: { runtime?: string; mirror?: string },
  ): Promise<{ cloneDirectory: string; mirrorDirectory: string }>;
  stageEvidence(
    paths: string[],
    mirror?: string,
    namespace?: string,
  ): Promise<string[]>;
  cleanup(): Promise<void>;
};

export async function createExplorationWorkspace(
  projectDirectory: string,
): Promise<ExplorationWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "idiom-explore-"));
  const runtimeBase = join(root, "runtime-base");
  const mirrorBase = join(root, "mirror-base");
  let cleanupPromise: Promise<void> | undefined;
  try {
    await copyTree(projectDirectory, runtimeBase);
    await makeMirror(projectDirectory, mirrorBase);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const readablePaths: string[] = [];
  for (const path of await trackedFiles(projectDirectory)) {
    if (excludedMirror(path)) continue;
    const candidate = join(mirrorBase, path);
    try {
      if ((await lstat(candidate)).isFile()) readablePaths.push(candidate);
    } catch {
      // Symlinks and raced/missing files are intentionally absent from the mirror.
    }
  }
  return {
    root,
    runtimeBase,
    mirrorBase,
    readablePaths,
    async createCandidate(label, bases = {}) {
      if (!/^[a-z][a-z0-9-]*$/.test(label))
        throw new IdiomError("unsafe candidate workspace label");
      const cloneDirectory = join(root, `runtime-${label}`);
      const mirrorDirectory = join(root, `mirror-${label}`);
      await copyTree(bases.runtime ?? runtimeBase, cloneDirectory);
      await copyTree(bases.mirror ?? mirrorBase, mirrorDirectory);
      return { cloneDirectory, mirrorDirectory };
    },
    async stageEvidence(paths, mirror = mirrorBase, namespace = "baseline") {
      if (!/^[a-z][a-z0-9-]*$/.test(namespace))
        throw new IdiomError("unsafe exploration evidence namespace");
      const directory = join(mirror, EVIDENCE);
      await mkdir(directory, { recursive: true });
      const staged: string[] = [];
      for (const [index, path] of paths.entries()) {
        const target = join(
          directory,
          `${namespace}-${String(index + 1).padStart(3, "0")}-${basename(path)}`,
        );
        await reflink(path, target);
        staged.push(await realpath(target));
      }
      return staged;
    },
    cleanup() {
      cleanupPromise ??= rm(root, { recursive: true, force: true });
      return cleanupPromise;
    },
  };
}
