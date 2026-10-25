import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import type { CheckTuple } from "../src/checks/types.js";
import {
  validateDistinctCandidates,
  validateRenderedCandidate,
} from "../src/explore/validate.js";
import type { ExplorationCandidate } from "../src/schemas/exploration.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function png(red: number, green: number, blue: number): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = red;
    image.data[offset + 1] = green;
    image.data[offset + 2] = blue;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

function candidate(
  label: string,
  references: string[] = [],
): ExplorationCandidate {
  return {
    label,
    direction: `Direction ${label}`,
    choiceKey: `choice-${label}`,
    rule: `Use direction ${label}.`,
    reason: `Direction ${label} is clearer.`,
    category: "hierarchy",
    repair: `Apply direction ${label}.`,
    references,
    edits: [{ path: "src/app.tsx", oldText: "old", newText: label }],
  };
}

async function tuple(options: {
  root: string;
  name: string;
  color: [number, number, number];
  mismatches?: CheckTuple["mismatches"];
  failure?: CheckTuple["failure"];
}): Promise<CheckTuple> {
  const directory = join(options.root, options.name, "ready", "desktop");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "dom.html"), "<main>old</main>");
  await writeFile(join(directory, "screenshot.png"), png(...options.color));
  return {
    flow: "fixture",
    state: "ready",
    viewport: "desktop",
    width: 800,
    height: 600,
    metadataPath: `${options.name}/ready/desktop/metadata.json`,
    screenshotPath: `${options.name}/ready/desktop/screenshot.png`,
    artifactPaths: [`${options.name}/ready/desktop/dom.html`],
    commit: "abc",
    createdAt: "2026-08-27T12:00:00.000Z",
    observations: {
      version: 2,
      viewport: { width: 800, height: 600 },
      document: {
        scrollWidth: 800,
        scrollHeight: 600,
        clientWidth: 800,
        clientHeight: 600,
      },
      elements: [],
      headings: [],
      tokens: { status: "not-configured" },
      maskMembership: [],
    },
    console: [],
    mismatches: options.mismatches ?? [],
    ...(options.failure === undefined ? {} : { failure: options.failure }),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "idiom-explore-validation-"));
  directories.push(root);
  const baseline = await tuple({
    root,
    name: "baseline",
    color: [255, 255, 255],
  });
  return { root, baseline };
}

test("render validation rejects failed expectations", async () => {
  const { root, baseline } = await fixture();
  const failed = await tuple({
    root,
    name: "failed",
    color: [255, 0, 0],
    mismatches: [
      {
        kind: "text-present",
        expected: "ready",
        actual: "missing",
      },
    ],
  });
  await expect(
    validateRenderedCandidate({
      candidate: candidate("A"),
      baselineRun: root,
      baseline: [baseline],
      candidateRun: root,
      candidateTuples: [failed],
    }),
  ).rejects.toThrow("failed declared expectations");
});

test("pairwise validation rejects visually identical candidates and accepts distinct ones", async () => {
  const { root } = await fixture();
  const redA = await tuple({ root, name: "red-a", color: [255, 0, 0] });
  const redB = await tuple({ root, name: "red-b", color: [255, 0, 0] });
  const blue = await tuple({ root, name: "blue", color: [0, 0, 255] });
  const a = { candidate: candidate("A"), runDirectory: root, tuples: [redA] };
  const b = { candidate: candidate("B"), runDirectory: root, tuples: [redB] };
  const c = { candidate: candidate("C"), runDirectory: root, tuples: [blue] };
  await expect(validateDistinctCandidates([a, b])).rejects.toThrow(
    "render identically",
  );
  await expect(validateDistinctCandidates([a, c])).resolves.toBeUndefined();
});
