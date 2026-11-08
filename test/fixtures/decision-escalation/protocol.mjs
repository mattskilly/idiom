// Scripted CLI/storage protocol fixture. This does not execute agent Markdown.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = process.argv[2];
const execute = async (command, args) => {
  try {
    const result = await exec(command, args, { maxBuffer: 16 * 1024 * 1024 });
    return { ...result, status: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, status: error.code };
  }
};
const ab = async (...args) => {
  const result = await execute("ab", args);
  if (result.status) throw new Error(result.stderr);
  return result.stdout.trim();
};
await mkdir(".ab/idiom-decisions", { recursive: true });
const context = JSON.parse(await readFile(".ab/context.json", "utf8"));
let changedHead = false;
if (context.feedback === "guidance") {
  const guidance = JSON.parse(await readFile(".ab/guidance.json", "utf8"));
  if (guidance.escalation !== "esc-1") throw new Error("stale guidance");
  const snapshot = JSON.parse(
    await ab("artifact", "get", "idiom-decision-questions@1"),
  );
  if (snapshot.build !== context.build) throw new Error("wrong build");
  const answers = JSON.parse(guidance.answer);
  for (const answer of answers) {
    const question = snapshot.questions.find(
      (q) => q.key === answer.key && q.id === answer.id,
    );
    const option = question?.options[answer.option];
    if (!option || typeof answer.reason !== "string" || !answer.reason.trim())
      throw new Error("incomplete/invalid explicit answer");
    const applied = await execute(process.execPath, [
      cli,
      "decide",
      ...option.args,
      "--reason",
      answer.reason,
      "--build",
      context.build,
      "--escalation",
      guidance.escalation,
    ]);
    if (applied.status) throw new Error(applied.stderr);
  }
  const before = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
  await execute("git", [
    "add",
    ".idiom/decisions.jsonl",
    ".idiom/finding-names.json",
  ]);
  const staged = await execute("git", ["diff", "--cached", "--quiet"]);
  if (staged.status === 1) {
    const commit = await execute("git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "Remember explicit human answers",
    ]);
    if (commit.status) throw new Error(commit.stderr);
  }
  const head = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
  changedHead = head !== before || head !== snapshot.head;
}
const result = await execute(process.execPath, [
  cli,
  "check",
  "--gate",
  "--fail-on",
  "major",
  "--deferred",
  "warn",
  "--json",
]);
await writeFile(".ab/idiom-decisions/stdout.json", result.stdout);
await writeFile(".ab/idiom-decisions/stderr.txt", result.stderr);
await writeFile(".ab/idiom-decisions/status.txt", String(result.status));
const payload = JSON.parse(result.stdout);
if (result.status === 4) {
  if (!payload.decisionNeeded?.length || !payload.decisionQuestion)
    throw new Error("invalid question payload");
  const head = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(
    ".ab/idiom-decisions/questions.json",
    JSON.stringify({
      build: context.build,
      head,
      questions: payload.decisionNeeded,
      question: payload.decisionQuestion,
    }),
  );
  await writeFile(".ab/idiom-decisions/report.md", payload.decisionQuestion);
  const snapshot = await ab(
    "artifact",
    "put",
    "idiom-decision-questions",
    ".ab/idiom-decisions/questions.json",
  );
  const report = await ab(
    "artifact",
    "put",
    "idiom-decision-report",
    ".ab/idiom-decisions/report.md",
  );
  await ab(
    "escalate",
    payload.decisionQuestion,
    "--refs",
    `${snapshot},${report}`,
  );
} else if (changedHead) {
  await writeFile(
    ".ab/revalidate.md",
    "Human-authorized memory changed HEAD; request normal implementation/review re-entry and rerun verification on the resulting head.",
  );
  await ab("verdict", "fail", "--report", ".ab/revalidate.md");
} else {
  await writeFile(
    ".ab/gate-report.md",
    `Gate exit ${result.status}\n${result.stderr}`,
  );
  await ab(
    "verdict",
    result.status === 0 ? "pass" : "fail",
    result.status === 0 ? "--notes" : "--report",
    ".ab/gate-report.md",
  );
}
