// Shared by the standalone Node hooks and the bundled CLI. Node built-ins only.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_UI_GLOBS = [
  ...[
    "jsx",
    "tsx",
    "vue",
    "svelte",
    "astro",
    "css",
    "scss",
    "sass",
    "less",
    "html",
    "mdx",
    "hbs",
    "handlebars",
    "ejs",
    "liquid",
    "pug",
  ].map((ext) => `**/*.${ext}`),
  ...["js", "ts"].flatMap((ext) => [
    `**/components/**/*.${ext}`,
    `**/pages/**/*.${ext}`,
    `**/app/**/page.${ext}`,
    `**/app/**/layout.${ext}`,
  ]),
];
const EXCLUDED = new Set([
  "node_modules",
  ".git",
  ".idiom",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".svelte-kit",
  ".astro",
  ".turbo",
  "vendor",
]);
const MAX_PATHS = 20000;
const MAX_PENDING = 64;
const STATE_VERSION = 1;
const compiledGlobs = new WeakMap();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.replaceAll("\\", "/");
const contained = (root, path) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export function createBudget(ms = 140) {
  const controller = new AbortController();
  const end = performance.now() + ms;
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref();
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, end - performance.now()),
    check() {
      if (performance.now() >= end) controller.abort();
      controller.signal.throwIfAborted();
    },
    close: () => {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

export function validGlob(pattern) {
  return (
    typeof pattern === "string" &&
    pattern.trim().length > 0 &&
    pattern.length <= 512 &&
    !isAbsolute(slash(pattern)) &&
    !/^[A-Za-z]:/.test(pattern) &&
    !slash(pattern).split("/").includes("..") &&
    !/[{}!]/.test(pattern) &&
    !/[@+?*]\(/.test(pattern)
  );
}

export function globRegex(pattern) {
  if (!validGlob(pattern)) throw new Error("unsupported UI glob");
  const source = slash(pattern).replace(/^\.\//, "");
  let expression = "^";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "*" && source[i + 1] === "*") {
      // Globstar is a whole path segment; **/ also matches zero directories.
      if (
        (i === 0 || source[i - 1] === "/") &&
        (source[i + 2] === "/" || i + 2 === source.length)
      ) {
        expression += source[i + 2] === "/" ? "(?:[^/]+/)*" : ".*";
        i += source[i + 2] === "/" ? 2 : 1;
      } else {
        expression += "[^/]*";
        i++;
      }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

export function matchesUI(path, globs = DEFAULT_UI_GLOBS) {
  let patterns = compiledGlobs.get(globs);
  if (!patterns) {
    patterns = globs.map(globRegex);
    compiledGlobs.set(globs, patterns);
  }
  const normalized = slash(path).replace(/^\.\//, "");
  return (
    normalized.length > 0 &&
    !normalized
      .split("/")
      .some((part) => part === ".." || EXCLUDED.has(part)) &&
    patterns.some((pattern) => pattern.test(normalized))
  );
}

async function readSmall(path, budget, max = 262144) {
  budget.check();
  const stat = await fs.stat(path);
  if (!stat.isFile() || stat.size > max)
    throw new Error("hook metadata too large");
  return fs.readFile(path, { encoding: "utf8", signal: budget.signal });
}

async function exists(path) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

export async function resolveContext(cwd, budget) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
  let current = await fs.realpath(cwd);
  let root;
  let tree;
  while (true) {
    budget.check();
    if (!root && (await exists(join(current, ".idiom/project.json"))))
      root = current;
    if (await exists(join(current, ".git"))) {
      tree = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!root) return undefined;
  // State/config symlinks must not escape into another worktree.
  for (const path of [
    join(root, ".idiom"),
    join(root, ".idiom/project.json"),
  ]) {
    if (!contained(root, await fs.realpath(path))) return undefined;
  }
  const project = JSON.parse(
    await readSmall(join(root, ".idiom/project.json"), budget),
  );
  if (
    !project ||
    typeof project !== "object" ||
    Array.isArray(project) ||
    project.version !== 1
  )
    return undefined;
  const agent = project.agent;
  if (
    agent !== undefined &&
    (!agent ||
      typeof agent !== "object" ||
      Array.isArray(agent) ||
      Object.keys(agent).some((key) => !["hooks", "uiGlobs"].includes(key)) ||
      (agent.hooks !== undefined && typeof agent.hooks !== "boolean") ||
      (agent.uiGlobs !== undefined &&
        (!Array.isArray(agent.uiGlobs) || !agent.uiGlobs.every(validGlob))))
  )
    return undefined;
  if (agent?.hooks === false) return undefined;
  const globs = agent?.uiGlobs ?? DEFAULT_UI_GLOBS;
  return {
    root,
    tree: tree ?? root,
    git: tree !== undefined,
    globs,
    identity: hash(JSON.stringify([root, tree ?? root, globs])),
    directory: join(root, ".idiom/agent-hooks"),
  };
}

export async function normalizePath(context, path, budget) {
  budget.check();
  if (typeof path !== "string" || path.length > 4096) return undefined;
  const absolute = resolve(context.root, slash(path));
  // Resolve the nearest existing ancestor too, for deleted files and new paths.
  let ancestor = absolute;
  while (true) {
    budget.check();
    try {
      const canonical = resolve(
        await fs.realpath(ancestor),
        relative(ancestor, absolute),
      );
      if (!contained(context.root, canonical)) return undefined;
      // Preserve in-project symlink names; accept OS aliases such as /var
      // for /private/var when the provider supplies an absolute filename.
      return slash(
        relative(
          context.root,
          contained(context.root, absolute) ? absolute : canonical,
        ),
      );
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      if (dirname(ancestor) === ancestor) return undefined;
      ancestor = dirname(ancestor);
    }
  }
}

async function git(context, args, budget) {
  budget.check();
  return new Promise((accept, reject) => {
    execFile(
      "git",
      ["-C", context.root, ...args],
      {
        signal: budget.signal,
        timeout: Math.max(1, Math.floor(budget.remaining())),
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stderr })) : accept(stdout),
    );
  });
}

async function walk(context, budget) {
  const files = [];
  let visited = 0;
  async function visit(directory) {
    budget.check();
    for await (const entry of await fs.opendir(directory)) {
      budget.check();
      if (++visited > MAX_PATHS) throw new Error("hook tree too large");
      if (EXCLUDED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(slash(relative(context.root, path)));
    }
  }
  await visit(context.root);
  return files;
}

export async function snapshot(
  context,
  budget,
  extra = [],
  scanIgnored = false,
) {
  budget.check();
  let candidates;
  const untracked = new Set();
  if (context.git) {
    const output = await git(
      context,
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "--stage",
        "-z",
        "--",
        ".",
      ],
      budget,
    );
    candidates = output
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        budget.check();
        const tracked = /^\d{6} [a-f0-9]+ [0-3]\t/.exec(line);
        const path = tracked ? line.slice(tracked[0].length) : line;
        if (!tracked) untracked.add(path);
        return path;
      });
  } else candidates = await walk(context, budget);
  const enumerated = new Set(candidates);
  if (context.git && scanIgnored)
    candidates.push(...(await walk(context, budget)));
  candidates = [...new Set([...candidates, ...extra])]
    .filter((path) => {
      budget.check();
      return matchesUI(path, context.globs);
    })
    .sort();
  if (candidates.length > MAX_PATHS) throw new Error("hook tree too large");
  const entries = new Array(candidates.length);
  let next = 0;
  async function worker() {
    while (next < candidates.length) {
      budget.check();
      const index = next++;
      const path = candidates[index];
      const normalized = await normalizePath(context, path, budget);
      if (normalized === undefined) continue;
      const absolute = join(context.root, normalized);
      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
        throw error;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const digest = createHash("sha256");
      if (stat.isSymbolicLink()) digest.update(await fs.readlink(absolute));
      if (stat.size <= 65536) {
        digest.update(await fs.readFile(absolute, { signal: budget.signal }));
      } else {
        // Stream large files instead of blocking the event loop or holding sources.
        for await (const chunk of createReadStream(absolute, {
          signal: budget.signal,
        })) {
          budget.check();
          digest.update(chunk);
        }
      }
      entries[index] = [
        normalized,
        stat.isSymbolicLink() ? "symlink" : "file",
        digest.digest("hex"),
      ];
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(8, candidates.length) }, worker),
  );
  budget.check();
  return {
    digest: hash(JSON.stringify(entries.filter(Boolean))),
    untracked: candidates.some(
      (path, index) => entries[index] && untracked.has(path),
    ),
    ignored: context.git
      ? candidates.filter(
          (path, index) => entries[index] && !enumerated.has(path),
        )
      : [],
  };
}

const freshState = (context) => ({
  version: STATE_VERSION,
  identity: context.identity,
  pending: [],
  sessions: {},
});
export async function readState(context, budget) {
  try {
    if (!contained(context.root, await fs.realpath(context.directory)))
      return freshState(context);
    const state = JSON.parse(
      await readSmall(join(context.directory, "state.json"), budget, 65536),
    );
    if (
      state.version !== STATE_VERSION ||
      state.identity !== context.identity ||
      !Array.isArray(state.pending) ||
      state.pending.length > MAX_PENDING ||
      !state.pending.every(
        (entry) =>
          typeof entry.path === "string" && typeof entry.at === "number",
      ) ||
      !state.sessions ||
      typeof state.sessions !== "object" ||
      Array.isArray(state.sessions) ||
      Object.keys(state.sessions).length > 64 ||
      (state.check !== undefined &&
        (typeof state.check.digest !== "string" ||
          typeof state.check.startedAt !== "number" ||
          typeof state.check.completedAt !== "number" ||
          typeof state.check.id !== "string"))
    )
      return freshState(context);
    return state;
  } catch {
    return freshState(context);
  }
}

// Well above the hook's 140ms work budget and the provider's 2s timeout.
const STALE_LOCK_MS = 5000;
const sameFile = (left, right) =>
  left.dev === right.dev && left.ino === right.ino;

async function acquireLock(path, budget, signal) {
  try {
    return await fs.open(path, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stale = await fs.lstat(path);
  if (!stale.isFile() || Date.now() - stale.mtimeMs < STALE_LOCK_MS)
    return undefined;
  budget.check();
  signal?.throwIfAborted();
  const current = await fs.lstat(path);
  if (!sameFile(stale, current) || stale.mtimeMs !== current.mtimeMs)
    return undefined;
  await fs.unlink(path);
  budget.check();
  signal?.throwIfAborted();
  // Retry only once. Another writer winning the retry remains normal contention.
  return fs.open(path, "wx");
}

// Exclusive, non-waiting mutation. Snapshot work always happens before this lock.
export async function mutateState(context, budget, update, signal) {
  let lock;
  let temporary;
  const lockPath = join(context.directory, "lock");
  try {
    budget.check();
    signal?.throwIfAborted();
    await fs.mkdir(context.directory, { recursive: true });
    if (!contained(context.root, await fs.realpath(context.directory)))
      return false;
    lock = await acquireLock(lockPath, budget, signal);
    if (!lock) return false;
    const ignorePath = join(context.root, ".idiom/.gitignore");
    if (
      (await exists(ignorePath)) &&
      !contained(context.root, await fs.realpath(ignorePath))
    )
      return false;
    let ignore = "";
    try {
      ignore = await readSmall(ignorePath, budget);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!ignore.split(/\r?\n/).includes("/agent-hooks/")) {
      await fs.appendFile(
        ignorePath,
        `${ignore && !ignore.endsWith("\n") ? "\n" : ""}/agent-hooks/\n`,
      );
    }
    const state = await readState(context, budget);
    if (!update(state)) return false;
    state.sessions = Object.fromEntries(
      Object.entries(state.sessions)
        .reverse()
        .filter(
          ([, session]) =>
            session &&
            typeof session.at === "number" &&
            session.at > Date.now() - 7 * 86400000,
        )
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 64),
    );
    budget.check();
    signal?.throwIfAborted();
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized) > 65536) return false;
    temporary = join(context.directory, `${randomUUID()}.tmp`);
    await fs.writeFile(temporary, serialized, {
      signal: budget.signal,
    });
    if (!sameFile(await lock.stat(), await fs.lstat(lockPath))) return false;
    budget.check();
    signal?.throwIfAborted();
    await fs.rename(temporary, join(context.directory, "state.json"));
    return true;
  } catch {
    return false;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    if (lock) {
      try {
        // A resumed old owner must not remove a successor's replacement lock.
        if (sameFile(await lock.stat(), await fs.lstat(lockPath)))
          await fs.unlink(lockPath);
      } catch {
        /* Lock already gone or unavailable; close our own handle. */
      }
      await lock.close().catch(() => {});
    }
  }
}

export async function recordEdit(context, path, budget) {
  const at = Date.now();
  return mutateState(context, budget, (state) => {
    state.editId = randomUUID();
    const pending = state.pending.filter((entry) => entry.path !== path);
    // Overflow switches future snapshots to a bounded filesystem walk.
    if (pending.length >= MAX_PENDING || path.length > 512)
      state.overflow = true;
    state.pending =
      path.length > 512
        ? pending
        : [...pending, { path, at }].slice(-MAX_PENDING);
    return true;
  });
}

export function stopDecision(state, digest, initialChanges, session) {
  const epoch = state.check?.id ?? "initial";
  const unchecked = state.check
    ? state.check.digest !== digest
    : initialChanges || state.pending.length > 0 || state.overflow === true;
  return unchecked && state.sessions[session]?.epoch !== epoch;
}

export async function claimStop(
  context,
  current,
  initialChanges,
  session,
  budget,
) {
  if (
    typeof session !== "string" ||
    session.length === 0 ||
    session.length > 256
  )
    return false;
  return mutateState(context, budget, (state) => {
    if (!stopDecision(state, current.digest, initialChanges, session))
      return false;
    Object.defineProperty(state.sessions, session, {
      value: { epoch: state.check?.id ?? "initial", at: Date.now() },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return true;
  });
}

export async function initialChanges(context, current, budget) {
  if (!context.git) return false;
  if (current.untracked) return true;
  try {
    const output = await git(
      context,
      [
        "diff",
        "HEAD",
        "--relative",
        "--no-renames",
        "--name-only",
        "-z",
        "--",
        ".",
      ],
      budget,
    );
    for (const path of output.split("\0")) {
      budget.check();
      if (
        matchesUI(path, context.globs) &&
        (await normalizePath(context, path, budget)) !== undefined
      )
        return true;
    }
    return false;
  } catch (error) {
    budget.check();
    // Unborn HEAD: tracked files have not been checked either. Other errors fail open.
    if (String(error.stderr).includes("HEAD")) return true;
    throw error;
  }
}

export async function publishCheck(
  context,
  start,
  end,
  metadata,
  budget,
  signal,
) {
  if (start.digest !== end.digest) return false;
  return mutateState(
    context,
    budget,
    (state) => {
      if (
        signal?.aborted ||
        state.check?.startedAt > metadata.startedAt ||
        state.editId !== metadata.editId
      )
        return false;
      state.check = {
        ...metadata,
        digest: end.digest,
        completedAt: Date.now(),
        id: randomUUID(),
      };
      // Ordinary paths need no inventory: Git will enumerate them next time.
      // Retain only ignored UI paths that otherwise disappear from later digests.
      const observed = new Map(
        state.pending.map((entry) => [entry.path, entry.at]),
      );
      state.pending = end.ignored
        .filter((path) => path.length <= 512)
        .slice(-MAX_PENDING)
        .map((path) => ({
          path,
          at: observed.get(path) ?? metadata.startedAt,
        }));
      state.overflow =
        end.ignored.length > MAX_PENDING ||
        end.ignored.some((path) => path.length > 512);
      state.sessions = {};
      return true;
    },
    signal,
  );
}

export async function flowReminder(context, budget) {
  let files;
  try {
    files = (await fs.readdir(join(context.root, ".idiom/flows")))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    files = [];
  }
  if (!files.length)
    return "Use idiom_flows or idiom init to configure a flow, then run idiom_check.";
  const flows = [];
  for (const file of files.slice(0, 8)) {
    const path = join(context.root, ".idiom/flows", file);
    if (!contained(context.root, await fs.realpath(path)))
      throw new Error("outside flow");
    const flow = JSON.parse(await readSmall(path, budget));
    if (typeof flow.id !== "string" || !flow.id.trim())
      throw new Error("invalid flow");
    flows.push(
      `${flow.id.replace(/[\r\n\t]/g, " ").slice(0, 80)} (all states)`,
    );
  }
  return `Run idiom_check for ${flows.join(", ")}${files.length > flows.length ? ", and all remaining configured flows/states" : ""}.`;
}

export async function readInput(budget) {
  let source = "";
  process.stdin.setEncoding("utf8");
  const abort = () => process.stdin.destroy();
  budget.signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of process.stdin) {
      budget.check();
      source += chunk;
      if (source.length > 262144) throw new Error("hook input too large");
    }
    budget.check();
    const input = JSON.parse(source);
    return input && typeof input === "object" && !Array.isArray(input)
      ? input
      : undefined;
  } finally {
    budget.signal.removeEventListener("abort", abort);
  }
}
