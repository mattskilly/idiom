import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { markdown, readJson, validateEvent } from "./common.mjs";

export const marker = "<!-- idiom-regression-guard -->";
export function renderComment(result, artifactUrl) {
  // Artifact URLs are downloads, never inline image hosts.
  const url = /^https:\/\/[^\s<>()[\]"']+$/.test(artifactUrl ?? "")
    ? artifactUrl
    : undefined;
  const download = url
    ? `[Download evidence](${url})`
    : "Evidence upload unavailable";
  const file = (path) => `${markdown(path)} (${download})`;
  const header = [
    marker,
    `## Idiom regression check: ${markdown(result.flow)}`,
    "",
    `Head: ${markdown(result.head ?? "unavailable")} · merge base: ${markdown(result.baseline ?? "unavailable")}`,
    `New: ${result.summary?.findings.length ?? 0} · Fixed: ${result.summary?.fixed.length ?? 0} · Pre-existing: ${result.summary?.preExistingFindings.length ?? 0} · fail-on: ${markdown(result.failOn)}`,
    "",
    `${download}. Open index.html after downloading. GitHub login is required; links expire when the artifact is removed (14-day retention, subject to repository policy).`,
    "",
    ...result.operationalErrors.map(
      (error) => `Operational error: ${markdown(error)}`,
    ),
    "",
  ];
  const details = [];
  for (const [index, finding] of (result.summary?.findings ?? []).entries()) {
    details.push(
      `- **${markdown(finding.severity)}** ${markdown(finding.where)}: ${markdown(finding.problem)}`,
      ...finding.fix.map((fix) => `  - Done when: ${markdown(fix)}`),
      ...(result.crops ?? [])
        .filter((crop) => crop.finding === index)
        .map((crop) => `  - ${markdown(crop.label)}: ${file(crop.path)}`),
    );
  }
  if (!result.summary?.findings.length)
    details.push("No new deterministic findings.");
  details.push(
    "",
    "### Before / after composites",
    "",
    ...(result.composites ?? []).map(
      (composite) => `- ${markdown(composite.key)}: ${file(composite.path)}`,
    ),
  );
  const comparison = result.comparison;
  if (comparison)
    details.push(
      `Unchanged: ${comparison.unchanged.length}; only before: ${comparison.onlyBefore.length}; only after: ${comparison.onlyAfter.length}; not comparable: ${comparison.notComparable.length}.`,
      ...comparison.onlyBefore.map(
        (tuple) => `- Only before: ${markdown(tuple.key)}`,
      ),
      ...comparison.onlyAfter.map(
        (tuple) => `- Only after: ${markdown(tuple.key)}`,
      ),
      ...comparison.notComparable.map(
        (tuple) =>
          `- Not comparable: ${markdown(tuple.key)} — ${markdown(tuple.reason)}`,
      ),
    );
  details.push(
    ...(result.unavailable ?? []).map(
      (reason) => `- Evidence unavailable: ${markdown(reason)}`,
    ),
  );
  const suffix = `\n\nComplete findings and images: ${download}; index.html, summary.json, comparison.json.\n`;
  // Bound only the rendered report; result.summary remains the complete gate input.
  const budget = 55000 - suffix.length;
  let body = header.join("\n").slice(0, budget);
  for (const line of details) {
    if (body.length + line.length + 1 > budget) {
      body += "\nFurther details omitted; see the complete artifact.";
      break;
    }
    body += `\n${line}`;
  }
  return body + suffix;
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
