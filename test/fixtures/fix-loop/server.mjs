import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const server = createServer(async (_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(await readFile("page.html"));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
