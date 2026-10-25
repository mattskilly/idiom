import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  agentArguments,
  runAgent,
  spawnAgentProcess,
} from "../src/fix/agent.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function stub(source: string) {
  const cwd = await mkdtemp(join(tmpdir(), "idiom-agent-"));
  directories.push(cwd);
  const path = join(cwd, "codex");
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o755);
  return {
    cwd,
    path,
    environment: { ...process.env, PATH: `${cwd}:${process.env.PATH}` },
  };
}
test("provider argument arrays permit bounded noninteractive edits", () => {
  expect(agentArguments("codex")).toEqual([
    "exec",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "--color",
    "never",
    "-",
  ]);
  expect(agentArguments("claude")).toEqual([
    "--print",
    "--output-format",
    "json",
    "--safe-mode",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read,Edit,Write,Glob,Grep",
    "--allowedTools",
    "Read,Edit,Write,Glob,Grep",
    "--disallowedTools",
    "mcp__*",
    "--strict-mcp-config",
  ]);
});
test("real spawn supplies stdin, cwd, and args without shell interpolation", async () => {
  const fixture = await stub(
    "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>require('fs').writeFileSync('seen.json',JSON.stringify({input,args:process.argv.slice(2),cwd:process.cwd()})));",
  );
  const prompt = "`literal` $(literal)\nsecret instruction";
  expect(
    await runAgent(
      { agent: "codex", prompt, cwd: fixture.cwd },
      { environment: fixture.environment },
    ),
  ).toEqual({ ok: true });
  expect(
    JSON.parse(await readFile(join(fixture.cwd, "seen.json"), "utf8")),
  ).toEqual({
    input: prompt,
    args: agentArguments("codex"),
    cwd: await realpath(fixture.cwd),
  });
});
for (const [name, stdout, ok] of [
  ["success", '{"type":"result","subtype":"success","is_error":false}', true],
  [
    "error flag",
    '{"type":"result","subtype":"success","is_error":true}',
    false,
  ],
  ["missing flag", '{"type":"result","subtype":"success"}', false],
  [
    "error subtype",
    '{"type":"result","subtype":"error_max_turns","is_error":false}',
    false,
  ],
  ["malformed", "nope", false],
  ["null", "null", false],
] as const)
  test(`Claude validates ${name}`, async () => {
    const result = await runAgent(
      { agent: "claude", prompt: "repair", cwd: "/" },
      { runner: async () => ({ code: 0, stdout, stderr: "" }) },
    );
    expect(result.ok).toBe(ok);
  });
test("missing executable and nonzero exit preserve useful bounded diagnostics", async () => {
  const missing = await runAgent(
    { agent: "codex", prompt: "repair", cwd: "/" },
    { environment: { PATH: "/nonexistent" } },
  );
  expect(missing).toMatchObject({ ok: false });
  expect(missing.diagnostic).toContain("PATH");
  const fixture = await stub(
    "process.stdin.resume();console.error('bad auth');process.exitCode=2;",
  );
  const result = await runAgent(
    { agent: "codex", prompt: "repair", cwd: fixture.cwd },
    { environment: fixture.environment },
  );
  expect(result.ok).toBe(false);
  expect(result.diagnostic).toContain("bad auth");
});
test("output overflow and finite timeout terminate real processes", async () => {
  const fixture = await stub(
    "process.stdin.resume();console.log('x'.repeat(10000));setInterval(()=>{},1000);",
  );
  const overflow = await runAgent(
    { agent: "codex", prompt: "repair", cwd: fixture.cwd },
    { environment: fixture.environment, maxOutputBytes: 100, timeoutMs: 2000 },
  );
  expect(overflow.ok).toBe(false);
  expect(overflow.diagnostic).toContain("output limit");
  await writeFile(
    fixture.path,
    `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);`,
  );
  const timeout = await runAgent(
    { agent: "codex", prompt: "repair", cwd: fixture.cwd },
    { environment: fixture.environment, timeoutMs: 50 },
  );
  expect(timeout.ok).toBe(false);
  expect(timeout.diagnostic).toContain("timed out");
});
test("early closed stdin, signals and aborts fail without hanging", async () => {
  const fixture = await stub("process.exit(0)");
  const result = await runAgent(
    { agent: "codex", prompt: "x".repeat(2_000_000), cwd: fixture.cwd },
    { environment: fixture.environment },
  );
  expect(result.ok).toBe(false);
  expect(result.diagnostic).toMatch(/stdin|EPIPE/);
  const controller = new AbortController();
  controller.abort();
  expect(
    await spawnAgentProcess({
      executable: fixture.path,
      args: [],
      cwd: fixture.cwd,
      stdin: "",
      environment: fixture.environment,
      timeoutMs: 1000,
      maxOutputBytes: 100,
      signal: controller.signal,
    }),
  ).toMatchObject({ error: "agent aborted" });
  expect(
    await runAgent(
      { agent: "codex", prompt: "", cwd: fixture.cwd },
      {
        runner: async () => ({
          code: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
        }),
      },
    ),
  ).toMatchObject({ ok: false });
});
