import { existsSync } from "node:fs";
import { createServer } from "node:http";

// `/held` waits while the parent test's HOLD_FILE exists, so a test can
// interrupt a run after its other tuples finished without guessing timing.
const page = (title) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`;
const server = createServer((request, response) => {
  const send = () => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(page(request.url === "/held" ? "Held" : "Home"));
  };
  if (request.url !== "/held") return send();
  const poll = setInterval(() => {
    if (existsSync(process.env.HOLD_FILE ?? "")) return;
    clearInterval(poll);
    send();
  }, 25);
  request.on("close", () => clearInterval(poll));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
