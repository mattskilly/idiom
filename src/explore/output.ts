import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sanitizeCritiqueDiagnostic } from "../critique/claude-code.js";
import { IdiomError } from "../errors.js";
import type {
  ExplorationCandidate,
  ExplorationRefinement,
} from "../schemas/exploration.js";
import {
  MalformedExplorationError,
  parseCandidateOutput,
  parseRefinementOutput,
} from "./schema.js";
import type { ExplorationEvidence } from "./types.js";

type OutputKind = "candidates" | "refinement";

type RepairOptions<T> = {
  evidence: ExplorationEvidence;
  initial: unknown;
  parse(value: unknown): T;
  repair(issues: string[]): Promise<unknown>;
  kind: OutputKind;
};

function shape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length ${value.length})`;
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value).sort();
  return `object(keys ${keys.length === 0 ? "none" : keys.join(", ")})`;
}

function repairedDiagnostic(kind: OutputKind, value: unknown): string {
  if (kind === "candidates" && value !== null && typeof value === "object") {
    const candidates = (value as Record<string, unknown>).candidates;
    if (Array.isArray(candidates)) {
      const labels = candidates.map((candidate) =>
        candidate !== null && typeof candidate === "object"
          ? (candidate as Record<string, unknown>).label
          : undefined,
      );
      if (labels.every((label) => typeof label === "string"))
        return `repaired output returned labels ${JSON.stringify(labels)}`;
      return `repaired output returned candidates ${shape(candidates)}`;
    }
  }
  if (kind === "refinement" && value !== null && typeof value === "object") {
    const refinement = (value as Record<string, unknown>).refinement;
    if (refinement !== undefined)
      return `repaired output returned refinement ${shape(refinement)}`;
  }
  return `repaired output returned ${shape(value)}`;
}

async function preserveRejectedOutput(options: {
  evidence: ExplorationEvidence;
  kind: OutputKind;
  initial: unknown;
  initialIssues: string[];
  repaired: unknown;
  repairedIssues: string[];
}): Promise<string> {
  const directory = resolve(options.evidence.runDirectory, "provider-output");
  const target = resolve(directory, `${options.kind}-rejected.json`);
  const temporary = resolve(
    directory,
    `.${options.kind}-rejected.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  const record = {
    version: 1,
    kind: options.kind,
    attempts: [
      {
        stage: "initial",
        output: options.initial,
        issues: options.initialIssues,
      },
      {
        stage: "repair",
        output: options.repaired,
        issues: options.repairedIssues,
      },
    ],
  };
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return target;
}

async function parseWithRepair<T>(options: RepairOptions<T>): Promise<T> {
  let initialError: MalformedExplorationError;
  try {
    return options.parse(options.initial);
  } catch (error) {
    if (!(error instanceof MalformedExplorationError)) throw error;
    initialError = error;
  }

  const repaired = await options.repair(initialError.issues);
  try {
    return options.parse(repaired);
  } catch (error) {
    if (!(error instanceof MalformedExplorationError)) throw error;
    const artifactPath = await preserveRejectedOutput({
      evidence: options.evidence,
      kind: options.kind,
      initial: options.initial,
      initialIssues: initialError.issues,
      repaired,
      repairedIssues: error.issues,
    });
    const diagnostic = sanitizeCritiqueDiagnostic(
      repairedDiagnostic(options.kind, repaired),
    );
    throw new IdiomError(
      `exploration provider output remained malformed after one repair: ${diagnostic}; rejected output preserved at ${artifactPath}`,
    );
  }
}

export function parseCandidatesWithRepair(options: {
  evidence: ExplorationEvidence;
  initial: unknown;
  permittedReferenceLabels: readonly string[];
  repair(issues: string[]): Promise<unknown>;
}): Promise<ExplorationCandidate[]> {
  return parseWithRepair({
    ...options,
    kind: "candidates",
    parse: (value) =>
      parseCandidateOutput(value, options.permittedReferenceLabels),
  });
}

export function parseRefinementWithRepair(options: {
  evidence: ExplorationEvidence;
  initial: unknown;
  permittedReferenceLabels: readonly string[];
  repair(issues: string[]): Promise<unknown>;
}): Promise<ExplorationRefinement> {
  return parseWithRepair({
    ...options,
    kind: "refinement",
    parse: (value) =>
      parseRefinementOutput(value, options.permittedReferenceLabels),
  });
}
