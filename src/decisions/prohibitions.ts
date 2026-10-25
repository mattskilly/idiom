import { isAbsolute } from "node:path";
import type { ReviewCatalog } from "../review/catalog.js";
import { compareFindingNames } from "../review/names.js";
import type { Decision } from "../schemas/decision.js";

export type ProhibitionEvidence = {
  runDirectory: string;
  screenshots: string[];
};

export type StandingProhibition =
  | {
      kind: "described";
      key: string;
      behavior: string;
      rule: string;
      reason: string | undefined;
      rejections: number;
      surface: string;
      evidence: ProhibitionEvidence;
    }
  | {
      kind: "degraded";
      key: string;
      fingerprint: string;
      reason: string | undefined;
      rejections: number;
    };

function safeReportPath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.split("/").includes("..")
  );
}

/** Latest rule-scope record across every fingerprint alias is current policy. */
export function collectStandingProhibitions(
  catalog: ReviewCatalog,
  decisions: readonly Decision[],
): StandingProhibition[] {
  const ruleDecisions = decisions.filter(
    (decision) => decision.scope === "rule",
  );
  const claimed = new Set<Decision>();
  const prohibitions: StandingProhibition[] = [];

  for (const lineage of catalog.lineages) {
    const group = ruleDecisions.filter((decision) =>
      lineage.fingerprints.includes(decision.fingerprint),
    );
    if (group.length === 0) continue;
    for (const decision of group) claimed.add(decision);
    const latest = group.at(-1);
    if (latest === undefined || latest.decision !== "reject") continue;
    const finding = lineage.latest.finding;
    const first = lineage.first.finding;
    prohibitions.push({
      kind: "described",
      key: lineage.id,
      behavior: finding.explanation,
      rule: finding.rule ?? finding.category,
      reason: latest.reason,
      rejections: group.filter((decision) => decision.decision === "reject")
        .length,
      surface: `${first.flow}/${first.state}/${first.viewport}${first.colorScheme === undefined ? "" : `/${first.colorScheme}`}`,
      evidence: {
        runDirectory: lineage.latest.runDirectory,
        screenshots: [...new Set(finding.evidence.screenshots)]
          .filter(safeReportPath)
          .sort(),
      },
    });
  }

  const orphans = new Map<string, Decision[]>();
  for (const decision of ruleDecisions) {
    if (claimed.has(decision)) continue;
    orphans.set(decision.fingerprint, [
      ...(orphans.get(decision.fingerprint) ?? []),
      decision,
    ]);
  }
  for (const [fingerprint, group] of orphans) {
    const latest = group.at(-1);
    if (latest === undefined || latest.decision !== "reject") continue;
    prohibitions.push({
      kind: "degraded",
      key: fingerprint,
      fingerprint,
      reason: latest.reason,
      rejections: group.filter((decision) => decision.decision === "reject")
        .length,
    });
  }

  return prohibitions.sort(
    (left, right) =>
      (left.kind === "described" ? 0 : 1) -
        (right.kind === "described" ? 0 : 1) ||
      compareFindingNames(left.key, right.key),
  );
}
