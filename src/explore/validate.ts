import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CheckTuple } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import type {
  ExplorationCandidate,
  ExplorationEdit,
} from "../schemas/exploration.js";
import {
  assertCandidateCopy,
  assertSafeGeneratedContent,
  copyCorpus,
  normalizeCopy,
} from "./content.js";

export class CandidateDistinctnessError extends IdiomError {
  readonly candidateIndex: number;

  constructor(message: string, candidateIndex: number) {
    super(message);
    this.name = "CandidateDistinctnessError";
    this.candidateIndex = candidateIndex;
  }
}

function key(tuple: CheckTuple): string {
  return `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? "light"}`;
}

function requireV2(tuple: CheckTuple) {
  if (tuple.observations?.version !== 2)
    throw new IdiomError(
      `exploration requires version-2 observations for ${tuple.state}/${tuple.viewport}`,
    );
  return tuple.observations;
}

async function dom(runDirectory: string, tuple: CheckTuple): Promise<string> {
  const path = tuple.artifactPaths.find((item) => item.endsWith("/dom.html"));
  if (path === undefined)
    throw new IdiomError(
      `capture tuple ${tuple.state}/${tuple.viewport} has no DOM artifact`,
    );
  return readFile(resolve(runDirectory, path), "utf8");
}

async function screenshot(
  runDirectory: string,
  tuple: CheckTuple,
): Promise<PNG> {
  if (tuple.screenshotPath === undefined)
    throw new IdiomError(
      `capture tuple ${tuple.state}/${tuple.viewport} has no screenshot`,
    );
  try {
    return PNG.sync.read(
      await readFile(resolve(runDirectory, tuple.screenshotPath)),
    );
  } catch (error) {
    throw new IdiomError(
      `cannot decode candidate screenshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function different(
  leftRun: string,
  left: CheckTuple,
  rightRun: string,
  right: CheckTuple,
): Promise<boolean> {
  const [a, b] = await Promise.all([
    screenshot(leftRun, left),
    screenshot(rightRun, right),
  ]);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pad = (image: PNG) => {
    const output = new PNG({ width, height });
    output.data.fill(255);
    PNG.bitblt(image, output, 0, 0, image.width, image.height, 0, 0);
    return output;
  };
  const aa = pad(a);
  const bb = pad(b);
  return (
    pixelmatch(aa.data, bb.data, undefined, width, height, { threshold: 0.1 }) >
    0
  );
}

export async function validateRenderedCandidate(options: {
  candidate: ExplorationCandidate;
  edits?: ExplorationEdit[] | undefined;
  baselineRun: string;
  baseline: CheckTuple[];
  candidateRun: string;
  candidateTuples: CheckTuple[];
  generatedContentSources?:
    | Array<{ path: string; before: string; after: string }>
    | undefined;
}): Promise<void> {
  const baselineByKey = new Map(
    options.baseline.map((tuple) => [key(tuple), tuple]),
  );
  if (options.candidateTuples.length !== options.baseline.length)
    throw new IdiomError(
      "candidate capture does not contain the complete declared tuple grid",
    );
  let visualChange = false;
  const corpora: string[] = [];
  for (const candidateTuple of options.candidateTuples) {
    const baselineTuple = baselineByKey.get(key(candidateTuple));
    if (baselineTuple === undefined)
      throw new IdiomError("candidate capture contains an unknown tuple");
    if (
      candidateTuple.failure !== undefined ||
      candidateTuple.mismatches.length > 0
    )
      throw new IdiomError(
        `candidate failed declared expectations at ${candidateTuple.state}/${candidateTuple.viewport}`,
      );
    const baselineDom = await dom(options.baselineRun, baselineTuple);
    const corpus = copyCorpus(requireV2(baselineTuple), baselineDom);
    corpora.push(corpus);
    assertCandidateCopy({
      baselineCorpus: corpus,
      observations: requireV2(candidateTuple),
      dom: await dom(options.candidateRun, candidateTuple),
      coordinate: `${candidateTuple.state}/${candidateTuple.viewport}/${candidateTuple.colorScheme ?? "light"}`,
    });
    if (
      await different(
        options.baselineRun,
        baselineTuple,
        options.candidateRun,
        candidateTuple,
      )
    )
      visualChange = true;
  }
  if (!visualChange)
    throw new IdiomError("candidate screenshots are identical to the baseline");
  assertSafeGeneratedContent(
    options.edits ?? options.candidate.edits,
    normalizeCopy(corpora.join(" ")),
    options.generatedContentSources,
  );
}

export async function validateDistinctCandidates(
  candidates: Array<{
    candidate: ExplorationCandidate;
    runDirectory: string;
    tuples: CheckTuple[];
  }>,
): Promise<void> {
  const editPayloads = new Set<string>();
  for (const [index, item] of candidates.entries()) {
    const payload = JSON.stringify(item.candidate.edits);
    if (editPayloads.has(payload))
      throw new CandidateDistinctnessError(
        "candidate edit payloads must be distinct",
        index,
      );
    editPayloads.add(payload);
  }
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const a = candidates[left];
      const b = candidates[right];
      if (a === undefined || b === undefined) continue;
      const bByKey = new Map(b.tuples.map((tuple) => [key(tuple), tuple]));
      let differs = false;
      for (const tuple of a.tuples) {
        const other = bByKey.get(key(tuple));
        if (
          other !== undefined &&
          (await different(a.runDirectory, tuple, b.runDirectory, other))
        ) {
          differs = true;
          break;
        }
      }
      if (!differs)
        throw new CandidateDistinctnessError(
          `candidates ${a.candidate.label} and ${b.candidate.label} render identically`,
          right,
        );
    }
  }
}
