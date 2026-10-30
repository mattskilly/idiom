import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IdiomError } from "../errors.js";
import type { Flow } from "../schemas/flow.js";
import { type Project, productionConfigExample } from "../schemas/project.js";
import {
  type PortReservation,
  replacePort,
  reservePort,
  serverEnvironment,
} from "./port.js";
import {
  inputHash,
  openProductionCache,
  readBuildId,
} from "./production-cache.js";
import { localOrigin } from "./resolve.js";
import { type PhaseTiming, skipped } from "./timings.js";
import type { ProductionBuild } from "./types.js";

export { replacePort };

const OUTPUT_LIMIT = 8_000;
const PLACEHOLDER = /\$\{([^}]+)\}/g;
const DATA_DIRECTORY_PLACEHOLDER = "$" + "{dataDir}";

export type SpawnProcess = typeof spawn;

export type ProcessDependencies = {
  spawn?: SpawnProcess;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  teardownTimeoutMs?: number | undefined;
  monotonicNow?: (() => number) | undefined;
};

export type SetupResult = {
  capturedStdout: string[];
  effectiveEnvironments: NodeJS.ProcessEnv[];
};

export type OwnedServer = {
  process: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
};

export function expandDataDirectory(
  value: string,
  dataDirectory: string,
  label: string,
): string {
  const result = value.replaceAll(DATA_DIRECTORY_PLACEHOLDER, dataDirectory);
  const unresolved = [...result.matchAll(PLACEHOLDER)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new IdiomError(
      `${label} contains unsupported placeholder \${${unresolved[0]}}`,
    );
  }
  return result;
}

function bounded(value: string): string {
  return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT);
}

function redact(value: string, environment: NodeJS.ProcessEnv): string {
  let result = value;
  for (const [name, secret] of Object.entries(environment)) {
    if (
      /_(TOKEN|SECRET|KEY)$/.test(name) &&
      secret !== undefined &&
      secret.length > 0
    ) {
      result = result.split(secret).join(`[redacted ${name}]`);
    }
  }
  return result;
}

export function expandEnvironment(
  values: Record<string, string> | undefined,
  dataDirectory: string,
): NodeJS.ProcessEnv {
  const expanded: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    expanded[name] = expandDataDirectory(
      value,
      dataDirectory,
      `environment ${name}`,
    );
  }
  return expanded;
}

function commandCwd(projectDirectory: string, cwd?: string): string {
  if (cwd === undefined) return projectDirectory;
  return isAbsolute(cwd) ? resolve(cwd) : resolve(projectDirectory, cwd);
}

async function runToClose(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnProcess: SpawnProcess;
  label: string;
  signal?: AbortSignal | undefined;
  teardownTimeoutMs?: number | undefined;
}): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  let child: ChildProcess;
  try {
    child = options.spawnProcess(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      detached: options.signal !== undefined && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new IdiomError(
      `${options.label} could not start (${redact(options.command, options.env)}, cwd ${options.cwd}): ${redact(String(error), options.env)}`,
    );
  }
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = bounded(stderr + chunk);
  });
  let stopping: Promise<void> | undefined;
  const abort = () => {
    stopping ??= stopCommand(child, options.teardownTimeoutMs ?? 3_000);
    void stopping.catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => accept({ code, signal }));
  })
    .finally(() => options.signal?.removeEventListener("abort", abort))
    .catch((error) => {
      throw new IdiomError(
        `${options.label} could not start (${redact(options.command, options.env)}, cwd ${options.cwd}): ${redact(String(error), options.env)}`,
      );
    });
  await stopping;
  options.signal?.throwIfAborted();
  if (result.code !== 0) {
    const status =
      result.signal === null
        ? `exit ${String(result.code)}`
        : `signal ${result.signal}`;
    const tail = redact(stderr.trim(), options.env);
    throw new IdiomError(
      `${options.label} failed (${redact(options.command, options.env)}, cwd ${options.cwd}, ${status})${tail.length > 0 ? `: ${tail}` : ""}`,
    );
  }
  return { stdout, stderr };
}

export async function runSetupSteps(options: {
  projectDirectory: string;
  flow: Flow;
  dataDirectory: string;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  dependencies?: ProcessDependencies | undefined;
  signal?: AbortSignal | undefined;
  onActivity?: ((step: string) => void) | undefined;
}): Promise<SetupResult> {
  const spawnProcess = options.dependencies?.spawn ?? spawn;
  const inherited = options.inheritedEnvironment ?? process.env;
  const capturedStdout: string[] = [];
  const effectiveEnvironments: NodeJS.ProcessEnv[] = [];
  for (const [index, step] of options.flow.setup.entries()) {
    options.signal?.throwIfAborted();
    options.onActivity?.(`setup step ${index + 1}`);
    const env = {
      ...inherited,
      ...expandEnvironment(step.env, options.dataDirectory),
    };
    effectiveEnvironments.push(env);
    const result = await runToClose({
      command: step.run,
      cwd: commandCwd(options.projectDirectory, step.cwd),
      env,
      spawnProcess,
      label: `setup step ${index + 1}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      teardownTimeoutMs: options.dependencies?.teardownTimeoutMs,
    });
    if (step.captureStdout) capturedStdout.push(result.stdout);
  }
  return { capturedStdout, effectiveEnvironments };
}

export async function runServerBuild(options: {
  projectDirectory: string;
  signal?: AbortSignal | undefined;
  project: Project;
  dataDirectory: string;
  /** The bound port, passed as `PORT` after every other variable. */
  port?: number | undefined;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  dependencies?: ProcessDependencies | undefined;
}): Promise<NodeJS.ProcessEnv> {
  const environment = {
    ...(options.inheritedEnvironment ?? process.env),
    ...expandEnvironment(options.project.server.env, options.dataDirectory),
    ...(options.port === undefined
      ? {}
      : serverEnvironment(options.project, options.port)),
  };
  await runToClose({
    command: options.project.server.build,
    cwd: options.projectDirectory,
    env: environment,
    spawnProcess: options.dependencies?.spawn ?? spawn,
    label: "server build",
    signal: options.signal,
    teardownTimeoutMs: options.dependencies?.teardownTimeoutMs,
  });
  return environment;
}

export async function isPortOpen(
  port: number,
  host = "127.0.0.1",
): Promise<boolean> {
  return await new Promise<boolean>((accept) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      accept(true);
    });
    const closed = () => {
      socket.destroy();
      accept(false);
    };
    socket.once("error", closed);
    socket.once("timeout", closed);
  });
}

async function waitForPortRelease(
  port: number,
  host: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await isPortOpen(port, host)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    // Darwin reports EPERM for a group whose remaining members are zombies
    // (the leader died but is not yet reaped); signal the leader directly.
    if (code === "EPERM") {
      child.kill(signal);
      return;
    }
    throw error;
  }
}

async function waitForClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((accept) => {
    const timer = setTimeout(() => {
      child.off("close", closed);
      accept(false);
    }, timeoutMs);
    const closed = () => {
      clearTimeout(timer);
      accept(true);
    };
    child.once("close", closed);
  });
}

export async function startServer(options: {
  projectDirectory: string;
  project: Project;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal | undefined;
  onOwned?: (server: OwnedServer) => void;
  dependencies?: ProcessDependencies | undefined;
  /** The project's own `server.port`, when capture reserved a different one. */
  configuredPort?: number | undefined;
}): Promise<OwnedServer> {
  options.signal?.throwIfAborted();
  const { server } = options.project;
  const teardownTimeoutMs = options.dependencies?.teardownTimeoutMs ?? 3_000;
  // Never capture a server this run did not start: anything already bound
  // where the ready URL points belongs to another process.
  const ready = new URL(server.readyUrl);
  const readyPort =
    ready.port === ""
      ? ready.protocol === "https:"
        ? 443
        : 80
      : Number(ready.port);
  const readyHost = ready.hostname.replace(/^\[(.*)\]$/, "$1");
  const occupied = (await isPortOpen(readyPort, readyHost))
    ? readyPort
    : (await isPortOpen(server.port, readyHost))
      ? server.port
      : undefined;
  if (occupied !== undefined) {
    throw new IdiomError(
      `cannot start application server: ${server.readyUrl} already answers — port ${occupied} in use by another process`,
    );
  }
  // A start command that pins its port (`next start --port 3100` inside a
  // script) ignores PORT. Watch the configured port so that case fails fast
  // with the fix instead of timing out on the reserved one.
  const configuredPort =
    options.configuredPort !== undefined &&
    options.configuredPort !== server.port &&
    !(await isPortOpen(options.configuredPort, readyHost))
      ? options.configuredPort
      : undefined;
  options.signal?.throwIfAborted();
  const child = (options.dependencies?.spawn ?? spawn)(server.start, {
    cwd: options.projectDirectory,
    env: options.environment,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (chunk: string | Buffer) => {
    output = bounded(output + chunk.toString());
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  let stopPromise: Promise<void> | undefined;
  const stop = async () => {
    if (stopPromise !== undefined) return stopPromise;
    stopPromise = (async () => {
      const childClosed = await waitForClose(child, 0);
      const portClosed = !(await isPortOpen(server.port, readyHost));
      if (!childClosed || !portClosed) signalTree(child, "SIGTERM");
      const [termExit, termRelease] = await Promise.all([
        waitForClose(child, teardownTimeoutMs),
        waitForPortRelease(server.port, readyHost, teardownTimeoutMs),
      ]);
      if (!termExit || !termRelease) {
        signalTree(child, "SIGKILL");
        const [killExit, killRelease] = await Promise.all([
          waitForClose(child, teardownTimeoutMs),
          waitForPortRelease(server.port, readyHost, teardownTimeoutMs),
        ]);
        if (!killExit || !killRelease) {
          throw new IdiomError(
            `application server did not exit and release port ${server.port} after SIGKILL`,
          );
        }
      }
    })();
    return stopPromise;
  };

  options.onOwned?.({ process: child, output: () => output, stop });
  const fetchReady = options.dependencies?.fetch ?? globalThis.fetch;
  const now = options.dependencies?.now ?? Date.now;
  const sleep = options.dependencies?.sleep ?? ((ms) => delay(ms));
  const deadline = now() + server.startupTimeoutMs;
  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (spawnError !== undefined) {
        throw new IdiomError(
          `application server could not start: ${redact(spawnError.message, options.environment)}`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new IdiomError(
          `application server exited before readiness (${child.signalCode ?? `exit ${String(child.exitCode)}`}): ${redact(output.trim(), options.environment)}`,
        );
      }
      try {
        const response = await fetchReady(server.readyUrl, {
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(1_000)])
            : AbortSignal.timeout(1_000),
        });
        options.signal?.throwIfAborted();
        if (response.status === 200) break;
      } catch {
        // The server may not have bound yet.
      }
      if (
        configuredPort !== undefined &&
        (await isPortOpen(configuredPort, readyHost))
      ) {
        throw new IdiomError(
          `application server started on its configured port ${configuredPort}, not the reserved port ${server.port}: its start command pins the port instead of reading PORT. Set "server.fixedPort": true in .idiom/project.json, or pass --port ${configuredPort}`,
        );
      }
      if (now() >= deadline) {
        throw new IdiomError(
          `application server was not ready at ${server.readyUrl} within ${server.startupTimeoutMs}ms: ${redact(output.trim(), options.environment)}`,
        );
      }
      await sleep(100);
    }
    return { process: child, output: () => output, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new IdiomError(
        `${String(error)}; server cleanup failed: ${String(cleanup)}`,
      );
    }
    throw error;
  }
}

async function stopCommand(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  signalTree(child, "SIGTERM");
  // The shell may exit before its descendants; always signal the group again.
  await Promise.all([waitForClose(child, timeoutMs), delay(timeoutMs)]);
  signalTree(child, "SIGKILL");
  if (!(await waitForClose(child, timeoutMs))) {
    throw new IdiomError("production build did not exit after SIGKILL");
  }
}

export type ProductionRuntime = {
  dataDirectory: string;
  timings: { build: PhaseTiming; start: PhaseTiming };
  project: Project;
  environment: NodeJS.ProcessEnv;
  execute: () => Promise<ProductionBuild>;
  close: () => Promise<void>;
};

export async function prepareProduction(options: {
  projectDirectory: string;
  project: Project;
  dataDirectory: string;
  commit: string;
  dirty?: boolean | undefined;
  /** A pinned port (`--port`, `IDIOM_PORT`, `fixedPort`); otherwise a free one. */
  port?: number | undefined;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  dependencies?: ProcessDependencies | undefined;
  signal?: AbortSignal | undefined;
  onActivity?: ((step: string) => void) | undefined;
}): Promise<ProductionRuntime> {
  const production = options.project.server.production;
  localOrigin(options.project.server.readyUrl);
  if (production === undefined)
    throw new IdiomError(
      `production capture requires server.production; ${productionConfigExample}`,
    );
  const root = await realpath(options.projectDirectory);
  const output = resolve(root, production.distDir ?? ".next");
  const contained = relative(root, output);
  if (
    !contained ||
    contained === ".." ||
    contained.startsWith(`..${sep}`) ||
    isAbsolute(contained)
  ) {
    throw new IdiomError(
      "server.production.distDir must remain inside the project",
    );
  }
  // Reject symlinked ancestors before creating or moving anything.
  let ancestor = output;
  while (ancestor !== root) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new IdiomError(
          "server.production.distDir must not traverse symlinks",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    ancestor = dirname(ancestor);
  }
  const clock = options.dependencies?.monotonicNow ?? (() => performance.now());
  const timings = { build: skipped(), start: skipped() };
  const cache = production.reuseBuild
    ? await openProductionCache(root, output)
    : undefined;
  const cacheable = cache !== undefined && options.dirty === false;
  const dataDirectory = cacheable ? cache.dataDirectory : options.dataDirectory;
  let reservation: PortReservation | undefined;
  const release = async () => {
    await reservation?.release();
  };
  let backup: string | undefined;
  let ownsOutput = false;
  let active: OwnedServer | undefined;
  let execution: Promise<ProductionBuild> | undefined;
  let closing: Promise<void> | undefined;
  const controller = new AbortController();
  const abort = () => {
    controller.abort(
      options.signal?.reason ??
        new IdiomError("production capture interrupted"),
    );
    // Stop the owned server independently of an adapter stuck in execute().
    void active?.stop().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const close = () => {
    closing ??= (async () => {
      abort();
      options.signal?.removeEventListener("abort", abort);
      await execution?.catch(() => undefined);
      // Do not touch output while a child might still be using it.
      await active?.stop();
      await release();
      if (ownsOutput) await rm(output, { recursive: true, force: true });
      if (backup !== undefined) {
        await rename(join(backup, "original"), output);
        await rm(backup, { recursive: true, force: true });
      }
      await cache?.close();
    })();
    return closing;
  };
  try {
    controller.signal.throwIfAborted();
    if (cacheable) await cache.resetData();
    controller.signal.throwIfAborted();
    let port = options.port;
    if (port === undefined) {
      reservation = await reservePort(
        options.project.server.port,
        cacheable ? cache.metadata?.port : undefined,
      );
      controller.signal.throwIfAborted();
      port = reservation.port;
    }
    const savedPort = cacheable && port === cache.metadata?.port;
    const replace = (value: string) =>
      replacePort(value, options.project.server.port, port);
    const env = Object.fromEntries(
      Object.entries(production.env).map(([key, value]) => [
        key,
        replace(value),
      ]),
    );
    const environment = {
      ...(options.inheritedEnvironment ?? process.env),
      ...expandEnvironment(env, dataDirectory),
      ...serverEnvironment(options.project, port),
    };
    const ready = new URL(options.project.server.readyUrl);
    ready.port = String(port);
    const project: Project = {
      ...options.project,
      server: {
        ...options.project.server,
        build: replace(production.build),
        start: replace(production.start),
        port,
        readyUrl: ready.href,
        env,
      },
    };
    const fallbackId = createHash("sha256")
      .update(`${production.build}\0${options.commit}`)
      .digest("hex");
    const hash = inputHash([
      root,
      output,
      options.commit,
      production,
      options.project.server.port,
      options.project.server.readyUrl,
      Object.entries(environment)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ]);
    controller.signal.throwIfAborted();
    await mkdir(dirname(output), { recursive: true });
    try {
      await lstat(output);
      const directory = await mkdtemp(
        join(dirname(output), ".idiom-production-"),
      );
      await rename(output, join(directory, "original"));
      backup = directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    ownsOutput = true;
    controller.signal.throwIfAborted();
    return {
      project,
      environment,
      dataDirectory,
      timings,
      close,
      execute: () => {
        if (closing !== undefined)
          return Promise.reject(
            new IdiomError("production runtime already closed"),
          );
        execution ??= (async () => {
          controller.signal.throwIfAborted();
          options.onActivity?.("production cache/build");
          const reused =
            cacheable && savedPort && (await cache.restore(hash, fallbackId));
          const buildStarted = clock();
          if (!reused)
            await runToClose({
              command: project.server.build,
              cwd: options.projectDirectory,
              env: environment,
              spawnProcess: options.dependencies?.spawn ?? spawn,
              label: "production build",
              signal: controller.signal,
              teardownTimeoutMs: options.dependencies?.teardownTimeoutMs,
            });
          timings.build = {
            status: reused ? "reused" : "measured",
            ms: reused ? 0 : Math.max(0, clock() - buildStarted),
          };
          const id = await readBuildId(output, fallbackId);
          controller.signal.throwIfAborted();
          await release();
          options.onActivity?.("production server readiness");
          const startStarted = clock();
          active = await startServer({
            projectDirectory: options.projectDirectory,
            project,
            environment,
            configuredPort: options.project.server.port,
            dependencies: options.dependencies,
            signal: controller.signal,
            onOwned: (owned) => {
              active = owned;
            },
          });
          controller.signal.throwIfAborted();
          timings.start = {
            status: "measured",
            ms: Math.max(0, clock() - startStarted),
          };
          if (cacheable && !reused)
            options.onActivity?.("production cache publication");
          if (cacheable && !reused)
            await cache.promote(
              { version: 1, inputHash: hash, port, id },
              controller.signal,
            );
          return { kind: "production", id };
        })();
        return execution;
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new IdiomError(
        `${String(error)}; production cleanup failed: ${String(cleanup)}`,
      );
    }
    throw error;
  }
}
