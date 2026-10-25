import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

createServer(async (req, res) => {
  await appendFile(process.env.AUDIT_FILE, `${req.url}\n`);
  res.setHeader("Content-Type", "text/html");
  res.end(
    `<!doctype html><html lang="en"><title>Scope fixture</title><body><main><h1>${req.url}</h1><button onclick="this.textContent='Done'">Continue</button></main></body></html>`,
  );
}).listen(Number(process.env.PORT), "127.0.0.1");
