import { renderCoverageHtml } from "../report/coverage.js";
import {
  escapeHtml,
  escapeHtmlAttribute,
  renderHtmlDocument,
} from "../report/html.js";
import { compareValueDrift } from "./drift.js";
import { normalizeCssValues } from "./learn/normalize.js";
import type {
  EvidenceCoordinate,
  ObservedValue,
  SystemPageModel,
} from "./types.js";

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function coordinateLabel(point: EvidenceCoordinate): string {
  return `${point.flow} / ${point.state} / ${point.viewport} / ${point.colorScheme}`;
}

function provenance(value: ObservedValue): string {
  return `<ul class="coordinates">${value.coordinates
    .map(
      (point) => `<li><code>${escapeHtml(coordinateLabel(point))}</code></li>`,
    )
    .join("")}</ul>`;
}

function tokenSection(model: SystemPageModel): string {
  if (model.tokens.status === "not-configured")
    return `<section id="design-tokens"><h2>Design tokens</h2><div class="empty-state"><p><code>design.tokensFile</code> is not configured. Authored tokens are unavailable.</p></div></section>`;
  return `<section id="design-tokens"><h2>Design tokens</h2><p class="section-intro">Declarations from <code>${escapeHtml(model.tokens.source)}</code> and confirmed inline tokens. Supporting local declarations resolve aliases.</p><div class="token-grid">${model.tokens.tokens
    .map((token, index) => {
      const unavailable =
        token.resolution.status === "unavailable"
          ? `<p class="token-state warning">${escapeHtml(token.resolution.reason)}</p>`
          : '<p class="token-state muted" data-token-state>Checking whether this value resolves to a colour…</p>';
      return `<article class="token" data-token-index="${index}" data-token-name="${escapeHtmlAttribute(token.name)}" data-token-value="${escapeHtmlAttribute(token.resolved ?? token.value)}" data-token-resolution="${token.resolution.status}"><div class="token-swatch" data-token-swatch hidden aria-label="Colour swatch for ${escapeHtmlAttribute(token.name)}"><span data-swatch-light></span><span data-swatch-dark></span></div><div><h3><code>${escapeHtml(token.name)}</code></h3><p class="token-value"><code>${escapeHtml(token.value)}</code></p>${unavailable}</div></article>`;
    })
    .join("")}</div></section>`;
}

function driftSection(model: SystemPageModel): string {
  const drift = model.drift;
  if (!drift)
    return '<section id="token-drift"><h2>Token drift</h2><p>Drift unavailable: no comparison evidence.</p></section>';
  const rows = drift.declarations
    .map(
      (t) =>
        `<tr><td><code>${escapeHtml(t.name)}</code></td><td>${escapeHtml(t.kind)}</td><td>${escapeHtml(t.source.path)}:${escapeHtml(t.source.key)}${t.theme === undefined ? "" : ` · theme ${escapeHtml(t.theme)}`}</td><td><code>${escapeHtml(t.value)}</code></td><td><code>${escapeHtml(t.resolved ?? t.value)}</code></td></tr>`,
    )
    .join("");
  return `<section id="token-drift"><h2>Token drift</h2><p>${drift.proposed ? "Transient proposed declarations (not confirmed configuration). " : "Current declared tokens. "}${drift.status === "available" ? `Value coverage in capture <code>${escapeHtml(drift.runId ?? "")}</code> at ${escapeHtml(drift.capturedAt ?? "")}. “Not observed” applies only to this selected capture; equal-valued aliases share coverage.` : escapeHtml(drift.reason ?? "No complete capture; drift unavailable.")}</p><div data-drift-results><p>Checking token drift in this browser…</p></div><details><summary>Source declarations and resolved CSS values (${drift.declarations.length})</summary><table><thead><tr><th>Name</th><th>Kind</th><th>Source / theme</th><th>Authored</th><th>Resolved CSS</th></tr></thead><tbody>${rows}</tbody></table></details></section>`;
}

function observedList(
  title: string,
  values: ObservedValue[],
  color = false,
): string {
  if (values.length === 0)
    return `<section class="observed-group"><h3>${escapeHtml(title)}</h3><p>none</p></section>`;
  return `<section class="observed-group"><h3>${escapeHtml(title)}</h3><div class="observed-list">${values
    .map(
      (entry) =>
        `<article class="observed-value">${color ? `<span class="observed-swatch" data-observed-color="${escapeHtmlAttribute(entry.value)}" aria-hidden="true"></span>` : ""}<div><code>${escapeHtml(entry.value)}</code>${provenance(entry)}</div></article>`,
    )
    .join("")}</div></section>`;
}

function observedSection(model: SystemPageModel): string {
  if (model.observed.status === "unavailable")
    return `<section id="observed"><h2>Observed palette and typography</h2><div class="empty-state"><p>${escapeHtml(model.observed.reason)} Observed values cannot be inferred without a complete capture.</p></div></section>`;
  const observed = model.observed;
  return `<section id="observed"><h2>Observed palette and typography</h2><p class="section-intro">Rendered evidence from capture <code>${escapeHtml(observed.runId)}</code>, selected at ${escapeHtml(observed.capturedAt)}. Each value names at least one flow / state / viewport / scheme coordinate.</p>${observedList("Palette", observed.colors, true)}<div class="type-columns">${observed.typographyAvailable ? `${observedList("Font families", observed.fontFamilies)}${observedList("Font sizes", observed.fontSizes)}${observedList("Font weights", observed.fontWeights)}` : '<section class="observed-group"><h3>Typography</h3><div class="empty-state"><p>Typography is unavailable because this capture uses legacy observations without computed type facts.</p></div></section>'}</div></section>`;
}

function lawSection(model: SystemPageModel): string {
  return `<section id="design-law"><h2>Design law</h2>${model.designLaw.trim() === "" ? "<p>No human-authored design law is recorded.</p>" : `<pre class="law">${escapeHtml(model.designLaw)}</pre>`}</section>`;
}

function rulingsSection(model: SystemPageModel): string {
  const content =
    model.rulings.length === 0
      ? "<p>No recorded rulings.</p>"
      : model.rulings
          .map(
            (ruling) =>
              `<article class="panel ruling"><h3>${escapeHtml(ruling.id)} · ${escapeHtml(ruling.choiceKey)}</h3><p>${ruling.outcome === "rule" ? escapeHtml(ruling.wording as string) : "No rule needed — deliberately left unruled."}</p><p class="meta">${escapeHtml(ruling.outcome)} · ${escapeHtml(ruling.recordedAt)} · <code>${escapeHtml(ruling.fingerprint)}</code></p></article>`,
          )
          .join("");
  return `<section id="recorded-rulings"><h2>Recorded rulings</h2>${content}</section>`;
}

function prohibitionsSection(model: SystemPageModel): string {
  let content: string;
  if (!model.decisionsAvailable)
    content =
      '<div class="empty-state"><p>The decision log is empty. No standing prohibitions are recorded.</p></div>';
  else if (model.prohibitions.length === 0)
    content = "<p>No standing rule-scope rejections are current.</p>";
  else
    content = model.prohibitions
      .map((prohibition) => {
        const reason = prohibition.reason ?? "No reason recorded";
        if (prohibition.kind === "degraded")
          return `<article class="panel prohibition"><h3>Rejected pattern <code>${escapeHtml(prohibition.fingerprint)}</code></h3><p>Descriptive finding evidence is unavailable.</p><p><strong>Reason:</strong> ${escapeHtml(reason)}</p></article>`;
        const evidence =
          (prohibition.images?.length ?? 0) === 0
            ? '<p class="muted">Screenshot evidence is unavailable in the reachable reports store.</p>'
            : `<div class="evidence-grid">${(prohibition.images ?? [])
                .map(
                  (image) =>
                    `<figure><img class="screenshot" src="${escapeHtmlAttribute(image.dataUri)}" alt="Evidence for ${escapeHtmlAttribute(prohibition.key)}"><figcaption>${escapeHtml(image.path)}</figcaption></figure>`,
                )
                .join("")}</div>`;
        return `<article class="panel prohibition"><h3>${escapeHtml(prohibition.key)}</h3><p>${escapeHtml(prohibition.behavior)}</p><dl><dt>Rule</dt><dd>${escapeHtml(prohibition.rule)}</dd><dt>Reason</dt><dd>${escapeHtml(reason)}</dd><dt>First observed</dt><dd><code>${escapeHtml(prohibition.surface)}</code></dd></dl>${evidence}</article>`;
      })
      .join("");
  return `<section id="standing-prohibitions"><h2>Standing prohibitions</h2>${content}</section>`;
}

function coverageSection(model: SystemPageModel): string {
  if (model.coverage.status === "unavailable")
    return `<section id="coverage"><h2>Coverage</h2><div class="empty-state"><p>${escapeHtml(model.coverage.reason)} Judged, governed-but-not-judged, and ungoverned surfaces are unavailable.</p></div></section>`;
  const rendered = renderCoverageHtml(model.coverage.value)
    .replace('id="coverage-heading">Coverage and limits', ">Coverage details")
    .replace('aria-labelledby="coverage-heading"', "");
  return `<section id="coverage"><h2>Coverage</h2><p class="section-intro">Newest completed review: <code>${escapeHtml(model.coverage.runId)}</code> at ${escapeHtml(model.coverage.reviewedAt)}.</p>${rendered}</section>`;
}

const SYSTEM_STYLES = `
.system-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; }
.system-kicker { color: var(--accent); font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
.section-intro { color: var(--muted); }
.empty-state { border: 1px dashed var(--line); border-radius: 12px; padding: 12px 18px; color: var(--muted); }
.token-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 12px; }
.token { min-width: 0; display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 14px; align-items: center; border: 1px solid var(--line); border-radius: 12px; padding: 14px; background: var(--panel); }
.token h3, .token p { margin: 0; }
.token-value { overflow-wrap: anywhere; }
.token-state { margin-top: 5px !important; font-size: .85rem; }
.token-swatch { width: 72px; height: 72px; overflow: hidden; display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); border-radius: 10px; background: repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 50% / 12px 12px; }
.token-swatch[hidden] { display: none !important; }
.token-swatch span { min-width: 0; }
.warning { color: var(--warning); }
.observed-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.observed-value { display: flex; gap: 12px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.observed-swatch { flex: 0 0 42px; width: 42px; height: 42px; border: 1px solid var(--line); border-radius: 8px; }
.coordinates { margin: 6px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: .78rem; }
.type-columns { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.law { max-height: none; font-family: inherit; font-size: 1rem; line-height: 1.6; }
.evidence-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.evidence-grid figcaption { color: var(--muted); font-size: .8rem; }
@media (max-width: 760px) { .system-header { grid-template-columns: 1fr; } .type-columns { grid-template-columns: 1fr; } }
@media print {
  .token-grid, .observed-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .type-columns { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .token, .observed-value { break-inside: avoid-page; }
  .token-swatch, .token-swatch span, .observed-swatch { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

function systemScript(model: SystemPageModel): string {
  const environment =
    model.tokens.status === "configured" ? model.tokens.environment : {};
  return `
const normalizeDriftCss = ${normalizeCssValues.toString()};
const compareDrift = ${compareValueDrift.toString()};
const driftInput = ${scriptJson(model.drift ?? null)};
if (driftInput) {
  const result = compareDrift(driftInput, normalizeDriftCss);
  const container = document.querySelector('[data-drift-results]');
  if (container) {
    container.replaceChildren();
    for (const [key,title] of [['uncovered','Uncovered values'],['notObserved','Tokens not observed in this capture'],['unresolved','Unresolved / coverage limitations'],['unconfigured','Unconfigured categories']]) {
      const heading = document.createElement('h3'); heading.textContent = title; container.append(heading);
      const list = document.createElement('ul');
      for (const text of result[key].length ? result[key] : [driftInput.status === 'available' ? 'None' : 'Unavailable without a complete capture']) {const item = document.createElement('li');item.textContent = text;list.append(item);}
      container.append(list);
    }
    container.dataset.driftReady = 'true';
  }
}
const baseTokenEnvironment = ${scriptJson(environment)};
const tokenContexts = ${scriptJson(model.tokens.status === "configured" ? model.tokens.tokens.map((t) => t.environment ?? environment) : [])};
let tokenEnvironment = baseTokenEnvironment;
const makeColorProbe = (scheme, inherited) => {
  const parent = document.createElement('span');
  parent.style.color = inherited;
  const probe = document.createElement('span');
  probe.style.colorScheme = scheme;
  for (const [name, value] of Object.entries(tokenEnvironment)) probe.style.setProperty(name, value);
  parent.append(probe);
  document.body.append(parent);
  return { parent, probe };
};
const resolveColor = (value, scheme) => {
  const first = makeColorProbe(scheme, 'rgb(1, 2, 3)');
  const second = makeColorProbe(scheme, 'rgb(4, 5, 6)');
  first.probe.style.color = value;
  second.probe.style.color = value;
  first.probe.style.backgroundColor = value;
  second.probe.style.backgroundColor = value;
  const firstStyle = getComputedStyle(first.probe);
  const secondStyle = getComputedStyle(second.probe);
  const a = firstStyle.color;
  const b = secondStyle.color;
  const backgroundA = firstStyle.backgroundColor;
  const backgroundB = secondStyle.backgroundColor;
  first.parent.remove();
  second.parent.remove();
  if (a === b) return a === 'rgba(0, 0, 0, 0)'
    ? { kind: 'transparent', color: a }
    : { kind: 'fixed', color: a };
  if (backgroundA !== backgroundB) return { kind: 'dependent' };
  return { kind: 'invalid' };
};
for (const row of document.querySelectorAll('[data-token-name]')) {
  if (!(row instanceof HTMLElement) || row.dataset.tokenResolution !== 'available') continue;
  tokenEnvironment = tokenContexts[Number(row.dataset.tokenIndex)] || baseTokenEnvironment;
  const value = row.dataset.tokenValue || '';
  const light = resolveColor(value, 'light');
  const dark = resolveColor(value, 'dark');
  const swatch = row.querySelector('[data-token-swatch]');
  const state = row.querySelector('[data-token-state]');
  const bothColors = light.kind !== 'invalid' && dark.kind !== 'invalid';
  const bothTransparent = light.kind === 'transparent' && dark.kind === 'transparent';
  const contextDependent = light.kind === 'dependent' || dark.kind === 'dependent';
  const drawable = bothColors && !bothTransparent && !contextDependent;
  if (drawable && swatch instanceof HTMLElement) {
    const lightPane = swatch.querySelector('[data-swatch-light]');
    const darkPane = swatch.querySelector('[data-swatch-dark]');
    if (lightPane instanceof HTMLElement && 'color' in light) lightPane.style.backgroundColor = light.color;
    if (darkPane instanceof HTMLElement && 'color' in dark) darkPane.style.backgroundColor = dark.color;
    swatch.hidden = false;
    row.dataset.hasSwatch = 'true';
    if (state instanceof HTMLElement) state.textContent = light.color === dark.color ? 'Colour token' : 'Colour token · light / dark';
  } else if (state instanceof HTMLElement && bothTransparent) {
    state.textContent = 'Colour token · fully transparent';
  } else if (state instanceof HTMLElement && bothColors) {
    state.textContent = 'Colour token · context-dependent';
  } else if (state instanceof HTMLElement) state.textContent = 'Not a colour value.';
}
for (const swatch of document.querySelectorAll('[data-observed-color]')) {
  if (!(swatch instanceof HTMLElement)) continue;
  const color = resolveColor(swatch.dataset.observedColor || '', 'light');
  if ('color' in color) swatch.style.backgroundColor = color.color;
}
`;
}

export function renderSystemPage(model: SystemPageModel): string {
  return renderHtmlDocument({
    title: `${model.projectName} design system`,
    body: `<header class="system-header"><div><p class="system-kicker">Idiom system</p><h1>${escapeHtml(model.projectName)}</h1><p class="meta">Evidence-derived design system · generated ${escapeHtml(model.generatedAt)}</p></div><nav aria-label="Page sections"><a href="#design-tokens">Tokens</a> · <a href="#token-drift">Drift</a> · <a href="#observed">Observed</a> · <a href="#design-law">Law</a> · <a href="#recorded-rulings">Rulings</a> · <a href="#standing-prohibitions">Prohibitions</a> · <a href="#coverage">Coverage</a></nav></header>${tokenSection(model)}${driftSection(model)}${observedSection(model)}${lawSection(model)}${rulingsSection(model)}${prohibitionsSection(model)}${coverageSection(model)}`,
    styles: SYSTEM_STYLES,
    script: systemScript(model),
    printable: true,
  });
}
