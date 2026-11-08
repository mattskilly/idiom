import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  bindProjectToPort,
  type PortReservation,
  requestedPort,
  reservePort,
} from "../capture/port.js";
import {
  isPortOpen,
  type OwnedServer,
  type ProcessDependencies,
  runServerBuild,
  runSetupSteps,
  serverRegistryFor,
  startServer,
} from "../capture/process.js";
import { sourceStatus } from "../capture/resolve.js";
import { serverFailureHint } from "../capture/server-diagnosis.js";
import {
  type LeftoverServer,
  leftoverServerMessage,
  reapLeftoverServers,
} from "../capture/server-registry.js";
import { IdiomError, RunFailure, type RunFailureJson } from "../errors.js";
import {
  MINIMUM_NODE,
  NODE_UPGRADE_HINT,
  nodeVersionProblem,
} from "../node-version.js";
import { validateForRun } from "../preflight.js";
import { preflightFindingNameRegistry } from "../review/names.js";
import { isWebFlow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";
import {
  inspectSurfaces,
  type SurfaceDependencies,
  type SurfacesReport,
} from "./surfaces.js";

export type DoctorStepId =
  | "node"
  | "config"
  | "registry"
  | "tree"
  | "port"
  | "setup"
  | "build"
  | "start"
  | "ready"
  | "shutdown";

export type DoctorStep = {
  id: DoctorStepId;
  status: "pass" | "fail" | "warn" | "skip";
  ms: number;
  detail?: string | undefined;
  hint?: string | undefined;
};

export type DoctorReport = {
  flow?: string | undefined;
  ok: boolean;
  steps: DoctorStep[];
  /** Servers an earlier, killed run left behind; present only when any were found. */
  leftovers?: LeftoverServer[] | undefined;
  failure?: RunFailureJson | undefined;
  /** Where Idiom is wired; informational, never affects `ok`. */
  surfaces?: SurfacesReport | undefined;
};

export type DoctorDependencies = {
  process?: ProcessDependencies | undefined;
  inheritedEnvironment?: NodeJS.ProcessEnv | undefined;
  nodeVersion?: string | undefined;
  onLeftoverServer?: ((message: string) => void) | undefined;
  surfaces?: SurfaceDependencies | undefined;
};

const STEP_ORDER: DoctorStepId[] = [
  "node",
  "config",
  "registry",
  "tree",
  "port",
  "setup",
  "build",
  "start",
  "ready",
  "shutdown",
];
const READY_TIMEOUT_MS = 5_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Boot the application server once, exactly as a capture would, and report
 * each step with its timing — so a run that cannot start says why in seconds.
 */
export async function runDoctor(options: {
  flow?: string | undefined;
  project?: string | undefined;
  cwd?: string | undefined;
  port?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Inspect where Idiom is wired (default true). */
  surfaces?: boolean | undefined;
  dependencies?: DoctorDependencies | undefined;
}): Promise<DoctorReport> {
  const surfaces =
    options.surfaces === false
      ? undefined
      : await inspectSurfaces({
          project: options.project,
          cwd: options.cwd,
          dependencies: options.dependencies?.surfaces,
        });
  const steps: DoctorStep[] = [];
  let leftovers: LeftoverServer[] = [];
  let failure: RunFailure | undefined;
  const inherited = options.dependencies?.inheritedEnvironment ?? process.env;
  const processDependencies = options.dependencies?.process;
  const fetchReady = processDependencies?.fetch ?? globalThis.fetch;

  const fail = (step: DoctorStep, error: RunFailure) => {
    steps.push({
      ...step,
      status: "fail",
      detail: error.headline,
      hint: error.hint,
    });
    failure ??= error;
  };
  const timed = async <T>(work: () => Promise<T>) => {
    const started = performance.now();
    try {
      return { value: await work(), ms: elapsed(started) };
    } catch (error) {
      return { error, ms: elapsed(started) };
    }
  };
  const skipRest = (detail: string) => {
    for (const id of STEP_ORDER)
      if (!steps.some((step) => step.id === id))
        steps.push({ id, status: "skip", ms: 0, detail });
  };
  const report = (): DoctorReport => {
    const ordered = STEP_ORDER.flatMap((id) =>
      steps.filter((step) => step.id === id),
    );
    return {
      ...(options.flow === undefined ? {} : { flow: options.flow }),
      ok: failure === undefined,
      steps: ordered,
      ...(leftovers.length === 0 ? {} : { leftovers }),
      ...(failure === undefined ? {} : { failure: failure.failureJson() }),
      ...(surfaces === undefined ? {} : { surfaces }),
    };
  };

  // node: the launcher refuses an old Node first; this reports it for in-process callers.
  const nodeStarted = performance.now();
  const nodeVersion =
    options.dependencies?.nodeVersion ?? process.versions.node;
  const nodeProblem = nodeVersionProblem(nodeVersion);
  if (nodeProblem !== undefined) {
    fail(
      { id: "node", status: "fail", ms: elapsed(nodeStarted) },
      new RunFailure({
        stage: "preflight",
        cause: "node-version",
        headline: nodeProblem,
        hint: NODE_UPGRADE_HINT,
      }),
    );
    skipRest(`Node ${MINIMUM_NODE} or newer is required`);
    return report();
  }
  steps.push({
    id: "node",
    status: "pass",
    ms: elapsed(nodeStarted),
    detail: `Node ${nodeVersion}; Idiom needs Node ${MINIMUM_NODE} or newer`,
  });

  // config
  const config = await timed(() => validateForRun(options));
  if ("error" in config) {
    if (!(config.error instanceof RunFailure)) throw config.error;
    fail({ id: "config", status: "fail", ms: config.ms }, config.error);
    skipRest("config must validate first");
    return report();
  }
  const validated = config.value;
  steps.push({
    id: "config",
    status: "pass",
    ms: config.ms,
    detail: `${validated.flows.length} flow(s) valid`,
  });

  // A server an earlier, killed run left on the port is stopped before the
  // port step probes it.
  const reaping = serverRegistryFor(processDependencies);
  if (reaping !== undefined) {
    leftovers = await reapLeftoverServers(validated.projectDirectory, reaping);
    for (const leftover of leftovers)
      options.dependencies?.onLeftoverServer?.(leftoverServerMessage(leftover));
  }

  // registry
  const registry = await timed(() =>
    preflightFindingNameRegistry({
      projectDirectory: validated.projectDirectory,
    }),
  );
  if ("error" in registry) {
    if (!(registry.error instanceof RunFailure)) throw registry.error;
    fail({ id: "registry", status: "fail", ms: registry.ms }, registry.error);
  } else
    steps.push({
      id: "registry",
      status: "pass",
      ms: registry.ms,
      detail: "finding-name registry readable",
    });

  // tree: a warning only; doctor never records a baseline.
  const tree = await timed(() =>
    sourceStatus(validated.projectDirectory, {
      ignoreDirty: validated.project.baselines?.ignoreDirty,
    }),
  );
  if ("error" in tree)
    steps.push({
      id: "tree",
      status: "warn",
      ms: tree.ms,
      detail: errorText(tree.error),
      hint: "baselines are recorded from a committed Git worktree",
    });
  else if (tree.value.dirty) {
    const paths = tree.value.dirtyPaths;
    steps.push({
      id: "tree",
      status: "warn",
      ms: tree.ms,
      detail: `a baseline cannot be recorded until these are committed: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}`,
      hint: "commit or stash, or check with --all",
    });
  } else
    steps.push({
      id: "tree",
      status: "pass",
      ms: tree.ms,
      detail: `clean at ${tree.value.commit.slice(0, 12)}`,
    });

  const flow =
    options.flow === undefined ? undefined : validated.flows[0]?.flow;
  if (flow !== undefined && !isWebFlow(flow)) {
    skipRest("Electron flows launch the app directly");
    return report();
  }

  const original = validated.project;
  let reservation: PortReservation | undefined;
  let server: OwnedServer | undefined;
  let dataDirectory: string | undefined;
  const serverFailure = (
    cause: string,
    headline: string,
    hint: string,
    detail?: string,
  ) =>
    new RunFailure({
      stage: "server",
      cause,
      headline,
      hint,
      ...(detail === undefined ? {} : { detail }),
    });
  try {
    // port
    const portStarted = performance.now();
    let project: Project;
    let portTaken: boolean;
    try {
      let port = requestedPort({
        flag: options.port,
        environment: inherited,
        project: original,
      });
      const pinned = port !== undefined;
      if (port === undefined) {
        reservation = await reservePort(original.server.port);
        port = reservation.port;
      }
      project = bindProjectToPort(original, port);
      const ready = new URL(project.server.readyUrl);
      const readyHost = ready.hostname.replace(/^\[(.*)\]$/, "$1");
      const detail = `bound ${port} (configured ${original.server.port}, fixedPort ${original.server.fixedPort === true ? "true" : "false"})`;
      // A reserved port is held by doctor itself; only a pinned one can be taken.
      portTaken = pinned && (await isPortOpen(port, readyHost));
      if (portTaken)
        fail(
          { id: "port", status: "fail", ms: elapsed(portStarted), detail },
          serverFailure(
            "port-in-use",
            `server failed to start: port ${port} in use — ${project.server.readyUrl} already answers`,
            serverFailureHint({
              cause: "port-in-use",
              output: "",
              project: original,
              port,
            }),
          ),
        );
      else
        steps.push({
          id: "port",
          status: "pass",
          ms: elapsed(portStarted),
          detail,
        });
    } catch (error) {
      if (!(error instanceof IdiomError)) throw error;
      fail(
        { id: "port", status: "fail", ms: elapsed(portStarted) },
        serverFailure(
          "port-config",
          `server failed to start: ${errorText(error)}`,
          "fix the port settings in .idiom/project.json, --port or IDIOM_PORT",
        ),
      );
      skipRest("no port to start on");
      return report();
    }
    if (portTaken) {
      skipRest("the port is not free");
      return report();
    }

    dataDirectory = await mkdtemp(join(tmpdir(), "idiom-doctor-"));
    const data = dataDirectory;

    // setup
    if (flow !== undefined && flow.setup.length > 0) {
      const setup = await timed(() =>
        runSetupSteps({
          projectDirectory: validated.projectDirectory,
          flow,
          dataDirectory: data,
          inheritedEnvironment: inherited,
          dependencies: processDependencies,
          signal: options.signal,
        }),
      );
      if ("error" in setup) {
        stepFailure("setup", setup.ms, setup.error, "setup-failed");
        skipRest("setup must succeed first");
        return report();
      }
      steps.push({
        id: "setup",
        status: "pass",
        ms: setup.ms,
        detail: `${flow.setup.length} step(s)`,
      });
    } else
      steps.push({
        id: "setup",
        status: "skip",
        ms: 0,
        detail: "no flow setup steps",
      });

    // build
    const build = await timed(() =>
      runServerBuild({
        projectDirectory: validated.projectDirectory,
        project,
        dataDirectory: data,
        port: project.server.port,
        signal: options.signal,
        inheritedEnvironment: inherited,
        dependencies: processDependencies,
      }),
    );
    if ("error" in build) {
      stepFailure("build", build.ms, build.error, "build-failed");
      skipRest("the build must succeed first");
      return report();
    }
    const environment = build.value;
    steps.push({
      id: "build",
      status: "pass",
      ms: build.ms,
      detail: project.server.build === "" ? "no build command" : "built",
    });
    const held = reservation;
    reservation = undefined;
    await held?.release();

    // start
    const start = await timed(() =>
      startServer({
        projectDirectory: validated.projectDirectory,
        project,
        environment,
        configuredPort: original.server.port,
        signal: options.signal,
        dependencies: processDependencies,
        onOwned: (owned) => {
          server = owned;
        },
      }),
    );
    if ("error" in start) {
      // startServer already stopped what it started.
      server = undefined;
      stepFailure("start", start.ms, start.error, "server-exited");
      skipRest("the server did not start");
      return report();
    }
    steps.push({
      id: "start",
      status: "pass",
      ms: start.ms,
      detail: `ready at ${project.server.readyUrl}`,
    });

    // ready
    const ready = await timed(async () => {
      const response = await fetchReady(project.server.readyUrl, {
        signal: AbortSignal.timeout(READY_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.status;
    });
    if ("error" in ready || ready.value !== 200) {
      const status =
        "error" in ready ? errorText(ready.error) : String(ready.value);
      fail(
        { id: "ready", status: "fail", ms: ready.ms },
        serverFailure(
          "ready-url",
          `server failed to start: ${project.server.readyUrl} returned ${status}`,
          `server.readyUrl returned ${status}; point it at a page that returns 200`,
        ),
      );
    } else
      steps.push({
        id: "ready",
        status: "pass",
        ms: ready.ms,
        detail: `${project.server.readyUrl} returned 200`,
      });

    // shutdown
    const owned = server as OwnedServer | undefined;
    server = undefined;
    const shutdown = await timed(async () => owned?.stop());
    if ("error" in shutdown)
      fail(
        { id: "shutdown", status: "fail", ms: shutdown.ms },
        serverFailure(
          "server-shutdown",
          `server did not shut down: ${errorText(shutdown.error)}`,
          "make server.start exit on SIGTERM and release its port",
        ),
      );
    else
      steps.push({
        id: "shutdown",
        status: "pass",
        ms: shutdown.ms,
        detail: `port ${project.server.port} released`,
      });
    return report();
  } finally {
    const cleanup = [
      (server as OwnedServer | undefined)?.stop(),
      reservation?.release(),
      dataDirectory === undefined
        ? undefined
        : rm(dataDirectory, { recursive: true, force: true }),
    ];
    await Promise.allSettled(cleanup);
  }

  function stepFailure(
    id: DoctorStepId,
    ms: number,
    error: unknown,
    cause: string,
  ) {
    if (!(error instanceof IdiomError)) throw error;
    fail(
      { id, status: "fail", ms },
      error instanceof RunFailure
        ? error
        : serverFailure(
            cause,
            `server failed to start: ${error.message.split("\n")[0]}`,
            id === "setup"
              ? "run the flow's setup steps yourself to see why they fail"
              : "run server.build yourself to see why it fails",
            error.message.split("\n").slice(1).join("\n") || undefined,
          ),
    );
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
