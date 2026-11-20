// Secret-scan cost on a large-DOM capture, before and after the run's
// content memo. Runs on Node through vite-node:
//
//   bunx vite-node scripts/secret-scan-bench.ts -- [states] [tuplesPerState] [observationMB] [screenshotMB]
//
// A capture writes each tuple at its pre-probe checkpoint, again at its
// post-probe checkpoint (new observations, same screenshot and DOM), then
// the whole run once more before publication. "before" scans every one of
// those writes in full with a fresh scan each time, as captures did; "after"
// runs the same sequence through one shared scanner.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSecretScanner,
  scanForSecrets,
} from "../src/capture/artifacts.js";

const [states = 40, perState = 6, observationMb = 1.5, screenshotMb = 0.6] =
  process.argv
    .slice(2)
    .filter((value) => value !== "--")
    .map(Number);
const environment = Object.fromEntries(
  Array.from({ length: 15 }, (_, index) => [
    `SERVICE_${index}_${["TOKEN", "KEY", "SECRET"][index % 3]}`,
    `secret-value-${index}-${"x".repeat(24)}`,
  ]),
);
const filler = (megabytes: number, seed: number) => {
  const unit = `{"selector":"main > div:nth-child(${seed}) > button.action","text":"Row ${seed} label","rect":[12,34,56,78]},`;
  return Buffer.from(
    unit.repeat(Math.ceil((megabytes * 1024 * 1024) / unit.length)),
  );
};
const domBytes = filler(observationMb / 2, 1);
const pngBytes = Buffer.alloc(Math.round(screenshotMb * 1024 * 1024), 7);
const before = filler(observationMb, 2);
const after = filler(observationMb, 3);
const tuples = Array.from({ length: states * perState }, (_, index) =>
  join(`state-${Math.floor(index / perState)}`, `viewport-${index % perState}`),
);

// Every tuple's bytes are its own (as in a real capture): a unique header
// on shared filler, so the memo can only skip a tuple's own rewrites.
async function writeTuple(root: string, tuple: string, observations: Buffer) {
  const directory = join(root, tuple);
  const own = (bytes: Buffer) => Buffer.concat([Buffer.from(tuple), bytes]);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "observations.json"), own(observations));
  await writeFile(join(directory, "dom.html"), own(domBytes));
  await writeFile(join(directory, "screenshot.png"), own(pngBytes));
}

async function sequence(scan: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "idiom-scan-bench-"));
  let ms = 0;
  const timed = async (directory: string) => {
    const started = performance.now();
    await scan(directory);
    ms += performance.now() - started;
  };
  try {
    for (const observations of [before, after])
      for (const tuple of tuples) {
        const checkpoint = await mkdtemp(join(root, ".checkpoint-"));
        await writeTuple(checkpoint, tuple, observations);
        await timed(checkpoint);
        await rm(checkpoint, { recursive: true, force: true });
      }
    const staging = join(root, "staging");
    for (const tuple of tuples) await writeTuple(staging, tuple, after);
    await timed(staging);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return ms;
}

const bytesPerTuple = before.length + domBytes.length + pngBytes.length;
const scanned = (tuples.length * bytesPerTuple * 3) / 1024 / 1024;
const fresh = await sequence((directory) =>
  scanForSecrets(directory, [environment]),
);
const scanner = createSecretScanner();
const memo = await sequence((directory) =>
  scanner.scan(directory, [environment]),
);
console.log(
  `${tuples.length} tuples (${states} states × ${perState}), ${(bytesPerTuple / 1024 / 1024).toFixed(1)} MB each, 15 secrets, ${scanned.toFixed(0)} MB written across the checkpoints and the final pass`,
);
console.log(`before (full scan of every write): ${(fresh / 1000).toFixed(2)}s`);
console.log(
  `after (one scanner, content memo):  ${(memo / 1000).toFixed(2)}s; ${scanner.stats.files} files read, ${scanner.stats.skipped} skipped as already clean`,
);
