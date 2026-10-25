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
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beneath,
  evidencePath,
  execute,
  gate,
  html,
  readJson,
  validateEvent,
  validateInputs,
  validateSummary,
} from "./common.mjs";

export function environmentInputs(env = process.env) {
  return {
    flow: env.IDIOM_ACTION_FLOW,
    project: env.IDIOM_ACTION_PROJECT ?? ".",
    version: env.IDIOM_ACTION_VERSION ?? "latest",
    failOn: env.IDIOM_ACTION_FAIL_ON ?? "major",
    setup: env.IDIOM_ACTION_SETUP ?? "npm ci",
  };
}

async function stageCrops(result, afterRun, evidence) {
  await mkdir(join(evidence, "crops"), { recursive: true });
  await mkdir(join(evidence, "compare"), { recursive: true });
  for (const [index, finding] of result.summary.findings.entries()) {
    if (!finding.screenshot) {
      result.unavailable.push(`No screenshot for finding ${finding.id}`);
      continue;
    }
    try {
      const source = await evidencePath(
        afterRun,
        resolve(result.headProject, finding.screenshot),
      );
      const path = `crops/${index + 1}-${basename(source)}`;
      await copyFile(source, join(evidence, path));
      result.crops.push({
        finding: index,
        path,
        label: source.includes("/crops/")
          ? "Element crop"
          : "Full screenshot (element crop unavailable)",
      });
    } catch (error) {
      result.unavailable.push(`Finding ${finding.id}: ${error.message}`);
    }
  }
}

async function stageComparison(result, compareDirectory, evidence) {
  for (const tuple of result.comparison.changed) {
    try {
      const source = await evidencePath(compareDirectory, tuple.path);
      const path = `compare/${basename(source)}`;
      await copyFile(source, join(evidence, path));
      result.composites.push({ key: tuple.key, path });
    } catch (error) {
      result.unavailable.push(`Composite ${tuple.key}: ${error.message}`);
    }
  }
  for (const name of ["before-after.md", "attachments.json"]) {
    await copyFile(
      await evidencePath(compareDirectory, name),
      join(evidence, "compare", name),
    );
  }
}

export function renderIndex(result) {
  const image = (entry) =>
    `<p>${html(entry.label ?? entry.key)}: <a href="${html(entry.path)}">${html(entry.path)}</a></p><img style="max-width:100%" src="${html(entry.path)}" alt="${html(entry.label ?? entry.key)}">`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Idiom regression evidence</title><body><h1>Idiom: ${html(result.flow)}</h1><p>Merge base ${html(result.baseline ?? "unavailable")} → ${html(result.head ?? "unavailable")}</p><p><a href="summary.json">Check JSON</a> · <a href="comparison.json">Compare JSON</a> · <a href="result.json">Action result</a> · <a href="diagnostics.log">Diagnostics</a></p>${result.operationalErrors.map((error) => `<p>${html(error)}</p>`).join("")}<h2>New findings</h2>${(
    result.summary?.findings ?? []
  )
    .map(
      (finding, index) =>
        `<article><h3>${html(finding.severity)}: ${html(finding.problem)}</h3><p>${html(finding.where)}</p><ul>${finding.fix.map((fix) => `<li>${html(fix)}</li>`).join("")}</ul>${(
          result.crops ?? []
        )
          .filter((crop) => crop.finding === index)
          .map(image)
          .join("")}</article>`,
    )
    .join(
      "",
    )}<h2>Before / after</h2>${(result.composites ?? []).map(image).join("")}<p>Unchanged: ${result.comparison?.unchanged.length ?? 0}; only before: ${result.comparison?.onlyBefore.length ?? 0}; only after: ${result.comparison?.onlyAfter.length ?? 0}</p><ul>${(result.comparison?.notComparable ?? []).map((tuple) => `<li>${html(tuple.key)}: ${html(tuple.reason)}</li>`).join("")}${(result.unavailable ?? []).map((reason) => `<li>${html(reason)}</li>`).join("")}</ul></body></html>\n`;
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
    for (const [side, sha] of [
      ["before", result.baseline],
      ["after", result.head],
    ]) {
      const tree = join(scratch, side);
      await git(["worktree", "add", "--detach", tree, sha]);
      ownedWorktrees.push(tree);
      await run(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", inputs.setup],
        tree,
      );
      const project = await evidencePath(tree, beneath(tree, inputs.project));
      // Require this exact project's config, rather than discovering an ancestor.
      await readFile(join(project, ".idiom/project.json"));
      await readFile(
        beneath(join(project, ".idiom/flows"), `${inputs.flow}.json`),
      );
      const runDirectory = join(project, ".idiom/reports", `action-${side}`);
      await idiom(
        ["capture", inputs.flow, "--project", project, "--out", runDirectory],
        project,
      );
      paths[side] = { project, runDirectory };
      if (side === "before") {
        const recorded = JSON.parse(
          await idiom(
            [
              "baseline",
              "record",
              inputs.flow,
              "--project",
              project,
              "--from",
              "action-before",
              "--out",
              join(scratch, "baselines"),
              "--json",
            ],
            project,
          ),
        );
        const file = await readJson(
          await evidencePath(join(scratch, "baselines"), recorded.path),
        );
        const record = file.records?.find(
          (record) => record.commit === result.baseline,
        );
        if (
          recorded.commit !== result.baseline ||
          !record ||
          file.flow !== inputs.flow ||
          file.version !== 1
        )
          throw new Error("Base baseline does not describe the merge base");
        paths.baselineFile = join(scratch, "merge-base.json");
        await writeFile(
          paths.baselineFile,
          JSON.stringify({ version: 1, flow: inputs.flow, records: [record] }),
        );
        await copyFile(paths.baselineFile, join(evidence, "merge-base.json"));
      }
    }
    result.headProject = paths.after.project;
    result.summary = validateSummary(
      JSON.parse(
        await idiom(
          [
            "check",
            inputs.flow,
            "--project",
            paths.after.project,
            "--from",
            "action-after",
            "--baseline-file",
            paths.baselineFile,
            "--json",
            "--fail-on",
            "never",
          ],
          paths.after.project,
        ),
      ),
      inputs.flow,
      result.baseline,
    );
    await writeFile(
      join(evidence, "summary.json"),
      `${JSON.stringify(result.summary, null, 2)}\n`,
    );
    await stageCrops(result, paths.after.runDirectory, evidence);
    await cp(
      paths.before.runDirectory,
      join(paths.after.project, ".idiom/reports/action-before"),
      { recursive: true, errorOnExist: true, force: false },
    );
    const comparisonDirectory = join(scratch, "comparison");
    result.comparison = JSON.parse(
      await idiom(
        [
          "compare",
          inputs.flow,
          "--project",
          paths.after.project,
          "--from",
          "action-after",
          "--against",
          "action-before",
          "--out",
          comparisonDirectory,
          "--json",
        ],
        paths.after.project,
      ),
    );
    if (
      result.comparison.before?.commit !== result.baseline ||
      result.comparison.after?.commit !== result.head ||
      ![
        "changed",
        "unchanged",
        "onlyBefore",
        "onlyAfter",
        "notComparable",
      ].every((key) => Array.isArray(result.comparison[key]))
    )
      throw new Error("invalid compare JSON or capture provenance");
    await writeFile(
      join(evidence, "comparison.json"),
      `${JSON.stringify(result.comparison, null, 2)}\n`,
    );
    await stageComparison(result, comparisonDirectory, evidence);
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
