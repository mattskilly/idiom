import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { IDIOM_PACKAGE_ROOT, IDIOM_VERSION, SEMVER } from "../version.js";

/**
 * Tells people a newer Idiom exists. Read-only and silent: every failure
 * (offline, timeout, odd registry answer) is no notice, never a warning, and
 * nothing here writes to stdout or stderr — callers render the line.
 */

export type InstallKind =
  | "npm-global"
  | "bun-global"
  | "npx"
  | "bunx"
  | "claude-plugin"
  | "codex-plugin"
  | "source"
  | "unknown";

export type UpdateNotice = { current: string; latest: string; command: string };

export type Environment = Record<string, string | undefined>;

/** The MCP client that started this process, from its `clientInfo`. */
export type UpdateClient = { name?: string | undefined };

/** Schedules `callback` after `ms`; returns a cancel function. */
export type UpdateTimer = (callback: () => void, ms: number) => () => void;

const defaultTimer: UpdateTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export type UpdateCheckDependencies = {
  env?: Environment | undefined;
  now?: (() => number) | undefined;
  fetch?: typeof fetch | undefined;
  cacheDirectory?: string | undefined;
  packageRoot?: string | undefined;
  currentVersion?: string | undefined;
  deadlineMs?: number | undefined;
  setTimer?: UpdateTimer | undefined;
};

export type UpdateCheckOptions = UpdateCheckDependencies & {
  project?: string | undefined;
  cwd?: string | undefined;
  client?: UpdateClient | undefined;
};

export const UPDATE_CHECK_DEADLINE_MS = 3000;
/** `idiom upgrade` asked for the check directly, so it waits longer than a notice. */
export const UPGRADE_CHECK_DEADLINE_MS = 10_000;
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
// A failed probe is remembered for an hour so an offline machine does not pay
// the deadline on every command.
export const UPDATE_CHECK_FAILURE_TTL_MS = 60 * 60 * 1000;
export const PACKAGE_NAME = "@mattskilly/idiom";
const RELEASE_TARBALL_PREFIX =
  "https://github.com/mattskilly/idiom/releases/download/";
const CACHE_FILE = "update-check.json";
/** Codex's MCP `clientInfo.name` (openai/codex codex-rs/codex-mcp/src/rmcp_client.rs). */
export const CODEX_MCP_CLIENT = "codex-mcp-client";

const enabled = (value: string | undefined): boolean =>
  value !== undefined &&
  value.trim() !== "" &&
  !["0", "false"].includes(value.trim().toLowerCase());

/** Any off switch: env (`IDIOM_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, `CI`) or `"updateCheck": false`. */
export async function updateCheckDisabled(
  env: Environment,
  projectDirectory: string | undefined,
): Promise<boolean> {
  if (enabled(env.IDIOM_NO_UPDATE_CHECK)) return true;
  if ((env.NO_UPDATE_NOTIFIER ?? "").trim() !== "") return true;
  if (enabled(env.CI)) return true;
  if (projectDirectory === undefined) return false;
  try {
    // Raw read on purpose: an invalid project must not break or delay the check.
    const project = JSON.parse(
      await readFile(join(projectDirectory, ".idiom", "project.json"), "utf8"),
    ) as { updateCheck?: unknown } | null;
    return project?.updateCheck === false;
  } catch {
    return false;
  }
}

async function projectDirectoryFor(
  options: UpdateCheckOptions,
): Promise<string | undefined> {
  try {
    return await findOptionalProjectDirectory(
      resolveProjectArgument(options.project, options.cwd),
    );
  } catch {
    return undefined;
  }
}

function releaseSpec(npxRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(npxRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown> };
    const spec = manifest.dependencies?.[PACKAGE_NAME];
    return typeof spec === "string" ? spec : undefined;
  } catch {
    return undefined;
  }
}

/** The package root with symlinks resolved, as install detection sees it. */
export function resolvedRoot(packageRoot: string): string {
  let root = packageRoot;
  try {
    root = realpathSync(packageRoot);
  } catch {}
  return root;
}

const normalized = (root: string): string =>
  root.replaceAll("\\", "/").replace(/\/+$/, "");

/** True when the root is an `_npx` cache entry installed from a release tarball. */
function releaseTarballNpx(path: string): boolean | undefined {
  const npx = /^(.*\/_npx\/[^/]+)\//.exec(path);
  if (npx?.[1] === undefined) return undefined;
  return releaseSpec(npx[1])?.startsWith(RELEASE_TARBALL_PREFIX) ?? false;
}

/**
 * A release-tarball npx root without the Claude marker: the Codex plugin or a
 * hand-run `npx --package=<tarball>`, told apart only by the MCP client.
 */
export function ambiguousPluginInstall(
  packageRoot: string,
  env: Environment,
): boolean {
  return (
    releaseTarballNpx(normalized(resolvedRoot(packageRoot))) === true &&
    !enabled(env.CLAUDE_PLUGIN_ROOT)
  );
}

/** Install kind from the package root's location; source checkouts never check. */
export function detectInstall(
  packageRoot: string,
  env: Environment,
  client?: UpdateClient | undefined,
): InstallKind {
  const root = resolvedRoot(packageRoot);
  // Published tarballs ship neither (package.json `files`).
  if (existsSync(join(root, "src", "cli.ts")) || existsSync(join(root, ".git")))
    return "source";
  const path = normalized(root);
  const tarball = releaseTarballNpx(path);
  if (tarball !== undefined) {
    if (!tarball) return "npx";
    // Claude Code exports CLAUDE_PLUGIN_ROOT to plugin MCP stdio servers.
    if (enabled(env.CLAUDE_PLUGIN_ROOT)) return "claude-plugin";
    // Codex sets no env marker on MCP processes (its stdio launcher passes
    // only default variables); it identifies itself by clientInfo instead.
    // Anything else, including a hand-run tarball npx, is an npx install.
    return client?.name === CODEX_MCP_CLIENT ? "codex-plugin" : "npx";
  }
  // bunx runs from bun's install cache (observed on macOS:
  // ~/.bun/install/cache/@mattskilly/idiom@0.16.1@@@1) or from a
  // bunx-<uid>-<spec> temp install.
  if (
    new RegExp(`/\\.bun/install/cache/${PACKAGE_NAME}@[^/]+$`).test(path) ||
    new RegExp(`/bunx-[^/]+(?:/[^/]+)*/node_modules/${PACKAGE_NAME}$`).test(
      path,
    )
  )
    return "bunx";
  if (path.endsWith(`/.bun/install/global/node_modules/${PACKAGE_NAME}`))
    return "bun-global";
  if (
    path.endsWith(`/lib/node_modules/${PACKAGE_NAME}`) ||
    path.endsWith(`/npm/node_modules/${PACKAGE_NAME}`)
  )
    return "npm-global";
  return "unknown";
}

/** The exact command that updates this install kind to `latest`. */
export function updateCommand(
  kind: Exclude<InstallKind, "source" | "unknown">,
  latest: string,
): string {
  switch (kind) {
    // `idiom upgrade` installs the new CLI itself for these two kinds.
    case "npm-global":
    case "bun-global":
      return "idiom upgrade";
    case "npx":
      return `npx -y ${PACKAGE_NAME}@latest upgrade`;
    case "bunx":
      return `bunx ${PACKAGE_NAME}@latest upgrade`;
    case "claude-plugin":
      return "claude plugin marketplace update idiom && claude plugin update idiom@idiom";
    case "codex-plugin":
      return `codex plugin marketplace upgrade idiom && codex plugin add idiom@idiom && codex mcp add idiom -- npx -y --package=${RELEASE_TARBALL_PREFIX}v${latest}/mattskilly-idiom-${latest}.tgz idiom mcp`;
  }
}

/** `<registry>/@mattskilly%2fidiom/latest`, honouring `NPM_CONFIG_REGISTRY`. */
export function registryLatestUrl(env: Environment): string {
  const configured = [env.NPM_CONFIG_REGISTRY, env.npm_config_registry]
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value !== "");
  const base = (configured ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  return `${base}/${PACKAGE_NAME.replace("/", "%2f")}/latest`;
}

async function fetchLatest(
  url: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  version: string,
): Promise<string | undefined> {
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": `idiom/${version} (node ${process.version}; ${process.platform})`,
      },
      signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown } | null;
    return typeof body?.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

function parts(version: string) {
  if (!SEMVER.test(version)) return undefined;
  const [core = "", prerelease] = (version.split("+")[0] ?? "").split(/-(.*)/s);
  const [major, minor, patch] = core.split(".").map(Number);
  return {
    triple: [major ?? 0, minor ?? 0, patch ?? 0],
    prerelease: prerelease !== undefined,
  };
}

/** A stable `latest` strictly greater than `current`; prereleases never notify. */
export function isNewer(latest: string, current: string): boolean {
  const next = parts(latest);
  const now = parts(current);
  if (next === undefined || now === undefined || next.prerelease) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = next.triple[index] ?? 0;
    const b = now.triple[index] ?? 0;
    if (a !== b) return a > b;
  }
  return now.prerelease;
}

export function updateCacheDirectory(env: Environment): string {
  if (env.XDG_CACHE_HOME?.trim()) return join(env.XDG_CACHE_HOME, "idiom");
  if (process.platform === "win32" && env.LOCALAPPDATA?.trim())
    return join(env.LOCALAPPDATA, "idiom");
  return join(homedir(), ".cache", "idiom");
}

type CacheRecord = {
  checkedAt: number;
  registry: string;
  latest: string | null;
};

async function readCache(
  directory: string,
  registry: string,
  now: number,
): Promise<CacheRecord | undefined> {
  try {
    const record = JSON.parse(
      await readFile(join(directory, CACHE_FILE), "utf8"),
    ) as Partial<CacheRecord> | null;
    if (
      typeof record?.checkedAt !== "number" ||
      record.registry !== registry ||
      (record.latest !== null && typeof record.latest !== "string")
    )
      return undefined;
    const ttl =
      record.latest === null
        ? UPDATE_CHECK_FAILURE_TTL_MS
        : UPDATE_CHECK_TTL_MS;
    const age = now - record.checkedAt;
    return age >= 0 && age < ttl ? (record as CacheRecord) : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(
  directory: string,
  record: CacheRecord,
): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${CACHE_FILE}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record)}\n`);
    await rename(temporary, join(directory, CACHE_FILE));
  } catch {}
}

type Eligible = {
  kind: Exclude<InstallKind, "source" | "unknown">;
  env: Environment;
  current: string;
  registry: string;
  cacheDirectory: string;
  now: number;
};

/** Off switches and install kind; undefined means never check. */
async function eligibility(
  options: UpdateCheckOptions,
): Promise<Eligible | undefined> {
  const env = options.env ?? process.env;
  if (await updateCheckDisabled(env, await projectDirectoryFor(options)))
    return undefined;
  const kind = detectInstall(
    options.packageRoot ?? IDIOM_PACKAGE_ROOT,
    env,
    options.client,
  );
  if (kind === "source" || kind === "unknown") return undefined;
  return {
    kind,
    env,
    current: options.currentVersion ?? IDIOM_VERSION,
    registry: registryLatestUrl(env),
    cacheDirectory: options.cacheDirectory ?? updateCacheDirectory(env),
    now: (options.now ?? Date.now)(),
  };
}

function noticeFor(
  eligible: Eligible,
  latest: string | null,
): UpdateNotice | undefined {
  if (latest === null || !isNewer(latest, eligible.current)) return undefined;
  return {
    current: eligible.current,
    latest,
    command: updateCommand(eligible.kind, latest),
  };
}

/** Cache-only read. `fresh` means no network check is needed. */
export async function readCachedUpdate(
  options: UpdateCheckOptions = {},
): Promise<{ fresh: boolean; notice?: UpdateNotice | undefined }> {
  try {
    const eligible = await eligibility(options);
    if (eligible === undefined) return { fresh: true };
    const cached = await readCache(
      eligible.cacheDirectory,
      eligible.registry,
      eligible.now,
    );
    if (cached === undefined) return { fresh: false };
    return { fresh: true, notice: noticeFor(eligible, cached.latest) };
  } catch {
    return { fresh: false };
  }
}

/**
 * Never rejects and writes nothing to stdio. The deadline bounds the registry
 * fetch; a timed-out probe still records its backoff, and that local write
 * finishes before this settles, so nothing is left writing after a command.
 */
export async function checkForUpdate(
  options: UpdateCheckOptions = {},
): Promise<UpdateNotice | undefined> {
  try {
    const eligible = await eligibility(options);
    if (eligible === undefined) return undefined;
    const cached = await readCache(
      eligible.cacheDirectory,
      eligible.registry,
      eligible.now,
    );
    if (cached !== undefined) return noticeFor(eligible, cached.latest);
    const latest =
      (await fetchLatestRelease({
        env: eligible.env,
        current: eligible.current,
        cacheDirectory: eligible.cacheDirectory,
        now: eligible.now,
        fetch: options.fetch,
        setTimer: options.setTimer,
        deadlineMs: options.deadlineMs,
      })) ?? null;
    return noticeFor(eligible, latest);
  } catch {
    return undefined;
  }
}

/**
 * One registry read of `latest`, bounded by the deadline, skipping the cache
 * read. Never rejects; always records the answer (`null` on failure) so the
 * notice's backoff and freshness stay in step, and that write finishes first.
 */
export async function fetchLatestRelease(options: {
  env: Environment;
  current: string;
  cacheDirectory: string;
  now: number;
  fetch?: typeof fetch | undefined;
  setTimer?: UpdateTimer | undefined;
  deadlineMs?: number | undefined;
}): Promise<string | undefined> {
  const controller = new AbortController();
  let cancel: (() => void) | undefined;
  try {
    const registry = registryLatestUrl(options.env);
    const deadline = new Promise<undefined>((resolve) => {
      cancel = (options.setTimer ?? defaultTimer)(() => {
        controller.abort();
        resolve(undefined);
      }, options.deadlineMs ?? UPDATE_CHECK_DEADLINE_MS);
    });
    const latest = await Promise.race([
      fetchLatest(
        registry,
        options.fetch ?? fetch,
        controller.signal,
        options.current,
      ),
      deadline,
    ]);
    await writeCache(options.cacheDirectory, {
      checkedAt: options.now,
      registry,
      latest: latest ?? null,
    });
    return latest;
  } catch {
    return undefined;
  } finally {
    cancel?.();
  }
}

export function renderUpdateNotice(notice: UpdateNotice): string {
  return `Idiom ${notice.latest} is available (you have ${notice.current}). Update: ${notice.command}`;
}

export type UpdateNoticeSession = {
  /** The notice line for MCP initialize instructions, when already cached. */
  instructions(): string | undefined;
  /** The notice once per session, unless instructions already carried it. */
  take(client?: UpdateClient | undefined): Promise<UpdateNotice | undefined>;
  /** Resolves once the background refresh, cache write included, finished. */
  settled(): Promise<void>;
};

/** One delivery per MCP server session; a stale cache refreshes in the background. */
export async function createUpdateNoticeSession(
  options: UpdateCheckOptions = {},
): Promise<UpdateNoticeSession> {
  const cached = await readCachedUpdate(options);
  const pending = cached.fresh
    ? Promise.resolve(cached.notice)
    : checkForUpdate(options);
  const env = options.env ?? process.env;
  const packageRoot = options.packageRoot ?? IDIOM_PACKAGE_ROOT;
  // Initialize instructions are built before clientInfo arrives, so an install
  // whose command depends on the client waits for the first tool result.
  let ambiguous = false;
  try {
    ambiguous = ambiguousPluginInstall(packageRoot, env);
  } catch {}
  let delivered: "instructions" | "result" | undefined;
  return {
    instructions() {
      if (ambiguous || cached.notice === undefined || delivered === "result")
        return undefined;
      delivered = "instructions";
      return renderUpdateNotice(cached.notice);
    },
    async take(client) {
      if (delivered !== undefined) return undefined;
      const notice = await pending;
      if (notice === undefined || delivered !== undefined) return undefined;
      delivered = "result";
      if (!ambiguous) return notice;
      const kind = detectInstall(packageRoot, env, client);
      return kind === "source" || kind === "unknown"
        ? notice
        : { ...notice, command: updateCommand(kind, notice.latest) };
    },
    settled: () =>
      pending.then(
        () => undefined,
        () => undefined,
      ),
  };
}
