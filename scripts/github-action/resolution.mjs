import {
  stageFinding,
  stageTuple,
  storedFindings,
  tupleImages,
} from "./evidence.mjs";
import { findingEntry, identity } from "./presentation.mjs";

export function previousHead(event) {
  if (event.action !== "synchronize") return undefined;
  for (const sha of [event.before, event.after])
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha ?? "") || /^0+$/.test(sha))
      throw new Error(
        "synchronize before/after must contain nonzero full commit hashes",
      );
  if (event.after !== event.pull_request.head.sha)
    throw new Error("synchronize after does not match PR head");
  if (event.before === event.after)
    throw new Error("synchronize previous head equals current head");
  return event.before;
}

/** fixed is the core comparator's alias-aware output, joined to previous new occurrences. */
export function resolvedFindings(
  previous,
  secondary,
  comparison,
  beforeTuples,
  afterTuples,
) {
  const notices = [];
  if (secondary.baseline?.stale)
    return {
      findings: [],
      notices: [
        `Previous-push checks configuration is stale: ${secondary.baseline.stale.reason}`,
      ],
    };
  if (previous.findings.some((finding) => !identity(finding)))
    return {
      findings: [],
      notices: [
        "Previous-head summary lacks fingerprints; resolution detail requires the matching candidate npm package.",
      ],
    };
  const fixed = new Set(secondary.fixed.map(identity).filter(Boolean));
  const uncovered = new Set(secondary.baseline?.uncoveredTuples ?? []);
  const comparable = new Set(
    [...comparison.changed, ...comparison.unchanged].map((tuple) => tuple.key),
  );
  for (const key of uncovered)
    notices.push(`Previous-push tuple uncovered: ${key}`);
  const findings = previous.findings.filter((finding) => {
    if (!fixed.has(identity(finding))) return false;
    const before = beforeTuples.get(finding.where),
      after = afterTuples.get(finding.where);
    if (
      uncovered.has(finding.where) ||
      !comparable.has(finding.where) ||
      !before ||
      !after ||
      before.failure ||
      after.failure
    ) {
      notices.push(
        `Cannot establish resolution for ${finding.where}: uncovered, missing, failed, ambiguous or not-comparable tuple.`,
      );
      return false;
    }
    return true;
  });
  return { findings, notices };
}

export async function stageResolved({
  result,
  findings,
  before,
  after,
  beforeTuples,
  afterTuples,
  evidence,
  origin,
  beforeCommit,
}) {
  const stored = await storedFindings(before);
  const seen = new Set((result.resolved ?? []).map(identity));
  for (const [index, finding] of findings.entries()) {
    if (seen.has(identity(finding))) continue;
    seen.add(identity(finding));
    const normalized = findingEntry(
      {
        ...finding,
        problem:
          finding.problem ??
          `${finding.rule ?? finding.category ?? "Finding"} (${finding.selector ?? finding.fingerprint})`,
      },
      `${origin}:${index}`,
    );
    const beforeEvidence =
      finding.screenshot || finding.filmstrip
        ? await stageFinding(
            finding,
            before,
            evidence,
            `resolved-${origin}-before`,
            index + 1,
            stored,
          )
        : await stageTuple(
            beforeTuples,
            finding.where,
            before,
            evidence,
            `resolved-${origin}-before`,
            index + 1,
          );
    const afterEvidence = await stageTuple(
      afterTuples,
      finding.where,
      after,
      evidence,
      `resolved-${origin}-after`,
      index + 1,
    );
    if (finding.timeline)
      afterEvidence.reasons.push(
        "After action/contact sheet unavailable; the after image is a settled screenshot, not a filmstrip.",
      );
    result.resolved.push({
      ...normalized,
      origin,
      beforeCommit,
      afterCommit: result.head,
      before: beforeEvidence,
      after: afterEvidence,
      composites: result.composites.filter(
        (item) => item.origin === origin && item.key === finding.where,
      ),
    });
  }
}

export { tupleImages };
