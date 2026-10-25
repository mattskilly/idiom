import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function reportContentSecurityPolicy(interactive = false): string {
  return [
    "default-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    interactive ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export const REPORT_CSP = reportContentSecurityPolicy(true);

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function reportRelativeHref(path: string): string {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "..")
  ) {
    throw new Error(`unsafe report-relative path: ${path}`);
  }
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function pngDataUri(source: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(source).toString("base64")}`;
}

export function badge(label: string, tone = "neutral"): string {
  return `<span class="badge badge-${escapeHtmlAttribute(tone)}">${escapeHtml(label)}</span>`;
}

export function evidenceLink(path: string, label = path): string {
  return `<a href="${escapeHtmlAttribute(reportRelativeHref(path))}">${escapeHtml(label)}</a>`;
}

export function preformatted(label: string, value: string): string {
  return `<section class="evidence"><h5>${escapeHtml(label)}</h5><pre>${escapeHtml(value)}</pre></section>`;
}

export type ImageComparison = {
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  before: string;
  after: string;
};

export function comparison(options: ImageComparison, index: number): string {
  const label = `${options.state} at ${options.viewport}${options.colorScheme === undefined ? "" : ` in ${options.colorScheme}`}`;
  const id = `comparison-${index}`;
  const beforeAlt = `Before: ${label}`;
  const afterAlt = `After: ${label}`;
  return `<section class="comparison" data-comparison>
    <div class="comparison-pair" aria-label="Before and after comparison for ${escapeHtmlAttribute(label)}">
      <figure><figcaption>Before</figcaption><img data-before-source src="${escapeHtmlAttribute(options.before)}" alt="${escapeHtmlAttribute(beforeAlt)}"></figure>
      <figure><figcaption>After</figcaption><img data-after-source src="${escapeHtmlAttribute(options.after)}" alt="${escapeHtmlAttribute(afterAlt)}"></figure>
    </div>
    <div class="comparison-slider">
      <div class="comparison-frame" data-frame aria-hidden="true">
        <div class="comparison-before" data-before></div>
        <div class="comparison-after" data-after></div>
      </div>
      <label for="${id}">Reveal after image</label>
      <input id="${id}" data-slider type="range" min="0" max="100" value="50" aria-valuetext="50 percent after image">
    </div>
  </section>`;
}

const STYLES = `
:root { color-scheme: light dark; --bg: #f7f7f4; --panel: #fff; --text: #1f2521; --muted: #5e6862; --line: #d8ddd9; --accent: #176b4d; --accent-soft: #dff3ea; --danger: #9d2c2c; --warning: #8a5a05; }
@media (prefers-color-scheme: dark) { :root { --bg: #111513; --panel: #1a201d; --text: #edf2ef; --muted: #abb6b0; --line: #39433e; --accent: #75d5ad; --accent-soft: #193b2e; --danger: #ff9a9a; --warning: #f0c36c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(1180px, calc(100% - 32px)); margin: 32px auto 72px; }
.report-actions { width: min(1180px, calc(100% - 32px)); margin: 24px auto -8px; display: flex; justify-content: flex-end; }
.report-actions button { border: 1px solid var(--accent); border-radius: 8px; padding: 9px 14px; background: var(--accent); color: var(--panel); font: inherit; font-weight: 700; cursor: pointer; }
header { margin-bottom: 28px; }
h1, h2, h3, h4, h5 { line-height: 1.2; overflow-wrap: anywhere; }
h1 { font-size: clamp(2rem, 5vw, 3.8rem); letter-spacing: -.04em; margin: 0 0 10px; }
h2 { margin-top: 38px; padding-top: 20px; border-top: 1px solid var(--line); }
h3 { margin-top: 28px; }
h4 { margin-bottom: 8px; }
h5 { margin: 0 0 6px; }
p { max-width: 82ch; }
.muted, .meta { color: var(--muted); }
.summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0; }
.badge { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.badge-good { color: var(--accent); background: var(--accent-soft); }
.badge-blocker, .badge-failed, .badge-reproduced { color: var(--danger); }
.badge-major, .badge-unverifiable { color: var(--warning); }
.panel, .finding, .comparison { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: clamp(14px, 2vw, 24px); margin: 14px 0; box-shadow: 0 6px 24px rgb(0 0 0 / .04); }
.finding > :first-child, .panel > :first-child { margin-top: 0; }
.finding > :last-child, .panel > :last-child { margin-bottom: 0; }
.screenshot { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
a { color: var(--accent); text-underline-offset: 2px; overflow-wrap: anywhere; }
pre { max-height: 34rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border-radius: 8px; background: var(--bg); border: 1px solid var(--line); font: 13px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; }
th, td { padding: 9px 11px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
ul { padding-left: 22px; }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 18px; }
dt { font-weight: 700; }
dd { margin: 0; overflow-wrap: anywhere; }
.comparison-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
figure { margin: 0; min-width: 0; }
figcaption { margin-bottom: 7px; font-weight: 700; }
.comparison-pair img { display: block; width: 100%; height: auto; background: #fff; }
.comparison-frame { position: relative; width: 100%; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.comparison-before, .comparison-after { position: absolute; inset: 0; overflow: hidden; }
.comparison-after { width: 50%; right: auto; box-shadow: inset -2px 0 var(--accent); }
.comparison-before img, .comparison-after img { display: block; width: 100%; height: 100%; max-width: none; object-fit: contain; background: #fff; }
.comparison-after img { width: var(--comparison-width, 200%); }
.comparison-slider { margin-top: 18px; }
.comparison-slider label { display: block; margin-top: 10px; font-weight: 700; }
.comparison-slider input { width: 100%; accent-color: var(--accent); }
@media (max-width: 680px) { main { width: min(100% - 20px, 1180px); margin-top: 20px; } .comparison-pair { grid-template-columns: 1fr; } th, td { min-width: 130px; } }
@page { margin: .6in; }
@media print {
  :root { color-scheme: light; --bg: #fff; --panel: #fff; --text: #171a18; --muted: #4d554f; --line: #bcc3be; --accent: #174f3c; --accent-soft: #e8f2ed; --danger: #7d2020; --warning: #684604; }
  body { background: #fff; color: var(--text); font-size: 11pt; }
  main { width: 100%; margin: 0; }
  .report-actions, .comparison-slider { display: none !important; }
  .panel, .finding, .comparison { box-shadow: none; break-inside: auto; }
  h1, h2, h3, h4, h5, figcaption { break-after: avoid-page; }
  pre { max-height: none; overflow: visible; white-space: pre-wrap; overflow-wrap: anywhere; }
  table { display: table; overflow: visible; table-layout: fixed; }
  th, td { min-width: 0; overflow-wrap: anywhere; }
  .screenshot, .comparison-pair img { max-height: 8in !important; width: auto; max-width: 100%; object-fit: contain; break-inside: avoid-page; }
  .comparison-pair { align-items: start; }
  a { color: inherit; }
}
`;

const SCRIPT = `
for (const root of document.querySelectorAll('[data-comparison]')) {
  const slider = root.querySelector('[data-slider]');
  const frame = root.querySelector('[data-frame]');
  const beforePane = root.querySelector('[data-before]');
  const after = root.querySelector('[data-after]');
  const beforeSource = root.querySelector('[data-before-source]');
  const afterSource = root.querySelector('[data-after-source]');
  if (!(slider instanceof HTMLInputElement) || !(frame instanceof HTMLElement) || !(beforePane instanceof HTMLElement) || !(after instanceof HTMLElement) || !(beforeSource instanceof HTMLImageElement) || !(afterSource instanceof HTMLImageElement)) continue;
  const update = () => {
    const value = Number(slider.value);
    after.style.width = value + '%';
    const image = after.querySelector('img');
    if (image instanceof HTMLElement && value > 0) image.style.setProperty('--comparison-width', (10000 / value) + '%');
    slider.setAttribute('aria-valuetext', value + ' percent after image');
  };
  const prepare = () => {
    if (beforeSource.naturalWidth === 0 || afterSource.naturalWidth === 0 || beforePane.childElementCount > 0) return;
    const beforeRatio = beforeSource.naturalHeight / beforeSource.naturalWidth;
    const afterRatio = afterSource.naturalHeight / afterSource.naturalWidth;
    frame.style.aspectRatio = String(1 / Math.max(beforeRatio, afterRatio));
    const beforeImage = beforeSource.cloneNode();
    const afterImage = afterSource.cloneNode();
    beforeImage.removeAttribute('data-before-source');
    afterImage.removeAttribute('data-after-source');
    beforeImage.alt = '';
    afterImage.alt = '';
    beforePane.append(beforeImage);
    after.append(afterImage);
    update();
  };
  beforeSource.addEventListener('load', prepare, { once: true });
  afterSource.addEventListener('load', prepare, { once: true });
  slider.addEventListener('input', update);
  update();
  prepare();
}
`;

const PRINT_SCRIPT = `
const printReport = document.querySelector('[data-print-report]');
if (printReport instanceof HTMLButtonElement) {
  printReport.addEventListener('click', () => window.print());
}
`;

export function renderHtmlDocument(options: {
  title: string;
  body: string;
  interactive?: boolean | undefined;
  printable?: boolean | undefined;
  styles?: string | undefined;
  script?: string | undefined;
}): string {
  const scripted =
    options.interactive === true ||
    options.printable === true ||
    options.script !== undefined;
  const csp = reportContentSecurityPolicy(scripted);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">
  <title>${escapeHtml(options.title)}</title>
  <style>${STYLES}${options.styles ?? ""}</style>
</head>
<body>
${options.printable === true ? '<div class="report-actions" data-report-controls><button type="button" data-print-report>Print or save as PDF</button></div>' : ""}
<main>${options.body}</main>
${scripted ? `<script>${options.interactive === true ? SCRIPT : ""}${options.printable === true ? PRINT_SCRIPT : ""}${options.script ?? ""}</script>` : ""}
</body>
</html>
`;
}

export async function writeHtmlReport(
  directory: string,
  source: string,
): Promise<string> {
  const path = join(directory, "report.html");
  const temporary = `${path}.tmp`;
  await writeFile(temporary, source);
  await rename(temporary, path);
  return path;
}

export async function writeHtmlFile(
  directory: string,
  filename: string,
  source: string,
): Promise<string> {
  const path = join(directory, filename);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, source);
  await rename(temporary, path);
  return path;
}
