import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IdiomError } from "../errors.js";
import { noteUnknownRecord } from "../records/unknown.js";
import {
  type Acknowledgement,
  acknowledgementSchema,
  type Decision,
  type DecisionLogEntry,
  decisionLogEntrySchema,
  decisionSchema,
  isAcknowledgement,
  type RulingDecision,
  rulingDecisionSchema,
} from "../schemas/decision.js";
import type { Finding } from "../schemas/finding.js";

export type DecisionViews = {
  byFindingId: Map<string, Decision>;
  byRuleFingerprint: Map<string, Decision>;
  /** Rule-scope decisions in log order. */
  ruleDecisions: Decision[];
};

export function decisionLogPath(projectDirectory: string): string {
  return join(projectDirectory, ".idiom", "decisions.jsonl");
}

export const knownDecisionTypes: readonly string[] = [
  "ruling",
  ...decisionSchema.shape.decision.options,
  ...acknowledgementSchema.shape.decision.options,
];

/**
 * The type a newer Idiom wrote, when this version doesn't know it and the
 * record still carries its identity; otherwise undefined, so the line is
 * validated (and fails) as before.
 */
export function unknownDecisionType(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.decision !== "string" ||
    knownDecisionTypes.includes(record.decision) ||
    typeof record.at !== "string" ||
    typeof record.findingId !== "string" ||
    typeof record.fingerprint !== "string"
  )
    return undefined;
  return record.decision;
}

function parseJson(source: string, path: string, lineNumber: number): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new IdiomError(
      `invalid decision log ${path} at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateEntry(
  value: unknown,
  path: string,
  lineNumber: number,
): DecisionLogEntry {
  const parsed = decisionLogEntrySchema.safeParse(value);
  if (!parsed.success) {
    const issues = entryIssues(value, parsed.error.issues)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new IdiomError(
      `invalid decision log ${path} at line ${lineNumber}: ${issues}`,
    );
  }
  return parsed.data;
}

/**
 * A union reports every branch's issues; name the branch the line meant, so
 * a malformed acknowledgement reads as one.
 */
export function entryIssues(
  value: unknown,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): ReadonlyArray<{ path: PropertyKey[]; message: string }> {
  const kind =
    typeof value === "object" && value !== null && "decision" in value
      ? (value as { decision: unknown }).decision
      : undefined;
  const schema =
    kind === "acknowledge" || kind === "unacknowledge"
      ? acknowledgementSchema
      : kind === "ruling"
        ? rulingDecisionSchema
        : decisionSchema;
  const branch = schema.safeParse(value);
  return branch.success ? issues : branch.error.issues;
}

/** Every known line: judgments and acknowledgements, in log order. */
export async function readDecisionLogEntries(
  projectDirectory: string,
): Promise<DecisionLogEntry[]> {
  const path = decisionLogPath(projectDirectory);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new IdiomError(
      `cannot read decision log ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const records: DecisionLogEntry[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const value = parseJson(line, path, index + 1);
    const type = unknownDecisionType(value);
    if (type !== undefined) {
      noteUnknownRecord({ family: "decision", path, line: index + 1, type });
      continue;
    }
    records.push(validateEntry(value, path, index + 1));
  }
  return records;
}

/** Judgments only (accept/reject); acknowledgements never read as either. */
export function judgments(entries: readonly DecisionLogEntry[]): Decision[] {
  return entries.filter(
    (entry): entry is Decision =>
      entry.decision === "accept" || entry.decision === "reject",
  );
}

export function acknowledgements(
  entries: readonly DecisionLogEntry[],
): Acknowledgement[] {
  return entries.filter(isAcknowledgement);
}

export async function readDecisionLog(
  projectDirectory: string,
): Promise<Decision[]> {
  return judgments(await readDecisionLogEntries(projectDirectory));
}

export async function readAcknowledgements(
  projectDirectory: string,
): Promise<Acknowledgement[]> {
  return acknowledgements(await readDecisionLogEntries(projectDirectory));
}

export function decisionViews(decisions: readonly Decision[]): DecisionViews {
  const byFindingId = new Map<string, Decision>();
  const byRuleFingerprint = new Map<string, Decision>();
  const ruleDecisions: Decision[] = [];
  for (const decision of decisions) {
    byFindingId.set(decision.findingId, decision);
    if (decision.scope === "rule") {
      byRuleFingerprint.set(decision.fingerprint, decision);
      ruleDecisions.push(decision);
    }
  }
  return { byFindingId, byRuleFingerprint, ruleDecisions };
}

/**
 * The one fingerprint-suppression policy: a finding is suppressed when the
 * latest rule-scope decision across its identities is a rejection. Instance
 * decisions never suppress. Returns that rejecting decision, or undefined.
 */
export function ruleRejection(
  identities: Iterable<string>,
  decisions: readonly Decision[],
): Decision | undefined {
  const fingerprints = new Set(identities);
  const latest = decisions
    .filter(
      (candidate) =>
        candidate.scope === "rule" && fingerprints.has(candidate.fingerprint),
    )
    .at(-1);
  return latest?.decision === "reject" ? latest : undefined;
}

export function isFingerprintSuppressed(
  fingerprint: string,
  views: DecisionViews,
): boolean {
  return ruleRejection([fingerprint], views.ruleDecisions) !== undefined;
}

export async function appendDecision(options: {
  projectDirectory: string;
  finding: Pick<Finding, "id" | "fingerprint" | "commit">;
  decision: "accept" | "reject";
  scope: "instance" | "rule";
  reason?: string | undefined;
  designChoice?: Decision["designChoice"] | undefined;
  provenance?: Decision["provenance"] | undefined;
  now?: (() => Date) | undefined;
}): Promise<{ path: string; record: Decision }> {
  // Validate the complete existing boundary before extending it.
  await readDecisionLogEntries(options.projectDirectory);
  const record = decisionSchema.parse({
    at: (options.now?.() ?? new Date()).toISOString(),
    commit: options.finding.commit,
    findingId: options.finding.id,
    fingerprint: options.finding.fingerprint,
    decision: options.decision,
    scope: options.scope,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    actor: "human",
    ...(options.provenance === undefined
      ? {}
      : { provenance: options.provenance }),
    ...(options.designChoice === undefined
      ? {}
      : { designChoice: options.designChoice }),
  });
  if (await identicalApplication(options.projectDirectory, record))
    return { path: decisionLogPath(options.projectDirectory), record };
  const path = await appendLine(options.projectDirectory, record);
  return { path, record };
}

async function appendLine(
  projectDirectory: string,
  record: DecisionLogEntry,
): Promise<string> {
  const path = decisionLogPath(projectDirectory);
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new IdiomError(
        `cannot read decision log ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const prefix = source.length > 0 && !source.endsWith("\n") ? "\n" : "";
  try {
    await appendFile(path, `${prefix}${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot append decision log ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return path;
}

export async function appendAcknowledgement(options: {
  projectDirectory: string;
  finding: Pick<Finding, "id" | "fingerprint" | "commit">;
  kind: "acknowledge" | "unacknowledge";
  reference: string;
  until?: string | undefined;
  note?: string | undefined;
  evidence?: Acknowledgement["evidence"] | undefined;
  now?: (() => Date) | undefined;
}): Promise<{ path: string; record: Acknowledgement }> {
  await readDecisionLogEntries(options.projectDirectory);
  const record = acknowledgementSchema.parse({
    at: (options.now?.() ?? new Date()).toISOString(),
    commit: options.finding.commit,
    findingId: options.finding.id,
    fingerprint: options.finding.fingerprint,
    decision: options.kind,
    reference: options.reference,
    ...(options.until === undefined ? {} : { until: options.until }),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    actor: "human",
  });
  const path = await appendLine(options.projectDirectory, record);
  return { path, record };
}

/** A replay of one external answer is safe; changing that answer is not. */
async function identicalApplication(
  projectDirectory: string,
  record: Decision | RulingDecision,
): Promise<boolean> {
  if (!record.provenance?.escalation) return false;
  const previous = (await readDecisionLogEntries(projectDirectory)).find(
    (entry) =>
      (entry.decision === "ruling" ||
        entry.decision === "accept" ||
        entry.decision === "reject") &&
      entry.provenance?.build === record.provenance?.build &&
      entry.provenance?.escalation === record.provenance?.escalation &&
      (record.decision === "ruling"
        ? entry.fingerprint === record.fingerprint
        : entry.decision !== "ruling" &&
          JSON.stringify(
            entry.designChoice && {
              ...entry.designChoice,
              reference: undefined,
            },
          ) ===
            JSON.stringify(
              record.designChoice && {
                ...record.designChoice,
                reference: undefined,
              },
            )),
  );
  if (!previous) return false;
  const content = (entry: DecisionLogEntry) => {
    const { at: _at, commit: _commit, ...answer } = entry;
    if (answer.decision === "ruling")
      return JSON.stringify({
        ...answer,
        resolution: { ...answer.resolution, recordedAt: undefined },
      });
    if (answer.decision === "accept" || answer.decision === "reject") {
      const {
        findingId: _findingId,
        fingerprint: _fingerprint,
        ...stableAnswer
      } = answer;
      return JSON.stringify(stableAnswer);
    }
    return JSON.stringify(answer);
  };
  if (content(previous) !== content(record))
    throw new IdiomError("conflicting answer for the same escalation identity");
  return true;
}

export async function appendRulingDecision(
  projectDirectory: string,
  record: RulingDecision,
): Promise<string> {
  const parsed = rulingDecisionSchema.parse(record);
  await readDecisionLogEntries(projectDirectory);
  if (await identicalApplication(projectDirectory, parsed))
    return decisionLogPath(projectDirectory);
  return appendLine(projectDirectory, parsed);
}
