import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckTuple } from "../checks/types.js";
import type { DecideDependencies } from "../commands/decide.js";
import { decideCommand } from "../commands/decide.js";
import { ticketsCommand } from "../commands/tickets.js";
import { IdiomError } from "../errors.js";
import { parseRulingBlocks } from "../rulings/law.js";
import {
  loadRulingNames,
  persistRulingNames,
  reserveRulingFingerprint,
} from "../rulings/names.js";
import { type RulingConfirmation, recordRuling } from "../rulings/record.js";
import {
  normalizeExplorationKey,
  type PersistedExplorationCandidate,
} from "../schemas/exploration.js";
import type { Project } from "../schemas/project.js";
import type { RulingResolution } from "../schemas/ruling.js";
import type { GitTopology } from "../verify/baseline.js";
import {
  type LoadedExplorationRun,
  recordExplorationResolution,
} from "./artifacts.js";
import { explorationQuestionFingerprint } from "./context.js";
import { publishExplorationRepairs } from "./repair.js";

type SteeringIdentity = {
  decision: string;
  fingerprint: string;
  choiceKey: string;
};

export type ExplorationResolutionResult = {
  outcome: "cancelled" | "rule-only" | "rule-plus-tickets";
  runDirectory: string;
  reportPath: string;
  ruling?: RulingResolution;
  ticketCount?: number;
};

function outcomeFingerprints(
  candidate: PersistedExplorationCandidate | undefined,
  steering: SteeringIdentity | undefined,
): Set<string> {
  return new Set([
    ...(candidate === undefined
      ? []
      : [explorationQuestionFingerprint(candidate.choiceKey)]),
    ...(steering === undefined ? [] : [steering.fingerprint]),
  ]);
}

async function assertNotRecorded(options: {
  designPath: string;
  candidate?: PersistedExplorationCandidate | undefined;
  steering?: SteeringIdentity | undefined;
}): Promise<string> {
  let source: string;
  try {
    source = await readFile(options.designPath, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot load design guidance from ${options.designPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fingerprints = outcomeFingerprints(options.candidate, options.steering);
  if (
    parseRulingBlocks(source).resolutions.some((resolution) =>
      fingerprints.has(resolution.fingerprint),
    )
  )
    throw new IdiomError(
      "this exploration run has already been resolved in the design law",
    );
  return source;
}

export async function resolveExplorationNone(options: {
  projectDirectory: string;
  project: Project;
  stored: LoadedExplorationRun;
  reason: string;
  clock?: (() => Date) | undefined;
}): Promise<{ outcome: "none"; runDirectory: string; reportPath: string }> {
  const reason = options.reason.trim();
  if (reason === "")
    throw new IdiomError("exploration reason must not be blank");
  await assertNotRecorded({
    designPath: join(
      options.projectDirectory,
      options.project.design.designFile,
    ),
    steering: options.stored.manifest.steering,
  });
  await recordExplorationResolution(options.stored.manifestPath, {
    outcome: "none",
    reason,
    recordedAt: (options.clock ?? (() => new Date()))().toISOString(),
  });
  return {
    outcome: "none",
    runDirectory: options.stored.runDirectory,
    reportPath: options.stored.reportPath,
  };
}

export async function resolveExplorationChoice(options: {
  projectDirectory: string;
  project: Project;
  stored: LoadedExplorationRun;
  baseline: CheckTuple[];
  candidate: PersistedExplorationCandidate;
  winnerRun: string;
  winner: CheckTuple[];
  reason: string;
  repairs: boolean | (() => Promise<boolean>);
  confirm: RulingConfirmation;
  write?: ((message: string) => void) | undefined;
  clock?: (() => Date) | undefined;
  gitTopology?: GitTopology | undefined;
  decide?: DecideDependencies | undefined;
}): Promise<ExplorationResolutionResult> {
  const reason = options.reason.trim();
  if (reason === "") throw new IdiomError("ruling reason must not be blank");
  const designPath = join(
    options.projectDirectory,
    options.project.design.designFile,
  );
  await assertNotRecorded({
    designPath,
    candidate: options.candidate,
    steering: options.stored.manifest.steering,
  });

  const steering = options.stored.manifest.steering;
  const fingerprint =
    steering?.fingerprint ??
    explorationQuestionFingerprint(options.candidate.choiceKey);
  let names: Awaited<ReturnType<typeof loadRulingNames>> | undefined;
  let id = steering?.decision;
  if (id === undefined) {
    names = await loadRulingNames({
      projectDirectory: options.projectDirectory,
      gitTopology: options.gitTopology,
    });
    id = reserveRulingFingerprint(names, fingerprint);
  }
  const recordedAt = (options.clock ?? (() => new Date()))().toISOString();
  const resolution: RulingResolution = {
    id,
    fingerprint,
    choiceKey:
      steering?.choiceKey ??
      normalizeExplorationKey(options.candidate.choiceKey),
    outcome: "rule",
    wording: options.candidate.rule,
    reason,
    recordedAt,
  };
  const recorded = await recordRuling({
    designPath,
    displayPath: options.project.design.designFile,
    resolution,
    confirm: options.confirm,
    write: options.write,
  });
  if (!recorded.recorded)
    return {
      outcome: "cancelled",
      runDirectory: options.stored.runDirectory,
      reportPath: options.stored.reportPath,
    };
  if (names !== undefined) await persistRulingNames(names);

  const repairs =
    typeof options.repairs === "function"
      ? await options.repairs()
      : options.repairs;
  let ticketCount: number | undefined;
  if (repairs) {
    const findings = await publishExplorationRepairs({
      projectDirectory: options.projectDirectory,
      runDirectory: options.stored.runDirectory,
      baseline: options.baseline,
      winnerRun: options.winnerRun,
      winner: options.winner,
      candidate: options.candidate,
    });
    for (const finding of findings)
      await decideCommand({
        project: options.projectDirectory,
        finding: finding.id,
        accept: true,
        dependencies: options.decide,
      });
    const tickets = await ticketsCommand({
      project: options.projectDirectory,
      findingIds: findings.map((finding) => finding.id),
    });
    ticketCount = tickets.outcomes.filter(
      (outcome) => outcome.kind === "created",
    ).length;
  }

  await recordExplorationResolution(options.stored.manifestPath, {
    outcome: "rule",
    reason,
    recordedAt,
    selected: options.candidate.label,
    ruling: {
      id: resolution.id,
      fingerprint: resolution.fingerprint,
      choiceKey: resolution.choiceKey,
    },
    repairs,
  });
  return {
    outcome: repairs ? "rule-plus-tickets" : "rule-only",
    runDirectory: options.stored.runDirectory,
    reportPath: options.stored.reportPath,
    ruling: resolution,
    ...(ticketCount === undefined ? {} : { ticketCount }),
  };
}
