import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { globRegex } from "../../plugins/claude/hooks/lib.mjs";
import { IdiomError } from "../errors.js";
import { findProjectDirectory, resolveProjectArgument } from "../project.js";
import { projectSchema } from "../schemas/project.js";
import { validateProject } from "../validation.js";
import { Deadline } from "./deadline.js";
import type { CaptureExecutionContext } from "./execution-context.js";
import { runOwnedCommand } from "./process.js";
import { assertContainedPath } from "./production-cache.js";
import type { CaptureDependencies } from "./run.js";

const exec = promisify(execFile);
const exists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Select only commands from committed metadata; never share caller dependencies. */
export async function dependencyInstall(
  project: string,
  root: string,
): Promise<{ cwd: string; command: string } | undefined> {
  const candidates: Array<{ cwd: string; manifest: Record<string, unknown> }> =
    [];
  for (let cwd = project; ; cwd = dirname(cwd)) {
    const manifest = await readFile(join(cwd, "package.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw new IdiomError(
          `ref dependency preparation: cannot read ${join(cwd, "package.json")}: ${String(error)}`,
        );
      });
    if (manifest) candidates.push({ cwd, manifest });
    if (cwd === root) break;
    if (relative(root, cwd).startsWith(".."))
      throw new IdiomError("ref project must remain inside the worktree");
  }
  if (!candidates.length) return undefined;
  let selected = candidates[0] as (typeof candidates)[number];
  for (const candidate of candidates) {
    if (
      candidate.manifest.workspaces ||
      (await exists(join(candidate.cwd, "pnpm-workspace.yaml")))
    )
      selected = candidate;
  }
  // A nested package may use an ancestor lockfile without a workspaces field.
  for (const candidate of candidates) {
    if (
      (
        await Promise.all(
          [
            "bun.lock",
            "bun.lockb",
            "pnpm-lock.yaml",
            "package-lock.json",
            "npm-shrinkwrap.json",
            "yarn.lock",
          ].map((file) => exists(join(candidate.cwd, file))),
        )
      ).some(Boolean)
    )
      selected = candidate;
  }
  const manifests = candidates.map(({ manifest }) => manifest);
  if (
    selected.manifest.workspaces ||
    (await exists(join(selected.cwd, "pnpm-workspace.yaml")))
  ) {
    // Include committed workspace members even when the root has no dependencies.
    const paths = (
      await exec("git", ["ls-files", "-z", "--", "**/package.json"], {
        cwd: root,
      })
    ).stdout
      .split("\0")
      .filter(Boolean);
    const workspaceConfig = selected.manifest.workspaces;
    const patterns = Array.isArray(workspaceConfig)
      ? workspaceConfig
      : (workspaceConfig as { packages?: string[] } | undefined)?.packages;
    for (const path of paths) {
      const local = relative(selected.cwd, join(root, path)).replaceAll(
        "\\",
        "/",
      );
      if (
        local.startsWith("../") ||
        (patterns &&
          !patterns.some((pattern) =>
            globRegex(`${pattern.replace(/\/$/, "")}/package.json`).test(local),
          ))
      )
        continue;
      manifests.push(JSON.parse(await readFile(join(root, path), "utf8")));
    }
  }
  const hasDependencies = manifests.some((manifest) =>
    ["dependencies", "devDependencies", "optionalDependencies"].some(
      (field) => Object.keys((manifest[field] ?? {}) as object).length > 0,
    ),
  );
  if (!hasDependencies) return undefined;
  const cwd = selected.cwd;
  const manager = String(selected.manifest.packageManager ?? "");
  const bun =
    (await exists(join(cwd, "bun.lock"))) ||
    (await exists(join(cwd, "bun.lockb")));
  const pnpm = await exists(join(cwd, "pnpm-lock.yaml"));
  const npm =
    (await exists(join(cwd, "package-lock.json"))) ||
    (await exists(join(cwd, "npm-shrinkwrap.json")));
  const yarn = await exists(join(cwd, "yarn.lock"));
  let command: string;
  if (bun && (!manager || manager.startsWith("bun@")))
    command = "bun install --frozen-lockfile";
  else if (pnpm && (!manager || manager.startsWith("pnpm@")))
    command = "pnpm install --frozen-lockfile";
  else if (npm && (!manager || manager.startsWith("npm@"))) command = "npm ci";
  else if (yarn && (!manager || manager.startsWith("yarn@"))) {
    const modern = manager
      ? !manager.startsWith("yarn@1.")
      : (await readFile(join(cwd, "yarn.lock"), "utf8")).includes(
          "__metadata:",
        );
    command = modern
      ? "yarn install --immutable"
      : "yarn install --frozen-lockfile";
  } else if (!bun && !pnpm && !npm && !yarn)
    command = "npm install --package-lock=false";
  else
    throw new IdiomError(
      `ref dependency preparation: packageManager ${manager} does not match the committed lockfile in ${cwd}; commit a matching lockfile`,
    );
  return { cwd, command };
}

/** Own exactly one detached tree, from preparation through review and baseline work. */
export async function withRefWorktree<T>(
  options: {
    ref: string;
    flow: string;
    project?: string | undefined;
    cwd?: string | undefined;
    dependencies?: CaptureDependencies | undefined;
  },
  work: (context: CaptureExecutionContext) => Promise<T>,
  dependencies: {
    addWorktree?: (root: string, tree: string, commit: string) => Promise<void>;
  } = {},
): Promise<T> {
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort(options.dependencies?.signal?.reason);
  const sigint = () =>
    controller.abort(new IdiomError("ref capture interrupted by SIGINT"));
  const sigterm = () =>
    controller.abort(new IdiomError("ref capture interrupted by SIGTERM"));
  options.dependencies?.signal?.addEventListener("abort", abort, {
    once: true,
  });
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);
  if (options.dependencies?.signal?.aborted) abort();
  let parent: string | undefined;
  let tree: string | undefined;
  let state: string | undefined;
  let root: string | undefined;
  let deadline: Deadline | undefined;
  let result: T | undefined;
  let failure: unknown;
  try {
    controller.signal.throwIfAborted();
    state = await realpath(
      await findProjectDirectory(
        resolveProjectArgument(options.project, options.cwd),
      ),
    );
    root = await realpath(
      (
        await exec("git", ["rev-parse", "--show-toplevel"], { cwd: state })
      ).stdout.trim(),
    );
    let commit: string;
    try {
      commit = (
        await exec(
          "git",
          [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${options.ref}^{commit}`,
          ],
          { cwd: root },
        )
      ).stdout.trim();
    } catch {
      throw new IdiomError(
        `cannot resolve --ref ${JSON.stringify(options.ref)} to a local commit; fetch the missing history and retry`,
      );
    }
    // Read the committed budget before allocating resources. The later full
    // validation still checks that revision's configuration and named flow.
    let maxMinutes: number;
    try {
      const path = join(
        relative(root, state),
        ".idiom/project.json",
      ).replaceAll("\\", "/");
      const content = (
        await exec("git", ["show", `${commit}:${path}`], { cwd: root })
      ).stdout;
      maxMinutes = projectSchema.parse(JSON.parse(content)).capture.maxMinutes;
    } catch (error) {
      throw new IdiomError(
        `--ref ${options.ref} has no valid committed .idiom/project.json at ${relative(root, state) || "repository root"}: ${String(error)}`,
      );
    }
    const remaining = maxMinutes * 60_000 - (Date.now() - started);
    if (remaining <= 0)
      throw new IdiomError(
        `Capture exceeded capture.maxMinutes=${maxMinutes} during ref preparation`,
      );
    deadline = new Deadline(
      "capture",
      remaining,
      () => "ref preparation/capture",
      { signal: controller.signal },
    );
    const expire = () =>
      controller.abort(
        new IdiomError(
          `Capture exceeded capture.maxMinutes=${maxMinutes} during ref preparation/capture`,
        ),
      );
    deadline.signal.addEventListener("abort", expire, { once: true });
    const cache = join(state, ".idiom/cache/worktrees");
    await assertContainedPath(state, cache);
    await mkdir(cache, { recursive: true });
    parent = await mkdtemp(join(cache, "capture-"));
    tree = join(parent, "source");
    await assertContainedPath(state, tree);
    controller.signal.throwIfAborted();
    // Await creation even after cancellation: cleanup must see late registrations.
    if (dependencies.addWorktree)
      await dependencies.addWorktree(root, tree, commit);
    else
      await runOwnedCommand({
        command: "git",
        args: ["worktree", "add", "--detach", tree, commit],
        cwd: root,
        label: "ref worktree creation",
        signal: controller.signal,
        environment: options.dependencies?.inheritedEnvironment,
        dependencies: {
          teardownTimeoutMs: options.dependencies?.process?.teardownTimeoutMs,
        },
      });
    controller.signal.throwIfAborted();
    const source = join(tree, relative(root, state));
    if (!(await exists(join(source, ".idiom/project.json"))))
      throw new IdiomError(
        `--ref ${options.ref} has no .idiom/project.json at ${relative(root, state) || "repository root"}; choose a revision with committed project configuration`,
      );
    let validated: Awaited<ReturnType<typeof validateProject>>;
    try {
      validated = await validateProject({
        project: source,
        flow: options.flow,
      });
    } catch (error) {
      throw new IdiomError(
        `--ref ${options.ref} configuration/flow validation failed: ${String(error)}`,
      );
    }
    validated.stateProjectDirectory = state;
    // Owned servers and builds are mandatory in a fresh detached tree.
    validated.project.server.reuse = false;
    if (validated.project.server.production)
      validated.project.server.production.reuseBuild = false;
    const install = await dependencyInstall(source, tree);
    controller.signal.throwIfAborted();
    if (install) {
      try {
        await runOwnedCommand({
          ...install,
          label: "ref dependency installation",
          signal: controller.signal,
          dependencies: options.dependencies?.process,
          environment: options.dependencies?.inheritedEnvironment,
        });
      } catch (error) {
        throw new IdiomError(
          `ref dependency installation failed: ${String(error)}; install the package-manager executable and ensure the committed lockfile can be installed`,
        );
      }
    }
    controller.signal.throwIfAborted();
    result = await work({
      sourceProjectDirectory: source,
      stateProjectDirectory: state,
      commit,
      validated,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
  } catch (error) {
    failure = error;
  } finally {
    // Inner capture has joined owned processes before this exact-path cleanup.
    try {
      if (state && tree && root) {
        await assertContainedPath(state, tree);
        const registrations = (
          await exec("git", ["worktree", "list", "--porcelain", "-z"], {
            cwd: root,
          })
        ).stdout;
        if (registrations.split("\0").includes(`worktree ${tree}`))
          await exec("git", ["worktree", "remove", "--force", tree], {
            cwd: root,
          });
      }
      if (parent && state) {
        await assertContainedPath(state, parent);
        await rm(parent, { recursive: true, force: true });
      }
    } catch (cleanup) {
      failure = new IdiomError(
        `${failure === undefined ? "ref capture cleanup failed" : String(failure)}; worktree cleanup failed: ${String(cleanup)}`,
      );
    }
    deadline?.dispose();
    options.dependencies?.signal?.removeEventListener("abort", abort);
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
  if (failure !== undefined) throw failure;
  return result as T;
}
