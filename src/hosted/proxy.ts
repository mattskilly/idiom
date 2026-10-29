import {
  Agent,
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
} from "node:http";
import { connect, type Socket } from "node:net";
import type { Readable } from "node:stream";
import { safeRequestMethod } from "../capture/request-policy.js";
import { LIMITS } from "./config.js";
import { HostedError } from "./errors.js";
import type { NetworkBudget } from "./network.js";
import { type Resolver, resolvePublic } from "./ssrf.js";

export type Dialer = (address: string, port: number, family: number) => Socket;
const systemDial: Dialer = (host, port, family) =>
  connect({ host, port, family });
/** HTTP forwarding + TLS tunnelling. Every socket is opened to a checked numeric address. */
export async function startProxy(
  budget: NetworkBudget,
  seams: { resolver?: Resolver; dial?: Dialer } = {},
) {
  const sockets = new Set<Socket>();
  const open = async (url: string) => {
    budget.check();
    if (budget.active >= LIMITS.connections) throw new HostedError("failed");
    budget.active++;
    try {
      const target = await resolvePublic(url, seams.resolver, budget.signal);
      budget.check();
      const socket = (seams.dial ?? systemDial)(
        target.address,
        Number(target.url.port) ||
          (target.url.protocol === "https:" ? 443 : 80),
        target.family,
      );
      sockets.add(socket);
      socket.setTimeout(10_000, () => socket.destroy());
      socket.once("close", () => {
        sockets.delete(socket);
        budget.active--;
      });
      socket.on("error", () => {});
      return { socket, target: target.url };
    } catch (error) {
      budget.active--;
      throw error;
    }
  };
  const meter = (source: Readable, peer: { destroy(): unknown }) => {
    source.on("data", (chunk: Buffer) => {
      try {
        budget.transfer(chunk.length);
      } catch {
        source.destroy();
        peer.destroy();
      }
    });
  };
  const server = createServer(async (req, res) => {
    let upstream: Socket | undefined;
    try {
      if (
        !safeRequestMethod(req.method ?? "") ||
        !req.url?.startsWith("http://") ||
        req.headers.upgrade
      )
        throw new HostedError("blocked-url");
      budget.request();
      const { socket, target } = await open(req.url);
      upstream = socket;
      const headers: OutgoingHttpHeaders = {
        ...req.headers,
        host: target.host,
        connection: "close",
      };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      // Never forward hop-by-hop connection tokens from untrusted callers.
      for (const token of (req.headers.connection ?? "").split(","))
        if (
          token.trim() &&
          !["host", "connection"].includes(token.trim().toLowerCase())
        )
          delete headers[token.trim().toLowerCase()];
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const outgoing = httpRequest(
        {
          method: req.method,
          path: `${target.pathname}${target.search}`,
          host: target.hostname,
          port: target.port || 80,
          headers,
          agent,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, {
            ...response.headers,
            connection: "close",
          });
          meter(response, res);
          response.pipe(res);
        },
      );
      meter(req, socket);
      outgoing.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
        socket.destroy();
      });
      req.on("aborted", () => outgoing.destroy());
      res.on("close", () => socket.destroy());
      req.pipe(outgoing);
    } catch {
      budget.note("proxy destination or budget blocked");
      upstream?.destroy();
      res.writeHead(403);
      res.end();
    }
  });
  server.on("connect", async (req, client, head) => {
    let upstream: Socket | undefined;
    try {
      // CONNECT accepts an authority only, including a validated explicit port.
      if (
        !req.url ||
        !/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):\d{1,5}$/i.test(req.url)
      )
        throw new HostedError("blocked-url");
      budget.request();
      const { socket } = await open(`https://${req.url}/`);
      upstream = socket;
      client.on("error", () => socket.destroy());
      socket.on("error", () => client.destroy());
      client.on("close", () => socket.destroy());
      socket.on("close", () => client.destroy());
      const connected = () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        budget.transfer(head.length);
        if (head.length) socket.write(head);
        meter(client, socket);
        meter(socket, client);
        client.pipe(socket);
        socket.pipe(client);
      };
      if (socket.connecting) socket.once("connect", connected);
      else connected();
    } catch {
      budget.note("proxy tunnel blocked");
      upstream?.destroy();
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("upgrade", (_req, socket) => {
    budget.note("proxy upgrades disabled");
    socket.destroy();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const clients = new Set<Socket>();
  server.on("connection", (socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    if (clients.size > 64) socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new HostedError("unavailable");
  const close = async () => {
    budget.signal.removeEventListener("abort", abort);
    for (const socket of [...sockets, ...clients]) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const abort = () => {
    void close();
  };
  budget.signal.addEventListener("abort", abort, { once: true });
  if (budget.signal.aborted) {
    await close();
    throw new HostedError("timeout");
  }
  return { url: `http://127.0.0.1:${address.port}`, close };
}
