// Pure helpers for scripts/first-run.mjs: parse the documented getting-started
// path, build the clean child environment, read the quick-review summary,
// decide pass/fail and maintain the committed record. No I/O here beyond the
// arguments each function takes, so test/first-run.test.ts covers them offline.

import { join } from "node:path";

export const BUDGET_MS = 300_000;
export const PACKAGE_NAME = "@mattskilly/idiom";
export const RECORD_VERSION = 1;

const NPM_LINE = `npm install -g ${PACKAGE_NAME}`;
const PLAYWRIGHT_LINE = /^npx playwright@(\d+\.\d+\.\d+) install chromium$/;
const QUICK_LINE = /^idiom quick (https?:\/\/\S+)$/;
const FENCE_OPEN = /^```(sh|bash|shell)\s*$/;

/** Splits markdown into `## ` sections keyed by heading text. */
function sections(markdown) {
  const result = [];
  let current;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1], lines: [] };
      result.push(current);
    } else if (current) current.lines.push(line);
  }
  return result;
}

/** The command lines of the first sh fence in a section, or undefined. */
function firstShellBlock(lines) {
  const open = lines.findIndex((line) => FENCE_OPEN.test(line.trim()));
  if (open === -1) return undefined;
  const block = [];
  for (const line of lines.slice(open + 1)) {
    if (line.trim().startsWith("```")) return block;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    block.push(trimmed);
  }
  return block;
}

function findSection(all, number, title) {
  return all.find((section) =>
    new RegExp(`^${number}\\.\\s+${title}$`).test(section.heading),
  );
}

/**
 * Reads the first-run path from site/docs/getting-started.md: the install
 * block under "## 1. Install" and the review block under "## 2. Review a
 * page". Anything the check does not recognise is reported, never skipped.
 */
export function parseGettingStarted(markdown) {
  const problems = [];
  const all = sections(markdown);
  const installSection = findSection(all, 1, "Install");
  const reviewSection = findSection(all, 2, "Review a page");
  if (!installSection) problems.push('missing section "## 1. Install"');
  if (!reviewSection) problems.push('missing section "## 2. Review a page"');

  let npmLine;
  let playwrightLine;
  let playwrightPin;
  if (installSection) {
    const block = firstShellBlock(installSection.lines);
    if (!block) problems.push('no sh code block under "## 1. Install"');
    else {
      for (const line of block) {
        const playwright = PLAYWRIGHT_LINE.exec(line);
        if (line === NPM_LINE && npmLine === undefined) npmLine = line;
        else if (playwright && playwrightLine === undefined) {
          playwrightLine = line;
          playwrightPin = playwright[1];
        } else
          problems.push(`unrecognised install line: ${JSON.stringify(line)}`);
      }
      if (npmLine === undefined)
        problems.push(`install block has no "${NPM_LINE}" line`);
      if (playwrightLine === undefined)
        problems.push(
          'install block has no "npx playwright@<version> install chromium" line',
        );
    }
  }

  let quickLine;
  let placeholderUrl;
  if (reviewSection) {
    const block = firstShellBlock(reviewSection.lines);
    if (!block) problems.push('no sh code block under "## 2. Review a page"');
    else {
      for (const line of block) {
        const quick = QUICK_LINE.exec(line);
        if (quick && quickLine === undefined) {
          quickLine = line;
          placeholderUrl = quick[1];
        } else
          problems.push(`unrecognised review line: ${JSON.stringify(line)}`);
      }
      if (quickLine === undefined)
        problems.push('review block has no "idiom quick <url>" line');
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    install: { npmLine, playwrightLine, playwrightPin },
    review: { quickLine, placeholderUrl },
  };
}

/**
 * The documented npm line, parametrised to a version or a local tarball.
 * Returns the argv to spawn.
 */
export function installCommand({ npmLine, version, tarball }) {
  if (npmLine !== NPM_LINE)
    throw new Error(`unexpected install line: ${JSON.stringify(npmLine)}`);
  if (version && tarball)
    throw new Error("pass either a version or a tarball, not both");
  if (!version && !tarball) throw new Error("pass a version or a tarball");
  const spec = tarball ?? `${PACKAGE_NAME}@${version}`;
  return ["npm", "install", "-g", spec];
}

/** The quick-review argv with the doc's placeholder swapped for the sample. */
export function quickCommand({ quickLine, placeholderUrl, sampleUrl }) {
  const match = QUICK_LINE.exec(quickLine ?? "");
  if (!match || match[1] !== placeholderUrl)
    throw new Error(`unexpected review line: ${JSON.stringify(quickLine)}`);
  return ["idiom", "quick", sampleUrl];
}

/**
 * A fresh child environment: nothing from the parent process except what is
 * listed here. HOME and the XDG dirs point inside the temporary root, so
 * npm, Playwright and Idiom find no existing state.
 */
export function cleanEnvironment({ root, nodeBin, lang, term }) {
  const home = join(root, "home");
  return {
    PATH: [
      join(root, "prefix", "bin"),
      nodeBin,
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_prefix: join(root, "prefix"),
    npm_config_userconfig: join(home, ".npmrc"),
    LANG: lang || "en_US.UTF-8",
    TERM: term || "dumb",
  };
}

const QUICK_SUMMARY =
  /^Quick review: (\d+) finding\(s\), .* — Markdown: (.+?) — HTML: /m;

/** The count and report path from `idiom quick`'s summary line. */
export function parseQuickSummary(stdoutText) {
  const match = QUICK_SUMMARY.exec(stdoutText ?? "");
  if (!match) return null;
  return { count: Number(match[1]), reportPath: match[2] };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Decides the run. Docs drift first (the check could not follow the docs),
 * then the first failed step, then no finding, then the time budget.
 */
export function evaluateRun({
  steps,
  firstFinding,
  docsProblems = [],
  budgetMs = BUDGET_MS,
}) {
  const totalMs = Math.round(steps.reduce((sum, step) => sum + step.ms, 0));
  const fail = (failure) => ({ totalMs, passed: false, failure });
  if (docsProblems.length > 0)
    return fail(`docs drift: ${docsProblems.join("; ")}`);
  const failed = steps.find((step) => !step.ok);
  if (failed)
    return fail(
      `step ${failed.id} failed${failed.note ? `: ${failed.note}` : ""}`,
    );
  if (!firstFinding || firstFinding.count < 1)
    return fail("no finding appeared");
  if (totalMs > budgetMs) {
    const slowest = steps.reduce((a, b) => (b.ms > a.ms ? b : a));
    return fail(
      `total ${seconds(totalMs)} exceeds ${seconds(budgetMs)} budget (slowest step: ${slowest.id} ${seconds(slowest.ms)})`,
    );
  }
  return { totalMs, passed: true, failure: null };
}

/** Appends one run to the record file's text; creates it when missing. */
export function appendRun(existingText, run) {
  let record = { version: RECORD_VERSION, runs: [] };
  if (existingText !== undefined && existingText.trim() !== "") {
    record = JSON.parse(existingText);
    if (record?.version !== RECORD_VERSION || !Array.isArray(record.runs))
      throw new Error(
        `unsupported first-run record version: ${JSON.stringify(record?.version)}`,
      );
  }
  record.runs.push(run);
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The printed summary: one row per step, then the total and verdict. */
export function formatTable(run) {
  const width = Math.max(5, ...run.steps.map((step) => step.id.length));
  const rows = run.steps.map(
    (step) =>
      `  ${step.id.padEnd(width)}  ${seconds(step.ms).padStart(8)}  ${step.ok ? "ok" : "FAILED"}  ${step.command}`,
  );
  const finding = run.firstFinding
    ? `${run.firstFinding.count} finding(s); first: ${run.firstFinding.ruleId ?? "?"} — ${run.firstFinding.title ?? ""}`
    : "no finding";
  return [
    `first-run: idiom ${run.idiomVersion ?? "?"} (${run.source.kind})`,
    ...rows,
    `  ${"total".padEnd(width)}  ${seconds(run.totalMs).padStart(8)}  budget ${seconds(run.budgetMs)}`,
    `  ${finding}`,
    "  not counted: sample server start",
    run.passed ? "first-run: PASSED" : `first-run: FAILED — ${run.failure}`,
  ].join("\n");
}
