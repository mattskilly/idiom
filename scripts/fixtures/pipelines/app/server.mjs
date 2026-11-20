// Static server for public/, with no dependencies.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "public");
const port = Number(process.env.PORT ?? 4317);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

createServer(async (request, response) => {
  request.resume();
  let path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    response.statusCode = 403;
    response.end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.setHeader("content-type", types[extname(file)] ?? "text/plain");
    response.end(body);
  } catch {
    response.statusCode = 404;
    response.end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`sample listening on http://127.0.0.1:${port}/`);
});
