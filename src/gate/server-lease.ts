import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindProjectToPort, reservePort } from "../capture/port.js";
import {
  type OwnedServer,
  runServerBuild,
  startServer,
} from "../capture/process.js";
import type { CaptureDependencies } from "../capture/run.js";
import { type Flow, isWebFlow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";

/** A server the gate started once and hands to every flow's capture. */
export type LeasedServer = {
  /** The project bound to the lease's port. */
  project: Project;
  buildMs: number;
  startMs: number;
};

export type ServerLease = LeasedServer & { stop: () => Promise<void> };

const DATA_DIRECTORY = "$" + "{dataDir}";

/**
 * Whether one server may serve every gated flow: not production, not a
 * reused server, no flow with setup steps, and nothing in the server's
 * command, build or env that needs a per-run data directory.
 */
export function serverLeaseEligible(
  project: Project,
  flows: Flow[],
  options: { production: boolean; reused: boolean },
): { eligible: true } | { eligible: false; reason: string } {
  if (options.production)
    return { eligible: false, reason: "production server" };
  if (options.reused) return { eligible: false, reason: "server reused" };
  for (const flow of flows) {
    if (!isWebFlow(flow))
      return { eligible: false, reason: `${flow.id} is not a web flow` };
    if ((flow.setup?.length ?? 0) > 0)
      return { eligible: false, reason: `${flow.id} has setup steps` };
  }
  const { server } = project;
  if (
    server.start.includes(DATA_DIRECTORY) ||
    server.build.includes(DATA_DIRECTORY) ||
    Object.values(server.env).some((value) => value.includes(DATA_DIRECTORY))
  )
    return { eligible: false, reason: "data directory in server config" };
  return { eligible: true };
}

/**
 * Build and start the project's server once, on a free port. The caller
 * owns the lease and must `stop()` it; only the PIDs it started are stopped.
 */
export async function leaseServer(options: {
  projectDirectory: string;
  project: Project;
  signal?: AbortSignal | undefined;
  dependencies?: CaptureDependencies | undefined;
}): Promise<ServerLease> {
  const clock = options.dependencies?.monotonicNow ?? (() => performance.now());
  const inherited = options.dependencies?.inheritedEnvironment ?? process.env;
  const processDependencies = {
    ...options.dependencies?.process,
    teardownTimeoutMs: Math.min(
      options.dependencies?.process?.teardownTimeoutMs ?? 3000,
      2000,
    ),
  };
  // Eligibility rules out `${dataDir}`; the directory only satisfies the API.
  const dataDirectory = await mkdtemp(join(tmpdir(), "idiom-gate-lease-"));
  let server: OwnedServer | undefined;
  const stop = async () => {
    const owned = server;
    server = undefined;
    try {
      await owned?.stop();
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  };
  try {
    const reservation = await reservePort(options.project.server.port);
    let project: Project;
    let environment: NodeJS.ProcessEnv;
    const buildStarted = clock();
    try {
      project = bindProjectToPort(options.project, reservation.port);
      environment = await runServerBuild({
        projectDirectory: options.projectDirectory,
        project,
        dataDirectory,
        port: project.server.port,
        signal: options.signal,
        inheritedEnvironment: inherited,
        dependencies: processDependencies,
      });
    } finally {
      await reservation.release();
    }
    const buildMs = Math.max(0, clock() - buildStarted);
    const startStarted = clock();
    server = await startServer({
      signal: options.signal,
      onOwned: (owned) => {
        server = owned;
      },
      projectDirectory: options.projectDirectory,
      project,
      environment,
      configuredPort: options.project.server.port,
      dependencies: processDependencies,
    });
    return {
      project,
      buildMs: Math.round(buildMs),
      startMs: Math.round(Math.max(0, clock() - startStarted)),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
