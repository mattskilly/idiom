import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, normalize } from "node:path";

const root = join(import.meta.dirname, "fixtures/benchmark");

export type LoadingServer = {
  origin: string;
  /** Requests other than GET/HEAD the app server received. */
  nonGet: string[];
  close(): Promise<void>;
};

/**
 * Serves the benchmark fixtures over HTTP with the small JSON API they call,
 * and counts every non-GET request that actually reached the server.
 */
export async function startLoadingServer(): Promise<LoadingServer> {
  const nonGet: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD")
      nonGet.push(`${method} ${url.pathname}`);
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    switch (url.pathname) {
      case "/api/items":
        return json(["Alpha", "Beta", "Gamma"]);
      case "/api/save":
        return json({ ok: true });
      case "/api/page":
        return json({ title: "Orders", body: "Three open orders." });
      case "/api/track":
        response.writeHead(204);
        return response.end();
      case "/next":
      case "/orders":
        response.writeHead(200, { "content-type": "text/html" });
        return response.end(
          '<!doctype html><html lang="en"><title>Next</title><main><h1>Next</h1></main></html>',
        );
    }
    const file = normalize(join(root, url.pathname));
    if (!file.startsWith(root)) {
      response.writeHead(403);
      return response.end();
    }
    readFile(file).then(
      (body) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(body);
      },
      () => {
        response.writeHead(404);
        response.end();
      },
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    nonGet,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
