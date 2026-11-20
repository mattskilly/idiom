// The shared shape of the agent setups (Claude Code, Codex): find the host
// tool, install exactly what getting-started says in an isolated home, probe
// model auth, and only then run the task prompt headless on the regression
// branch and read the transcript.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  agentSignals,
  evaluateSetup,
  notRun,
  parseAgentInstall,
  TASK_PROMPT,
} from "../check-pipelines-lib.mjs";
import {
  hostTool,
  installBrowser,
  isolatedHome,
  postCheck,
  sampleRepo,
  stepper,
} from "./common.mjs";

export const INSTALL_DOC =
  "site/docs/getting-started.md#3-hand-it-to-your-agent";

/** The highest version directory under a plugin cache, or null. */
export async function cachedPluginVersion(directory) {
  if (!existsSync(directory)) return null;
  const versions = (await readdir(directory)).filter((name) =>
    /^\d+\.\d+\.\d+/.test(name),
  );
  return versions.sort().at(-1) ?? null;
}

/**
 * spec: { id, tool, keyVariables, install(ctx) → {installedVersion, drift?},
 * auth(ctx) → {loggedIn, detail}, session(ctx) → argv, signalsKind,
 * reminderRequired, substitutions }
 */
export async function runAgentSetup(context, spec) {
  const started = performance.now();
  const steps = [];
  const docsDrift = [];
  const substitutions = [...spec.substitutions];
  const home = await isolatedHome(context, spec.id);
  const step = stepper(home, steps);
  const evidence = {};
  let installedVersion = null;
  const partial = () => ({
    steps,
    docsDrift,
    substitutions,
    evidence,
    installedVersion,
    wallMs: Math.round(performance.now() - started),
  });
  const finish = (fields) =>
    evaluateSetup({ id: spec.id, ...partial(), ...fields });

  const tool = await hostTool(spec.tool, home);
  if (tool.missing) return notRun(spec.id, tool.missing, partial());
  evidence.toolVersion = tool.version;

  const docs = parseAgentInstall(context.docs.gettingStarted);
  if (!docs.ok) {
    for (const problem of docs.problems)
      docsDrift.push({
        step: "install",
        doc: INSTALL_DOC,
        expected: "the documented agent install lines",
        found: problem,
      });
    return finish({});
  }

  const install = await spec.install({
    context,
    home,
    step,
    docs: docs.value,
    evidence,
  });
  installedVersion = install.installedVersion;
  docsDrift.push(...(install.drift ?? []));
  if (steps.some((entry) => !entry.ok) || docsDrift.length) return finish({});

  // Model auth: never copy credentials. Only an API key variable already set
  // in this process is forwarded, and only with --model-key-env.
  const forwarded = context.modelKeyEnv
    ? spec.keyVariables.filter((name) => process.env[name])
    : [];
  for (const name of forwarded) home.env[name] = process.env[name];
  if (forwarded.length)
    substitutions.push(
      `model auth: forwarded env key ${forwarded.join(", ")} (--model-key-env)`,
    );
  const auth = await spec.auth({ home, step });
  evidence.auth = { loggedIn: auth.loggedIn, detail: auth.detail, forwarded };
  if (!forwarded.length && !auth.loggedIn)
    return notRun(
      spec.id,
      `no model credentials in the isolated home (pass --model-key-env to forward ${spec.keyVariables.join(" or ")})`,
      partial(),
    );
  if (!forwarded.length && auth.loggedIn)
    return notRun(
      spec.id,
      `the isolated home reports a login it did not make (${auth.detail}); real credentials are out of scope, pass --model-key-env instead`,
      partial(),
    );

  const browser = await installBrowser(context, home, step);
  if (!browser.ok) return finish({});
  const repo = await sampleRepo(context, home, context.regression.branch);
  const transcriptPath = join(home.evidence, "transcript.jsonl");
  const session = await step("session", spec.session({ repo }), {
    cwd: repo,
    logFile: transcriptPath,
    quiet: true,
    timeoutMs: 1_200_000,
    display: `${spec.tool} (headless) "${TASK_PROMPT}"`,
  });
  const lines = (await readFile(transcriptPath, "utf8")).split("\n");
  const signals = agentSignals(lines, spec.signalsKind, context.regression);
  if (spec.reminderRequired) {
    const hookRecord = existsSync(join(repo, ".idiom", "agent-hooks"));
    signals.reminderSource = signals.reminderFired
      ? "transcript"
      : hookRecord
        ? ".idiom/agent-hooks"
        : null;
    signals.reminderFired = signals.reminderFired || hookRecord;
  }
  const post = await postCheck(context, repo, step, "post-check");
  evidence.signals = signals;
  evidence.postCheck = post;
  evidence.sessionExit = session.code;
  const caught = signals.caught;
  const fixVerified =
    signals.fixed &&
    signals.verifyRan &&
    post.exitCode === 0 &&
    post.planted === false;
  return finish({
    caught,
    fixVerified,
    extra: spec.reminderRequired
      ? { required: { reminderFired: signals.reminderFired === true } }
      : {
          notes:
            "no reminder hook in this setup; reminderFired is not required",
        },
  });
}
