import { escapeHtml, escapeHtmlAttribute } from "../report/html.js";
import type { HostedReport } from "./schema.js";

export const reportHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
export function renderHostedReport(
  id: string,
  report: HostedReport,
  expiresAt: number,
): string {
  const images = (names: string[], label: string) =>
    names
      .map(
        (name, index) =>
          `<figure><img src="/api/hosted-asset?id=${id}&amp;name=${name}" alt="${escapeHtmlAttribute(label)} ${index + 1}" loading="lazy"></figure>`,
      )
      .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Idiom · design review</title><style>
  :root{color-scheme:light dark;--bg:#fafaf8;--fg:#111113;--muted:#555;--line:#ccc;--redline:#bf271f}@media(prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f5f5f1;--muted:#bbb;--line:#555;--redline:#ff786c}}*{box-sizing:border-box}body{margin:auto;padding:24px;max-width:1050px;background:var(--bg);color:var(--fg);font:18px/1.6 system-ui,sans-serif}header{border-bottom:2px solid var(--redline)}h1,h2,h3,code,.meta{font-family:ui-monospace,monospace}h1{font-size:2rem}h2{margin-top:2.5rem}p,li,code{overflow-wrap:anywhere}img{max-width:100%;height:auto;border:1px solid var(--line)}figure{margin:16px 0}a{color:var(--redline)}button{font:inherit;padding:10px;background:var(--bg);color:var(--fg);border:1px solid var(--fg);cursor:pointer}:focus-visible{outline:3px solid var(--redline);outline-offset:4px}.meta{color:var(--muted);font-size:14px}article{border-top:1px solid var(--line);padding:16px 0}pre{white-space:pre-wrap}#delete-report[hidden]{display:none}
  </style><script src="/hosted/report.js" defer></script></head><body data-report-id="${id}"><header><a href="/">idiom.</a><h1>Design review</h1><p>${escapeHtml(report.target)}</p><p class="meta">Measured checks and a strict read-only interaction probe. Expires ${escapeHtml(new Date(expiresAt).toISOString())}.</p></header>
  <main><h2>Top issues</h2>${report.issues.length ? report.issues.map((issue, i) => `<article><h3>${i + 1}. ${escapeHtml(issue.title)}</h3><p class="meta">${escapeHtml(issue.severity)}</p><p>${escapeHtml(issue.detail)}</p>${images(issue.assets, "Issue evidence")}</article>`).join("") : "<p>No measured issues were found in the checked surfaces. This is not a guarantee that the page has no design problems.</p>"}
  <h2>Between states</h2>${report.filmstrips.length ? images(report.filmstrips, "Filmstrip") : "<p>No filmstrip evidence was available for the checked actions.</p>"}
  <h2>Design drift</h2><p>${escapeHtml(report.design.detail)}</p>${images(report.design.assets, "Design comparison")}
  <h2>Coverage · what was not checked</h2><ul>${report.coverage.map((entry) => `<li>${escapeHtml(entry)}</li>`).join("")}</ul>
  <h2>Fix these with your agent</h2><p>Install Idiom and give your agent the report.</p><pre><code>npm install -g @mattskilly/idiom</code></pre><p><a href="/guide">Set up the MCP server</a>, then ask your agent to call <code>idiom_quick</code> with your URL. Idiom checks; your agent makes the repairs.</p>
  <p><a href="/r/${id}" id="share-report">Share this unlisted report</a> <button type="button" id="copy-report">Copy link</button></p><p class="meta">Anyone with the link can read it until expiry or deletion. The link grants no deletion access. Delivery is limited; use the CLI for continued review.</p><button id="delete-report" type="button" hidden>Delete report</button><p id="report-status" role="status" aria-live="polite"></p></main></body></html>`;
}
