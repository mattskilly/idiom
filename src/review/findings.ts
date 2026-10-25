import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import type { CheckTuple, FindingCandidate } from "../checks/types.js";
import type {
  ModelFindingCandidate,
  ScreenshotRef,
} from "../critique/types.js";
import type { DecisionViews } from "../decisions/log.js";
import { evaluateRules } from "../rules/index.js";
import type { Decision } from "../schemas/decision.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import type { RuleOverride, Rules } from "../schemas/rules.js";
import { deriveVerificationLocus } from "../verify/locus.js";
import { assertEvidencePaths } from "./artifacts.js";
import type { ReviewCatalog } from "./catalog.js";
import { findingFingerprintIdentity, findingGroupKey } from "./fingerprint.js";
import { FINDING_NAME_PATTERN, type FindingNamingSession } from "./names.js";

export type FindingDraft = {
  finding: Finding;
  selectorHint: string;
  stableOrder: number;
  fingerprintAliases?: string[] | undefined;
  severityOverride?:
    | {
        override: RuleOverride;
        original: Finding["severity"];
        effective: Finding["severity"];
      }
    | undefined;
};

export type SuppressedFinding =
  | {
      finding: Finding;
      source?: "decision" | undefined;
      decision: Decision;
      decisionFindingId?: string | undefined;
    }
  | { finding: Finding; source: "rule"; override: RuleOverride };

const severityOrder = new Map([
  ["blocker", 0],
  ["major", 1],
  ["minor", 2],
]);

/**
 * Severity, then the optional priority (lower first; page reviews rank
 * requested focus areas ahead), then confidence and stable identity.
 */
export function sortFindingDrafts(
  drafts: FindingDraft[],
  priority?: ((draft: FindingDraft) => number) | undefined,
): FindingDraft[] {
  return [...drafts].sort(
    (left, right) =>
      (severityOrder.get(left.finding.severity) ?? 3) -
        (severityOrder.get(right.finding.severity) ?? 3) ||
      (priority === undefined ? 0 : priority(left) - priority(right)) ||
      right.finding.confidence - left.finding.confidence ||
      left.finding.fingerprint.localeCompare(right.finding.fingerprint) ||
      left.finding.layer.localeCompare(right.finding.layer) ||
      left.stableOrder - right.stableOrder ||
      left.selectorHint.localeCompare(right.selectorHint),
  );
}

export function dedupeFindingDrafts(drafts: FindingDraft[]): FindingDraft[] {
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    const identities = new Set([
      draft.finding.fingerprint,
      ...(draft.fingerprintAliases ?? []),
    ]);
    if ([...identities].some((identity) => seen.has(identity))) return false;
    for (const identity of identities) seen.add(identity);
    return true;
  });
}

export function dedupeSuppressedFindings(
  suppressed: SuppressedFinding[],
): SuppressedFinding[] {
  const seen = new Set<string>();
  return suppressed.filter(({ finding }) => {
    const key = `${finding.fingerprint}\0${finding.category}\0${finding.state}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deterministicFinding(options: {
  runId: string;
  tuple: CheckTuple;
  candidate: FindingCandidate;
  stableOrder: number;
  legacyColorScheme?: "light" | "dark" | undefined;
}): FindingDraft {
  const { tuple, candidate } = options;
  const identity = findingFingerprintIdentity({
    category: candidate.category,
    flow: tuple.flow,
    state: tuple.state,
    rule: candidate.rule,
    selectorHint: candidate.fingerprintHint ?? candidate.selectorHint,
    ...(tuple.colorSchemeAxis
      ? {
          colorScheme: tuple.colorScheme,
          legacyColorScheme: options.legacyColorScheme,
        }
      : {}),
  });
  const evidenceTuples = candidate.evidenceTuples ?? [tuple];
  return {
    selectorHint: candidate.selectorHint,
    stableOrder: options.stableOrder,
    fingerprintAliases: identity.aliases,
    finding: findingSchema.parse({
      id: `draft-${options.runId}-${options.stableOrder}`,
      fingerprint: identity.fingerprint,
      groupKey: findingGroupKey({
        category: candidate.category,
        flow: tuple.flow,
        rule: candidate.rule,
        selectorHint: candidate.fingerprintHint ?? candidate.selectorHint,
      }),
      createdAt: tuple.createdAt,
      commit: tuple.commit,
      flow: tuple.flow,
      state: tuple.state,
      viewport: tuple.viewport,
      ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
      ...(tuple.combination === undefined
        ? {}
        : { combination: tuple.combination }),
      layer: "deterministic",
      category: candidate.category,
      severity: candidate.severity,
      confidence: 1,
      rule: candidate.rule,
      evidence: {
        screenshots: [
          ...new Set(
            evidenceTuples.flatMap((evidence) =>
              evidence.screenshotPath === undefined
                ? []
                : [evidence.screenshotPath],
            ),
          ),
        ],
        artifacts: [
          ...new Set(
            evidenceTuples.flatMap((evidence) => evidence.artifactPaths),
          ),
        ],
        ...(candidate.domSnippet === undefined
          ? {}
          : { domSnippet: candidate.domSnippet }),
        ...(candidate.consoleExcerpt === undefined
          ? {}
          : { consoleExcerpt: candidate.consoleExcerpt }),
        ...(candidate.axeNodes === undefined
          ? {}
          : { axeNodes: candidate.axeNodes }),
      },
      explanation: candidate.explanation,
      acceptance: candidate.acceptance,
      verification: {
        kind: "deterministic-check",
        check: candidate.verification.check,
        ...(candidate.verification.params === undefined
          ? {}
          : { params: candidate.verification.params }),
      },
      status: "open",
    }),
  };
}

export function buildDeterministicDrafts(options: {
  runId: string;
  entries: Array<{
    tuple: CheckTuple;
    candidate: FindingCandidate;
    checkOrder: number;
  }>;
  legacyColorScheme?: "light" | "dark" | undefined;
}): FindingDraft[] {
  const tupleOrder = new Map<string, number>();
  for (const { tuple } of options.entries) {
    const key = `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme ?? ""}`;
    if (!tupleOrder.has(key)) tupleOrder.set(key, tupleOrder.size);
  }
  const sorted = [...options.entries].sort(
    (left, right) =>
      (tupleOrder.get(
        `${left.tuple.state}\0${left.tuple.viewport}\0${left.tuple.colorScheme ?? ""}`,
      ) ?? 0) -
        (tupleOrder.get(
          `${right.tuple.state}\0${right.tuple.viewport}\0${right.tuple.colorScheme ?? ""}`,
        ) ?? 0) ||
      left.checkOrder - right.checkOrder ||
      left.candidate.selectorHint.localeCompare(right.candidate.selectorHint) ||
      left.candidate.rule.localeCompare(right.candidate.rule),
  );
  return sorted.map(({ tuple, candidate }, stableOrder) =>
    deterministicFinding({
      runId: options.runId,
      tuple,
      candidate,
      stableOrder,
      legacyColorScheme: options.legacyColorScheme,
    }),
  );
}

export function buildModelDrafts(options: {
  runId: string;
  candidates: ModelFindingCandidate[];
  screenshots: ScreenshotRef[];
  tuples: CheckTuple[];
  legacyColorScheme?: "light" | "dark" | undefined;
}): FindingDraft[] {
  const screenshotByLabel = new Map(
    options.screenshots.map((screenshot) => [screenshot.label, screenshot]),
  );
  const tupleByKey = new Map(
    options.tuples.map((tuple) => [
      `${tuple.state}\0${tuple.viewport}\0${tuple.colorSchemeAxis ? tuple.colorScheme : ""}`,
      tuple,
    ]),
  );
  return options.candidates.map((candidate, stableOrder) => {
    const tuple = tupleByKey.get(
      `${candidate.state}\0${candidate.viewport}\0${candidate.colorScheme ?? ""}`,
    );
    if (tuple === undefined)
      throw new Error(
        `model finding references unknown tuple ${candidate.state}/${candidate.viewport}`,
      );
    const screenshots = candidate.screenshots.map((label) => {
      const screenshot = screenshotByLabel.get(label);
      if (
        screenshot === undefined ||
        screenshot.state !== candidate.state ||
        screenshot.viewport !== candidate.viewport ||
        screenshot.colorScheme !== candidate.colorScheme
      ) {
        throw new Error(`model finding references invalid screenshot ${label}`);
      }
      return screenshot.path;
    });
    const identity = findingFingerprintIdentity({
      category: candidate.category,
      flow: tuple.flow,
      state: candidate.state,
      rule: candidate.rule,
      selectorHint: candidate.selectorHint,
      ...(tuple.colorSchemeAxis
        ? {
            colorScheme: tuple.colorScheme,
            legacyColorScheme: options.legacyColorScheme,
          }
        : {}),
    });
    const locus = deriveVerificationLocus(tuple, candidate.selectorHint);
    return {
      selectorHint: candidate.selectorHint,
      stableOrder,
      fingerprintAliases: identity.aliases,
      finding: findingSchema.parse({
        id: `draft-${options.runId}-model-${stableOrder}`,
        fingerprint: identity.fingerprint,
        createdAt: tuple.createdAt,
        commit: tuple.commit,
        flow: tuple.flow,
        state: candidate.state,
        viewport: candidate.viewport,
        ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
        layer: "model",
        category: candidate.category,
        severity: candidate.severity,
        confidence: candidate.confidence,
        rule: candidate.rule,
        evidence: {
          screenshots,
          ...(candidate.references.length === 0
            ? {}
            : { references: candidate.references }),
          ...(candidate.section === undefined
            ? {}
            : { section: candidate.section }),
          ...(candidate.citations === undefined
            ? {}
            : { citations: candidate.citations }),
        },
        explanation: candidate.explanation,
        suggestedArea: candidate.suggestedArea,
        ...(candidate.fix === undefined ? {} : { fix: candidate.fix }),
        ...(candidate.focus === undefined ? {} : { focus: candidate.focus }),
        acceptance: candidate.acceptance,
        verification: {
          kind: "recapture-visual",
          ...(locus === undefined ? {} : { locus }),
        },
        status: "open",
      }),
    };
  });
}

export function suppressFindingDrafts(
  drafts: FindingDraft[],
  decisions: Decision[],
): { kept: FindingDraft[]; suppressed: SuppressedFinding[] } {
  const kept: FindingDraft[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const draft of drafts) {
    const identities = new Set([
      draft.finding.fingerprint,
      ...(draft.fingerprintAliases ?? []),
    ]);
    const decision = decisions
      .filter(
        (candidate) =>
          candidate.scope === "rule" && identities.has(candidate.fingerprint),
      )
      .at(-1);
    if (decision?.decision !== "reject") kept.push(draft);
    else
      suppressed.push({
        finding: draft.finding,
        source: "decision",
        decision,
        decisionFindingId: draft.finding.id,
      });
  }
  return { kept, suppressed };
}

/** Name drafts once, before any prompt, selection, suppression, or rendering. */
export function nameFindingDrafts(
  session: FindingNamingSession,
  drafts: FindingDraft[],
): FindingDraft[] {
  return drafts.map((draft) => ({
    ...draft,
    finding: session.name(draft.finding, draft.fingerprintAliases),
  }));
}

export function applyRulesToDrafts(
  drafts: FindingDraft[],
  rules: Rules,
): { kept: FindingDraft[]; suppressed: SuppressedFinding[] } {
  const kept: FindingDraft[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const draft of drafts) {
    const policy = evaluateRules(rules, {
      ...draft.finding,
      fingerprintAliases: draft.fingerprintAliases,
    });
    const finding =
      policy.severity === undefined
        ? draft.finding
        : findingSchema.parse({
            ...draft.finding,
            severity: policy.severity.effective,
          });
    if (policy.suppression !== undefined) {
      suppressed.push({
        finding,
        source: "rule",
        override: policy.suppression,
      });
    } else {
      kept.push({
        ...draft,
        finding,
        ...(policy.severity === undefined
          ? {}
          : { severityOverride: policy.severity }),
      });
    }
  }
  return { kept, suppressed };
}

export function finalizeFindingSelection(options: {
  runId: string;
  drafts: FindingDraft[];
  maxFindings: number;
  catalog?: ReviewCatalog | undefined;
  priority?: ((draft: FindingDraft) => number) | undefined;
}): {
  material: Finding[];
  deferred: Finding[];
  orderedDrafts: FindingDraft[];
} {
  const orderedDrafts = dedupeFindingDrafts(
    sortFindingDrafts(options.drafts, options.priority),
  );
  const reservedIds = new Set(
    options.catalog?.lineages.flatMap((lineage) => lineage.ids) ?? [],
  );
  const emittedIds = new Set<string>();
  let sequence = 1;
  const finalized = orderedDrafts.map((draft) => {
    const identities = new Set([
      draft.finding.fingerprint,
      ...(draft.fingerprintAliases ?? []),
    ]);
    const lineage = options.catalog?.lineages.find((candidate) =>
      candidate.fingerprints.some((fingerprint) => identities.has(fingerprint)),
    );
    let id = lineage?.id;
    if (FINDING_NAME_PATTERN.test(draft.finding.id)) id = draft.finding.id;
    if (id === undefined) {
      do {
        id = `finding-${sequence}`;
        sequence += 1;
      } while (reservedIds.has(id) || emittedIds.has(id));
    }
    emittedIds.add(id);
    return findingSchema.parse({
      ...draft.finding,
      id,
      status: lineage?.latest.finding.status ?? draft.finding.status,
    });
  });
  return {
    material: finalized.slice(0, options.maxFindings),
    deferred: finalized.slice(options.maxFindings),
    orderedDrafts,
  };
}

export function finalizeFindings(options: {
  runId: string;
  drafts: FindingDraft[];
  maxFindings?: number | undefined;
  catalog?: ReviewCatalog | undefined;
}): Finding[] {
  return finalizeFindingSelection({
    runId: options.runId,
    drafts: options.drafts,
    maxFindings: options.maxFindings ?? Number.POSITIVE_INFINITY,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  }).material;
}

export function selectFindings(options: {
  findings: Finding[];
  decisions: DecisionViews;
  maxFindings: number;
}): {
  actionable: Finding[];
  suppressed: Array<{ finding: Finding; decision: Decision }>;
  deferred: Finding[];
} {
  const suppressed = options.findings.flatMap((finding) => {
    const decision = options.decisions.byRuleFingerprint.get(
      finding.fingerprint,
    );
    return decision?.decision === "reject" ? [{ finding, decision }] : [];
  });
  const unsuppressed = options.findings
    .map((finding, index) => ({ finding, index }))
    .filter(
      ({ finding }) =>
        options.decisions.byRuleFingerprint.get(finding.fingerprint)
          ?.decision !== "reject",
    )
    .sort(
      (left, right) =>
        (severityOrder.get(left.finding.severity) ?? 3) -
          (severityOrder.get(right.finding.severity) ?? 3) ||
        right.finding.confidence - left.finding.confidence ||
        left.finding.fingerprint.localeCompare(right.finding.fingerprint) ||
        left.index - right.index,
    )
    .map(({ finding }) => finding);
  return {
    actionable: unsuppressed.slice(0, options.maxFindings),
    suppressed,
    deferred: unsuppressed.slice(options.maxFindings),
  };
}

export async function writeFindings(
  runDirectory: string,
  findings: Finding[],
): Promise<string> {
  for (const finding of findings) {
    await assertEvidencePaths(runDirectory, [
      ...finding.evidence.screenshots,
      ...(finding.evidence.artifacts ?? []),
    ]);
  }
  const path = join(runDirectory, "findings.json");
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(findings, null, 2)}\n`);
  await rename(temporary, path);
  return path;
}

/** Finalize each tuple separately: canonical IDs may legitimately occur more than once. */
export function finalizeDeterministicOccurrences(options: {
  runId: string;
  drafts: FindingDraft[];
  catalog?: ReviewCatalog | undefined;
}): Finding[] {
  const groups = new Map<string, FindingDraft[]>();
  for (const draft of options.drafts) {
    const key = tupleCoordinateKey(draft.finding);
    const group = groups.get(key) ?? [];
    group.push(draft);
    groups.set(key, group);
  }
  return [...groups.values()]
    .flatMap((drafts) => finalizeFindings({ ...options, drafts }))
    .sort(
      (left, right) =>
        (severityOrder.get(left.severity) ?? 3) -
          (severityOrder.get(right.severity) ?? 3) ||
        tupleCoordinateKey(left).localeCompare(tupleCoordinateKey(right)) ||
        left.fingerprint.localeCompare(right.fingerprint),
    );
}
