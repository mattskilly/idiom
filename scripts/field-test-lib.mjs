// Pure helpers for scripts/field-test.mjs: target validation, result
// normalisation, label merging, precision maths and markdown rendering.
// No I/O here, so test/field-test.test.ts covers it without a browser.

export const REQUIRED_KINDS = [
  "marketing",
  "saas-dashboard",
  "docs",
  "ecommerce",
  "form-heavy",
  "mobile-first",
  "ai-built",
];
export const PRECISION_THRESHOLD = 0.7;
export const TOP_N = 10;
export const GENERATED_START = "<!-- field-test:generated:start -->";
export const GENERATED_END = "<!-- field-test:generated:end -->";
const RATINGS = ["agree", "disagree", "unsure"];

/**
 * @typedef {{ id: string, kind: string, aiBuilt: boolean, urls: string[],
 *   notes?: string, repo?: { url: string, commit: string, install: string[],
 *   server: Record<string, unknown>, dev: string[] } }} Target
 * @typedef {{ key: string, rank: number, rules: string[], family?: string,
 *   severity: string, category: string, score: number, title: string,
 *   selector?: string, state?: string, viewport?: string,
 *   colorScheme?: string, evidence?: string }} TopIssue
 * @typedef {{ rating: "agree" | "disagree" | "unsure" | null,
 *   reason: string }} Rating
 * @typedef {{ target: string, rules: string[], title: string,
 *   agent: Rating | null, human: Rating | null }} Label
 */

/** @param {unknown} json @returns {Target[]} */
export function validateTargets(json) {
  if (!Array.isArray(json)) throw new Error("targets must be an array");
  if (json.length < 8 || json.length > 10)
    throw new Error(`expected 8–10 targets, found ${json.length}`);
  const ids = new Set();
  for (const target of json) {
    const where = `target ${target?.id ?? "(no id)"}`;
    if (typeof target?.id !== "string" || !/^[a-z0-9-]+$/.test(target.id))
      throw new Error(`${where}: id must be kebab-case`);
    if (ids.has(target.id)) throw new Error(`${where}: duplicate id`);
    ids.add(target.id);
    if (!REQUIRED_KINDS.includes(target.kind))
      throw new Error(`${where}: unknown kind ${target.kind}`);
    if (typeof target.aiBuilt !== "boolean")
      throw new Error(`${where}: aiBuilt must be boolean`);
    if (
      !Array.isArray(target.urls) ||
      target.urls.length < 1 ||
      target.urls.length > 3
    )
      throw new Error(`${where}: urls must list 1–3 URLs`);
    const origins = new Set(
      target.urls.map((url) => {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol))
          throw new Error(`${where}: ${url} is not HTTP(S)`);
        return parsed.origin;
      }),
    );
    if (origins.size !== 1)
      throw new Error(`${where}: urls must share one origin`);
    if (target.repo !== undefined) {
      const repo = target.repo;
      if (
        typeof repo.url !== "string" ||
        !/^[0-9a-f]{40}$/.test(repo.commit ?? "") ||
        !Array.isArray(repo.install) ||
        !Array.isArray(repo.dev) ||
        repo.dev.length < 1 ||
        typeof repo.server !== "object"
      )
        throw new Error(
          `${where}: repo needs url, a pinned 40-char commit, install[], dev[] and server`,
        );
    }
  }
  const kinds = new Set(json.map((target) => target.kind));
  const missing = REQUIRED_KINDS.filter((kind) => !kinds.has(kind));
  if (missing.length)
    throw new Error(`targets miss required kinds: ${missing.join(", ")}`);
  const aiBuilt = json.filter((target) => target.aiBuilt).length;
  if (aiBuilt < 3)
    throw new Error(`expected at least 3 AI-built targets, found ${aiBuilt}`);
  if (!json.some((target) => target.repo !== undefined))
    throw new Error("expected at least 1 repo target");
  return json;
}

const strip = (id) => id.replace(/^quick:[^:]+:/, "");
const clip = (text, length = 220) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;
const relativeTo = (path, root) =>
  path && root && path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : path;

/** Rules an issue is attributed to: every constituent rule of a family. */
export function issueRules(issue) {
  const rules = issue.rules?.length ? issue.rules : [issue.rule ?? "unknown"];
  return [...new Set(rules)].sort();
}

/**
 * `idiom_quick` structured content → counts plus the ranked Top 10.
 * @param {any} content @param {{ elapsedMs: number, target: string }} options
 */
export function summarizeQuickResult(content, { elapsedMs, target }) {
  const root = content.runDirectory;
  const issues = content.issues ?? [];
  /** @type {TopIssue[]} */
  const topIssues = issues.slice(0, TOP_N).map((issue, index) => {
    const detail = issue.representative;
    const finding = detail?.finding ?? {};
    const selectors = finding.verification?.params?.selectors;
    return {
      key: `${target}:${strip(issue.id)}`,
      rank: index + 1,
      rules: issueRules(issue),
      ...(issue.family ? { family: issue.family } : {}),
      severity: issue.severity,
      category: issue.category,
      score: round(issue.score),
      title: clip(finding.explanation ?? finding.title ?? issue.category),
      ...optional(
        "selector",
        detail?.selector ??
          (Array.isArray(selectors) ? selectors.join(" ⟷ ") : undefined),
      ),
      ...optional("state", finding.state),
      ...optional("viewport", finding.viewport),
      ...optional("colorScheme", finding.colorScheme),
      ...optional("evidence", relativeTo(detail?.cropPath, root)),
    };
  });
  return {
    elapsedMs: Math.round(elapsedMs),
    tuples: content.counts?.captures?.total ?? 0,
    captures: content.counts?.captures ?? null,
    findings: content.counts?.findings ?? 0,
    issues: content.counts?.issues ?? issues.length,
    groups: content.counts?.groups ?? 0,
    topIssues,
  };
}

/**
 * `check --json` output plus its run.json → the same shape plus timings.
 * @param {any} json @param {any} runRecord
 * @param {{ elapsedMs: number, target: string }} options
 */
export function summarizeCheckResult(json, runRecord, { elapsedMs, target }) {
  const groups = new Map((json.groups ?? []).map((group) => [group.id, group]));
  const issues = json.issues ?? [];
  const topIssues = issues.slice(0, TOP_N).map((issue, index) => {
    const group = groups.get(issue.groups?.[0]) ?? {};
    const [state, viewport] = (
      issue.explanation?.coordinate ??
      group.where ??
      ""
    ).split("/");
    return {
      key: `${target}:${issue.id}`,
      rank: index + 1,
      rules: issueRules(issue),
      ...(issue.family ? { family: issue.family } : {}),
      severity: issue.severity,
      category: issue.category,
      score: round(issue.score),
      title: clip(group.problem ?? issue.category),
      ...optional("selector", issue.explanation?.selector),
      ...optional("state", state || undefined),
      ...optional("viewport", viewport || undefined),
      ...optional(
        "evidence",
        group.screenshot?.replace(/^.*\.idiom\/reports\/[^/]+\//, ""),
      ),
    };
  });
  const timings = runRecord?.timings;
  return {
    elapsedMs: Math.round(elapsedMs),
    tuples: runRecord?.selected?.length ?? 0,
    captures: null,
    findings: json.findings?.length ?? 0,
    issues: issues.length,
    groups: json.groups?.length ?? 0,
    topIssues,
    timings: timings ? timingDigest(timings) : null,
    probeCoverage: runRecord?.probe
      ? {
          policy: runRecord.probe.policy,
          intended: runRecord.probe.intended.length,
          executed: runRecord.probe.executed.length,
        }
      : null,
  };
}

/** run.json timings → phase totals, slowest tuples and slowest controls. */
export function timingDigest(timings) {
  const tuples = timings.tuples ?? [];
  return {
    build: timings.build,
    start: timings.start,
    probe: timings.probe,
    checks: timings.checks,
    tuplesTotalMs: round(
      tuples.reduce((sum, tuple) => sum + (tuple.total?.ms ?? 0), 0),
    ),
    slowestTuples: [...tuples]
      .sort((a, b) => (b.total?.ms ?? 0) - (a.total?.ms ?? 0))
      .slice(0, 3)
      .map((tuple) => ({
        tuple: `${tuple.state}/${tuple.viewport}/${tuple.colorScheme}`,
        totalMs: round(tuple.total?.ms ?? 0),
        probeMs: round(tuple.probe?.ms ?? 0),
      })),
    slowestControls: (timings.slowestControls ?? []).map((control) => ({
      tuple: `${control.state}/${control.viewport}/${control.colorScheme}`,
      name: control.name,
      elapsedMs: round(control.elapsedMs),
      outcome: control.outcome,
    })),
  };
}

/**
 * Probe outcome counts over a run's observations.json documents.
 * @param {any[]} documents
 */
export function countProbeTimeouts(documents) {
  const counts = { ran: 0, partial: 0, timedOut: 0, partialTimedOut: 0 };
  for (const document of documents) {
    const probe = document?.probe;
    if (!probe) continue;
    if (probe.status === "ran") counts.ran += 1;
    else if (probe.status === "timed-out") counts.timedOut += 1;
    else if (probe.status === "partial") {
      counts.partial += 1;
      if (/timed[- ]out/i.test(probe.reason ?? "")) counts.partialTimedOut += 1;
    }
  }
  return counts;
}

/**
 * @param {{ stage: string, message?: string, timedOut?: boolean,
 *   exitCode?: number | null, signal?: string | null }} failure
 */
export function classifyFailure(failure) {
  const message = failure.message ?? "";
  const kind =
    failure.timedOut ||
    /request timed out|-32001|timed out after|timeout of \d+/i.test(message)
      ? "timeout"
      : /(?:quick )?capture failed/i.test(message)
        ? "capture-failed"
        : "crash";
  return {
    kind,
    stage: failure.stage,
    message: clip(message.trim() || describeExit(failure), 600),
  };
}

function describeExit({ exitCode, signal }) {
  return signal ? `killed by ${signal}` : `exited with code ${exitCode}`;
}

/** Adds an unrated entry per Top-10 issue; never touches an existing one. */
export function mergeLabelTemplate(results, labels) {
  const merged = {
    version: 1,
    labels: { ...(labels?.labels ?? {}) },
  };
  let added = 0;
  for (const target of results.targets ?? [])
    for (const issue of target.topIssues ?? []) {
      if (merged.labels[issue.key] !== undefined) continue;
      merged.labels[issue.key] = {
        target: target.id,
        rules: issue.rules,
        title: issue.title,
        agent: null,
        human: null,
      };
      added += 1;
    }
  return { labels: merged, added };
}

/** Human rating where present, otherwise the agent's. */
export function effectiveRating(label) {
  if (RATINGS.includes(label?.human?.rating))
    return { rating: label.human.rating, source: "human" };
  if (RATINGS.includes(label?.agent?.rating))
    return { rating: label.agent.rating, source: "agent" };
  return undefined;
}

/** Rated Top-10 issues of the current results only. */
function ratedIssues(results, labels) {
  return (results.targets ?? []).flatMap((target) =>
    (target.topIssues ?? []).flatMap((issue) => {
      const rated = effectiveRating(labels?.labels?.[issue.key]);
      return rated ? [{ target: target.id, issue, ...rated }] : [];
    }),
  );
}

/** precision = agree / (agree + disagree); unsure is excluded. */
export function precisionByRule(results, labels) {
  const rows = new Map();
  for (const { issue, rating, source } of ratedIssues(results, labels))
    for (const rule of issue.rules) {
      const row = rows.get(rule) ?? {
        rule,
        agree: 0,
        disagree: 0,
        unsure: 0,
        sources: new Set(),
      };
      row[rating] += 1;
      row.sources.add(source);
      rows.set(rule, row);
    }
  return [...rows.values()]
    .map(({ sources, ...row }) => {
      const denominator = row.agree + row.disagree;
      const precision = denominator === 0 ? null : row.agree / denominator;
      return {
        ...row,
        n: row.agree + row.disagree + row.unsure,
        precision,
        source: sources.size > 1 ? "mixed" : [...sources][0],
        belowThreshold: precision !== null && precision < PRECISION_THRESHOLD,
      };
    })
    .sort(
      (a, b) =>
        (a.precision ?? 2) - (b.precision ?? 2) ||
        b.n - a.n ||
        a.rule.localeCompare(b.rule),
    );
}

/** Overall and per-target precision over rated issues (not per rule). */
export function precisionByTarget(results, labels) {
  const rated = ratedIssues(results, labels);
  const summarize = (items) => {
    const count = (rating) =>
      items.filter((item) => item.rating === rating).length;
    const agree = count("agree");
    const disagree = count("disagree");
    return {
      agree,
      disagree,
      unsure: count("unsure"),
      precision: agree + disagree === 0 ? null : agree / (agree + disagree),
    };
  };
  return {
    overall: summarize(rated),
    targets: (results.targets ?? []).map((target) => ({
      id: target.id,
      ...summarize(rated.filter((item) => item.target === target.id)),
    })),
  };
}

const percent = (value) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
const seconds = (ms) =>
  ms === null || ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`;
const cell = (text) =>
  String(text ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

/** Markdown for the section between the generated markers. */
export function renderGenerated(results, labels) {
  const lines = [];
  const byTarget = precisionByTarget(results, labels);
  lines.push(
    "_Generated by `node scripts/field-test.mjs score` from `docs/field-test/results.json` and `docs/field-test/labels.json`. Do not edit by hand._",
    "",
    `Run ${results.startedAt} · Idiom ${results.idiomCommit?.slice(0, 7)} · Node ${results.node} · ${results.machine?.cpu} (${results.machine?.cores} cores, ${results.machine?.memoryGb} GB)`,
    "",
    "### Runs",
    "",
    "| Target | Kind | AI-built | Mode | Time | Tuples | Findings | Issues | Probe ran / partial / timed out | CLI quick smoke | Failures |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |",
  );
  for (const target of results.targets ?? []) {
    const probe = target.probe;
    const smoke = target.cliSmoke;
    lines.push(
      `| ${target.id} | ${target.kind} | ${target.aiBuilt ? "yes" : "no"} | ${target.mode} | ${seconds(target.elapsedMs)} | ${target.tuples ?? "—"} | ${target.findings ?? "—"} | ${target.issues ?? "—"} | ${probe ? `${probe.ran} / ${probe.partial} / ${probe.timedOut + probe.partialTimedOut}` : "—"} | ${smoke ? `${smoke.exitCode === 0 ? "ok" : `exit ${smoke.exitCode ?? smoke.signal}`} in ${seconds(smoke.elapsedMs)}` : "—"} | ${target.failures?.length ? cell(target.failures.map((failure) => `${failure.kind}@${failure.stage}`).join(", ")) : "none"} |`,
    );
  }
  lines.push(
    "",
    `### Precision by target (agent-rated unless noted)`,
    "",
    "| Target | Agree | Disagree | Unsure | Precision |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...byTarget.targets.map(
      (row) =>
        `| ${row.id} | ${row.agree} | ${row.disagree} | ${row.unsure} | ${percent(row.precision)} |`,
    ),
    `| **all** | **${byTarget.overall.agree}** | **${byTarget.overall.disagree}** | **${byTarget.overall.unsure}** | **${percent(byTarget.overall.precision)}** |`,
    "",
    "### Precision by rule",
    "",
    `Attribution: an issue counts once for every rule it contains (a multi-rule family counts for each constituent). Precision = agree / (agree + disagree); unsure is excluded. Rows below ${PRECISION_THRESHOLD * 100}% are flagged ⚠.`,
    "",
    "| Rule | Agree | Disagree | Unsure | n | Precision | Rated by | |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |",
    ...precisionByRule(results, labels).map(
      (row) =>
        `| \`${row.rule}\` | ${row.agree} | ${row.disagree} | ${row.unsure} | ${row.n} | ${percent(row.precision)} | ${row.source} | ${row.belowThreshold ? "⚠" : ""} |`,
    ),
    "",
    "### Crashes and timeouts",
    "",
  );
  const failures = (results.targets ?? []).flatMap((target) =>
    (target.failures ?? []).map((failure) => ({ target: target.id, failure })),
  );
  if (!failures.length) lines.push("None.");
  else
    lines.push(
      "| Target | Kind | Stage | Message |",
      "| --- | --- | --- | --- |",
      ...failures.map(
        ({ target, failure }) =>
          `| ${target} | ${failure.kind} | ${failure.stage} | ${cell(failure.message)} |`,
      ),
    );
  lines.push("", "### Top 10 per target", "");
  for (const target of results.targets ?? []) {
    lines.push(
      `#### ${target.id}`,
      "",
      "| # | Rule(s) | Sev | Where | Finding | Rating | Reason |",
      "| ---: | --- | --- | --- | --- | --- | --- |",
    );
    if (!target.topIssues?.length) lines.push("| — | | | | no issues | | |");
    for (const issue of target.topIssues ?? []) {
      const label = labels?.labels?.[issue.key];
      const rated = effectiveRating(label);
      const reason =
        rated?.source === "human" ? label.human.reason : label?.agent?.reason;
      lines.push(
        `| ${issue.rank} | ${issue.rules.map((rule) => `\`${rule}\``).join(" ")} | ${issue.severity} | ${cell([issue.state, issue.viewport, issue.colorScheme].filter(Boolean).join("/"))} | ${cell(clip(issue.title, 160))} | ${rated ? `${rated.rating}${rated.source === "human" ? " (human)" : ""}` : "unrated"} | ${cell(reason ?? "")} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Replaces only the text between the generated markers. */
export function replaceGeneratedSection(document, generated) {
  const start = document.indexOf(GENERATED_START);
  const end = document.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start)
    throw new Error(
      `docs/field-test.md needs ${GENERATED_START} … ${GENERATED_END} markers`,
    );
  return `${document.slice(0, start + GENERATED_START.length)}\n\n${generated}\n${document.slice(end)}`;
}

function round(value) {
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

function optional(key, value) {
  return value === undefined || value === null || value === ""
    ? {}
    : { [key]: value };
}
