import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type SpawnProcess, startServer } from "../src/capture/process.js";
import { projectSchema } from "../src/schemas/project.js";

const network = vi.hoisted(() => ({
  phase: "preflight",
  calls: [] as { host: string; port: number; phase: string }[],
  probe: (_host: string, _port: number): boolean => false,
}));

// Only this file replaces the TCP boundary; other lifecycle tests use real sockets.
vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof import("node:net")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...net,
    createConnection: ({ host, port }: { host: string; port: number }) => {
      const socket = new EventEmitter();
      Object.assign(socket, {
        setTimeout: () => socket,
        destroy: () => socket,
      });
      network.calls.push({ host, port, phase: network.phase });
      const open = network.probe(host, port);
      queueMicrotask(() => {
        if (open) socket.emit("connect");
        else socket.emit("error", new Error("connection refused"));
      });
      return socket;
    },
  };
});

beforeEach(() => {
  network.phase = "preflight";
  network.calls.length = 0;
  network.probe = () => false;
});
afterEach(() => vi.restoreAllMocks());

const readyPort = 4101;
const serverPort = 4102;
const configuredPort = 4103;

function fixture(readyUrl: string) {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: undefined,
    exitCode: null,
    signalCode: null,
  });
  const close = () => {
    Object.assign(child, { exitCode: 0 });
    child.emit("close", 0, null);
  };
  const spawn = vi.fn(() => child);
  const fetch = vi.fn(async () => {
    close();
    return new Response("ready");
  });
  const options = {
    projectDirectory: process.cwd(),
    project: projectSchema.parse({
      version: 1,
      app: { name: "host propagation", framework: "other" },
      server: {
        build: "unused",
        start: "unused",
        readyUrl,
        port: serverPort,
        env: {},
      },
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
    environment: {},
    dependencies: {
      spawn: spawn as SpawnProcess,
      fetch,
      teardownTimeoutMs: 60,
    },
  };
  return { child, close, spawn, fetch, options };
}

describe.each([
  { host: "127.0.0.1", authority: "127.0.0.1" },
  { host: "::1", authority: "[::1]" },
])("ready URL host $host", ({ host, authority }) => {
  const readyUrl = `http://${authority}:${readyPort}/ready`;

  test("probes the ready endpoint and refuses a collision before spawn", async () => {
    const f = fixture(readyUrl);
    network.probe = (address, port) => address === host && port === readyPort;
    await expect(startServer(f.options)).rejects.toThrow(
      `port ${readyPort} in use by another process`,
    );
    expect(f.spawn).not.toHaveBeenCalled();
    expect(network.calls).toEqual([
      { host, port: readyPort, phase: "preflight" },
    ]);
  });

  test("probes a distinct server.port on the same host before spawn", async () => {
    const f = fixture(readyUrl);
    network.probe = (address, port) => address === host && port === serverPort;
    await expect(startServer(f.options)).rejects.toThrow(
      `port ${serverPort} in use by another process`,
    );
    expect(f.spawn).not.toHaveBeenCalled();
    expect(network.calls).toEqual([
      { host, port: readyPort, phase: "preflight" },
      { host, port: serverPort, phase: "preflight" },
    ]);
  });

  test.each([
    { protocol: "http", port: 80 },
    { protocol: "https", port: 443 },
  ])("retains the default $protocol ready port", async ({ protocol, port }) => {
    const f = fixture(`${protocol}://${authority}/ready`);
    network.probe = (address, probedPort) =>
      address === host && probedPort === port;
    await expect(startServer(f.options)).rejects.toThrow(
      `port ${port} in use by another process`,
    );
    expect(f.spawn).not.toHaveBeenCalled();
    expect(network.calls).toEqual([{ host, port, phase: "preflight" }]);
  });

  test("watches the original configured port before spawn and after failed readiness", async () => {
    const f = fixture(readyUrl);
    f.fetch.mockImplementation(async () => {
      expect(network.calls).toEqual([
        { host, port: readyPort, phase: "preflight" },
        { host, port: serverPort, phase: "preflight" },
        { host, port: configuredPort, phase: "preflight" },
      ]);
      network.phase = "readiness";
      network.probe = (address, port) =>
        address === host && port === configuredPort;
      f.close();
      return new Response("not ready", { status: 503 });
    });
    await expect(startServer({ ...f.options, configuredPort })).rejects.toThrow(
      `started on its configured port ${configuredPort}, not the reserved port ${serverPort}`,
    );
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(
      network.calls.filter((call) => call.port === configuredPort),
    ).toEqual([
      { host, port: configuredPort, phase: "preflight" },
      { host, port: configuredPort, phase: "readiness" },
    ]);
    expect(network.calls.every((call) => call.host === host)).toBe(true);
  });

  test("does not watch a configured port that was already occupied on that host", async () => {
    const f = fixture(readyUrl);
    network.probe = (address, port) =>
      address === host && port === configuredPort;
    f.fetch.mockImplementation(async () => {
      network.phase = "readiness";
      f.close();
      return new Response("not ready", { status: 503 });
    });
    f.options.project.server.startupTimeoutMs = 0;
    await expect(startServer({ ...f.options, configuredPort })).rejects.toThrow(
      "was not ready",
    );
    expect(
      network.calls.filter((call) => call.port === configuredPort),
    ).toEqual([{ host, port: configuredPort, phase: "preflight" }]);
    expect(network.calls.every((call) => call.host === host)).toBe(true);
  });

  function trackSignals(child: ChildProcess) {
    // A closed leader may still have descendants holding the socket open.
    Object.assign(child, { pid: 12345 });
    const signals: NodeJS.Signals[] = [];
    const signal = (value?: number | string) => {
      const name = value as NodeJS.Signals;
      signals.push(name);
      network.phase = name;
      return true as const;
    };
    vi.spyOn(process, "kill").mockImplementation((_pid, value) =>
      signal(value),
    );
    child.kill = vi.fn(signal);
    return signals;
  }

  test("rejects a retained listener despite child exit and polls the host after TERM and KILL", async () => {
    const f = fixture(readyUrl);
    const server = await startServer(f.options);
    expect(f.child.exitCode).toBe(0);
    const signals = trackSignals(f.child);
    network.phase = "initial teardown";
    network.probe = (address, port) => address === host && port === serverPort;
    const begin = network.calls.length;
    await expect(server.stop()).rejects.toThrow(
      `application server did not exit and release port ${serverPort} after SIGKILL`,
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    const calls = network.calls.slice(begin);
    expect(calls[0]).toEqual({
      host,
      port: serverPort,
      phase: "initial teardown",
    });
    for (const phase of ["SIGTERM", "SIGKILL"]) {
      const polls = calls.filter((call) => call.phase === phase);
      expect(polls.length).toBeGreaterThanOrEqual(2);
      expect(
        polls.every((call) => call.host === host && call.port === serverPort),
      ).toBe(true);
    }
    const count = network.calls.length;
    await expect(server.stop()).rejects.toThrow("after SIGKILL");
    expect(network.calls).toHaveLength(count);
  });

  test.each(["SIGTERM", "SIGKILL"])(
    "accepts release during %s polling after child exit",
    async (releasePhase) => {
      const f = fixture(readyUrl);
      const server = await startServer(f.options);
      const signals = trackSignals(f.child);
      network.phase = "initial teardown";
      let polls = 0;
      network.probe = (address, port) => {
        if (address !== host || port !== serverPort) return false;
        if (network.phase === releasePhase) return ++polls < 2;
        return true;
      };
      const begin = network.calls.length;
      await server.stop();
      expect(signals).toEqual(
        releasePhase === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"],
      );
      expect(polls).toBe(2);
      expect(
        network.calls
          .slice(begin)
          .every((call) => call.host === host && call.port === serverPort),
      ).toBe(true);
      const count = network.calls.length;
      await server.stop();
      expect(network.calls).toHaveLength(count);
    },
  );
});
