import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export async function fixtureServer(port = 0) {
  const html = await readFile(new URL("./page.html", import.meta.url));
  const counts = new Map();
  const sockets = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path.startsWith("/__vite/click/")) {
      const id = path.slice(14);
      counts.set(id, (counts.get(id) ?? 0) + 1);
      response.writeHead(204).end();
      return;
    }
    if (path === "/never" || path === "/no-headers") return;
    if (path === "/loading") {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("<html><body>Still loading");
      return;
    }
    if (path === "/attachment") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="fixture.bin"',
      });
      response.write(Buffer.alloc(1024));
      return;
    }
    // Keep the effect window active for the CLI deadline regression. Quiet
    // controls now finish early, so a long waitMs alone no longer times out.
    const body =
      path === "/continuous-effect"
        ? html
            .toString()
            .replace(
              "</body>",
              `<script>document.querySelector('#print').addEventListener('click',()=>setInterval(()=>{document.body.dataset.probeActivity=String(performance.now())},25))</script></body>`,
            )
        : html;
    response.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    counts,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const fixture = await fixtureServer(Number(process.env.PORT ?? 0));
  console.error(`Fixture ready ${fixture.url}`);
  const stop = () => {
    void fixture.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
