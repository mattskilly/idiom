// Serves each route from the page source in the server's working directory,
// so a capture of an older commit (its own worktree) serves that commit's
// markup: `app/<route>/page.tsx` carries it on a `// html:` line.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

createServer(async (req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/ready") return res.end("ok");
  const source = await readFile(
    join(process.cwd(), "app", req.url ?? "/", "page.tsx"),
    "utf8",
  ).catch(() => "");
  const body = /^\/\/ html: (.*)$/m.exec(source)?.[1] ?? "<h1>missing</h1>";
  res.end(
    `<!doctype html><html lang="en"><title>Base fixture</title><body><main>${body}</main></body></html>`,
  );
}).listen(Number(process.env.PORT), "127.0.0.1");
