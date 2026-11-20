// Autobuild: the documented noninteractive setup (`idiom upgrade --yes`, read
// from configuration.md) and design-review wiring in an existing Autobuild
// project, run through a stub `ab` that executes the wired verify step's gate
// command the way the idiom-verify skill's gate branch does.

import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  autobuildWired,
  evaluateSetup,
  outputNamesRule,
  parseAutobuildSetup,
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

const CONFIG_DOC = "docs/configuration.md#autobuild";
const STARTING_TOML = `baseBranch = "main"

[commands]
test = "true"

[verify]
steps = ["test"]

[verify.test]
`;

/** The stub's source: parse autobuild.toml, run the step's gate command. */
function stubSource(tomlModuleUrl) {
  return `#!/usr/bin/env node
// Stub ab for the build-setup check: only \`ab verify-step <step>\`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from ${JSON.stringify(tomlModuleUrl)};
const [verb, step] = process.argv.slice(2);
if (verb !== "verify-step" || !step) {
  console.error("stub ab: usage: ab verify-step <step>");
  process.exit(2);
}
const config = parse(readFileSync("autobuild.toml", "utf8"));
if (!(config.verify?.steps ?? []).includes(step)) {
  console.error(\`stub ab: \${step} is not in [verify].steps\`);
  process.exit(2);
}
const table = config.verify?.[step];
if (!table) {
  console.error(\`stub ab: no [verify.\${step}] table\`);
  process.exit(2);
}
if (table.kind === "agent" && table.skill)
  console.log(\`stub ab: [verify.\${step}] kind agent, skill \${table.skill} (\${existsSync(\`.agents/skills/\${table.skill}/SKILL.md\`) ? "installed" : "NOT installed"})\`);
mkdirSync(".ab", { recursive: true });
writeFileSync(".ab/context.json", JSON.stringify({ phase: "verify", step }));
const command = config.commands?.[step];
if (typeof command !== "string") {
  console.error(\`stub ab: no [commands].\${step}\`);
  process.exit(2);
}
console.log(\`stub ab: \${step} → \${command}\`);
const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
process.exit(result.status ?? 1);
`;
}

export async function run(context) {
  const started = performance.now();
  const steps = [];
  const docsDrift = [];
  const substitutions = [
    "no Autobuild agent: a stub `ab verify-step idiom-check` runs the verify step's [commands] gate command directly, as the idiom-verify skill's gate branch does",
    "the existing Autobuild project is a minimal autobuild.toml (one `test` verify step) written by the harness; Idiom's wiring comes only from the documented setup command",
    "the setup runs on the sample's clean main and is committed there with its recorded baseline (the documented first-run step); its local origin/main ref is advanced to it as if pushed (the shared origin is untouched), and the regression branch is then cut from that commit with the same planted line",
  ];
  const home = await isolatedHome(context, "autobuild");
  const step = stepper(home, steps);
  const evidence = {};
  const finish = (fields) =>
    evaluateSetup({
      id: "autobuild",
      steps,
      docsDrift,
      substitutions,
      evidence,
      installedVersion: context.idiomVersion,
      wallMs: Math.round(performance.now() - started),
      ...fields,
    });

  // Setup runs on a clean main, as configuration.md documents; the build
  // branch is cut from the commit that carries the wiring and baseline.
  const repo = await sampleRepo(context, home);
  await writeFile(join(repo, "autobuild.toml"), STARTING_TOML);
  git(repo, ["add", "autobuild.toml"], home.env);
  git(repo, ["commit", "--quiet", "-m", "Add Autobuild config"], home.env);

  const browser = await installBrowser(context, home, step);
  if (!browser.ok) return finish({});

  // 1. The documented noninteractive setup, read from configuration.md and
  // run as written, with no terminal.
  const setup = parseAutobuildSetup(context.docs.configuration);
  if (!setup.ok) {
    for (const problem of setup.problems)
      docsDrift.push({
        step: "setup",
        doc: CONFIG_DOC,
        expected: "a documented noninteractive Autobuild setup command",
        found: problem,
      });
    return finish({});
  }
  const command = setup.value.argv.join(" ");
  evidence.setupCommand = command;
  const upgrade = await step("setup", setup.value.argv, {
    cwd: repo,
    doc: CONFIG_DOC,
    stdin: "",
  });
  evidence.setupOutput = upgrade.stdout.split("\n").slice(0, 60).join("\n");
  await writeFile(
    join(home.evidence, "upgrade.txt"),
    upgrade.stdout + upgrade.stderr,
  );
  const tomlPath = join(repo, "autobuild.toml");
  const skillPath = join(repo, ".agents", "skills", "idiom-verify", "SKILL.md");
  evidence.verifySkillInstalled = existsSync(skillPath);
  if (!evidence.verifySkillInstalled)
    docsDrift.push({
      step: "setup",
      doc: CONFIG_DOC,
      expected:
        "the documented setup installs the idiom-verify skill (.agents/skills/idiom-verify/SKILL.md)",
      found: `after ${command}: no idiom-verify skill`,
    });
  const afterSetup = autobuildWired(await readFile(tomlPath, "utf8"));
  if (!afterSetup.command || !afterSetup.inSteps || !afterSetup.verify)
    docsDrift.push({
      step: "setup",
      doc: CONFIG_DOC,
      expected:
        "[commands].idiom-check, [verify].steps and [verify.idiom-check]",
      found: `after ${command}: ${JSON.stringify(afterSetup)}`,
    });

  // 3. The design-review landing rule, as configuration.md documents it.
  await step(
    "design-review",
    ["idiom", "init", "--wire", "--design-review", "--yes"],
    {
      cwd: repo,
      doc: "docs/commands.md#wire-agents-ci-hooks-and-autobuild",
      stdin: "",
    },
  );
  const wired = autobuildWired(await readFile(tomlPath, "utf8"));
  evidence.wiring = wired;
  if (!wired.command || !wired.inSteps || !wired.verify)
    docsDrift.push({
      step: "design-review",
      doc: CONFIG_DOC,
      expected:
        "[commands].idiom-check, [verify].steps and [verify.idiom-check]",
      found: `after ${command} and design-review: ${JSON.stringify(wired)}`,
    });
  if (!wired.designReview)
    docsDrift.push({
      step: "design-review",
      doc: "docs/commands.md#wire-agents-ci-hooks-and-autobuild",
      expected:
        '[[landing]] label = "design-review" after idiom init --wire --design-review --yes',
      found: "no design-review landing rule in autobuild.toml",
    });
  // 4. The documented first-run step: commit the wiring and the baseline the
  // setup recorded on main, then branch the build from it.
  const baselineFile = join(repo, ".idiom", "baselines", "home.json");
  evidence.firstBaselineRecorded = existsSync(baselineFile);
  if (!evidence.firstBaselineRecorded)
    docsDrift.push({
      step: "setup",
      doc: CONFIG_DOC,
      expected:
        "on a clean main the documented setup records the gate's first baseline (.idiom/baselines/home.json)",
      found: `after ${command}: no baseline recorded`,
    });
  git(repo, ["add", "-A"], home.env);
  git(repo, ["commit", "--quiet", "-m", "Wire Idiom into Autobuild"], home.env);
  // As if main were pushed: builds take their base from origin/main. The
  // shared origin other setups clone stays untouched.
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"], home.env);
  git(repo, ["checkout", "--quiet", "-B", context.regression.branch], home.env);
  await commitLine(
    repo,
    home,
    context.regression,
    context.regression.line,
    context.regression.regression,
    context.regression.commitMessage,
  );

  // 5. The stub ab.
  const stub = join(home.hostbin, "ab");
  await writeFile(stub, stubSource(import.meta.resolve("smol-toml")));
  await chmod(stub, 0o755);

  const regressionRun = await step(
    "verify-regression",
    ["ab", "verify-step", "idiom-check"],
    {
      cwd: repo,
      expect: (raw) => raw.code !== 0 && raw.code !== 2,
      note: (raw) =>
        `expected the gate to fail on the regression; exit ${raw.code}`,
      timeoutMs: 900_000,
    },
  );
  const regressionText = regressionRun.stdout + regressionRun.stderr;
  await writeFile(join(home.evidence, "verify-regression.txt"), regressionText);
  const regressionPost = await postCheck(
    context,
    repo,
    step,
    "post-check-regression",
  );
  const caught =
    regressionRun.ok &&
    outputNamesRule(regressionText, context.regression) &&
    regressionPost.planted === true;

  const fixedHead = await commitLine(
    repo,
    home,
    context.regression,
    context.regression.regression,
    context.regression.fix,
    context.regression.fixMessage,
  );
  const fixRun = await step(
    "verify-fix",
    ["ab", "verify-step", "idiom-check"],
    {
      cwd: repo,
      timeoutMs: 900_000,
    },
  );
  const fixText = fixRun.stdout + fixRun.stderr;
  await writeFile(join(home.evidence, "verify-fix.txt"), fixText);
  const fixPost = await postCheck(context, repo, step, "post-check-fix");
  const fixVerified =
    fixRun.code === 0 &&
    !outputNamesRule(fixText, context.regression) &&
    fixPost.exitCode === 0 &&
    fixPost.planted === false;

  Object.assign(evidence, {
    fixedHead,
    regressionGate: {
      exitCode: regressionRun.code,
      tail: tail(regressionText),
    },
    fixGate: { exitCode: fixRun.code, tail: tail(fixText) },
    postCheck: { regression: regressionPost, fix: fixPost },
  });
  return finish({ caught, fixVerified });
}

const tail = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("Probe "))
    .slice(-6)
    .join("\n");
