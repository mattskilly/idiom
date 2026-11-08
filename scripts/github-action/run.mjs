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
  fullSha,
  gate,
  readJson,
  resolveEvent,
  validateInputs,
  validateSummary,
} from "./common.mjs";

import { stageComparison, stageCurrent } from "./evidence.mjs";
import { renderIndex, renderRootIndex } from "./report.mjs";
import {
  previousHead,
  resolvedFindings,
  stageResolved,
  tupleImages,
} from "./resolution.mjs";

export { renderIndex, renderRootIndex } from "./report.mjs";

export function environmentInputs(env = process.env) {
  return {
    flow: env.IDIOM_ACTION_FLOW,
    project: env.IDIOM_ACTION_PROJECT ?? ".",
    version: env.IDIOM_ACTION_VERSION ?? "latest",
    failOn: env.IDIOM_ACTION_FAIL_ON ?? "major",
    setup: env.IDIOM_ACTION_SETUP ?? "npm ci",
  };
}

const shortSha = (sha) => sha.slice(0, 12);

/** Why an `idiom` call exited 3 (busy host): its JSON, else its stderr. */
export function deferredReason(error) {
  try {
    const output = JSON.parse(error.stdout ?? "");
    const tuples = output.timedOutTuples ?? output.summary?.timedOutTuples;
    if (Array.isArray(tuples) && tuples.length)
      return `host busy: ${tuples.length} tuple(s) timed out (${tuples
        .slice(0, 5)
        .map((tuple) =>
          [tuple.flow, tuple.state, tuple.viewport, tuple.colorScheme]
            .filter(Boolean)
            .join("/"),
        )
        .join(", ")})`;
    if (typeof output.verdict === "string")
      return `host busy: ${output.verdict}`;
  } catch {}
  const tail = String(error.stderr ?? "")
    .trim()
    .split("\n")
    .at(-1);
  return tail ? `host busy: ${tail.slice(0, 500)}` : "host busy";
}

/** The executable seam uses the built npm CLI in offline integration tests. */
export async function runAction({
  inputs,
  event,
  cwd = process.cwd(),
  temporary = process.env.RUNNER_TEMP ?? tmpdir(),
  cli,
  installBrowsers,
  env = process.env,
} = {}) {
  const root = await mkdtemp(join(temporary, "idiom-action-"));
  const evidence = join(root, "evidence");
  const scratch = join(root, "scratch");
  await mkdir(evidence);
  await mkdir(scratch);
  const result = {
    flow: inputs.flow || undefined,
    failOn: inputs.failOn,
    operationalErrors: [],
    notices: [],
    flows: [],
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
    const resolved = resolveEvent(env.GITHUB_EVENT_NAME, event, env);
    result.mode = resolved.mode;
    result.head = resolved.head;
    if (resolved.pr) {
      result.pr = resolved.pr.number;
      result.fork =
        resolved.pr.head.repo?.full_name !== resolved.pr.base.repo?.full_name;
    }
    repository = await git(["rev-parse", "--show-toplevel"], cwd);
    if ((await git(["rev-parse", "--is-shallow-repository"])) === "true")
      throw new Error(
        "Full Git history is required; use actions/checkout with fetch-depth: 0",
      );
    const present = async (sha) => {
      try {
        await git(["cat-file", "-e", `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    };
    const fetchHint =
      result.mode === "pull_request"
        ? "fetch PR base/head and full history (fetch-depth: 0)"
        : "fetch full history (fetch-depth: 0)";
    // push checks its previous commit below: a missing one falls back.
    for (const sha of result.mode === "push"
      ? [result.head]
      : [resolved.base, result.head])
      if (sha !== undefined && !(await present(sha)))
        throw new Error(`Missing commit ${sha}; ${fetchHint}`);
    let base = resolved.base;
    if (result.mode === "push") {
      // A new branch has no previous commit; a force push's may be gone.
      if (base !== undefined && !(await present(base))) {
        result.notices.push(
          `Previous commit ${base} unavailable locally (force push?); comparing with the parent commit.`,
        );
        base = undefined;
      }
      if (base === undefined) {
        try {
          base = await git(["rev-parse", "--verify", `${result.head}^`]);
        } catch {
          throw new Error(
            `${result.head} has no parent commit to compare with; use the schedule trigger or fetch full history (fetch-depth: 0)`,
          );
        }
      }
    }
    if (base !== undefined) {
      result.baseline = await git(["merge-base", base, result.head]);
      if (!fullSha(result.baseline))
        throw new Error("Cannot resolve merge base; fetch full Git history");
    }
    let tools;
    if (!cli) {
      tools = join(scratch, "tools");
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
    }
    installBrowsers ??= tools
      ? () =>
          run(process.execPath, [
            join(tools, "node_modules/playwright/cli.js"),
            "install",
            "--with-deps",
            "chromium",
          ])
      : async () => {};
    const idiom = (args, directory) =>
      run(cli[0], [...cli.slice(1), ...args], directory);
    const trees = new Map();
    // Each revision gets one worktree and one setup, shared by every flow.
    const worktree = (side, sha) => {
      if (!trees.has(side))
        trees.set(
          side,
          (async () => {
            const tree = join(scratch, side);
            await git(["worktree", "add", "--detach", tree, sha]);
            ownedWorktrees.push(tree);
            const project = await evidencePath(
              tree,
              beneath(tree, inputs.project),
            );
            return { side, tree, project };
          })(),
        );
      return trees.get(side);
    };
    const setups = new Map();
    const setup = (tree) => {
      if (!setups.has(tree.side))
        setups.set(
          tree.side,
          run(
            "bash",
            [
              "--noprofile",
              "--norc",
              "-e",
              "-o",
              "pipefail",
              "-c",
              inputs.setup,
            ],
            tree.tree,
          ),
        );
      return setups.get(tree.side);
    };
    const prepared = async (side, sha) => {
      const tree = await worktree(side, sha);
      await setup(tree);
      return tree;
    };
    const after = await worktree("after", result.head);
    await readFile(join(after.project, ".idiom/project.json"));

    // Plan before paying: no browsers, setup or capture for a non-UI change.
    let flows;
    try {
      const planned = JSON.parse(
        await idiom(
          [
            "check",
            ...(inputs.flow ? [inputs.flow] : []),
            "--gate",
            "--plan-only",
            "--json",
            "--project",
            after.project,
            "--changed",
            result.baseline ?? result.head,
          ],
          after.project,
        ),
      ).gate;
      if (planned?.skipped === true) {
        if (result.mode !== "schedule") {
          const line =
            planned.line ??
            `no UI changes since ${shortSha(result.baseline)}; skipped`;
          result.skipped = {
            base: planned.base ?? shortSha(result.baseline),
            reason: planned.reason,
            line,
          };
          await appendFile(log, `${line}\n`);
          console.log(line);
          return { result, resultFile, evidence };
        }
        flows = inputs.flow ? [inputs.flow] : planned.allFlows;
      } else if (planned?.planOnly === true) {
        result.plan = planned.line;
        flows = inputs.flow
          ? [inputs.flow]
          : result.mode === "schedule"
            ? planned.plan.allFlows
            : planned.plan.flows;
      } else throw new Error("invalid gate plan JSON");
    } catch (error) {
      if (!/unknown option '--plan-only'/.test(error.message)) throw error;
      if (!inputs.flow)
        throw new Error(
          "The installed idiom lacks check --gate --plan-only; set the flow input or use an @mattskilly/idiom release newer than 0.20.0",
        );
      result.notices.push(
        `installed idiom ${inputs.version} lacks --plan-only; UI-change skip disabled`,
      );
      flows = [inputs.flow];
    }
    if (
      !Array.isArray(flows) ||
      !flows.length ||
      !flows.every((flow) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flow))
    )
      throw new Error("the gate's plan selected no valid flow");
    result.plannedFlows = flows;

    await installBrowsers();
    await setup(after);

    for (const flow of flows) {
      const entry = {
        flow,
        head: result.head,
        crops: [],
        composites: [],
        unavailable: [],
        resolved: [],
        resolutionNotices: [],
      };
      result.flows.push(entry);
      const flowEvidence = beneath(evidence, flow);
      await mkdir(flowEvidence);
      try {
        await checkFlow(entry, flowEvidence);
      } catch (error) {
        if (error.code === 3)
          entry.deferred = { reason: deferredReason(error) };
        else {
          result.operationalErrors.push(`${flow}: ${error.message}`);
          await appendFile(log, `${flow}: ${error.stack ?? error}\n`);
        }
      }
    }

    async function checkFlow(entry, flowEvidence) {
      const { flow } = entry;
      const capture = async (tree, side) => {
        await readFile(
          beneath(join(tree.project, ".idiom/flows"), `${flow}.json`),
        );
        const from = `action-${side}-${flow}`;
        const runDirectory = join(tree.project, ".idiom/reports", from);
        await idiom(
          ["capture", flow, "--project", tree.project, "--out", runDirectory],
          tree.project,
        );
        return { project: tree.project, runDirectory, from };
      };
      const record = async (capture, sha, name) => {
        const output = join(scratch, `${flow}-${name}-baselines`);
        const recorded = JSON.parse(
          await idiom(
            [
              "baseline",
              "record",
              flow,
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
          file.flow !== flow ||
          file.version !== 1
        )
          throw new Error(
            `${name} baseline does not describe the expected commit`,
          );
        const path = join(scratch, `${flow}-${name}.json`);
        await writeFile(
          path,
          JSON.stringify({ version: 1, flow, records: [selected] }),
        );
        await copyFile(path, beneath(flowEvidence, `${name}.json`));
        return path;
      };
      const check = async (capture, baselineFile, sha) =>
        validateSummary(
          JSON.parse(
            await idiom(
              [
                "check",
                flow,
                "--project",
                capture.project,
                "--from",
                capture.from,
                ...(baselineFile === undefined
                  ? ["--since-baseline"]
                  : ["--baseline-file", baselineFile]),
                "--json",
                "--fail-on",
                "never",
              ],
              capture.project,
            ),
          ),
          flow,
          sha,
        );
      const paths = {};
      const compare = async (before, sha, name) => {
        await cp(
          await evidencePath(before.project, before.runDirectory),
          beneath(paths.after.project, `.idiom/reports/${before.from}`),
          { recursive: true, errorOnExist: true, force: false },
        );
        const directory = join(scratch, `${flow}-comparison-${name}`);
        const comparison = JSON.parse(
          await idiom(
            [
              "compare",
              flow,
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
            flowEvidence,
            name === "merge-base"
              ? "comparison.json"
              : "history-comparison.json",
          ),
          `${JSON.stringify(comparison, null, 2)}\n`,
        );
        await stageComparison(entry, comparison, directory, flowEvidence, name);
        return comparison;
      };
      if (result.mode === "schedule") {
        // Full coverage against the newest recorded baseline: no before side.
        paths.after = await capture(after, "after");
        entry.summary = await check(paths.after, undefined, undefined);
        await writeFile(
          join(flowEvidence, "summary.json"),
          `${JSON.stringify(entry.summary, null, 2)}\n`,
        );
        await stageCurrent(entry, paths.after, flowEvidence);
        return;
      }
      paths.before = await capture(
        await prepared("before", result.baseline),
        "before",
      );
      paths.baselineFile = await record(
        paths.before,
        result.baseline,
        "merge-base",
      );
      paths.after = await capture(after, "after");
      entry.summary = await check(
        paths.after,
        paths.baselineFile,
        result.baseline,
      );
      await writeFile(
        join(flowEvidence, "summary.json"),
        `${JSON.stringify(entry.summary, null, 2)}\n`,
      );
      await stageCurrent(entry, paths.after, flowEvidence);
      entry.comparison = await compare(
        paths.before,
        result.baseline,
        "merge-base",
      );
      // Historical evidence failures never replace the primary check or its gate.
      try {
        const afterTuples = await tupleImages(paths.after, flow, result.head);
        const beforeTuples = await tupleImages(
          paths.before,
          flow,
          result.baseline,
        );
        const baseFixed = resolvedFindings(
          { findings: entry.summary.fixed },
          entry.summary,
          entry.comparison,
          beforeTuples,
          afterTuples,
        );
        entry.resolutionNotices.push(...baseFixed.notices);
        await stageResolved({
          result: entry,
          findings: baseFixed.findings,
          before: paths.before,
          after: paths.after,
          beforeTuples,
          afterTuples,
          evidence: flowEvidence,
          origin: "merge-base",
          beforeCommit: result.baseline,
        });
        const previous =
          result.mode === "pull_request" ? previousHead(event) : undefined;
        if (previous) {
          entry.previousHead = previous;
          if (!(await present(previous)))
            throw new Error(
              `Previous commit ${previous} unavailable locally; resolution evidence unavailable.`,
            );
          try {
            await git(["merge-base", "--is-ancestor", previous, result.head]);
          } catch {
            throw new Error(
              "Previous head is not an ancestor of current head (force push); resolution evidence unavailable.",
            );
          }
          try {
            await git([
              "merge-base",
              "--is-ancestor",
              result.baseline,
              previous,
            ]);
          } catch {
            throw new Error(
              "Previous head does not descend from the current merge base; resolution evidence unavailable.",
            );
          }
          const historical = await capture(
            await prepared("previous", previous),
            "previous",
          );
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
          const secondary = await check(
            paths.after,
            previousBaseline,
            previous,
          );
          await writeFile(
            join(flowEvidence, "previous-summary.json"),
            `${JSON.stringify(previousSummary, null, 2)}\n`,
          );
          await writeFile(
            join(flowEvidence, "resolution-summary.json"),
            `${JSON.stringify(secondary, null, 2)}\n`,
          );
          entry.historyComparison = await compare(
            historical,
            previous,
            "previous-push",
          );
          const previousTuples = await tupleImages(historical, flow, previous);
          const resolved = resolvedFindings(
            previousSummary,
            secondary,
            entry.historyComparison,
            previousTuples,
            afterTuples,
          );
          entry.resolutionNotices.push(...resolved.notices);
          await stageResolved({
            result: entry,
            findings: resolved.findings,
            before: historical,
            after: paths.after,
            beforeTuples: previousTuples,
            afterTuples,
            evidence: flowEvidence,
            origin: "previous-push",
            beforeCommit: previous,
          });
        }
      } catch (error) {
        entry.resolutionNotices.push(error.message);
        await appendFile(
          log,
          `${flow}: resolution evidence unavailable: ${error.stack ?? error}\n`,
        );
      }
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
    for (const entry of result.flows)
      await writeFile(
        join(beneath(evidence, entry.flow), "index.html"),
        renderIndex({ ...result, ...entry }, { root: "../" }),
      );
    await writeFile(join(evidence, "index.html"), renderRootIndex(result));
    if (env.GITHUB_OUTPUT)
      await appendFile(
        env.GITHUB_OUTPUT,
        `evidence-directory=${evidence}\nresult-file=${resultFile}\nbaseline-sha=${result.baseline ?? ""}\noutcome=${outcome(result)}\nnew-findings=${result.flows.reduce((sum, entry) => sum + (entry.summary?.findings.length ?? 0), 0)}\n`,
      );
  }
  return { result, resultFile, evidence };
}

export function outcome(result) {
  if (result.operationalErrors.length) return "error";
  if (result.skipped) return "skipped";
  if (result.flows.some((entry) => entry.deferred)) return "deferred";
  return "checked";
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
      const passed = gate(result);
      if (passed.skipped) console.log(passed.skipped.line);
      for (const { flow, reason } of passed.deferred)
        console.log(`::notice::Idiom deferred (host busy): ${flow}: ${reason}`);
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
