#!/usr/bin/env node
// Prove the idiom-fix verify step on the fixture repository, outside a real
// Autobuild build: the same command sequence the skill runs, against the built
// CLI, with a stub `ab` that records every call.
//
//   node scripts/prove-idiom-fix.mjs [--agent claude|codex] [--out <dir>]
//
// Cycle 1: gate round 0 finds the planted toolbar gap; the fixer edits the
// CSS; gate round 1 re-verifies; the fix is committed and the step fails
// "fixed in-build". The implement turn keeps the commit. Cycle 2: the gate
// passes on the new head. Writes <out>/transcript.md, <out>/branch.diff,
// <out>/artifacts.json and <out>/ab-calls.jsonl. Run `bun run build` first.
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createFixFixture, scriptedFix } from "./idiom-fix-fixture.mjs";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const cli = join(root, "build", "cli.js");
const gateCommand = "idiom check --gate --fail-on major --deferred warn";
const { values } = parseArgs({
  options: {
    agent: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean" },
  },
});
if (values.agent !== undefined && !["claude", "codex"].includes(values.agent))
  throw new Error("--agent must be claude or codex");
const out = resolve(
  values.out ?? (await mkdtemp(join(tmpdir(), "idiom-fix-proof-"))),
);
await mkdir(out, { recursive: true });

// The stub `ab`: records argv, answers `context`, accepts the rest.
const bin = await mkdtemp(join(tmpdir(), "idiom-fix-ab-"));
const log = join(out, "ab-calls.jsonl");
await writeFile(log, "");
await writeFile(
  join(bin, "ab"),
  `#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.AB_STUB_LOG, JSON.stringify({ args, cycle: process.env.AB_STUB_CYCLE }) + "\\n");
if (args[0] === "context") {
  mkdirSync(".ab", { recursive: true });
  writeFileSync(".ab/context.json", JSON.stringify({ build: "fixture", phase: "verify:idiom-check", round: Number(process.env.AB_STUB_CYCLE), required: [], allowedTerminals: ["verdict", "escalate"], manifestPath: ".ab/context.json", materialized: {} }, null, 2));
  console.log("context materialized for fixture — verify:idiom-check");
} else console.log("ok");
`,
);
await chmod(join(bin, "ab"), 0o755);
let cycle = 1;
const env = () => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  AB_STUB_LOG: log,
  AB_STUB_CYCLE: String(cycle),
});

async function idiom(directory, args) {
  try {
    const { stdout, stderr } = await exec("node", [cli, ...args], {
      cwd: directory,
      env: env(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: 0, out: stdout, err: stderr };
  } catch (error) {
    return {
      status: typeof error.code === "number" ? error.code : 1,
      out: error.stdout ?? "",
      err: error.stderr ?? String(error),
    };
  }
}

const transcript = [];
const say = (...lines) => transcript.push(...lines);
const fixture = await createFixFixture({ idiom });
const directory = fixture.directory;
const ab = async (...args) =>
  (await exec("ab", args, { cwd: directory, env: env() })).stdout.trim();
const git = fixture.git;

/** One gate call with the skill's exact argv plus --json --handoff. */
async function gate(n) {
  const args = [
    ...gateCommand.split(" ").slice(1),
    "--json",
    "--handoff",
    ".ab/idiom-fix",
  ];
  const result = await idiom(directory, args);
  await mkdir(join(directory, ".ab", "idiom-fix"), { recursive: true });
  await writeFile(join(directory, `.ab/idiom-fix/gate-${n}.json`), result.out);
  await writeFile(join(directory, `.ab/idiom-fix/gate-${n}.err`), result.err);
  await writeFile(
    join(directory, `.ab/idiom-fix/gate-${n}.status`),
    `${result.status}\n`,
  );
  const json = JSON.parse(result.out);
  return { ...result, json };
}

/** The fixer: the scripted CSS edit, or a real agent given the handoff. */
async function fix(round) {
  const handoff = await readFile(
    join(directory, `.ab/idiom-fix/round-${round}/handoff.md`),
    "utf8",
  );
  if (values.agent === undefined) return await scriptedFix(directory);
  const prompt = `${handoff}\n\nYou are working in ${directory}. Edit the application source to fix the findings above. Leave all edits uncommitted. Never stage, commit, stash, reset or clean.`;
  // The same argument shape as src/fix/agent.ts uses for idiom fix.
  const args =
    values.agent === "codex"
      ? [
          "exec",
          "--sandbox",
          "workspace-write",
          "-c",
          'approval_policy="never"',
          "--color",
          "never",
          "-",
        ]
      : [
          "--print",
          "--permission-mode",
          "acceptEdits",
          "--tools",
          "Read,Edit,Write,Glob,Grep",
          "--allowedTools",
          "Read,Edit,Write,Glob,Grep",
        ];
  const status = await new Promise((accept) => {
    const child = spawn(values.agent, args, {
      cwd: directory,
      env: process.env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", () => accept(127));
    child.on("close", (code) => accept(code ?? 1));
    child.stdin.end(prompt);
  });
  if (status !== 0) throw new Error(`${values.agent} exited ${status}`);
  return (await git("status", "--porcelain"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((path) => !path.startsWith(".ab/") && !path.startsWith(".idiom/"));
}

try {
  say(
    "# idiom-fix verify step — fixture build transcript",
    "",
    `Fixture: test/fixtures/idiom-fix on branch ab/fixture (base ${fixture.baseline.slice(0, 12)}, planted change ${fixture.change.slice(0, 12)}: the toolbar change centres its buttons and drops \`gap: 8px\` to \`gap: 2px\`).`,
    `Fixer: ${values.agent ?? "scripted (applies the suggested CSS change)"}.`,
    "",
    "## Verify cycle 1",
    "",
  );
  await ab("context");
  const startHead = (await git("rev-parse", "HEAD")).trim();
  await rm(join(directory, ".ab", "idiom-fix"), {
    recursive: true,
    force: true,
  });
  const round0 = await gate(0);
  say(
    `\`$ ${gateCommand} --json --handoff .ab/idiom-fix\` → exit ${round0.status}, handoff round ${round0.json.handoff.round}, next \`${round0.json.handoff.next}\`, ${round0.json.handoff.targets} target(s).`,
    "",
    "### Finding (round-0/handoff.md)",
    "",
    (
      await readFile(
        join(directory, ".ab/idiom-fix/round-0/handoff.md"),
        "utf8",
      )
    ).trim(),
    "",
  );
  if (round0.json.handoff.next !== "repair")
    throw new Error(`round 0 did not ask for repair: ${round0.err}`);
  const paths = await fix(0);
  say(
    "### Fix",
    "",
    "```diff",
    (await git("diff", "--", ...paths)).trim(),
    "```",
    "",
  );
  const round1 = await gate(1);
  const handoff1 = JSON.parse(
    await readFile(
      join(directory, ".ab/idiom-fix/round-1/handoff.json"),
      "utf8",
    ),
  );
  say(
    "### Re-verify",
    "",
    `\`$ ${gateCommand} --json --handoff .ab/idiom-fix\` → exit ${round1.status}, round ${handoff1.round}, next \`${handoff1.next}\`; fixed ${handoff1.progress.fixed.join(", ") || "none"}, persisting ${handoff1.progress.persisting.join(", ") || "none"}, introduced ${handoff1.progress.introduced.join(", ") || "none"}.`,
    "",
  );
  if (handoff1.outcome !== "commit") throw new Error("the fix did not verify");
  await git("add", "--", ...paths);
  await git(
    "-c",
    "user.name=Idiom fix",
    "-c",
    "user.email=fix@example.com",
    "commit",
    "--quiet",
    "-m",
    `idiom-fix: ${handoff1.progress.fixed.join(", ")} (verify round 1)\n\nCo-Authored-By: Idiom fixture proof <noreply@example.com>`,
  );
  await writeFile(
    join(directory, ".ab/idiom-fix/round-1/edits.md"),
    `- ${paths.join(", ")}: restored the toolbar gap to 8px (the director's "at least 8px apart"); committed.\n`,
  );
  await git(
    "restore",
    "--source=HEAD",
    "--worktree",
    "--",
    ".idiom/finding-names.json",
  );
  const transcriptPath = join(directory, ".ab/idiom-fix/transcript.md");
  await writeFile(
    transcriptPath,
    `${await readFile(transcriptPath, "utf8")}\n### Edits re-verified in round 1\n\n${await readFile(join(directory, ".ab/idiom-fix/round-1/edits.md"), "utf8")}`,
  );
  let crop = 0;
  for (const round of ["round-0", "round-1"])
    for (const name of (
      await readdir(join(directory, ".ab/idiom-fix", round, "crops")).catch(
        () => [],
      )
    ).sort()) {
      crop += 1;
      await ab(
        "artifact",
        "put",
        `idiom-fix-crop-${String(crop).padStart(3, "0")}`,
        `.ab/idiom-fix/${round}/crops/${name}`,
        "--attach",
      );
    }
  await ab(
    "artifact",
    "put",
    "idiom-fix-report",
    ".ab/idiom-fix/transcript.md",
    "--attach",
  );
  const shas = (await git("log", "--format=%H", `${startHead}..HEAD`)).trim();
  const patch = (
    await git("format-patch", "--stdout", `${startHead}..HEAD`)
  ).trim();
  await writeFile(
    join(directory, ".ab/idiom-fix/fixed.md"),
    [
      `Idiom fixed and re-verified ${handoff1.progress.fixed.length} finding(s) in this build in commit(s) ${shas.split("\n").join(", ")}; the re-verify passed on that head.`,
      "Implement must keep these commits and finish without reverting them. If they are missing, apply this patch:",
      "",
      "```",
      patch,
      "```",
      "",
    ].join("\n"),
  );
  const verdict1 = ["verdict", "fail", "--report", ".ab/idiom-fix/fixed.md"];
  await ab(...verdict1);
  say(
    "### Result",
    "",
    `Committed ${shas.slice(0, 12)}; \`ab ${verdict1.join(" ")}\` (fixed in-build: the build returns to implement).`,
    `Worktree clean apart from .ab/: ${(await git("status", "--porcelain")).trim() === "" ? "yes" : "no"}.`,
    "",
    "## Implement",
    "",
    `The implement turn keeps the commit (HEAD ${(await git("rev-parse", "--short=12", "HEAD")).trim()} contains it) and finishes; its terminal publishes it.`,
    "",
    "## Verify cycle 2",
    "",
  );
  cycle = 2;
  await ab("context");
  await rm(join(directory, ".ab", "idiom-fix"), {
    recursive: true,
    force: true,
  });
  const pass = await gate(0);
  say(
    `\`$ ${gateCommand} --json --handoff .ab/idiom-fix\` → exit ${pass.status}, next \`${pass.json.handoff.next}\`.`,
  );
  if (pass.status !== 0 || pass.json.handoff.next !== "pass")
    throw new Error(`cycle 2 did not pass: ${pass.err}`);
  await git(
    "restore",
    "--source=HEAD",
    "--worktree",
    "--",
    ".idiom/finding-names.json",
  );
  await ab(
    "artifact",
    "put",
    "idiom-fix-report",
    ".ab/idiom-fix/transcript.md",
    "--attach",
  );
  await ab("verdict", "pass", "--notes", ".ab/idiom-fix/transcript.md");
  say("`ab verdict pass --notes .ab/idiom-fix/transcript.md`.", "");

  const calls = (await readFile(log, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const artifacts = calls
    .filter((call) => call.args[0] === "artifact" && call.args[1] === "put")
    .map((call) => ({
      cycle: Number(call.cycle),
      kind: call.args[2],
      path: call.args[3],
      attach: call.args.includes("--attach"),
    }));
  await writeFile(
    join(out, "artifacts.json"),
    `${JSON.stringify(artifacts, null, 2)}\n`,
  );
  await writeFile(
    join(out, "branch.diff"),
    await git("log", "-p", "--format=commit %H%n%s%n", "main..ab/fixture"),
  );
  await cp(
    join(directory, ".ab/idiom-fix/transcript.md"),
    join(out, "cycle-2-transcript.md"),
  );
  say(
    "## Stub `ab` calls",
    "",
    ...calls.map(
      (call) => `- cycle ${call.cycle}: \`ab ${call.args.join(" ")}\``,
    ),
    "",
  );
  await writeFile(join(out, "transcript.md"), `${transcript.join("\n")}\n`);
  console.log(`prove-idiom-fix: PASS — evidence in ${out}`);
} finally {
  if (!values.keep) await fixture.cleanup();
  else console.log(`fixture kept at ${directory}`);
  await rm(bin, { recursive: true, force: true });
}
