import type { SweepSummary, SweepSummaryFinding } from "../commands/sweep.js";
import type { CatalogFinding } from "../review/catalog.js";
import type { RankingExplanation } from "../review/ranking.js";
import type { ReviewRunResult } from "../review/run.js";
import type { Finding } from "../schemas/finding.js";
import type { FindingCluster } from "../tickets/cluster.js";
import type { ClusterTicketsResult } from "../tickets/emit.js";
import type { sweepProbeCoverage } from "./coverage.js";

export type SweepFlowResult = {
  flow: string;
  summary: SweepSummary;
  review: ReviewRunResult;
  records: CatalogFinding[];
  occurrences: CatalogFinding[];
};
export type SweepProposal = {
  id: string;
  cluster: FindingCluster;
  findingIds: string[];
  severity: Finding["severity"];
  salience: number;
  prominence: number;
  score: number;
  explanation: RankingExplanation;
};
export type ProductSweepSummary = {
  scope: "all";
  outcome: SweepSummary["outcome"];
  flows: Array<
    | {
        flow: string;
        status: "reviewed";
        summary: SweepSummary;
        probeCoverage: ReturnType<typeof sweepProbeCoverage>;
        coverage: Pick<
          ReviewRunResult,
          "scope" | "reportCoverage" | "checkCoverage" | "probes" | "timings"
        >;
      }
    | { flow: string; status: "failed"; reason: string }
  >;
  findings: Array<SweepSummaryFinding & { flow: string }>;
  /** Exact current-run records; paths remain relative to the owning run. */
  sourceFindings: CatalogFinding[];
  occurrences: CatalogFinding[];
  proposals: SweepProposal[];
  proposalCount: number;
  selectedCount: number;
  omittedCount: number;
  occurrenceCount: number;
  severityCounts: Record<string, number>;
  ruleCounts: Record<string, number>;
  blocking: number;
  tickets?: ClusterTicketsResult | undefined;
  runDirectory: string;
  jsonPath: string;
  reportPath: string;
  htmlReportPath: string;
};
