import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// One route, sixteen editor views. Only `text-selected` and `heading-editing`
// render the floating text toolbar, styled by components/Toolbar.module.css
// (read on every request, hashed like a CSS-module build).
const views = [
  ["empty-canvas", "Empty canvas"],
  ["page-selected", "Page selected"],
  ["section-selected", "Section selected"],
  ["layers-open", "Layers open"],
  ["layers-dragging", "Layer dragging"],
  ["inspector-layout", "Layout inspector"],
  ["inspector-style", "Style inspector"],
  ["library-open", "Library open"],
  ["library-search", "Library search"],
  ["image-selected", "Image selected"],
  ["button-selected", "Button block selected"],
  ["form-selected", "Form selected"],
  ["text-selected", "Text selected"],
  ["publish-dialog", "Publish"],
  ["heading-editing", "Heading editing"],
  ["preview-mode", "Preview"],
];
const toolbarViews = new Set(["text-selected", "heading-editing"]);
const hashed = {
  toolbar: "Toolbar_toolbar__k3x9",
  button: "Toolbar_button__p7q2",
};

const style = `
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #f6f7f9; color: #1f2933; }
@media (prefers-color-scheme: dark) { body { background: #111418; color: #e6e9ee; } }
.Header_bar__h1x2 { display: flex; gap: 12px; align-items: center; padding: 8px 16px; border-bottom: 1px solid #d5d9e0; }
.Editor_shell__e4r5 { display: grid; grid-template-columns: 200px 1fr 220px; gap: 16px; padding: 16px; }
.Canvas_stage__c2v8 { min-height: 240px; padding: 16px; border: 1px dashed #9aa3af; border-radius: 8px; background: #ffffff; color: #1f2933; }
.Panel_list__l5m1 { display: grid; gap: 6px; align-content: start; }
.Panel_action__q9w3 { font: inherit; padding: 4px 10px; border: 1px solid #9aa3af; border-radius: 6px; background: #ffffff; color: #1f2933; }
@media (max-width: 640px) { .Editor_shell__e4r5 { grid-template-columns: 1fr; } }
`;

const panel = (id, title) => {
  const actions = {
    "layers-open": ["Group", "Hide layer", "Lock layer"],
    "layers-dragging": ["Drop above", "Drop below"],
    "inspector-layout": ["Stack", "Grid", "Free"],
    "inspector-style": ["Fill", "Stroke", "Shadow"],
    "library-open": ["Insert section", "Insert hero"],
    "library-search": ["Search blocks"],
    "image-selected": ["Replace image", "Crop"],
    "button-selected": ["Edit link", "Style button"],
    "form-selected": ["Add field", "Edit fields"],
    "publish-dialog": ["Publish now", "Schedule"],
    "preview-mode": ["Exit preview"],
  }[id] ?? ["Add block"];
  return `<section class="Panel_list__l5m1 Panel_${id.replace(/-/g, "")}__x0" aria-label="${title} panel">${actions
    .map(
      (label) =>
        `<button type="button" class="Panel_action__q9w3" onclick="document.getElementById('status').textContent = '${label}'">${label}</button>`,
    )
    .join("")}</section>`;
};

const toolbar = async () => {
  let css = await readFile(
    new URL("./components/Toolbar.module.css", import.meta.url),
    "utf8",
  );
  for (const [key, name] of Object.entries(hashed))
    css = css.replace(new RegExp(`\\.${key}\\b`, "g"), `.${name}`);
  return `<style>${css}</style><div class="${hashed.toolbar}" role="toolbar" aria-label="Text formatting">${[
    "Bold",
    "Italic",
    "Underline",
    "Link",
    "Align",
  ]
    .map(
      (label) =>
        `<button type="button" class="${hashed.button}" onclick="document.getElementById('status').textContent = '${label} applied'">${label}</button>`,
    )
    .join("")}</div>`;
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture");
  if (url.pathname === "/ready") {
    response.end("ok");
    return;
  }
  const view = views.find(([id]) => id === url.searchParams.get("view"));
  if (url.pathname !== "/editor" || !view) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }
  const [id, title] = view;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Builder</title><style>${style}</style></head>
<body><header class="Header_bar__h1x2"><strong>Builder fixture</strong><span>${title}</span></header>
<main class="Editor_shell__e4r5"><nav class="Panel_list__l5m1" aria-label="Pages"><a href="/editor?view=empty-canvas">Home page</a></nav>
<div class="Canvas_stage__c2v8"><h1>${title}</h1>${toolbarViews.has(id) ? await toolbar() : ""}<p>Edit the page on the canvas.</p></div>
${panel(id, title)}</main><p id="status" role="status" aria-live="polite"></p></body></html>`);
}).listen(Number(process.env.PORT), "127.0.0.1");
