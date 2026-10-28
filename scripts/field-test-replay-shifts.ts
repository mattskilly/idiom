// Replay the interaction-shift judge on the exact captures in results.json.
// bun scripts/field-test-replay-shifts.ts <scratch> <out.json>
// Read-only: historical rankings and ratings are preserved. Missing captures
// fail the audit; new groups are listed as unrated rather than silently dropped.
import { createHash } from "node:crypto";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { interactionShiftCheck } from "../src/checks/interaction-shift.ts";
import { checksConfigFrom } from "../src/checks/registry.ts";
import type { CheckTuple } from "../src/checks/types.ts";
import { findingGroupKey } from "../src/review/fingerprint.ts";
import { checksConfigSchema } from "../src/schemas/project.ts";
import {
  effectiveRating,
  feelPrecision,
  uniqueFeelKeys,
} from "./field-test-lib.mjs";

const [scratch, output] = process.argv.slice(2);
if (!scratch || !output) throw new Error("Expected <scratch> <out.json>");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const results = read("docs/field-test/results.json");
const labels = read("docs/field-test/labels.json");
const config = checksConfigFrom(checksConfigSchema.parse({}));
const rule = "idiom:interaction-shift";
const targets = results.targets.map(
  (target: {
    id: string;
    kind: string;
    runs?: { runDirectory: string }[];
    perState?: { runDirectory: string }[];
    runDirectory?: string;
  }) => {
    const runs = target.runs ??
      target.perState ?? [{ runDirectory: target.runDirectory }];
    const issues = [];
    let tuples = 0;
    const coverage = [];
    for (const run of runs) {
      if (!run.runDirectory) throw new Error(`No capture for ${target.id}`);
      const directory = run.runDirectory.replace("$SCRATCH", resolve(scratch));
      const paths = [
        ...globSync("**/timelines.json", { cwd: directory }),
      ].sort();
      if (paths.length === 0) throw new Error(`No timelines in ${directory}`);
      const groups = new Map();
      for (const path of paths) {
        const timelinePath = join(directory, path);
        const tupleDirectory = resolve(timelinePath, "..");
        const metadata = read(join(tupleDirectory, "metadata.json"));
        const tuple: CheckTuple = {
          flow: metadata.flow.id,
          state: metadata.state.id,
          viewport: metadata.viewport.name,
          colorScheme: metadata.colorScheme,
          width: metadata.viewport.width,
          height: metadata.viewport.height,
          commit: metadata.source.commit,
          createdAt: metadata.timestamps.startedAt,
          metadataPath: join(tupleDirectory, "metadata.json"),
          artifactPaths: [],
          console: [],
          mismatches: [],
          observations: read(join(tupleDirectory, "observations.json")),
          timelines: read(timelinePath),
        };
        tuples++;
        const result = interactionShiftCheck.run({
          tuple,
          config,
          narrowViewport: false,
        });
        coverage.push({
          path: `$SCRATCH/${relative(resolve(scratch), timelinePath)}`,
          ...result.coverage,
        });
        for (const candidate of result.candidates) {
          const group = findingGroupKey({
            category: candidate.category,
            flow: tuple.flow,
            rule,
            selectorHint: candidate.fingerprintHint ?? candidate.selectorHint,
          });
          const key = `${target.id}:group-${group.slice(0, 12)}`;
          const issue = groups.get(key) ?? {
            key,
            rules: [rule],
            state: tuple.state,
            title: candidate.explanation,
            evidence: [],
          };
          issue.evidence.push({
            path: `$SCRATCH/${relative(resolve(scratch), timelinePath)}`,
            timeline: candidate.timeline,
            selector: candidate.selectorHint,
            explanation: candidate.explanation,
          });
          groups.set(key, issue);
        }
      }
      issues.push(...groups.values());
    }
    const feelIssues = uniqueFeelKeys(issues).map((issue: { key: string }) => ({
      ...issue,
      rating: effectiveRating(labels.labels[issue.key]) ?? null,
    }));
    return { id: target.id, kind: target.kind, tuples, coverage, feelIssues };
  },
);
const precision = feelPrecision({ targets }, labels).find(
  (row: { rule: string }) => row.rule === rule,
);
writeFileSync(
  output,
  `${JSON.stringify(
    {
      method:
        "Same-capture deterministic judge replay; groups counted once per run, matching the field harness. No new live capture or ranking claim.",
      inputs: Object.fromEntries(
        [
          "src/checks/interaction-shift.ts",
          "docs/field-test/results.json",
          "docs/field-test/labels.json",
        ].map((path) => [
          path,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
      ),
      targets,
      precision,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify(
    {
      tuples: targets.reduce(
        (sum: number, target: { tuples: number }) => sum + target.tuples,
        0,
      ),
      precision,
      targets: targets.map(
        (target: {
          id: string;
          feelIssues: { key: string; rating: unknown }[];
        }) => ({
          id: target.id,
          groups: target.feelIssues.length,
          unrated: target.feelIssues
            .filter((issue) => !issue.rating)
            .map((issue) => issue.key),
        }),
      ),
    },
    null,
    2,
  ),
);
