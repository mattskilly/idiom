import {
  appendFile,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beneath,
  evidencePath,
  execute,
  gate,
  readJson,
  validateEvent,
  validateInputs,
  validateSummary,
} from "./common.mjs";

import { stageComparison, stageCurrent } from "./evidence.mjs";
import { renderIndex } from "./report.mjs";
import {
  previousHead,
  resolvedFindings,
  stageResolved,
  tupleImages,
} from "./resolution.mjs";

export { renderIndex } from "./report.mjs";

export function environmentInputs(env = process.env) {
  return {
    flow: env.IDIOM_ACTION_FLOW,
    project: env.IDIOM_ACTION_PROJECT ?? ".",
    version: env.IDIOM_ACTION_VERSION ?? "latest",
    failOn: env.IDIOM_ACTION_FAIL_ON ?? "major",
    setup: env.IDIOM_ACTION_SETUP ?? "npm ci",
  };
}

/** The executable seam uses the built npm CLI in offline integration tests. */
export async function runAction({
  inputs,
  event,
  cwd = process.cwd(),
  temporary = process.env.RUNNER_TEMP ?? tmpdir(),
  cli,
  env = process.env,
} = {}) {
  const root = await mkdtemp(join(temporary, "idiom-action-"));
  const evidence = join(root, "evidence");
  const scratch = join(root, "scratch");
  await mkdir(evidence);
  await mkdir(scratch);
  const result = {
    flow: inputs.flow,
    failOn: inputs.failOn,
    operationalErrors: [],
    crops: [],
    composites: [],
    unavailable: [],
    resolved: [],
    resolutionNotices: [],
  };
  const resultFile = join(evidence, "result.json");
  const log = join(evidence, "diagnostics.log");
  await writeFile(log, "");
  const ownedWorktrees = [];
  let repository;
  const run = (file, args, directory = cwd) =>
    execute(file, args, { cwd: directory, env, log });
  const git = (args, directory = repository ?? cwd) =>
    run("git", args, directory);
  try {
    validateInputs(inputs);
    if (
      env.GITHUB_EVENT_NAME !== undefined &&
      env.GITHUB_EVENT_NAME !== "pull_request"
    )
      throw new Error("this action requires the pull_request event");
    const pr = validateEvent(event);
    result.head = pr.head.sha;
    result.pr = pr.number;
    result.fork = pr.head.repo?.full_name !== pr.base.repo?.full_name;
    repository = await git(["rev-parse", "--show-toplevel"], cwd);
    if ((await git(["rev-parse", "--is-shallow-repository"])) === "true")
      throw new Error(
        "Full Git history is required; use actions/checkout with fetch-depth: 0",
      );
    for (const sha of [pr.base.sha, pr.head.sha]) {
      try {
        await git(["cat-file", "-e", `${sha}^{commit}`]);
      } catch {
        throw new Error(
          `Missing commit ${sha}; fetch PR base/head and full history (fetch-depth: 0)`,
        );
      }
    }
    result.baseline = await git(["merge-base", pr.base.sha, pr.head.sha]);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.baseline))
      throw new Error("Cannot resolve merge base; fetch full Git history");
    if (!cli) {
      const tools = join(scratch, "tools");
      await run("npm", [
        "install",
        "--prefix",
        tools,
        "--no-audit",
        "--no-fund",
        `@mattskilly/idiom@${inputs.version}`,
      ]);
      cli = [
        process.execPath,
        join(tools, "node_modules/@mattskilly/idiom/dist/cli.js"),
      ];
      await run(process.execPath, [
        join(tools, "node_modules/playwright/cli.js"),
        "install",
        "--with-deps",
        "chromium",
      ]);
    }
    const idiom = (args, directory) =>
      run(cli[0], [...cli.slice(1), ...args], directory);
    const paths = {};
    const capture = async (side, sha) => {
      const tree = join(scratch, side);
      await git(["worktree", "add", "--detach", tree, sha]);
      ownedWorktrees.push(tree);
      await run(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", inputs.setup],
        tree,
      );
      const project = await evidencePath(tree, beneath(tree, inputs.project));
      await readFile(join(project, ".idiom/project.json"));
      await readFile(
        beneath(join(project, ".idiom/flows"), `${inputs.flow}.json`),
      );
      const runDirectory = join(project, ".idiom/reports", `action-${side}`);
      await idiom(
        ["capture", inputs.flow, "--project", project, "--out", runDirectory],
        project,
      );
      return { project, runDirectory, from: `action-${side}` };
    };
    const record = async (capture, sha, name) => {
      const output = join(scratch, `${name}-baselines`);
      const recorded = JSON.parse(
        await idiom(
          [
            "baseline",
            "record",
            inputs.flow,
            "--project",
            capture.project,
            "--from",
            capture.from,
            "--out",
            output,
            "--json",
          ],
          capture.project,
        ),
      );
      const file = await readJson(await evidencePath(output, recorded.path));
      const selected = file.records?.find((record) => record.commit === sha);
      if (
        recorded.commit !== sha ||
        !selected ||
        file.flow !== inputs.flow ||
        file.version !== 1
      )
        throw new Error(
          `${name} baseline does not describe the expected commit`,
        );
      const path = join(scratch, `${name}.json`);
      await writeFile(
        path,
        JSON.stringify({ version: 1, flow: inputs.flow, records: [selected] }),
      );
      await copyFile(path, beneath(evidence, `${name}.json`));
      return path;
    };
    const check = async (capture, baselineFile, sha) =>
      validateSummary(
        JSON.parse(
          await idiom(
            [
              "check",
              inputs.flow,
              "--project",
              capture.project,
              "--from",
              capture.from,
              "--baseline-file",
              baselineFile,
              "--json",
              "--fail-on",
              "never",
            ],
            capture.project,
          ),
        ),
        inputs.flow,
        sha,
      );
    const compare = async (before, sha, name) => {
      await cp(
        await evidencePath(before.project, before.runDirectory),
        beneath(paths.after.project, `.idiom/reports/${before.from}`),
        { recursive: true, errorOnExist: true, force: false },
      );
      const directory = join(scratch, `comparison-${name}`);
      const comparison = JSON.parse(
        await idiom(
          [
            "compare",
            inputs.flow,
            "--project",
            paths.after.project,
            "--from",
            paths.after.from,
            "--against",
            before.from,
            "--out",
            directory,
            "--json",
          ],
          paths.after.project,
        ),
      );
      if (
        comparison.before?.commit !== sha ||
        comparison.after?.commit !== result.head ||
        ![
          "changed",
          "unchanged",
          "onlyBefore",
          "onlyAfter",
          "notComparable",
        ].every((key) => Array.isArray(comparison[key]))
      )
        throw new Error("invalid compare JSON or capture provenance");
      await writeFile(
        beneath(
          evidence,
          name === "merge-base" ? "comparison.json" : "history-comparison.json",
        ),
        `${JSON.stringify(comparison, null, 2)}\n`,
      );
      await stageComparison(result, comparison, directory, evidence, name);
      return comparison;
    };
    paths.before = await capture("before", result.baseline);
    paths.baselineFile = await record(
      paths.before,
      result.baseline,
      "merge-base",
    );
    paths.after = await capture("after", result.head);
    result.summary = await check(
      paths.after,
      paths.baselineFile,
      result.baseline,
    );
    await writeFile(
      join(evidence, "summary.json"),
      `${JSON.stringify(result.summary, null, 2)}\n`,
    );
    await stageCurrent(result, paths.after, evidence);
    result.comparison = await compare(
      paths.before,
      result.baseline,
      "merge-base",
    );
    // Historical evidence failures never replace the primary check or its gate.
    try {
      const afterTuples = await tupleImages(
        paths.after,
        inputs.flow,
        result.head,
      );
      const beforeTuples = await tupleImages(
        paths.before,
        inputs.flow,
        result.baseline,
      );
      const baseFixed = resolvedFindings(
        { findings: result.summary.fixed },
        result.summary,
        result.comparison,
        beforeTuples,
        afterTuples,
      );
      result.resolutionNotices.push(...baseFixed.notices);
      await stageResolved({
        result,
        findings: baseFixed.findings,
        before: paths.before,
        after: paths.after,
        beforeTuples,
        afterTuples,
        evidence,
        origin: "merge-base",
        beforeCommit: result.baseline,
      });
      const previous = previousHead(event);
      if (previous) {
        result.previousHead = previous;
        try {
          await git(["cat-file", "-e", `${previous}^{commit}`]);
        } catch {
          throw new Error(
            `Previous commit ${previous} unavailable locally; resolution evidence unavailable.`,
          );
        }
        try {
          await git(["merge-base", "--is-ancestor", previous, result.head]);
        } catch {
          throw new Error(
            "Previous head is not an ancestor of current head (force push); resolution evidence unavailable.",
          );
        }
        try {
          await git(["merge-base", "--is-ancestor", result.baseline, previous]);
        } catch {
          throw new Error(
            "Previous head does not descend from the current merge base; resolution evidence unavailable.",
          );
        }
        const historical = await capture("previous", previous);
        const previousSummary = await check(
          historical,
          paths.baselineFile,
          result.baseline,
        );
        const previousBaseline = await record(
          historical,
          previous,
          "previous-head",
        );
        const secondary = await check(paths.after, previousBaseline, previous);
        await writeFile(
          join(evidence, "previous-summary.json"),
          `${JSON.stringify(previousSummary, null, 2)}\n`,
        );
        await writeFile(
          join(evidence, "resolution-summary.json"),
          `${JSON.stringify(secondary, null, 2)}\n`,
        );
        result.historyComparison = await compare(
          historical,
          previous,
          "previous-push",
        );
        const previousTuples = await tupleImages(
          historical,
          inputs.flow,
          previous,
        );
        const resolved = resolvedFindings(
          previousSummary,
          secondary,
          result.historyComparison,
          previousTuples,
          afterTuples,
        );
        result.resolutionNotices.push(...resolved.notices);
        await stageResolved({
          result,
          findings: resolved.findings,
          before: historical,
          after: paths.after,
          beforeTuples: previousTuples,
          afterTuples,
          evidence,
          origin: "previous-push",
          beforeCommit: previous,
        });
      }
    } catch (error) {
      result.resolutionNotices.push(error.message);
      await appendFile(
        log,
        `Resolution evidence unavailable: ${error.stack ?? error}\n`,
      );
    }
  } catch (error) {
    result.operationalErrors.push(error.message);
    await appendFile(log, `${error.stack ?? error}\n`);
  } finally {
    for (const tree of ownedWorktrees.reverse()) {
      try {
        await git(["worktree", "remove", "--force", tree]);
      } catch (error) {
        result.operationalErrors.push(`Worktree cleanup: ${error.message}`);
      }
    }
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (error) {
      result.operationalErrors.push(`Scratch cleanup: ${error.message}`);
    }
    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(evidence, "index.html"), renderIndex(result));
    if (env.GITHUB_OUTPUT)
      await appendFile(
        env.GITHUB_OUTPUT,
        `evidence-directory=${evidence}\nresult-file=${resultFile}\nbaseline-sha=${result.baseline ?? ""}\nnew-findings=${result.summary?.findings.length ?? 0}\n`,
      );
  }
  return { result, resultFile, evidence };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "gate") {
    try {
      const result = await readJson(process.env.IDIOM_ACTION_RESULT);
      for (const key of [
        "IDIOM_ACTION_UPLOAD_OUTCOME",
        "IDIOM_ACTION_COMMENT_OUTCOME",
      ])
        if (process.env[key] !== "success")
          result.operationalErrors.push(
            `${key}: ${process.env[key] ?? "unavailable"}`,
          );
      gate(result);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else {
    let event;
    try {
      event = await readJson(process.env.GITHUB_EVENT_PATH);
    } catch {
      event = {};
    }
    const { result } = await runAction({ inputs: environmentInputs(), event });
    if (result.operationalErrors.length)
      console.error(result.operationalErrors.join("\n"));
  }
}
