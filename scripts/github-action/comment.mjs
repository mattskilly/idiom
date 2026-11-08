import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flowsOf, gate, markdown, readJson, validateEvent } from "./common.mjs";

import { comparisonDetails, presentation } from "./presentation.mjs";

export const marker = "<!-- idiom-regression-guard -->";
export function renderComment(result, artifactUrl) {
  let shortened = false;
  // Escape each complete Unicode codepoint before budgeting, never half an entity,
  // Markdown escape, or surrogate pair. Full source text remains in index.html.
  const text = (value, budget = 700) => {
    let output = "",
      bytes = 0;
    for (const point of String(value ?? "unavailable").replace(
      /[\r\n]+/g,
      " ",
    )) {
      const escaped = markdown(point),
        length = Buffer.byteLength(escaped, "utf8");
      if (bytes + length > budget) {
        shortened = true;
        return `${output}…`;
      }
      output += escaped;
      bytes += length;
    }
    return output;
  };
  const validUrl = /^https:\/\/[^\s<>()[\]"']+$/.test(artifactUrl ?? "");
  const url =
    validUrl && Buffer.byteLength(artifactUrl, "utf8") <= 2048
      ? artifactUrl
      : undefined;
  if (validUrl && !url) shortened = true;
  const download = url
    ? `[Download evidence](${url})`
    : "Evidence upload unavailable";
  const flows = flowsOf(result);
  // Older single-flow results are their own entry, with unprefixed paths.
  const multi = Array.isArray(result.flows);
  const evidence = (entry, prefix) =>
    text(
      [
        ...(entry?.images ?? []).map(
          (image) => `${image.label}: ${prefix}${image.path}`,
        ),
        ...(entry?.reasons ?? []),
      ].join("; ") || "Evidence unavailable: no staged image.",
    );
  const count = (key) =>
    flows.reduce((sum, entry) => sum + (entry.summary?.[key].length ?? 0), 0);
  const deferred = flows.filter((entry) => entry.deferred);
  const base =
    result.mode === "schedule"
      ? "recorded baseline"
      : `${result.mode === "push" ? "previous commit" : "merge base"}: ${text(result.baseline, 100)}`;
  const parts = [
    marker,
    `## Idiom regression check: ${text(flows.map((entry) => entry.flow).join(", ") || result.flow || "no flow checked", 160)}`,
    `Head: ${text(result.head, 100)} · ${base}`,
    `New: ${count("findings")} · Pre-existing: ${count("preExistingFindings")} · fail-on: ${text(result.failOn, 40)}`,
    `Operational status: ${result.operationalErrors.length ? `${result.operationalErrors.length} error(s)` : result.skipped ? "skipped" : deferred.length ? `deferred (host busy) in ${deferred.length} flow(s)` : "complete"}`,
    ...result.operationalErrors
      .slice(0, 3)
      .map((error) => `Operational error: ${text(error)}`),
    ...(result.skipped ? [text(result.skipped.line)] : []),
    ...deferred.map(
      (entry) =>
        `Deferred ${text(entry.flow, 160)}: ${text(entry.deferred.reason)}`,
    ),
    ...(result.notices ?? [])
      .slice(0, 3)
      .map((notice) => `Notice: ${text(notice)}`),
    "",
  ];
  if (result.operationalErrors.length > 3) shortened = true;
  const slots = [];
  for (const entry of flows) {
    if (entry.deferred || (multi && !entry.summary)) continue;
    const flowResult = multi ? { ...result, ...entry } : result;
    const prefix = multi ? `${entry.flow}/` : "";
    const heading = multi ? "####" : "###";
    if (multi) parts.push(`### Flow: ${text(entry.flow, 160)}`, "");
    const model = presentation(flowResult);
    const issue = (
      entry,
    ) => `- **${text(entry.severity ?? "Design-system question", 50)}** ${text(entry.where, 180)} · ${text(entry.basis, 40)}
  - **Problem:** ${text(entry.problem)}
  - **Fix:** ${text(entry.fix.join("; "))}
  - **Evidence:** ${evidence(entry.evidence, prefix)}
  - **Done when:** ${text(entry.doneWhen.join("; "))}`;
    const previousCount = model.resolved.filter(
      (entry) => entry.origin === "previous-push",
    ).length;
    const baselineCount = model.resolved.filter(
      (entry) => entry.origin === "merge-base",
    ).length;
    for (const tier of model.tiers) {
      parts.push(
        `${heading} ${tier.name} (${tier.entries.length})`,
        "",
        ...tier.entries.slice(0, 3).map(issue),
      );
      if (tier.entries.length > 3) {
        parts.push(
          `\n<details><summary>${tier.entries.length - 3} more in ${tier.name}</summary>\n`,
        );
        slots.push({
          position: parts.length,
          entries: tier.entries.slice(3).map((entry) => () => issue(entry)),
        });
        parts.push("", "\n</details>\n");
      }
    }
    parts.push(
      `\n<details><summary>Resolved (${model.resolved.length}): ${previousCount} since previous push; ${baselineCount} since merge base</summary>\n`,
      "Previous-push evidence reproduces the preceding revision, rather than retaining an earlier run's pixels.",
    );
    slots.push({
      position: parts.length,
      entries: model.resolved.map(
        (entry) => () =>
          `- ${text(entry.problem)} · ${text(entry.where, 180)} (${text(entry.origin, 40)})\n  - Before ${text(entry.beforeCommit, 100)}: ${evidence(entry.before, prefix)}\n  - After ${text(entry.afterCommit, 100)}: ${evidence(entry.after, prefix)}`,
      ),
    });
    parts.push(
      "",
      "\n</details>\n",
      "<details><summary>Comparison and evidence diagnostics</summary>\n",
    );
    slots.push({
      position: parts.length,
      entries: comparisonDetails(flowResult).map(
        (line) => () => `- ${text(line)}`,
      ),
    });
    parts.push("", "\n</details>\n");
  }
  const overflow =
    "Further details omitted; see the complete artifact's index.html.";
  const files = multi
    ? "index.html, result.json and one directory per flow"
    : "index.html, summary.json, comparison.json";
  const footer = `\nComplete findings and images: ${download}; ${files}. Open index.html after downloading. GitHub login is required; links expire when the artifact is removed (14-day retention, subject to repository policy).\n`;
  let remaining =
    55000 -
    Buffer.byteLength(parts.join("\n") + overflow + footer, "utf8") -
    20;
  for (const slot of slots) {
    const accepted = [];
    for (const render of slot.entries) {
      const entry = render(),
        size = Buffer.byteLength(entry, "utf8") + 1;
      if (size > remaining) {
        shortened = true;
        break;
      }
      remaining -= size;
      accepted.push(entry);
    }
    parts[slot.position] = accepted.join("\n");
  }
  return parts.join("\n") + (shortened ? `\n${overflow}\n` : "") + footer;
}

export async function upsertComment({
  fetch: request = globalThis.fetch,
  api = "https://api.github.com",
  repository,
  number,
  token,
  body,
  fork = false,
  warn = console.warn,
}) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new Error("invalid comment repository or PR number");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2026-03-10",
    "Content-Type": "application/json",
  };
  const root = `${api}/repos/${repository}`;
  const collection = `${root}/issues/${number}/comments`;
  async function call(url, method = "GET", payload) {
    const response = await request(url, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) {
      if (fork && [401, 403, 404].includes(response.status)) {
        warn(
          "Comment publication unavailable with this fork PR's read-only token; artifacts, job summary and finding gate are preserved.",
        );
        return undefined;
      }
      throw new Error(`GitHub comment ${method} failed (${response.status})`);
    }
    if (response.status !== (method === "POST" ? 201 : 200))
      throw new Error("unexpected GitHub comment response status");
    return response.json();
  }
  if (!token) {
    if (fork) {
      warn("Comment publication unavailable: no writable token for fork PR.");
      return;
    }
    throw new Error("comment publication requires a token");
  }
  let managed;
  for (let page = 1; ; page++) {
    const comments = await call(`${collection}?per_page=100&page=${page}`);
    if (comments === undefined) return;
    if (
      !Array.isArray(comments) ||
      comments.some(
        (comment) =>
          !Number.isSafeInteger(comment?.id) ||
          comment.id < 1 ||
          typeof comment.body !== "string" ||
          typeof comment.user?.type !== "string",
      )
    )
      throw new Error("malformed GitHub comments response");
    managed = comments.find(
      (comment) => comment.user.type === "Bot" && comment.body.includes(marker),
    );
    if (managed || comments.length < 100) break;
  }
  const comment = managed
    ? await call(`${root}/issues/comments/${managed.id}`, "PATCH", { body })
    : await call(collection, "POST", { body });
  if (
    comment !== undefined &&
    (!Number.isSafeInteger(comment?.id) ||
      comment.id < 1 ||
      typeof comment.body !== "string")
  )
    throw new Error("malformed GitHub comment write response");
  return comment;
}

const passes = (result) => {
  try {
    gate(result);
    return true;
  } catch {
    return false;
  }
};

/**
 * A busy host is neither a pass nor a failure: a neutral check run says why.
 * Needs `checks: write`; without it the deferral is a warning, never an error.
 */
export async function publishNeutralCheck({
  fetch: request = globalThis.fetch,
  api = "https://api.github.com",
  repository,
  token,
  head,
  reason,
  result,
  warn = console.warn,
}) {
  const unavailable = (detail) => {
    const notice = `Neutral deferred check unavailable (${detail}); grant checks: write to publish it.`;
    result.notices = [...(result.notices ?? []), notice];
    warn(`::warning::${notice}`);
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token) {
    unavailable("no repository or token");
    return;
  }
  try {
    const response = await request(`${api}/repos/${repository}/check-runs`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Idiom",
        head_sha: head,
        conclusion: "neutral",
        output: { title: "Idiom deferred: host busy", summary: reason },
      }),
    });
    if (!response.ok) unavailable(`HTTP ${response.status}`);
  } catch (error) {
    unavailable(error.message);
  }
}

export async function publishResult({
  resultFile,
  artifactUrl,
  uploadOutcome,
  token,
  repository,
  api,
  event,
  summaryPath,
  fetch,
} = {}) {
  const result = await readJson(resultFile);
  if (uploadOutcome !== "success" || !artifactUrl)
    result.operationalErrors.push("Evidence artifact upload failed");
  const body = renderComment(result, artifactUrl);
  if (summaryPath) await appendFile(summaryPath, body);
  // push and schedule have no PR to comment on: the job summary is the report.
  if (event?.pull_request) {
    try {
      const pr = validateEvent(event);
      await upsertComment({
        fetch,
        api,
        repository,
        number: pr.number,
        token,
        body,
        fork: result.fork === true,
      });
    } catch (error) {
      result.operationalErrors.push(`Comment publication: ${error.message}`);
    }
  }
  if (flowsOf(result).some((entry) => entry.deferred) && passes(result))
    await publishNeutralCheck({
      fetch,
      api,
      repository,
      token,
      head: result.head,
      reason: flowsOf(result)
        .filter((entry) => entry.deferred)
        .map((entry) => `${entry.flow}: ${entry.deferred.reason}`)
        .join("\n"),
      result,
    });
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await publishResult({
      resultFile: process.env.IDIOM_ACTION_RESULT,
      artifactUrl: process.env.IDIOM_ACTION_ARTIFACT_URL,
      uploadOutcome: process.env.IDIOM_ACTION_UPLOAD_OUTCOME,
      token: process.env.IDIOM_ACTION_TOKEN,
      repository: process.env.GITHUB_REPOSITORY,
      api: process.env.GITHUB_API_URL,
      event: await readJson(process.env.GITHUB_EVENT_PATH),
      summaryPath: process.env.GITHUB_STEP_SUMMARY,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
