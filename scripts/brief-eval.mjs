// Measures whether a coding agent reaches for `idiom brief` unprompted: runs a
// headless Claude Code session in a fixture project with the Idiom skill and
// MCP server installed, asks for a ticket without mentioning Idiom, and checks
// whether it triaged before writing the ticket. Not part of `bun run test`.
//
//   node scripts/brief-eval.mjs [--runs 3] [--model <id>] [--with-instruction]
//                               [--keep] [--json]
//
// Exits 0 for any measured result, nonzero only when the harness fails.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyTranscript,
  EVAL_BRIEF_INSTRUCTION,
  renderEvalTable,
} from "./brief-eval-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const fixture = join(root, "scripts", "fixtures", "brief-eval");
const TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const options = { runs: 3, withInstruction: false, keep: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runs") options.runs = Number(argv[++index]);
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--with-instruction") options.withInstruction = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error("--runs must be a positive integer");
  return options;
}

function fail(message) {
  console.error(`brief-eval: ${message}`);
  process.exit(2);
}

function which(command) {
  const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], {
    encoding: "utf8",
  });
  return found.status === 0 ? found.stdout.trim() : undefined;
}

async function prepare(withInstruction) {
  // The wrapper and MCP config live beside the project, not in it.
  const harness = await mkdtemp(join(tmpdir(), "idiom-brief-eval-"));
  const directory = join(harness, "project");
  await cp(fixture, directory, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("node", [cli, "init", "--yes", "--project", directory], {
    cwd: directory,
    stdio: "ignore",
  });
  const bin = join(harness, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "idiom"),
    `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`,
  );
  await chmod(join(bin, "idiom"), 0o755);
  const mcpConfig = join(harness, "mcp.json");
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: { idiom: { command: "node", args: [cli, "mcp"] } },
    }),
  );
  if (withInstruction)
    await appendFile(join(directory, "CLAUDE.md"), EVAL_BRIEF_INSTRUCTION);
  return { harness, directory, bin, mcpConfig };
}

async function requestText() {
  const pinned = JSON.parse(
    await readFile(
      join(root, "test", "fixtures", "brief", "triage", "pinned-group.json"),
      "utf8",
    ),
  );
  return pinned.request;
}

function runClaude({ directory, bin, mcpConfig }, prompt, model) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    // Keep the user's own plugins and settings (an installed Idiom plugin
    // included) out of the run; the project's skill and CLAUDE.md still load.
    "--setting-sources",
    "project",
    ...(model === undefined ? [] : ["--model", model]),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: directory,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(cli)) fail(`missing ${cli}; run bun run build first`);
  if (which("claude") === undefined) fail("claude is not on PATH");
  const version = execFileSync("claude", ["--version"], {
    encoding: "utf8",
  }).trim();
  const prompt = `Write a ticket for this request and save it in tickets/: "${await requestText()}"`;
  const arms = options.withInstruction
    ? ["skill", "skill+instruction"]
    : ["skill"];
  const rows = [];
  for (const arm of arms)
    for (let run = 1; run <= options.runs; run += 1) {
      const project = await prepare(arm === "skill+instruction");
      try {
        const outcome = await runClaude(project, prompt, options.model);
        const lines = outcome.stdout.split("\n").filter(Boolean);
        if (lines.length === 0)
          fail(
            `claude produced no transcript (exit ${outcome.code}${outcome.signal ? `, ${outcome.signal}` : ""}): ${outcome.stderr.trim().slice(0, 500)}`,
          );
        const result = lines
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return undefined;
            }
          })
          .find((event) => event?.type === "result");
        if (result?.is_error === true)
          fail(
            `claude reported an error: ${String(result.result ?? result.subtype).slice(0, 500)}`,
          );
        rows.push({
          arm,
          run,
          exit: outcome.code,
          ...classifyTranscript(lines),
          ...(options.keep ? { directory: project.directory } : {}),
        });
      } finally {
        if (!options.keep)
          await rm(project.harness, { recursive: true, force: true });
      }
    }
  const summary = {
    date: new Date().toISOString().slice(0, 10),
    claudeCode: version,
    model: options.model ?? "default",
    rows,
  };
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else
    console.log(
      `${summary.date} · ${version} · model ${summary.model}\n\n${renderEvalTable(rows)}`,
    );
}

main().catch((error) => fail(error?.stack ?? String(error)));
