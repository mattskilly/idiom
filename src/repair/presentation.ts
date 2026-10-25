import { IdiomError } from "../errors.js";
import type {
  CatalogFinding,
  FindingLineage,
  ReviewCatalog,
} from "../review/catalog.js";

export type RepairPresentation = {
  target: CatalogFinding;
  siblings: CatalogFinding[];
};

function lineageFor(catalog: ReviewCatalog, findingId: string): FindingLineage {
  const matches = catalog.lineages.filter((lineage) =>
    lineage.ids.includes(findingId),
  );
  if (matches.length === 0)
    throw new IdiomError(`unknown finding id ${JSON.stringify(findingId)}`);
  if (matches.length > 1)
    throw new IdiomError(`ambiguous finding id ${JSON.stringify(findingId)}`);
  const match = matches[0];
  if (match === undefined)
    throw new IdiomError(`unknown finding id ${JSON.stringify(findingId)}`);
  return match;
}

export function reviewFindings(
  catalog: ReviewCatalog,
  record: CatalogFinding,
): CatalogFinding[] {
  return (
    catalog.runs.find((run) => run.runDirectory === record.runDirectory)
      ?.findings ?? []
  );
}

function presentedRecord(
  record: CatalogFinding,
  id: string,
  aliases: string[],
  fingerprint = record.finding.fingerprint,
): CatalogFinding {
  return {
    ...record,
    finding: {
      ...record.finding,
      id,
      fingerprint,
      ...(aliases.length === 0
        ? { idAliases: undefined }
        : { idAliases: aliases }),
    },
  };
}

export function repairPresentation(
  catalog: ReviewCatalog,
  record: CatalogFinding,
): RepairPresentation {
  const lineage = lineageFor(catalog, record.finding.id);
  const firstIdentity = lineage.identities[0] ?? {
    fingerprint: lineage.first.finding.fingerprint,
    findingId: lineage.first.finding.id,
  };
  const target = presentedRecord(
    record,
    lineage.id,
    lineage.ids.filter((id) => id !== lineage.id),
    firstIdentity.fingerprint,
  );
  const siblings = reviewFindings(catalog, record).flatMap((sibling) => {
    const siblingLineage = lineageFor(catalog, sibling.finding.id);
    if (siblingLineage.id === lineage.id) return [];
    return [
      presentedRecord(
        sibling,
        siblingLineage.id,
        siblingLineage.ids.filter((id) => id !== siblingLineage.id),
      ),
    ];
  });
  return { target, siblings };
}

export function repairSiblingLines(
  siblings: readonly CatalogFinding[],
): string[] {
  return siblings.length === 0
    ? ["- Other findings from this review: none."]
    : [
        "- Other findings from this review are separate work:",
        ...siblings.map(
          (record) =>
            `  - ${record.finding.id}: ${record.finding.category} on ${record.finding.state}/${record.finding.viewport}${record.finding.colorScheme === undefined ? "" : `/${record.finding.colorScheme}`}${record.finding.combination === undefined ? "" : ` [${record.finding.combination}]`}`,
        ),
      ];
}

export function repairScopeBoundary(
  finding: CatalogFinding["finding"],
): string {
  return finding.colorScheme === undefined
    ? `- The default scope is flow ${finding.flow}, state ${finding.state}, and viewport ${finding.viewport}. An acceptance criterion that explicitly requires additional coverage extends the corresponding flow, state, or viewport scope; every flow, state, and viewport not required by that default tuple or an acceptance criterion remains out of scope.`
    : `- The default scope is flow ${finding.flow}, state ${finding.state}, viewport ${finding.viewport}, and color scheme ${finding.colorScheme}. An acceptance criterion that explicitly requires additional coverage extends the corresponding flow, state, viewport, or color-scheme scope; every coordinate not required by that default tuple or an acceptance criterion remains out of scope.`;
}
