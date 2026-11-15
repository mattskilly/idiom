import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// Serves the canvas page next to this script; the test rewrites it to fix the chip.
createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path !== "/") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(await readFile(new URL("index.html", import.meta.url)));
}).listen(Number(process.env.PORT), "127.0.0.1");
