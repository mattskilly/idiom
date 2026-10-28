import { relative, resolve, sep } from "node:path";
import type { CheckTuple } from "../checks/types.js";
import {
  loadReviewCatalog,
  persistCatalogFindingNames,
} from "../review/catalog.js";
import { writeFindings } from "../review/findings.js";
import { findingFingerprint } from "../review/fingerprint.js";
import { FindingNamingSession } from "../review/names.js";
import type { ExplorationCandidate } from "../schemas/exploration.js";
import { type Finding, findingSchema } from "../schemas/finding.js";

function key(tuple: CheckTuple): string {
  return `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? "light"}`;
}

function reportPath(root: string, directory: string, path: string): string {
  return relative(resolve(root), resolve(directory, path)).split(sep).join("/");
}

export async function publishExplorationRepairs(options: {
  projectDirectory: string;
  runDirectory: string;
  baseline: CheckTuple[];
  winnerRun: string;
  winner: CheckTuple[];
  candidate: Pick<
    ExplorationCandidate,
    "category" | "rule" | "repair" | "references"
  >;
}): Promise<Finding[]> {
  const catalog = await loadReviewCatalog({
    project: options.projectDirectory,
  });
  const naming = new FindingNamingSession(catalog.names);
  const winnerByKey = new Map(
    options.winner.map((tuple) => [key(tuple), tuple]),
  );
  const findings = options.baseline.map((baseline, index) => {
    const chosen = winnerByKey.get(key(baseline));
    if (chosen === undefined)
      throw new Error("winner capture is missing a baseline coordinate");
    const selectorHint = `exploration:${baseline.state}/${baseline.viewport}/${baseline.colorScheme ?? "light"}`;
    const fingerprint = findingFingerprint({
      category: options.candidate.category,
      flow: baseline.flow,
      state: baseline.state,
      rule: options.candidate.rule,
      selectorHint,
      ...(baseline.colorSchemeAxis
        ? { colorScheme: baseline.colorScheme }
        : {}),
    });
    const screenshots = [
      ...(baseline.screenshotPath === undefined
        ? []
        : [baseline.screenshotPath]),
      ...(chosen.screenshotPath === undefined
        ? []
        : [
            reportPath(
              options.runDirectory,
              options.winnerRun,
              chosen.screenshotPath,
            ),
          ]),
    ];
    const draft = findingSchema.parse({
      id: `draft-exploration-${index + 1}`,
      fingerprint,
      createdAt: baseline.createdAt,
      commit: baseline.commit,
      flow: baseline.flow,
      state: baseline.state,
      viewport: baseline.viewport,
      ...(baseline.colorSchemeAxis
        ? { colorScheme: baseline.colorScheme }
        : {}),
      layer: "model",
      category: options.candidate.category,
      severity: "major",
      confidence: 1,
      rule: options.candidate.rule,
      evidence: {
        screenshots,
        ...(options.candidate.references.length === 0
          ? {}
          : { references: options.candidate.references }),
      },
      explanation: `The current ${baseline.state}/${baseline.viewport}${baseline.colorSchemeAxis ? `/${baseline.colorScheme}` : ""} rendering does not yet embody the newly recorded rule. ${options.candidate.repair}`,
      suggestedArea: `${baseline.flow}/${baseline.state}`,
      basis: "judged",
      basisDetails: {
        kind: "judged",
        summary: "Exploration critique; no model-stated confidence recorded.",
      },
      acceptance: {
        version: 1,
        kind: "manual",
        doneWhen: [
          options.candidate.repair,
          `Recapture only ${baseline.state} at ${baseline.viewport}${baseline.colorSchemeAxis ? ` in ${baseline.colorScheme}` : ""} and match the chosen exploration direction without applying its temporary code verbatim.`,
        ],
      },
      verification: { kind: "recapture-visual" },
      status: "open",
    });
    return naming.name(draft);
  });
  await persistCatalogFindingNames(catalog);
  await writeFindings(options.runDirectory, findings);
  return findings;
}
