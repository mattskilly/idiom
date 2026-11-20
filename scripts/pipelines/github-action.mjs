// GitHub Actions: the workflow `idiom init` writes, its pull-request job run
// step by step as a runner would, with the published Action (cloned
// read-only) for the Idiom step, then its gate and comment body.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  evaluateSetup,
  parseStepOutputs,
  parseWorkflowJob,
  resolveExpressions,
} from "../check-pipelines-lib.mjs";
import {
  commitLine,
  git,
  installBrowser,
  isolatedHome,
  postCheck,
  sampleRepo,
  stepper,
} from "./common.mjs";

const WIRE_DOC = "site/docs/getting-started.md#5-gate-pull-requests";
const INPUT_ENV = {
  flow: "IDIOM_ACTION_FLOW",
  project: "IDIOM_ACTION_PROJECT",
  version: "IDIOM_ACTION_VERSION",
  "fail-on": "IDIOM_ACTION_FAIL_ON",
  "setup-command": "IDIOM_ACTION_SETUP",
};

export async function run(context) {
  const started = performance.now();
  const steps = [];
  const docsDrift = [];
  const substitutions = [
    "no GitHub runner: the pull-request job's run steps and the Action's composite steps run locally on this machine",
    "actions/checkout: the sample repo checked out at the PR head sha, full history",
    "actions/setup-node: the host's Node from the clean environment",
    "upload-artifact and the PR comment POST are not run (outcomes passed as success); the comment body is rendered with the Action's own renderComment",
    `Action input version pinned to ${context.idiomVersion} instead of the workflow's \`latest\``,
  ];
  const home = await isolatedHome(context, "github-action");
  const step = stepper(home, steps);
  const evidence = {};
  const fail = (reason) => {
    throw Object.assign(new Error(reason), { partial: true });
  };
  const finish = (fields) =>
    evaluateSetup({
      id: "github-action",
      steps,
      docsDrift,
      substitutions,
      evidence,
      installedVersion: context.idiomVersion,
      wallMs: Math.round(performance.now() - started),
      ...fields,
    });

  try {
    const repo = await sampleRepo(context, home, "main");
    // 1. The documented wiring: init writes the workflow when the folder exists.
    await mkdir(join(repo, ".github", "workflows"), { recursive: true });
    await step("wire", ["idiom", "init", "--wire", "--yes"], {
      cwd: repo,
      doc: WIRE_DOC,
      stdin: "",
    });
    const workflowPath = join(repo, ".github", "workflows", "idiom.yml");
    if (!existsSync(workflowPath)) {
      docsDrift.push({
        step: "wire",
        doc: WIRE_DOC,
        expected:
          "idiom init writes .github/workflows/idiom.yml when .github/workflows/ exists",
        found: "no .github/workflows/idiom.yml after idiom init --wire --yes",
      });
      return finish({});
    }
    const workflowText = await readFile(workflowPath, "utf8");
    await writeFile(join(home.evidence, "idiom.yml"), workflowText);
    const job = parseWorkflowJob(workflowText);
    if (!job.ok) {
      for (const problem of job.problems)
        docsDrift.push({
          step: "workflow",
          doc: WIRE_DOC,
          expected: "a pull-request job with a mattskilly/idiom@<ref> step",
          found: problem,
        });
      return finish({});
    }
    git(repo, ["add", "-A"], home.env);
    git(repo, ["commit", "--quiet", "-m", "Add the Idiom workflow"], home.env);
    const mainSha = git(repo, ["rev-parse", "HEAD"], home.env);
    git(repo, ["checkout", "--quiet", context.regression.branch], home.env);
    git(repo, ["merge", "--quiet", "--no-edit", "main"], home.env);

    const unsupported = job.value.steps.find(
      (entry) => entry.kind === "unsupported",
    );
    if (unsupported)
      fail(`workflow step cannot run locally: ${unsupported.reason}`);
    const actionStep = job.value.steps.find((entry) => entry.kind === "action");
    evidence.actionRef = actionStep.ref;

    // 2. The published Action, read-only.
    const actionDir = join(home.root, "action");
    const clone = await step(
      "action-clone",
      [
        "git",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        actionStep.ref,
        `https://github.com/${context.actionRepository}`,
        actionDir,
      ],
      {
        cwd: home.root,
        display: `git clone --quiet --depth 1 --branch ${actionStep.ref} https://github.com/${context.actionRepository} <setup root>/action`,
      },
    );
    if (!clone.ok) return finish({});
    evidence.actionSha = git(actionDir, ["rev-parse", "HEAD"], home.env);
    const actionYml = parseYaml(
      await readFile(join(actionDir, "action.yml"), "utf8"),
    );
    const browser = await installBrowser(context, home, step);
    if (!browser.ok) return finish({});

    const runner = join(home.root, "runner");
    await mkdir(runner, { recursive: true });
    const pass = async (label, headSha) => {
      const github = {
        event_name: "pull_request",
        repository: "local/sample",
        sha: headSha,
        event: {
          pull_request: {
            number: 1,
            head: {
              sha: headSha,
              ref: context.regression.branch,
              repo: { full_name: "local/sample" },
            },
            base: {
              sha: mainSha,
              ref: "main",
              repo: { full_name: "local/sample" },
            },
          },
          repository: { full_name: "local/sample", default_branch: "main" },
        },
      };
      const eventPath = join(runner, `${label}-event.json`);
      await writeFile(eventPath, JSON.stringify(github.event));
      const runnerEnv = {
        ...home.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "local/sample",
        GITHUB_SHA: headSha,
        RUNNER_TEMP: runner,
        CI: "true",
      };
      const outputs = {};
      let resolvedInputs;
      for (const entry of job.value.steps) {
        if (entry.kind === "infrastructure") continue;
        if (entry.kind === "run") {
          const outputFile = join(runner, `${label}-step-${entry.index}.out`);
          await writeFile(outputFile, "");
          const stepEnv = {};
          for (const [key, value] of Object.entries(entry.env)) {
            const resolved = resolveExpressions(value, {
              steps: outputs,
              github,
            });
            if (!resolved.ok)
              fail(
                `unresolved workflow expression ${resolved.unresolved.join(", ")} in env.${key}`,
              );
            stepEnv[key] = resolved.value;
          }
          const result = await step(
            `${label}-run-${entry.id ?? entry.index}`,
            [
              "bash",
              "--noprofile",
              "--norc",
              "-eo",
              "pipefail",
              "-c",
              entry.run,
            ],
            {
              cwd: repo,
              env: { ...runnerEnv, ...stepEnv, GITHUB_OUTPUT: outputFile },
              display: `run: ${entry.name ?? entry.id ?? `step ${entry.index}`}`,
            },
          );
          if (!result.ok) return { failed: true };
          if (entry.id)
            outputs[entry.id] = parseStepOutputs(
              await readFile(outputFile, "utf8"),
            );
          continue;
        }
        // The Idiom Action step.
        resolvedInputs = {};
        for (const [name, value] of Object.entries(entry.with)) {
          const resolved = resolveExpressions(value, {
            steps: outputs,
            github,
          });
          if (!resolved.ok)
            fail(
              `unresolved workflow expression ${resolved.unresolved.join(", ")} in with.${name}`,
            );
          resolvedInputs[name] = resolved.value;
        }
        const actionEnv = {};
        for (const [name, variable] of Object.entries(INPUT_ENV)) {
          const fallback = actionYml.inputs?.[name]?.default;
          const value = resolvedInputs[name] ?? fallback;
          if (value !== undefined) actionEnv[variable] = String(value);
        }
        actionEnv.IDIOM_ACTION_VERSION = context.idiomVersion;
        actionEnv.IDIOM_ACTION_PATH = actionDir;
        const outputFile = join(runner, `${label}-action.out`);
        const summaryFile = join(runner, `${label}-summary.md`);
        await writeFile(outputFile, "");
        await writeFile(summaryFile, "");
        const runResult = await step(
          `${label}-action`,
          ["node", join(actionDir, "scripts", "github-action", "run.mjs")],
          {
            cwd: repo,
            env: {
              ...runnerEnv,
              ...actionEnv,
              GITHUB_OUTPUT: outputFile,
              GITHUB_STEP_SUMMARY: summaryFile,
            },
            display: `${actionStep.uses} (run.mjs)`,
            timeoutMs: 900_000,
            quiet: true,
          },
        );
        const actionOutputs = parseStepOutputs(
          await readFile(outputFile, "utf8"),
        );
        if (runResult.ok && !actionOutputs["result-file"]) {
          const last = steps.at(-1);
          last.ok = false;
          last.note = "the Action wrote no result-file output";
        }
        if (!runResult.ok || !actionOutputs["result-file"])
          return { failed: true, resolvedInputs };
        const result = JSON.parse(
          await readFile(actionOutputs["result-file"], "utf8"),
        );
        const { renderComment } = await import(
          pathToFileURL(
            join(actionDir, "scripts", "github-action", "comment.mjs"),
          ).href
        );
        const comment = renderComment(result, undefined);
        await writeFile(join(home.evidence, `${label}-comment.md`), comment);
        const gate = await step(
          `${label}-gate`,
          [
            "node",
            join(actionDir, "scripts", "github-action", "run.mjs"),
            "gate",
          ],
          {
            cwd: repo,
            env: {
              ...runnerEnv,
              IDIOM_ACTION_PATH: actionDir,
              IDIOM_ACTION_RESULT: actionOutputs["result-file"],
              IDIOM_ACTION_UPLOAD_OUTCOME: "success",
              IDIOM_ACTION_COMMENT_OUTCOME: "success",
            },
            display: `${actionStep.uses} (run.mjs gate)`,
            expect: () => true,
          },
        );
        return {
          resolvedInputs,
          outcome: actionOutputs.outcome,
          newFindings: Number(actionOutputs["new-findings"] ?? Number.NaN),
          operationalErrors: result.operationalErrors ?? [],
          gateExit: gate.code,
          gateOutput: (gate.stdout + gate.stderr).trim().slice(0, 600),
          comment,
        };
      }
      return { failed: true };
    };

    const blocks = (comment) => {
      const index = comment.indexOf("Blocks merge");
      return (
        index >= 0 &&
        new RegExp(`\\b${context.regression.rule}\\b`, "i").test(
          comment.slice(index),
        )
      );
    };

    // 3. The pull request at the regression head.
    const regressionHead = git(repo, ["rev-parse", "HEAD"], home.env);
    const first = await pass("regression", regressionHead);
    evidence.regression = summarize(first);
    if (first.failed) return finish({});
    const regressionPost = await postCheck(
      context,
      repo,
      step,
      "post-check-regression",
    );
    const caught =
      first.gateExit !== 0 &&
      first.newFindings > 0 &&
      blocks(first.comment) &&
      regressionPost.planted === true;

    // 4. The fix pushed to the same pull request.
    const fixedHead = await commitLine(
      repo,
      home,
      context.regression,
      context.regression.regression,
      context.regression.fix,
      context.regression.fixMessage,
    );
    const second = await pass("fix", fixedHead);
    evidence.fix = summarize(second);
    if (second.failed) return finish({ caught });
    const fixPost = await postCheck(context, repo, step, "post-check-fix");
    const fixVerified =
      second.gateExit === 0 &&
      !blocks(second.comment) &&
      fixPost.exitCode === 0 &&
      fixPost.planted === false;
    evidence.postCheck = { regression: regressionPost, fix: fixPost };
    evidence.commentExcerpt = first.comment.slice(0, 1500);
    return finish({ caught, fixVerified });
  } catch (error) {
    if (!error.partial) throw error;
    const result = finish({});
    return { ...result, status: "failed", reason: error.message };
  }
}

function summarize(pass) {
  if (!pass) return null;
  return {
    failed: pass.failed ?? false,
    resolvedInputs: pass.resolvedInputs ?? null,
    outcome: pass.outcome ?? null,
    newFindings: pass.newFindings ?? null,
    operationalErrors: pass.operationalErrors ?? [],
    gateExit: pass.gateExit ?? null,
    gateOutput: pass.gateOutput ?? null,
  };
}
