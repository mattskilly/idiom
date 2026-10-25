import { readDecisionLog } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import { renderInstruction } from "../instructions/render.js";
import { repairPresentation } from "../repair/presentation.js";
import { findCatalogLineage, loadReviewCatalog } from "../review/catalog.js";
import { lineageDecision } from "../review/lifecycle.js";

export async function instructionCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  findingId: string;
}): Promise<string> {
  const catalog = await loadReviewCatalog(options);
  const decisions = await readDecisionLog(catalog.projectDirectory);
  const lineage = findCatalogLineage(catalog, options.findingId);
  const latest = lineage.latest;
  const decision = lineageDecision(lineage, decisions, latest);
  if (decision?.decision !== "accept") {
    const reason =
      decision?.decision === "reject"
        ? "is rejected"
        : "has no acceptance for its latest occurrence";
    throw new IdiomError(
      `finding ${JSON.stringify(lineage.id)} ${reason}; accept the latest occurrence before emitting an instruction`,
    );
  }
  return renderInstruction(repairPresentation(catalog, latest));
}
