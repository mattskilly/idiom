import { flowsOf, html } from "./common.mjs";
import { comparisonDetails, presentation } from "./presentation.mjs";

// HTML only embeds generated, relative PNG paths persisted by the staging helper.
const safeImage = (path) =>
  /^(?:crops|filmstrips|compare)\/[A-Za-z0-9_./-]+\.png$/.test(path ?? "") &&
  !path.split("/").includes("..");
function images(evidence) {
  return `${(evidence?.images ?? []).map((image) => (safeImage(image.path) ? `<figure><a href="${html(image.path)}"><img style="max-width:100%" src="${html(image.path)}" alt="${html(image.label)}"></a><figcaption>${html(image.label)}: ${html(image.path)}</figcaption></figure>` : `<p>Evidence unavailable: unsafe image path ${html(image.path)}</p>`)).join("")}${(evidence?.reasons ?? []).map((reason) => `<p>${html(reason)}</p>`).join("")}`;
}
const list = (items) =>
  `<ul>${items.map((item) => `<li>${html(item)}</li>`).join("")}</ul>`;
/** One flow's evidence; `root` reaches the run-wide result.json and log. */
export function renderIndex(result, { root = "" } = {}) {
  const model = presentation(result);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Idiom regression evidence</title><body><h1>Idiom: ${html(result.flow)}</h1><p>${result.mode === "schedule" ? "Recorded baseline" : `Merge base ${html(result.baseline ?? "unavailable")}`} → current ${html(result.head ?? "unavailable")}; fail-on: ${html(result.failOn)}</p><p><a href="summary.json">Check JSON</a> · <a href="comparison.json">Compare JSON</a> · <a href="${root}result.json">Action result</a> · <a href="${root}diagnostics.log">Diagnostics</a>${result.historyComparison ? ' · <a href="history-comparison.json">Previous-push comparison</a> · <a href="previous-summary.json">Previous-head check</a> · <a href="resolution-summary.json">Resolution check</a>' : ""}</p><p>New: ${result.summary?.findings.length ?? 0}; pre-existing: ${result.summary?.preExistingFindings.length ?? 0}</p><h2>Operational status</h2>${result.operationalErrors.length ? list(result.operationalErrors) : "<p>Complete</p>"}${model.tiers.map((tier) => `<section><h2>${tier.name} (${tier.entries.length})</h2>${tier.entries.map((entry) => `<article><h3>${html(entry.severity ?? "Design-system question")} · ${html(entry.id ?? entry.source)}</h3><p>${html(entry.where)} · ${html(entry.basis)}</p><h4>Problem</h4><p>${html(entry.problem)}</p><h4>Fix</h4>${list(entry.fix)}<h4>Done when</h4>${list(entry.doneWhen)}${images(entry.evidence)}</article>`).join("")}</section>`).join("")}<h2>Resolved (${model.resolved.length})</h2><p>Previous-push evidence reproduces the preceding pushed revision; it does not retain pixels from an earlier workflow run.</p>${model.resolved.map((entry) => `<article><h3>${html(entry.problem)}</h3><p>${html(entry.where)} · ${html(entry.fingerprint)} · ${html(entry.origin)}</p><h4>Before ${html(entry.beforeCommit)}</h4>${images(entry.before)}<h4>After ${html(entry.afterCommit)}</h4>${images(entry.after)}${images({ images: entry.composites })}</article>`).join("")}<h2>Before / after composites</h2>${images({ images: result.composites })}<h2>Comparison and evidence diagnostics</h2>${list(comparisonDetails(result))}</body></html>\n`;
}

/** The run's landing page: status, then one link per flow's evidence. */
export function renderRootIndex(result) {
  const flows = flowsOf(result);
  const status = (entry) =>
    entry.deferred
      ? `deferred — ${entry.deferred.reason}`
      : entry.summary
        ? `new ${entry.summary.findings.length}; pre-existing ${entry.summary.preExistingFindings.length}`
        : "not checked";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Idiom regression evidence</title><body><h1>Idiom regression evidence</h1><p>${html(result.mode ?? "pull_request")} · head ${html(result.head ?? "unavailable")} · ${result.mode === "schedule" ? "recorded baseline" : `base ${html(result.baseline ?? "unavailable")}`} · fail-on: ${html(result.failOn)}</p>${result.skipped ? `<p>${html(result.skipped.line)}</p>` : ""}${result.plan ? `<p>${html(result.plan)}</p>` : ""}<p><a href="result.json">Action result</a> · <a href="diagnostics.log">Diagnostics</a></p><h2>Flows</h2>${flows.length ? `<ul>${flows.map((entry) => `<li><a href="${html(entry.flow)}/index.html">${html(entry.flow)}</a>: ${html(status(entry))}</li>`).join("")}</ul>` : "<p>No flow checked.</p>"}<h2>Operational status</h2>${result.operationalErrors.length ? list(result.operationalErrors) : "<p>Complete</p>"}${result.notices?.length ? `<h2>Notices</h2>${list(result.notices)}` : ""}</body></html>\n`;
}
