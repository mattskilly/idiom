import { createServer, type Server } from "node:net";
import { IdiomError } from "../errors.js";
import type { Project } from "../schemas/project.js";

/** Replace a complete configured port token, never a substring of another number. */
export function replacePort(
  value: string,
  original: number,
  selected: number,
): string {
  return value.replace(
    new RegExp(`(?<![0-9])${original}(?![0-9])`, "g"),
    String(selected),
  );
}

/** Swap one exact origin for another; shared by capture and review so both agree. */
export function replaceOrigin(value: string, from: string, to: string): string {
  if (from === to) return value;
  // An origin ending in :543 must not match the start of :54321.
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`${escaped}(?![0-9])`, "g"), () => to);
}

export function parsePort(value: string, source: string): number {
  const trimmed = value.trim();
  const port = Number(trimmed);
  if (!/^[0-9]+$/.test(trimmed) || port < 1 || port > 65_535) {
    throw new IdiomError(
      `${source} must be an integer from 1 to 65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

/**
 * The port a capture must use, if one is pinned: `--port`, then `IDIOM_PORT`,
 * then `server.port` under `server.fixedPort`. Undefined means reserve one.
 */
export function requestedPort(options: {
  flag?: number | undefined;
  environment: NodeJS.ProcessEnv;
  project: Project;
}): number | undefined {
  const { server } = options.project;
  const explicit =
    options.flag !== undefined
      ? parsePort(String(options.flag), "--port")
      : options.environment.IDIOM_PORT === undefined
        ? undefined
        : parsePort(options.environment.IDIOM_PORT, "IDIOM_PORT");
  if (server.fixedPort === true) {
    if (explicit !== undefined && explicit !== server.port) {
      throw new IdiomError(
        `server.fixedPort is true; remove --port/IDIOM_PORT or set fixedPort to false`,
      );
    }
    return server.port;
  }
  return explicit;
}

export type PortReservation = {
  port: number;
  release: () => Promise<void>;
};

function listen(port: number, host: string): Promise<Server> {
  const server = createServer();
  return new Promise<Server>((accept, reject) => {
    server.once("error", reject);
    server.listen({ port, host, ipv6Only: host === "::" }, () => {
      server.removeListener("error", reject);
      accept(server);
    });
  });
}

async function close(servers: Server[]): Promise<void> {
  await Promise.all(
    servers
      .filter((server) => server.listening)
      .map(
        (server) =>
          new Promise<void>((accept, reject) =>
            server.close((error) => (error ? reject(error) : accept())),
          ),
      ),
  );
}

/**
 * Hold both loopback address families, never the configured port. Try a cached
 * preferred port first, falling back to a free one if it is occupied. An IPv6-only
 * listener avoids conflicting with our IPv4 reservation on dual-stack systems.
 * Holding IPv4 loopback explicitly also prevents SO_REUSEADDR binds on macOS.
 */
export async function reservePort(
  avoid: number,
  preferred?: number,
): Promise<PortReservation> {
  let held: Server[] = [];
  let candidate = preferred === avoid ? undefined : preferred;
  const release = async () => {
    const servers = held;
    held = [];
    await close(servers);
  };
  try {
    while (true) {
      await release();
      const requested = candidate;
      candidate = undefined;
      let loopback: Server;
      try {
        loopback = await listen(requested ?? 0, "127.0.0.1");
      } catch (error) {
        if (
          requested !== undefined &&
          (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        )
          continue;
        throw error;
      }
      held = [loopback];
      const address = loopback.address();
      if (address === null || typeof address === "string")
        throw new IdiomError("could not reserve a free port");
      if (address.port === avoid) continue;
      try {
        held.push(await listen(address.port, "::"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EADDRINUSE") continue;
        // Hosts without IPv6 can still capture an IPv4 loopback application.
        if (
          code !== "EAFNOSUPPORT" &&
          code !== "EADDRNOTAVAIL" &&
          code !== "EPROTONOSUPPORT"
        )
          throw error;
      }
      return { port: address.port, release };
    }
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

/** Point a project's server at the chosen port; fixed-port projects are untouched. */
export function bindProjectToPort(project: Project, port: number): Project {
  const { server } = project;
  if (server.fixedPort === true || port === server.port) return project;
  const replace = (value: string) => replacePort(value, server.port, port);
  const ready = new URL(server.readyUrl);
  ready.port = String(port);
  return {
    ...project,
    server: {
      ...server,
      build: replace(server.build),
      start: replace(server.start),
      port,
      readyUrl: ready.href,
      env: Object.fromEntries(
        Object.entries(server.env).map(([key, value]) => [key, replace(value)]),
      ),
    },
  };
}

/** The `PORT` the application server receives, after every other variable. */
export function serverEnvironment(
  project: Project,
  port: number,
): NodeJS.ProcessEnv {
  return project.server.fixedPort === true ? {} : { PORT: String(port) };
}
