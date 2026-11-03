import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const pages = {
  catalog: "Catalog",
  orders: "Orders",
  customers: "Customers",
  settings: "Settings",
  team: "Team",
};
const style = `
:root { color-scheme: light dark; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #f6f7f9; color: #1f2933; }
@media (prefers-color-scheme: dark) { body { background: #111418; color: #e6e9ee; } }
header { display: flex; gap: 16px; align-items: center; padding: 12px 24px; border-bottom: 1px solid #d5d9e0; }
nav { display: flex; gap: 12px; }
nav a { color: inherit; }
main { padding: 24px; display: grid; gap: 16px; max-width: 960px; }
.toolbar, form { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; padding: 6px 12px; border: 1px solid #9aa3af; border-radius: 6px; background: #ffffff; color: #1f2933; }
[role=menu] { display: grid; gap: 4px; padding: 8px; border: 1px solid #9aa3af; border-radius: 6px; background: #ffffff; }
dialog { border: 1px solid #9aa3af; border-radius: 8px; }
`;
const controls = (page) => `
<div class="toolbar" aria-label="${page} actions">
  ${["Refresh", "Export", "Share", "Duplicate", "Archive view", "Pin"]
    .map(
      (label) =>
        `<button type="button" onclick="this.dataset.done = '1'; document.getElementById('status').textContent = '${label} done'">${label}</button>`,
    )
    .join("\n  ")}
  <button type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="sort-menu" onclick="const m = document.getElementById('sort-menu'); m.hidden = !m.hidden; this.setAttribute('aria-expanded', String(!m.hidden))">Sort</button>
  <div id="sort-menu" role="menu" hidden>
    <button type="button" role="menuitem" onclick="document.getElementById('status').textContent = 'Sorted by name'">Name</button>
    <button type="button" role="menuitem" onclick="document.getElementById('status').textContent = 'Sorted by date'">Date</button>
  </div>
  <button type="button" onclick="document.getElementById('details').showModal()">Open details</button>
</div>
<form aria-label="${page} filters" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'Filtered'">
  ${[
    "Active",
    "Archived",
    "Recent",
    "Starred",
    "Shared",
    "Mine",
    "Overdue",
    "Drafts",
  ]
    .map(
      (label) =>
        `<button type="submit" name="filter" value="${label}">${label}</button>`,
    )
    .join("\n  ")}
</form>
<p id="status" role="status" aria-live="polite"></p>
<dialog id="details" aria-label="${page} details"><p>${page} details</p><button type="button" onclick="this.closest('dialog').close()">Close</button></dialog>`;

createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://fixture").pathname;
  if (path === "/ready") {
    response.end("ok");
    return;
  }
  const id = path.replace(/^\//, "");
  const title = pages[id];
  if (title === undefined) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  const card =
    id === "orders"
      ? `<style>${await readFile(new URL("./components/Card.module.css", import.meta.url), "utf8")}</style>
<section class="card" aria-label="Order summary"><h2>Order summary</h2><p>3 orders awaiting review.</p><button type="button" onclick="document.getElementById('status').textContent = 'Reviewed'">Review orders</button></section>`
      : "";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${style}</style></head>
<body><header><strong>Gate fixture</strong><nav aria-label="Primary">${Object.entries(
    pages,
  )
    .map(
      ([key, label]) =>
        `<a href="/${key}"${key === id ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav></header>
<main><h1>${title}</h1>${card}${controls(title)}</main></body></html>`);
}).listen(Number(process.env.PORT), "127.0.0.1");
