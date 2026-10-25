import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const port = Number(process.env.PORT);
const primitives = await readFile(new URL("primitives.css", import.meta.url));
const theme = await readFile(new URL("theme.css", import.meta.url));
const page = `<!doctype html>
  <link rel="stylesheet" href="/primitives.css">
  <link rel="stylesheet" href="/theme.css">
  <style>
    #fg, #fg-secondary { color: var(--fg); }
    #muted { color: var(--fg-muted); }
    #accent { color: var(--accent); }
    #direct { color: var(--direct); }
    #undeclared { color: rgb(201, 35, 61); }
  </style>
  <p id="fg">Foreground</p>
  <p id="fg-secondary">Foreground again</p>
  <p id="muted">Muted foreground</p>
  <p id="accent">Accent</p>
  <p id="direct">Direct token</p>
  <p id="undeclared">Undeclared color</p>`;

const server = createServer((request, response) => {
  if (request.url === "/primitives.css") {
    response.writeHead(200, { "content-type": "text/css" });
    response.end(primitives);
    return;
  }
  if (request.url === "/theme.css") {
    response.writeHead(200, { "content-type": "text/css" });
    response.end(theme);
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(page);
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
