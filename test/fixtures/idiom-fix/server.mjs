import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

// Serves the orders page, inlining components/Toolbar.module.css read on each
// request from the server's working directory, so a stylesheet edit changes
// what renders and a capture of an older commit (its own worktree) serves
// that commit's stylesheet.
const style = `
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #f6f7f9; color: #1f2933; }
main { padding: 24px; display: grid; gap: 16px; max-width: 960px; }
button { font: inherit; padding: 6px 12px; border: 1px solid #6b7280; border-radius: 6px; background: #ffffff; color: #1f2933; }
`;

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://fixture").pathname;
  if (path === "/ready") {
    response.end("ok");
    return;
  }
  if (path !== "/orders") {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  const toolbar = await readFile(
    join(process.cwd(), "components", "Toolbar.module.css"),
    "utf8",
  );
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Orders</title><style>${style}</style><style>${toolbar}</style></head>
<body><main><h1>Orders</h1><p>3 orders awaiting review.</p>
<div class="toolbar" role="toolbar" aria-label="Order actions">
  <button type="button" onclick="document.getElementById('status').textContent = 'Refreshed'">Refresh</button>
  <button type="button" onclick="document.getElementById('status').textContent = 'Exported'">Export</button>
  <button type="button" onclick="document.getElementById('status').textContent = 'Shared'">Share</button>
</div>
<p id="status" role="status" aria-live="polite"></p></main></body></html>`);
}).listen(Number(process.env.PORT), "127.0.0.1");
