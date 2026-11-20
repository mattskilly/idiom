// Pure helpers for scripts/check-pipelines.mjs: the setup result record,
// verdicts, the docs lines each setup follows, the generated workflow's
// steps and expressions, agent transcript signals and the Cursor checklist.
// No I/O here beyond the arguments each function takes, so
// test/check-pipelines.test.ts covers them offline.

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export const SETUP_IDS = [
  "autobuild",
  "github-action",
  "claude-code",
  "codex",
  "cursor",
];
export const HEADLESS_IDS = SETUP_IDS.filter((id) => id !== "cursor");
export const RECORD_VERSION = 1;

/** The one task every agent setup gets. It says nothing about Idiom. */
export const TASK_PROMPT =
  "On the home page, change the main heading to 'Book a table' and finish the change.";

const STATUSES = new Set([
  "passed",
  "failed",
  "not-run",
  "manual-pending",
  "manual-recorded",
]);

function base(id, partial = {}) {
  if (!SETUP_IDS.includes(id)) throw new Error(`unknown setup: ${id}`);
  return {
    id,
    status: "failed",
    reason: null,
    installedVersion: partial.installedVersion ?? null,
    caught: null,
    fixVerified: null,
    wallMs: partial.wallMs ?? null,
    docsDrift: partial.docsDrift ?? [],
    substitutions: partial.substitutions ?? [],
    evidence: partial.evidence ?? {},
    steps: partial.steps ?? [],
  };
}

/**
 * A setup that could not run here (tool missing, no credentials). Never
 * passed: caught and fixVerified are null. Install steps already taken are
 * kept so the record shows how far it got.
 */
export function notRun(id, reason, partial = {}) {
  if (typeof reason !== "string" || reason.trim() === "")
    throw new Error("a not-run setup needs a reason");
  return { ...base(id, partial), status: "not-run", reason };
}

/** The Cursor row before a recorded result is supplied. */
export function manualPending(id, reason) {
  return { ...base(id), status: "manual-pending", reason };
}

/**
 * The verdict for one setup that ran. Docs drift first (the docs could not be
 * followed as written), then the first failed step, then a missing required
 * signal, then not caught, then not verified.
 */
export function evaluateSetup({
  id,
  steps = [],
  caught,
  fixVerified,
  docsDrift = [],
  extra = {},
  manual = false,
  ...partial
}) {
  const result = {
    ...base(id, { ...partial, steps, docsDrift }),
    caught: caught ?? null,
    fixVerified: fixVerified ?? null,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
  const fail = (reason) => ({ ...result, status: "failed", reason });
  if (docsDrift.length > 0)
    return fail(
      `docs drift: ${docsDrift.map((drift) => `${drift.step}: ${drift.found}`).join("; ")}`,
    );
  const failed = steps.find((step) => !step.ok);
  if (failed)
    return fail(
      `step ${failed.id} failed${failed.note ? `: ${failed.note}` : ""}`,
    );
  const missing = Object.entries(extra.required ?? {}).find(
    ([, value]) => value !== true,
  );
  if (missing) return fail(`required signal missing: ${missing[0]}`);
  if (caught !== true) return fail("the planted regression was not caught");
  if (fixVerified !== true) return fail("the fix was not verified");
  return {
    ...result,
    status: manual ? "manual-recorded" : "passed",
    reason: null,
  };
}

/**
 * failed when any setup failed (exit 1); passed when every headless setup
 * passed and Cursor is recorded; otherwise incomplete (exit 0), naming each
 * setup that did not run.
 */
export function overallVerdict(setups) {
  for (const setup of setups)
    if (!STATUSES.has(setup.status))
      throw new Error(`unknown status ${setup.status} for ${setup.id}`);
  const notRunList = setups
    .filter(
      (setup) =>
        setup.status === "not-run" || setup.status === "manual-pending",
    )
    .map((setup) => ({ id: setup.id, reason: setup.reason }));
  if (setups.some((setup) => setup.status === "failed"))
    return { verdict: "failed", exitCode: 1, notRun: notRunList };
  const byId = new Map(setups.map((setup) => [setup.id, setup]));
  const complete =
    HEADLESS_IDS.every((id) => byId.get(id)?.status === "passed") &&
    byId.get("cursor")?.status === "manual-recorded";
  return complete
    ? { verdict: "passed", exitCode: 0, notRun: [] }
    : { verdict: "incomplete", exitCode: 0, notRun: notRunList };
}

// ---------------------------------------------------------------- markdown

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

/** Every fenced block in a section: its language and raw lines. */
function fencedBlocks(lines) {
  const blocks = [];
  let open;
  for (const line of lines) {
    const fence = /^```(\S*)\s*$/.exec(line.trim());
    if (fence && !open) {
      open = { lang: fence[1], lines: [] };
    } else if (fence && open) {
      blocks.push(open);
      open = undefined;
    } else if (open) open.lines.push(line);
  }
  return blocks;
}

const commandLines = (block) =>
  block.lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

const PACKAGE_URL =
  /^https:\/\/github\.com\/mattskilly\/idiom\/releases\/download\/v(\d+\.\d+\.\d+)\/mattskilly-idiom-(\d+\.\d+\.\d+)\.tgz$/;

/**
 * The agent install lines from getting-started's "## 3. Hand it to your
 * agent": the Claude Code slash commands and the three Codex shell lines.
 */
export function parseAgentInstall(markdown) {
  const problems = [];
  const section = sections(markdown).find((entry) =>
    /^3\.\s+Hand it to your agent$/.test(entry.heading),
  );
  if (!section)
    return {
      ok: false,
      problems: ['missing section "## 3. Hand it to your agent"'],
    };
  const blocks = fencedBlocks(section.lines);
  const claudeBlock = blocks.find((block) =>
    commandLines(block).some((line) => line.startsWith("/plugin ")),
  );
  const codexBlock = blocks.find((block) =>
    commandLines(block).some((line) => line.startsWith("codex ")),
  );
  let claude;
  if (!claudeBlock) problems.push("no Claude Code /plugin block");
  else {
    const lines = commandLines(claudeBlock);
    const marketplace = lines.find((line) =>
      /^\/plugin marketplace add \S+$/.test(line),
    );
    const install = lines.find((line) => /^\/plugin install \S+$/.test(line));
    for (const line of lines)
      if (line !== marketplace && line !== install)
        problems.push(`unrecognised Claude Code line: ${JSON.stringify(line)}`);
    if (!marketplace)
      problems.push('Claude Code block has no "/plugin marketplace add" line');
    if (!install)
      problems.push('Claude Code block has no "/plugin install" line');
    claude = { lines: [marketplace, install].filter(Boolean) };
  }
  let codex;
  if (!codexBlock) problems.push("no Codex shell block");
  else {
    const lines = commandLines(codexBlock);
    const marketplace = lines.find((line) =>
      /^codex plugin marketplace add \S+$/.test(line),
    );
    const plugin = lines.find((line) => /^codex plugin add \S+$/.test(line));
    const mcp = lines.find((line) => line.startsWith("codex mcp add "));
    for (const line of lines)
      if (line !== marketplace && line !== plugin && line !== mcp)
        problems.push(`unrecognised Codex line: ${JSON.stringify(line)}`);
    if (!marketplace)
      problems.push('Codex block has no "codex plugin marketplace add" line');
    if (!plugin) problems.push('Codex block has no "codex plugin add" line');
    let packageUrl;
    let urlVersion;
    if (!mcp) problems.push('Codex block has no "codex mcp add" line');
    else {
      const match =
        /^codex mcp add idiom -- npx -y --package=(\S+) idiom mcp$/.exec(mcp);
      const url = match ? PACKAGE_URL.exec(match[1]) : null;
      if (!match)
        problems.push(`unexpected codex mcp add line: ${JSON.stringify(mcp)}`);
      else if (!url || url[1] !== url[2])
        problems.push(`unexpected release package URL: ${match[1]}`);
      else {
        packageUrl = match[1];
        urlVersion = url[1];
      }
    }
    for (const line of lines)
      if (/["'`$\\]/.test(line))
        problems.push(
          `Codex line needs shell quoting: ${JSON.stringify(line)}`,
        );
    codex = {
      lines: [marketplace, plugin, mcp].filter(Boolean),
      packageUrl,
      urlVersion,
    };
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { claude, codex } };
}

/**
 * The shell equivalents of the documented Claude Code slash commands. The
 * page shows slash commands; the harness has no interactive session, so this
 * mapping is a declared substitution.
 */
export function claudeShellEquivalents(lines) {
  return lines.map((line) => {
    const match = /^\/plugin (marketplace add|install) (\S+)$/.exec(line);
    if (!match) throw new Error(`no shell equivalent for ${line}`);
    return ["claude", "plugin", ...match[1].split(" "), match[2]];
  });
}

/**
 * The manual Autobuild gate wiring from configuration.md's "## Autobuild":
 * the toml block holding `idiom-check = "…"` and `[verify.idiom-check]`.
 */
export function parseAutobuildWiring(markdown) {
  const section = sections(markdown).find(
    (entry) => entry.heading === "Autobuild",
  );
  if (!section)
    return { ok: false, problems: ['missing section "## Autobuild"'] };
  const block = fencedBlocks(section.lines).find(
    (entry) =>
      entry.lang === "toml" &&
      entry.lines.some((line) => /^idiom-check\s*=/.test(line.trim())),
  );
  if (!block)
    return {
      ok: false,
      problems: ['no toml block with "idiom-check =" under "## Autobuild"'],
    };
  let parsed;
  try {
    parsed = parseToml(block.lines.join("\n"));
  } catch (error) {
    return {
      ok: false,
      problems: [`toml block does not parse: ${error.message}`],
    };
  }
  const problems = [];
  const command = parsed.commands?.["idiom-check"];
  const verify = parsed.verify?.["idiom-check"];
  if (typeof command !== "string" || !command.startsWith("idiom check"))
    problems.push("toml block has no [commands] idiom-check command");
  if (!verify || typeof verify.kind !== "string")
    problems.push("toml block has no [verify.idiom-check] table with a kind");
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { command, verify } };
}

/**
 * The documented noninteractive Autobuild setup from configuration.md's
 * "## Autobuild": the first sh line running `idiom upgrade` with `--yes`
 * and without `--dry-run` (a dry run writes nothing, so it cannot set up).
 */
export function parseAutobuildSetup(markdown) {
  const section = sections(markdown).find(
    (entry) => entry.heading === "Autobuild",
  );
  if (!section)
    return { ok: false, problems: ['missing section "## Autobuild"'] };
  for (const block of fencedBlocks(section.lines)) {
    if (block.lang !== "sh") continue;
    for (const line of commandLines(block)) {
      const argv = line
        .replace(/\s+#.*$/, "")
        .trim()
        .split(/\s+/);
      if (
        argv[0] === "idiom" &&
        argv[1] === "upgrade" &&
        argv.includes("--yes") &&
        !argv.includes("--dry-run")
      )
        return { ok: true, value: { argv } };
    }
  }
  return {
    ok: false,
    problems: [
      'no sh block under "## Autobuild" runs idiom upgrade --yes (without --dry-run)',
    ],
  };
}

/** Whether a parsed autobuild.toml carries the gate step and its table. */
export function autobuildWired(tomlText) {
  const config = parseToml(tomlText);
  return {
    command: config.commands?.["idiom-check"] ?? null,
    inSteps: (config.verify?.steps ?? []).includes("idiom-check"),
    verify: config.verify?.["idiom-check"] ?? null,
    designReview: (config.landing ?? []).some(
      (rule) => rule?.label === "design-review",
    ),
  };
}

// ---------------------------------------------------------------- workflow

const INFRASTRUCTURE = /^actions\/(checkout|setup-node)@/;
const IDIOM_ACTION = /^mattskilly\/idiom@(\S+)$/;

/**
 * The ordered steps of one job in the workflow `idiom init` writes. Each is
 * `run` (id, run, env), `infrastructure` (checkout, setup-node), `action`
 * (the Idiom Action with its ref and raw `with:`) or `unsupported` (any other
 * `uses:`, or a step `if:`).
 */
export function parseWorkflowJob(yamlText, jobId = "pull-request") {
  let workflow;
  try {
    workflow = parseYaml(yamlText);
  } catch (error) {
    return {
      ok: false,
      problems: [`workflow does not parse: ${error.message}`],
    };
  }
  const job = workflow?.jobs?.[jobId];
  if (!job) return { ok: false, problems: [`workflow has no ${jobId} job`] };
  if (!Array.isArray(job.steps) || job.steps.length === 0)
    return { ok: false, problems: [`${jobId} job has no steps`] };
  const steps = job.steps.map((step, index) => {
    const common = { index, name: step.name ?? null, id: step.id ?? null };
    if (step.if !== undefined)
      return {
        ...common,
        kind: "unsupported",
        reason: `step condition ${JSON.stringify(step.if)}`,
      };
    if (typeof step.run === "string")
      return { ...common, kind: "run", run: step.run, env: step.env ?? {} };
    const uses = String(step.uses ?? "");
    const action = IDIOM_ACTION.exec(uses);
    if (action)
      return {
        ...common,
        kind: "action",
        uses,
        ref: action[1],
        with: step.with ?? {},
      };
    if (INFRASTRUCTURE.test(uses))
      return { ...common, kind: "infrastructure", uses, with: step.with ?? {} };
    return { ...common, kind: "unsupported", uses, reason: `uses ${uses}` };
  });
  const problems = [];
  if (!steps.some((step) => step.kind === "action"))
    problems.push(`${jobId} job has no mattskilly/idiom@<ref> step`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { if: job.if ?? null, steps } };
}

const EXPRESSION = /\$\{\{\s*(.*?)\s*\}\}/g;

function lookup(object, path) {
  let value = object;
  for (const key of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      return undefined;
    value = value[key];
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

/**
 * Substitutes `${{ steps.<id>.outputs.<key> }}` and `${{ github.<path> }}`.
 * Anything else, or a missing value, is unresolved: never passed through.
 */
export function resolveExpressions(value, context) {
  if (typeof value !== "string") return { ok: true, value: String(value) };
  const unresolved = [];
  const resolved = value.replace(EXPRESSION, (whole, expression) => {
    const step = /^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)$/.exec(
      expression,
    );
    let found;
    if (step) found = lookup(context.steps ?? {}, [step[1], step[2]]);
    else if (/^github(\.[A-Za-z0-9_-]+)+$/.test(expression))
      found = lookup(context.github ?? {}, expression.split(".").slice(1));
    if (found === undefined) {
      unresolved.push(whole);
      return whole;
    }
    return found;
  });
  return unresolved.length
    ? { ok: false, unresolved }
    : { ok: true, value: resolved };
}

/** GITHUB_OUTPUT text: `key=value` lines and the `key<<DELIM` heredoc form. */
export function parseStepOutputs(text) {
  const outputs = {};
  const lines = String(text ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heredoc = /^([^=<\s]+)<<(\S+)$/.exec(line);
    if (heredoc) {
      const body = [];
      index++;
      while (index < lines.length && lines[index] !== heredoc[2])
        body.push(lines[index++]);
      outputs[heredoc[1]] = body.join("\n");
      continue;
    }
    const pair = /^([^=\s]+)=(.*)$/.exec(line);
    if (pair) outputs[pair[1]] = pair[2];
  }
  return outputs;
}

// ---------------------------------------------------------------- fixture

/** Replaces the one line `from` with `to`; throws unless it occurs once. */
export function applyLine(text, from, to) {
  const lines = text.split("\n");
  const hits = lines.filter((line) => line === from).length;
  if (hits !== 1)
    throw new Error(
      `expected exactly one ${JSON.stringify(from)}, found ${hits}`,
    );
  return lines.map((line) => (line === from ? to : line)).join("\n");
}

/** Whether a check finding is the planted one. */
export function isPlanted(finding, regression) {
  return (
    finding?.category === regression.rule ||
    (regression.ruleIds ?? []).includes(finding?.rule)
  );
}

/**
 * Whether `idiom check` text output names the planted rule at a blocking
 * severity: "[major] contrast — …" lines or the rule id.
 */
export function outputNamesRule(text, regression) {
  const rule = regression.rule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\[(blocker|major)\\]\\s+${rule}\\b`).test(text ?? ""))
    return true;
  return (regression.ruleIds ?? []).some((id) => (text ?? "").includes(id));
}

/** The planted-rule findings in `idiom check --json` output. */
export function plantedInCheckJson(json, regression) {
  const findings = (json?.checks ?? []).flatMap(
    (check) => check?.summary?.findings ?? [],
  );
  return {
    findings: findings.map((finding) => ({
      category: finding.category ?? null,
      rule: finding.rule ?? null,
      severity: finding.severity ?? null,
    })),
    planted: findings.some((finding) => isPlanted(finding, regression)),
    skipped: json?.gate?.plan?.skipped === true,
  };
}

// ---------------------------------------------------------------- agents

const CHECK_COMMAND = /\bidiom\s+(check|verify)\b/;
const CHECK_TOOL = /idiom.*(?:^|_|\.)(check|verify|quick)$/i;

/**
 * Normalises a Claude Code stream-json or Codex `exec --json` transcript to
 * ordered events: tool calls (check, edit, other) with their results, and
 * every text seen.
 */
export function transcriptEvents(lines, kind) {
  const events = [];
  const pending = new Map();
  const texts = [];
  for (const raw of lines) {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    texts.push(raw);
    if (kind === "claude-code") {
      const content = entry?.message?.content;
      if (entry.type === "assistant" && Array.isArray(content))
        for (const item of content) {
          if (item?.type !== "tool_use") continue;
          const event = {
            tool: item.name,
            input: item.input ?? {},
            command: item.input?.command ?? null,
            path: item.input?.file_path ?? item.input?.path ?? null,
            output: "",
          };
          pending.set(item.id, event);
          events.push(event);
        }
      if (entry.type === "user" && Array.isArray(content))
        for (const item of content) {
          if (item?.type !== "tool_result") continue;
          const event = pending.get(item.tool_use_id);
          if (!event) continue;
          event.output +=
            typeof item.content === "string"
              ? item.content
              : JSON.stringify(item.content ?? "");
        }
    } else if (kind === "codex") {
      const item = entry?.item;
      if (entry.type !== "item.completed" || !item) continue;
      if (item.type === "command_execution")
        events.push({
          tool: "shell",
          command: item.command ?? "",
          path: null,
          output: item.aggregated_output ?? "",
        });
      else if (item.type === "mcp_tool_call")
        events.push({
          tool: `${item.server ?? ""}.${item.tool ?? ""}`,
          command: null,
          path: null,
          output: JSON.stringify(item.result ?? item.error ?? ""),
        });
      else if (item.type === "file_change")
        for (const change of item.changes ?? [])
          events.push({
            tool: "file_change",
            command: null,
            path: change.path ?? null,
            output: "",
          });
    }
  }
  return { events, texts };
}

const isCheck = (event) =>
  CHECK_TOOL.test(event.tool ?? "") ||
  (typeof event.command === "string" && CHECK_COMMAND.test(event.command));

const isEditOf = (event, file) => {
  if (typeof event.path === "string" && event.path.endsWith(file))
    return /^(Edit|Write|MultiEdit|file_change|apply_patch)$/.test(event.tool);
  return (
    typeof event.command === "string" &&
    event.command.includes(file.split("/").at(-1)) &&
    /\b(sed\s+-i|perl\s+-[a-z]*i|apply_patch|tee|>)/.test(event.command)
  );
};

/**
 * What an agent session did, in order: the reminder (Claude Code's hook
 * additionalContext), the first check that named the planted rule, an edit
 * of the planted file after it, and a check after that edit.
 */
export function agentSignals(lines, kind, regression) {
  const { events, texts } = transcriptEvents(lines, kind);
  const reminderFired =
    kind === "claude-code"
      ? texts.some((text) => text.includes("UI changed:"))
      : null;
  const checkIndexes = events
    .map((event, index) => (isCheck(event) ? index : -1))
    .filter((index) => index >= 0);
  const caughtAt = checkIndexes.find(
    (index) =>
      outputNamesRule(events[index].output, regression) ||
      events[index].output.includes(`"category":"${regression.rule}"`) ||
      events[index].output.includes(`\\"category\\":\\"${regression.rule}\\"`),
  );
  const fixAt =
    caughtAt === undefined
      ? undefined
      : events.findIndex(
          (event, index) =>
            index > caughtAt && isEditOf(event, regression.file),
        );
  const fixedAt = fixAt === undefined || fixAt < 0 ? undefined : fixAt;
  const verifyAt =
    fixedAt === undefined
      ? undefined
      : checkIndexes.find((index) => index > fixedAt);
  return {
    reminderFired,
    checkRan: checkIndexes.length > 0,
    checks: checkIndexes.length,
    caught: caughtAt !== undefined,
    fixed: fixedAt !== undefined,
    verifyRan: verifyAt !== undefined,
    toolCalls: events.length,
  };
}

// ---------------------------------------------------------------- cursor

export const CURSOR_FIELDS = {
  recordedAt: "ISO time the session finished",
  installedVersion: "output of idiom --version",
  caught: "true when the agent reported a contrast finding",
  fixVerified:
    "true when idiom check --gate --fail-on major passed after the fix",
  wallMs: "wall time from the task prompt to the agent's finish, in ms",
  docsDrift:
    'every step that departed from the docs: [{ "step", "doc", "expected", "found" }]',
  notes: "optional free text",
};

/** The manual checklist for Cursor, which cannot run headless. */
export function cursorChecklist({
  installLines,
  regressionBranch,
  repoPath,
  taskPrompt,
  recordCommand,
}) {
  const example = {
    recordedAt: "2026-01-01T12:00:00Z",
    installedVersion: "0.0.0",
    caught: true,
    fixVerified: true,
    wallMs: 300000,
    docsDrift: [],
    notes: "",
  };
  return [
    "Cursor (manual: Cursor has no headless session this check can drive)",
    "",
    "1. In a fresh terminal, install Idiom exactly as idiom.build/docs/getting-started says:",
    ...installLines.map((line) => `     ${line}`),
    `2. Clone the sample app and check out its regression branch:`,
    `     git clone ${repoPath} idiom-cursor-sample && cd idiom-cursor-sample && git checkout ${regressionBranch}`,
    "3. Wire the Cursor rule the documented way, then confirm the rule file exists:",
    "     mkdir -p .cursor && idiom init --wire --yes",
    "     test -f .cursor/rules/idiom.mdc && echo rule present",
    "4. Open the folder in Cursor and give the agent exactly this prompt:",
    `     ${taskPrompt}`,
    "5. Let the agent finish without hinting at Idiom. Then record:",
    ...Object.entries(CURSOR_FIELDS).map(
      ([key, description]) => `     ${key}: ${description}`,
    ),
    "6. Save the record as JSON, for example:",
    `     ${JSON.stringify(example)}`,
    "   and add it to the record with:",
    `     ${recordCommand}`,
  ].join("\n");
}

/** A recorded Cursor result, run through the same verdict as the others. */
export function validateCursorResult(json) {
  const fail = (field, expected) => {
    throw new Error(`cursor result: ${field} must be ${expected}`);
  };
  if (!json || typeof json !== "object") fail("the record", "a JSON object");
  if (
    typeof json.recordedAt !== "string" ||
    Number.isNaN(Date.parse(json.recordedAt))
  )
    fail("recordedAt", "an ISO date string");
  if (typeof json.installedVersion !== "string" || json.installedVersion === "")
    fail("installedVersion", "a non-empty string");
  if (typeof json.caught !== "boolean") fail("caught", "a boolean");
  if (typeof json.fixVerified !== "boolean") fail("fixVerified", "a boolean");
  if (typeof json.wallMs !== "number" || !(json.wallMs >= 0))
    fail("wallMs", "a non-negative number");
  if (!Array.isArray(json.docsDrift)) fail("docsDrift", "an array");
  for (const drift of json.docsDrift)
    if (typeof drift?.step !== "string" || typeof drift?.found !== "string")
      fail("docsDrift[]", 'objects with "step" and "found" strings');
  if (json.notes !== undefined && typeof json.notes !== "string")
    fail("notes", "a string when present");
  return evaluateSetup({
    id: "cursor",
    manual: true,
    caught: json.caught,
    fixVerified: json.fixVerified,
    docsDrift: json.docsDrift,
    installedVersion: json.installedVersion,
    wallMs: json.wallMs,
    evidence: {
      recordedAt: json.recordedAt,
      ...(json.notes ? { notes: json.notes } : {}),
    },
  });
}

// ---------------------------------------------------------------- record

/** Appends one run to the record file's text; creates it when missing. */
export function appendRun(existingText, run) {
  let record = { version: RECORD_VERSION, runs: [] };
  if (existingText !== undefined && existingText.trim() !== "") {
    record = JSON.parse(existingText);
    if (record?.version !== RECORD_VERSION || !Array.isArray(record.runs))
      throw new Error(
        `unsupported pipelines record version: ${JSON.stringify(record?.version)}`,
      );
  }
  record.runs.push(run);
  return `${JSON.stringify(record, null, 2)}\n`;
}

const seconds = (ms) =>
  ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
const yesNo = (value) =>
  value === true ? "yes" : value === false ? "no" : "-";
const LABELS = {
  passed: "passed",
  failed: "FAILED",
  "not-run": "NOT RUN",
  "manual-pending": "MANUAL (pending)",
  "manual-recorded": "manual: recorded",
};

/** The printed summary: one row per setup, then the verdict. */
export function formatTable(run) {
  const header = [
    "setup",
    "status",
    "version",
    "caught",
    "verified",
    "wall",
    "drift",
    "subs",
  ];
  const rows = run.setups.map((setup) => [
    setup.id,
    LABELS[setup.status] ?? setup.status,
    setup.installedVersion ?? "-",
    yesNo(setup.caught),
    yesNo(setup.fixVerified),
    seconds(setup.wallMs),
    String(setup.docsDrift.length),
    String(setup.substitutions.length),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const format = (row) =>
    `  ${row.map((cell, column) => cell.padEnd(widths[column])).join("  ")}`.trimEnd();
  const notes = run.setups
    .filter((setup) => setup.reason)
    .map((setup) => `  ${setup.id}: ${setup.reason}`);
  const verdict =
    run.verdict === "passed"
      ? "check:pipelines: PASSED"
      : run.verdict === "failed"
        ? "check:pipelines: FAILED"
        : "check:pipelines: INCOMPLETE (not every setup ran; see reasons)";
  return [
    `check:pipelines: idiom ${run.idiomVersion ?? "?"} (${run.source?.kind ?? "?"})`,
    format(header),
    ...rows.map(format),
    ...(notes.length ? ["", ...notes] : []),
    verdict,
  ].join("\n");
}
