import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/" || path === "/canvas") {
    response.setHeader("Content-Type", "text/html");
    response.end(await readFile(new URL("canvas.html", import.meta.url)));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
server.listen(Number(process.env.PORT), "127.0.0.1");
