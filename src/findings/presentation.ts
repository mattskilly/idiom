import type {
  Acceptance,
  BasisDetails,
  FindingBasis,
} from "../schemas/acceptance.js";

/** Human text only; callers publishing evidence must also retain the contract. */
export function acceptanceText(finding: {
  acceptance: Acceptance | string[];
}): string[] {
  return Array.isArray(finding.acceptance)
    ? finding.acceptance
    : finding.acceptance.doneWhen;
}
export function basisDescription(finding: {
  basis?: FindingBasis | undefined;
  basisDetails?: BasisDetails | undefined;
  layer?: string | undefined;
  confidence?: number | undefined;
}): string {
  const basis =
    finding.basis ?? (finding.layer === "model" ? "judged" : "measured");
  const details = finding.basisDetails;
  if (!details)
    return `${basis}: ${basis === "judged" ? "model critique" : "measurement details not recorded"}`;
  if (details.kind === "judged")
    return `judged: ${details.summary}${details.confidence === undefined ? "" : ` (stated confidence ${details.confidence})`}`;
  if (details.kind === "measured")
    return `measured: ${details.rule} — ${details.summary}`;
  const timing = details.timing;
  return `observed: ${details.action.kind} ${details.action.selector ?? details.action.name} — ${details.summary} (${timing.elapsedMs !== undefined ? `${timing.elapsedMs}ms elapsed` : timing.windowMs !== undefined ? `${timing.windowMs}ms window` : (timing.reason ?? "timing not recorded")})`;
}
export function acceptanceDescription(acceptance: Acceptance): string {
  if (acceptance.kind !== "rule")
    return `${acceptance.kind}: no executable acceptance condition recorded`;
  const target = acceptance.target;
  return `${acceptance.rule}: rule-clear for ${target.kind === "action" ? `${target.action.source} ${target.action.kind} ${target.action.selector ?? target.action.name}` : target.kind === "selectors" ? target.selectors.join(", ") : "document"}; settings ${acceptance.condition.settingsIdentity}`;
}
