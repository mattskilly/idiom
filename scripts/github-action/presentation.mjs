import { severities } from "./common.mjs";

export const tierNames = ["Blocks merge", "Should fix", "Opportunities"];
const lines = (value) =>
  Array.isArray(value)
    ? value.filter((line) => typeof line === "string" && line.trim())
    : [];
export const identity = (finding) =>
  typeof finding.fingerprint === "string" &&
  finding.fingerprint &&
  typeof finding.where === "string"
    ? JSON.stringify([finding.where, finding.fingerprint])
    : undefined;

export function findingEntry(finding, source, evidence) {
  const fix = lines(finding.fix);
  const acceptance = lines(
    Array.isArray(finding.acceptance)
      ? finding.acceptance
      : finding.acceptance?.doneWhen,
  );
  return {
    source,
    id: finding.id,
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    basis: finding.basis ?? "measured",
    where: finding.where ?? "Location unavailable",
    problem: finding.problem ?? "Problem description unavailable",
    fix: fix.length ? fix : ["Repair instructions unavailable."],
    doneWhen: acceptance.length
      ? acceptance
      : fix.length
        ? fix
        : ["Acceptance criteria unavailable; human review required."],
    evidence: evidence ?? {
      images: [],
      reasons: ["Evidence unavailable: no staged image."],
    },
  };
}

/** Presentation only. With never, blockers remain visible in Should fix. */
export function presentation(result) {
  const tiers = tierNames.map((name) => ({ name, entries: [] }));
  const seenJudged = new Set();
  const judgedKey = (finding) =>
    identity(finding) ?? JSON.stringify([finding.id, finding.where]);
  for (const [index, finding] of (result.summary?.findings ?? []).entries()) {
    const source = `finding:${index}`;
    // Retain compatibility with older Action result files without evidence maps.
    const legacy = (result.crops ?? []).filter(
      (crop) => crop.finding === index,
    );
    const evidence =
      result.evidence?.[source] ??
      (legacy.length ? { images: legacy, reasons: [] } : undefined);
    const entry = findingEntry(finding, source, evidence);
    if (entry.basis === "judged") {
      const key = judgedKey(finding);
      if (!seenJudged.has(key)) tiers[2].entries.push(entry);
      seenJudged.add(key);
    } else {
      const blocks =
        result.failOn !== "never" &&
        severities[finding.severity] <= severities[result.failOn];
      // A blocker remains visible when gating is disabled, too.
      tiers[blocks ? 0 : 1].entries.push(entry);
    }
  }
  for (const [p, pattern] of (
    result.summary?.advisory?.patterns ?? []
  ).entries()) {
    for (const [i, finding] of (pattern.findings ?? []).entries()) {
      const key = judgedKey(finding);
      if (seenJudged.has(key)) continue;
      seenJudged.add(key);
      const source = `advisory:${p}:${i}`;
      tiers[2].entries.push(
        findingEntry(
          { ...finding, basis: "judged" },
          source,
          result.evidence?.[source],
        ),
      );
    }
  }
  for (const tier of tiers)
    tier.entries.sort(
      (a, b) => severities[a.severity] - severities[b.severity],
    );
  const seenQuestions = new Set();
  for (const [index, question] of (
    result.summary?.designSystemQuestions ?? []
  ).entries()) {
    if (seenQuestions.has(question.id)) continue;
    seenQuestions.add(question.id);
    const source = `question:${index}`;
    tiers[2].entries.push({
      source,
      id: question.id,
      basis: "question",
      where: `${question.count} occurrences · suggested token: ${question.suggestedToken || "unavailable"}`,
      problem: question.question,
      fix: [
        `Decide whether this belongs in the scale: idiom ruling --decision ${question.id} --add-step [--token ${question.suggestedToken || "TOKEN"}] or --drift.`,
      ],
      doneWhen: [
        "A human has chosen an intentional scale step (--add-step) or classified the value as drift (--drift).",
      ],
      evidence: result.evidence?.[source] ?? {
        images: [],
        reasons: ["Evidence unavailable: question examples were not staged."],
      },
    });
  }
  return { tiers, resolved: result.resolved ?? [] };
}

export function comparisonDetails(result) {
  const details = [];
  for (const [origin, comparison] of [
    ["Merge base", result.comparison],
    ["Previous push", result.historyComparison],
  ]) {
    if (!comparison) continue;
    details.push(
      `${origin}: unchanged ${comparison.unchanged.length}; only before ${comparison.onlyBefore.length}; only after ${comparison.onlyAfter.length}; not comparable ${comparison.notComparable.length}.`,
    );
    for (const kind of ["onlyBefore", "onlyAfter", "notComparable"])
      for (const tuple of comparison[kind])
        details.push(
          `${origin} ${kind}: ${tuple.key}${tuple.reason ? ` — ${tuple.reason}` : ""}`,
        );
  }
  for (const entry of result.composites ?? [])
    details.push(
      `${entry.origin ?? "Merge base"} composite ${entry.key}: ${entry.path}`,
    );
  for (const reason of result.unavailable ?? [])
    details.push(`Evidence unavailable: ${reason}`);
  for (const reason of result.resolutionNotices ?? [])
    details.push(`Resolution evidence: ${reason}`);
  if (result.summary?.baseline?.stale)
    details.push(
      `Merge-base comparison possibly stale: ${result.summary.baseline.stale.reason}`,
    );
  for (const key of result.summary?.baseline?.uncoveredTuples ?? [])
    details.push(`Merge-base tuple uncovered: ${key}`);
  return details;
}
