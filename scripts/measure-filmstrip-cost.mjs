#!/usr/bin/env node
// Read paired unchanged field-harness outputs; never edits shared results/labels.
// node scripts/measure-filmstrip-cost.mjs <off-results> <off-scratch> <on-results> <on-scratch> <output.json>
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

const [offFile, offRoot, onFile, onRoot, output] = process.argv.slice(2);
if (!output)
  throw Error(
    "expected off-results off-scratch on-results on-scratch output.json",
  );
const read = async (p) => JSON.parse(await readFile(p, "utf8"));
async function files(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found;
}
async function runStats(target, scratch) {
  const run = target.runs?.[0];
  const stored = run?.runDirectory ?? target.runDirectory;
  if (!stored)
    return {
      unavailable: "harness did not produce a capture",
      failures: target.failures,
    };
  const directory = stored
    .replaceAll("$SCRATCH", scratch)
    .replaceAll("$TMPDIR", process.env.TMPDIR ?? "/tmp/");
  const all = await files(directory);
  const metadata = await Promise.all(
    all
      .filter((p) => p.endsWith("/metadata.json"))
      .map(async (path) => ({
        path,
        data: await read(path),
        file: await stat(path),
      })),
  );
  if (!metadata.length)
    return { unavailable: "capture has no tuple metadata", directory };
  // Quick capture is sequential; configured lanes overlap. These are absolute
  // first-input / last-artifact boundaries, never a sum of lane durations.
  const begin = Math.min(
    ...metadata.map((m) => Date.parse(m.data.timestamps.startedAt)),
  );
  const interactionEnd = Math.max(
    ...metadata.map((m) => Date.parse(m.data.timestamps.endedAt)),
  );
  const end = Math.max(...metadata.map((m) => m.file.mtimeMs));
  const manifests = await Promise.all(
    all.filter((p) => p.endsWith("/filmstrips.json")).map(read),
  );
  const actions = manifests.flatMap((m) => m.actions);
  const frames = actions.flatMap((a) => a.frames);
  const pngs = all.filter(
    (p) => p.includes("/filmstrips/") && p.endsWith(".png"),
  );
  const retainedBytes = (await Promise.all(pngs.map(stat))).reduce(
    (s, f) => s + f.size,
    0,
  );
  const findings = await read(join(directory, "findings.json")).catch(() => []);
  const sheets = findings.flatMap((f) =>
    f.evidence.filmstrip?.sheet ? [f.evidence.filmstrip] : [],
  );
  return {
    directory,
    captureWallMs: Math.round(end - begin),
    interactionWallMs: interactionEnd - begin,
    elapsedMs: run?.elapsedMs ?? target.elapsedMs,
    harnessWallMs: target.wallMs,
    browser: metadata[0].data.browserVersion,
    tuples: metadata.length,
    failures: target.failures,
    captureFailures: metadata.filter((m) => m.data.failure).length,
    probeSafety: run?.probeSafety ?? target.probeSafety,
    probe: run?.probe ?? target.probe,
    selectedActions: actions.length,
    retainedFrames: frames.filter((f) => f.path).length,
    unavailableSlots: frames.filter((f) => !f.path).length,
    retainedBytes,
    sheets: sheets.length,
    sheetBytes: sheets.reduce((s, f) => s + (f.bytes ?? 0), 0),
    sheetGenerationMs: sheets.every((f) => f.generationMs !== undefined)
      ? Math.round(sheets.reduce((s, f) => s + f.generationMs, 0))
      : null,
  };
}
const off = await read(offFile);
const on = await read(onFile);
const targets = [];
for (const target of off.targets) {
  const current = on.targets.find((t) => t.id === target.id);
  if (!current) throw Error(`missing on target ${target.id}`);
  const baseline = await runStats(target, offRoot);
  const changed = await runStats(current, onRoot);
  targets.push({
    target: target.id,
    baseline,
    changed,
    ratio:
      baseline.captureWallMs && changed.captureWallMs
        ? changed.captureWallMs / baseline.captureWallMs
        : null,
  });
}
const total = (side) =>
  targets.reduce((s, t) => s + (t[side].captureWallMs ?? 0), 0);
async function sourceIdentity(resultFile) {
  const root = resolve(dirname(resultFile), "../..");
  const bundle = await readFile(join(root, "dist/cli.js"));
  return {
    bundleSha256: createHash("sha256").update(bundle).digest("hex"),
    compiledCommit: /IDIOM_BUILD_COMMIT = true \? "([^"]+)"/.exec(
      bundle.toString(),
    )?.[1],
    snapshot: await read(join(root, "source.json")).catch(() => undefined),
  };
}
const complete =
  targets.length === 10 &&
  targets.every(
    (t) =>
      t.baseline.captureWallMs > 0 &&
      t.changed.captureWallMs > 0 &&
      t.baseline.tuples === t.changed.tuples,
  );
const audit = {
  version: 1,
  source: {
    baseline: await sourceIdentity(offFile),
    changed: await sourceIdentity(onFile),
  },
  completeTenTargetComparison: complete,
  configuration: {
    baseline: { filmstrips: { enabled: false } },
    changed: {
      filmstrips: {
        enabled: true,
        offsetsMs: [0, 50, 100, 200, 400, 800],
        actions: [],
      },
    },
  },
  startedAt: { baseline: off.startedAt, changed: on.startedAt },
  node: process.version,
  machine: {
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
  },
  method:
    "Unchanged ten-target field harness, controlled enabled:false/default-true bundles. Capture wall is first tuple's startedAt through the last tuple metadata file write, including concurrent lanes, probe tails, runtime teardown and retained PNG publication. Interaction wall ends at the last tuple's endedAt. Quick/check elapsed is independently recorded by the harness. No sum of overlapping tuple durations. Raw scratch evidence is required: copied metadata mtimes cannot be used.",
  targets,
  aggregate: {
    baselineCaptureWallMs: total("baseline"),
    changedCaptureWallMs: total("changed"),
    ratio: total("changed") / total("baseline"),
    budgetRatio: 1.1,
    withinBudget: complete && total("changed") / total("baseline") <= 1.1,
  },
};
await writeFile(output, `${JSON.stringify(audit, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(audit.aggregate)}\n`);
