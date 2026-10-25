import { spawn } from "node:child_process";
import { appendFile, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const severities = { blocker: 0, major: 1, minor: 2 };
export const html = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const markdown = (value) =>
  html(value)
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&")
    .replace(/[\r\n]+/g, " ");
export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
export function childEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !/^(IDIOM_ACTION_|INPUT_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$|NODE_AUTH_TOKEN$|ACTIONS_RUNTIME_TOKEN$|GITHUB_OUTPUT$|GITHUB_ENV$|GITHUB_PATH$|GITHUB_STEP_SUMMARY$)/i.test(
          key,
        ),
    ),
  );
}
export async function execute(file, args, { cwd, env, log } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: childEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      try {
        if (log)
          await appendFile(
            log,
            `$ ${file} ${args.join(" ")}\n${stdout}\n${stderr}\n`,
          );
        if (code !== 0)
          throw new Error(
            `${file} exited ${code}: ${stderr.slice(-4000) || stdout.slice(-4000)}`,
          );
        resolvePromise(stdout.trim());
      } catch (error) {
        reject(error);
      }
    });
  });
}
export function beneath(root, path) {
  const target = resolve(root, path);
  const local = relative(root, target);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error(`path escapes its root: ${path}`);
  return target;
}
export async function evidencePath(root, path) {
  const base = await realpath(root);
  const target = await realpath(beneath(root, path));
  return beneath(base, target);
}
export function validateInputs(inputs) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(inputs.flow ?? ""))
    throw new Error("flow must be a flow manifest id");
  if (!Object.hasOwn(severities, inputs.failOn) && inputs.failOn !== "never")
    throw new Error("fail-on must be blocker, major, minor, or never");
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(inputs.version))
    throw new Error("version must be an npm version or tag");
  if (!inputs.setup?.trim())
    throw new Error("setup-command must be a non-empty shell script");
  if (isAbsolute(inputs.project) || inputs.project.includes("\\"))
    throw new Error("project must be relative to the repository");
  beneath(resolve("/repository"), inputs.project);
}
export function validateEvent(event) {
  const pr = event.pull_request;
  if (!Number.isSafeInteger(pr?.number) || pr.number < 1)
    throw new Error(
      "this action requires a pull_request event with a valid PR number",
    );
  for (const sha of [pr.base?.sha, pr.head?.sha])
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha ?? ""))
      throw new Error("pull_request base/head must contain full commit hashes");
  return pr;
}
export function validateSummary(summary, flow, baseline) {
  if (
    summary?.flow !== flow ||
    summary.baseline?.commit !== baseline ||
    summary.baselineRecorded !== undefined ||
    !Array.isArray(summary.findings) ||
    !Array.isArray(summary.fixed) ||
    !Array.isArray(summary.preExistingFindings)
  )
    throw new Error("invalid check JSON or incorrect merge-base provenance");
  for (const finding of summary.findings) {
    if (
      !Object.hasOwn(severities, finding?.severity) ||
      typeof finding.problem !== "string" ||
      typeof finding.where !== "string" ||
      !Array.isArray(finding.fix) ||
      !finding.fix.every((line) => typeof line === "string")
    )
      throw new Error("invalid check finding JSON");
  }
  return summary;
}
export function gate(result) {
  if (!Array.isArray(result.operationalErrors))
    throw new Error("invalid Action result");
  if (result.operationalErrors.length)
    throw new Error(result.operationalErrors.join("\n"));
  if (!Object.hasOwn(severities, result.failOn) && result.failOn !== "never")
    throw new Error("invalid fail threshold");
  const summary = validateSummary(result.summary, result.flow, result.baseline);
  const failing = summary.findings.filter(
    (finding) =>
      result.failOn !== "never" &&
      severities[finding.severity] <= severities[result.failOn],
  );
  if (failing.length)
    throw new Error(
      `${failing.length} new finding(s) at or above ${result.failOn}`,
    );
}
