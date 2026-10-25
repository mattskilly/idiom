import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// A dependency-free app so both revision worktrees run wholly offline.
createServer(async (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(await readFile("index.html"));
}).listen(Number(process.env.PORT), "127.0.0.1");
