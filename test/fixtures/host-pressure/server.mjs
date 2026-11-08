import { createServer } from "node:http";

const counts = new Map();
const events = [];
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  if (path === "/ready") return response.end("ready");
  if (path === "/events") return response.end(JSON.stringify(events));
  const count = (counts.get(path) ?? 0) + 1;
  counts.set(path, count);
  events.push(`${path}:${count}`);
  if (path === "/stall" && count === 1) return;
  response.setHeader("Content-Type", "text/html");
  if (path === "/tall")
    return response.end(
      '<!doctype html><html lang="en"><head><title>Tall</title></head><body style="margin:0;height:40000px;background:#00f"><main><h1 style="margin:0">Ready</h1></main></body></html>',
    );
  response.end(
    `<!doctype html><html lang="en"><head><title>Ready</title></head><body><main><h1>${path === "/wait" && count === 1 ? "Waiting" : "Ready"}</h1></main></body></html>`,
  );
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
