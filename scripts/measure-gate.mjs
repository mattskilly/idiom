#!/usr/bin/env node
// Measure `idiom check --gate` against the full check on test/fixtures/gate-app.
// Run after `bun run build`: node scripts/measure-gate.mjs
// Exits non-zero, printing no pass numbers, when the gate does not take the
// narrow path the measurement relies on.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..");
const cli = join(root, "build", "cli.js");
const fixture = join(root, "test", "fixtures", "gate-app");
const budgetMs = 180_000;

function fail(reason) {
  console.error(`measure-gate: FAILED — ${reason}`);
  process.exit(1);
}

async function idiom(cwd, args) {
  const started = performance.now();
  try {
    const { stdout, stderr } = await exec("node", [cli, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, ms: performance.now() - started };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
      ms: performance.now() - started,
    };
  }
}

const lastTiming = (stderr) =>
  stderr
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("Timing"))
    .at(-1) ?? "(no Timing line)";
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

const directory = await mkdtemp(join(tmpdir(), "idiom-gate-measure-"));
const git = (...args) => exec("git", args, { cwd: directory });
const commit = async (message) => {
  await git("add", ".");
  await git(
    "-c",
    "user.name=Measure",
    "-c",
    "user.email=measure@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  );
};
try {
  const init = await idiom(directory, ["init", "--yes"]);
  if (init.code !== 0) fail(`idiom init failed: ${init.stderr}`);
  await cp(fixture, directory, { recursive: true, force: true });
  await writeFile(
    join(directory, ".gitignore"),
    ".idiom/reports/\n.idiom/cache/\n.idiom/agent-state.json\n",
  );
  await git("init", "--quiet", "--initial-branch=main");
  await commit("gate fixture");

  // 1. Full run: seeds timing history, probe fingerprints and the baseline.
  const full = await idiom(directory, [
    "check",
    "app",
    "--json",
    "--fail-on",
    "never",
  ]);
  if (full.code !== 0) fail(`full check failed: ${full.stderr.slice(-2000)}`);
  const fullSummary = JSON.parse(full.stdout);
  await commit("record baseline");

  // 2. One colour in one component stylesheet, left uncommitted.
  const css = join(directory, "components", "Card.module.css");
  const before = await readFile(css, "utf8");
  const after = before.replace("color: #1f4fd1;", "color: #b4234a;");
  if (after === before) fail("the fixture stylesheet changed shape");
  await writeFile(css, after);

  // 3. The gate.
  const gate = await idiom(directory, [
    "check",
    "--gate",
    "--json",
    "--fail-on",
    "never",
  ]);
  if (gate.code !== 0) fail(`gate failed: ${gate.stderr.slice(-2000)}`);
  const output = JSON.parse(gate.stdout);
  const plan = output.gate?.plan;
  if (!plan) fail("the gate printed no plan (did it skip?)");
  if (plan.graph?.complete !== true)
    fail(`graph incomplete: ${(plan.graph?.reasons ?? []).join("; ")}`);
  const mapping = plan.files.find(
    (file) => file.path === "components/Card.module.css",
  );
  if (
    mapping?.kind !== "import" ||
    JSON.stringify(mapping.routes) !== JSON.stringify(["/orders"])
  )
    fail(`unexpected mapping: ${JSON.stringify(mapping)}`);
  const tuples = plan.tuples.map(
    (tuple) => `${tuple.flow}/${tuple.state}@${tuple.viewport}/${tuple.scheme}`,
  );
  if (JSON.stringify(tuples) !== JSON.stringify(["app/orders@desktop/light"]))
    fail(`unexpected tuples: ${tuples.join(", ")}`);
  if (output.gate.skippedWork.length)
    fail(`unexpected trims: ${JSON.stringify(output.gate.skippedWork)}`);
  if (gate.ms >= budgetMs) fail(`gate took ${seconds(gate.ms)}`);

  const results = (summary) => {
    const coverage = summary.coverage?.probeCoverage?.states ?? [];
    return coverage;
  };
  const gated = output.checks[0]?.summary;
  const observations = JSON.parse(
    await readFile(
      join(gated.runDirectory, "orders", "desktop", "observations.json"),
      "utf8",
    ).catch(() =>
      readFile(
        join(
          gated.runDirectory,
          "orders",
          "desktop",
          "light",
          "observations.json",
        ),
        "utf8",
      ),
    ),
  );
  const probeResults = observations.probe?.results ?? [];
  const regionSkipped = probeResults.filter((result) =>
    String(result.skipped ?? "").includes("gate: unchanged since"),
  ).length;
  const clicked = probeResults.filter(
    (result) => result.elapsedMs !== undefined,
  ).length;
  const planLine = gate.stderr
    .split("\n")
    .find((line) => line.startsWith("idiom check --gate:"));
  console.log("measure-gate: PASS");
  console.log("");
  console.log("Full run (idiom check app):");
  console.log(
    `  ${fullSummary.coverage.states.length} states × ${fullSummary.coverage.viewports.length} viewports × ${fullSummary.coverage.colorSchemes.length} schemes = ${fullSummary.coverage.selectedTuples} tuples; wall clock ${seconds(full.ms)}`,
  );
  console.log(`  ${lastTiming(full.stderr)}`);
  console.log("");
  console.log("Gate run (idiom check --gate, one colour in Card.module.css):");
  console.log(`  ${planLine}`);
  console.log(`  tuples: ${tuples.join(", ")}`);
  console.log(
    `  probe: ${clicked} control(s) clicked, ${regionSkipped} left out as unchanged`,
  );
  console.log(`  skippedWork: ${JSON.stringify(output.gate.skippedWork)}`);
  console.log(`  wall clock ${seconds(gate.ms)} (budget ${seconds(budgetMs)})`);
  console.log(`  ${lastTiming(gate.stderr)}`);
  void results;
} finally {
  await rm(directory, { recursive: true, force: true });
}
