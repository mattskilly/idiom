import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { readGit } from "../changed/git.js";
import { inspect } from "../skills/paths.js";
import { AUTOBUILD_SKILLS } from "./autobuild-skills.js";
import type {
  DetectionDependencies,
  Signal,
  WiringDetection,
} from "./types.js";

export const SIGNAL_PATHS = [
  "autobuild.toml",
  ".github/workflows",
  ".husky",
  "lefthook.yml",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursor",
  ".cursor/rules/idiom.mdc",
  ".github/workflows/idiom.yml",
  ".husky/pre-push",
  ...AUTOBUILD_SKILLS.map((target) => target.path),
] as const;

export async function executableOnPath(
  name: string,
  dependencies: DetectionDependencies = {},
): Promise<boolean> {
  const environment = dependencies.environment ?? process.env;
  const windows = (dependencies.platform ?? process.platform) === "win32";
  const pathValue =
    Object.entries(environment).find(([key]) =>
      windows ? key.toUpperCase() === "PATH" : key === "PATH",
    )?.[1] ?? "";
  const extensions = windows
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const executable =
    dependencies.executable ??
    (async (path: string) => {
      try {
        await access(path, windows ? constants.F_OK : constants.X_OK);
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    });
  for (const directory of pathValue.split(windows ? ";" : ":").filter(Boolean))
    for (const extension of extensions)
      if (
        await executable(
          (windows ? win32 : posix).join(directory, name + extension),
        )
      )
        return true;
  return false;
}

/** No processes except read-only Git; never probes an agent's usability. */
export async function detectWiring(
  root: string,
  dependencies: DetectionDependencies = {},
): Promise<WiringDetection> {
  const signals: Record<string, Signal> = {};
  for (const path of SIGNAL_PATHS) {
    try {
      const value = await inspect(root, path);
      signals[path] = { detected: value.kind !== "absent", entry: value };
    } catch (error) {
      signals[path] = { detected: true, reason: (error as Error).message };
    }
  }
  const detection: WiringDetection = {
    signals,
    agents: {
      claude: await executableOnPath("claude", dependencies),
      codex: await executableOnPath("codex", dependencies),
    },
    branchReason:
      "No local remote default-branch hint; other push branches create skipped runs.",
  };
  const git = dependencies.git ?? readGit;
  try {
    const refs = (
      await git(root, ["for-each-ref", "--format=%(refname)", "refs/remotes"])
    )
      .trim()
      .split("\n")
      .filter((ref) => /^refs\/remotes\/[^/]+\/HEAD$/.test(ref))
      .sort(
        (a, b) =>
          Number(b.startsWith("refs/remotes/origin/")) -
            Number(a.startsWith("refs/remotes/origin/")) || a.localeCompare(b),
      );
    for (const ref of refs) {
      const target = (await git(root, ["symbolic-ref", "--quiet", ref])).trim();
      const prefix = ref.slice(0, -4);
      if (target.startsWith(prefix) && target.slice(prefix.length)) {
        detection.defaultBranch = target.slice(prefix.length);
        detection.branchReason = `Default branch from local ${ref}.`;
        break;
      }
    }
  } catch {
    /* Not a Git repo or no symbolic remote HEAD; instructions still work. */
  }
  try {
    const manifest = await inspect(root, "package.json");
    if (manifest.kind !== "file") throw new Error("no regular package.json");
    const value = JSON.parse(manifest.content) as { packageManager?: unknown };
    const declared =
      typeof value.packageManager === "string"
        ? /^(bun|pnpm|yarn|npm)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+sha\d+\.[a-fA-F0-9]+)?$/.exec(
            value.packageManager,
          )
        : undefined;
    if (value.packageManager !== undefined && !declared)
      throw new Error("unsupported packageManager field");
    let manager = declared?.[1] as
      | NonNullable<WiringDetection["setup"]>["manager"]
      | undefined;
    let locked = false;
    for (const [path, candidate] of [
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["npm-shrinkwrap.json", "npm"],
    ] as const) {
      if (
        (await inspect(root, path)).kind === "file" &&
        (!manager || manager === candidate)
      ) {
        manager = candidate;
        locked = true;
        break;
      }
    }
    if (!manager) manager = "npm";
    const version = declared?.[2];
    const command =
      manager === "bun"
        ? `bun install${locked ? " --frozen-lockfile" : ""}`
        : manager === "pnpm"
          ? `pnpm install${locked ? " --frozen-lockfile" : ""}`
          : manager === "yarn"
            ? `yarn install${locked ? (!version || Number(version.split(".")[0]) === 1 ? " --frozen-lockfile" : " --immutable") : ""}`
            : locked
              ? "npm ci"
              : "npm install";
    detection.setup = { manager, command, ...(version ? { version } : {}) };
  } catch (error) {
    detection.setupReason = `Cannot determine dependency setup: ${(error as Error).message}. Add package.json/packageManager and rerun idiom init --wire.`;
  }
  return detection;
}

/** Bounded facts only: never expose config contents, paths to executables or environment. */
export function wiringFacts(detection: WiringDetection): {
  found: string[];
  agents: WiringDetection["agents"];
  branchReason: string;
} {
  return {
    found: Object.entries(detection.signals)
      .filter(([, signal]) => signal.detected)
      .map(
        ([path, signal]) =>
          `${path}${signal.reason || (signal.entry && !["file", "directory"].includes(signal.entry.kind)) ? " (protected)" : ""}`,
      ),
    agents: detection.agents,
    branchReason: detection.branchReason,
  };
}
