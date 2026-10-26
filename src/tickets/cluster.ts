import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { observationArtifactSchema } from "../checks/artifact-schema.js";
import type {
  ObservationArtifact,
  ObservedElement,
  ObservedElementV2,
} from "../checks/types.js";
import { IdiomError } from "../errors.js";
import { assertEvidencePaths } from "../review/artifacts.js";
import type { CatalogFinding } from "../review/catalog.js";
import type { RootCause } from "../review/root-causes.js";

/** The root cause a member's finding is a symptom of, when one formed. */
export type ClusterCause = Pick<
  RootCause,
  "id" | "kind" | "key" | "cause" | "confidence" | "evidence" | "fix"
> & { symptoms: number };
export type ClusterMember = {
  id: string;
  record: CatalogFinding;
  component: string;
  cause?: ClusterCause | undefined;
};
export type FindingCluster = {
  key: string;
  component: string;
  members: ClusterMember[];
  cause?: ClusterCause | undefined;
};
export function findingSelector(record: CatalogFinding): string | undefined {
  const selector = record.finding.verification.params?.selector;
  return typeof selector === "string" && selector.length > 0
    ? selector
    : record.finding.verification.locus?.target.selector;
}
export function isComponentShell(element: ObservedElement): boolean {
  const attrs = (element as Partial<ObservedElementV2>).attributes ?? {};
  const role =
    (element as Partial<ObservedElementV2>).signals?.role ?? attrs.role;
  return (
    ["html", "body", "main"].includes(element.tag.toLowerCase()) ||
    role === "main" ||
    /^(?:root|app|__next|__nuxt|app-root)$/i.test(attrs.id ?? "") ||
    /^#(?:root|app|__next|__nuxt|app-root)$/i.test(element.selector)
  );
}
export function isComponentBoundary(element: ObservedElement): boolean {
  const attrs = (element as Partial<ObservedElementV2>).attributes ?? {};
  const role =
    (element as Partial<ObservedElementV2>).signals?.role ?? attrs.role ?? "";
  return (
    !!attrs.id ||
    Object.keys(attrs).some((key) =>
      /^(?:data-testid|data-test|data-cy)$/.test(key),
    ) ||
    /^#|\[data-(?:testid|test|cy)=/.test(element.selector) ||
    [
      "dialog",
      "form",
      "nav",
      "section",
      "article",
      "aside",
      "toolbar",
    ].includes(element.tag.toLowerCase()) ||
    [
      "dialog",
      "alertdialog",
      "form",
      "navigation",
      "region",
      "article",
      "complementary",
      "toolbar",
    ].includes(role)
  );
}
export function componentFor(
  record: CatalogFinding,
  id: string,
  observations?: ObservationArtifact,
): string {
  const singleton = `finding:${id}`;
  const selector = findingSelector(record);
  if (selector === undefined || observations === undefined) return singleton;
  const unique = (value: string) => {
    const matches = observations.elements.filter(
      (element) => element.selector === value,
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const target = unique(selector);
  if (target === undefined || isComponentShell(target)) return singleton;
  const ancestors = target.ancestorSelectors.map(unique);
  // An ambiguous/missing nearer ancestor cannot supply trustworthy component evidence.
  const chain = [target, ...ancestors];
  for (const element of chain) {
    if (element === undefined) break;
    if (isComponentShell(element)) continue;
    const nodeId = (element as Partial<ObservedElementV2>).signals?.nodeId;
    if (nodeId !== undefined && nodeId.trim().length > 0)
      return `node:${nodeId}`;
  }
  const parents: ObservedElement[] = [];
  for (const element of ancestors) {
    if (element === undefined) return singleton;
    if (isComponentShell(element)) break;
    parents.push(element);
  }
  const anchored = parents.find(isComponentBoundary);
  const component = anchored ?? parents[0] ?? target;
  return `selector:${component.selector}`;
}
export function groupFindings(members: ClusterMember[]): FindingCluster[] {
  const groups = new Map<string, FindingCluster>();
  for (const member of members) {
    const finding = member.record.finding;
    // One ticket per root cause, across categories and components.
    const key = JSON.stringify(
      member.cause === undefined
        ? [finding.flow, finding.category, member.component]
        : ["cause", member.cause.id],
    );
    const cluster = groups.get(key) ?? {
      key,
      component: member.component,
      members: [],
      ...(member.cause === undefined ? {} : { cause: member.cause }),
    };
    cluster.members.push(member);
    groups.set(key, cluster);
  }
  return [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((cluster) => ({
      ...cluster,
      members: cluster.members.sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
export function clusterTicketId(cluster: FindingCluster): string {
  return `idiom-cluster-${createHash("sha256")
    .update("idiom-cluster-v1\0")
    .update(JSON.stringify(cluster.members.map((m) => m.id).sort()))
    .digest("hex")}`;
}
export function observationLoader() {
  const cache = new Map<string, Promise<ObservationArtifact>>();
  return async (
    record: CatalogFinding,
  ): Promise<ObservationArtifact | undefined> => {
    const finding = record.finding;
    const paths = (finding.evidence.artifacts ?? []).filter((path) =>
      path.endsWith("/observations.json"),
    );
    const matching: string[] = [];
    for (const path of paths) {
      await assertEvidencePaths(record.runDirectory, [path]);
      const parts = path.split("/");
      if (
        parts[0] !== finding.state ||
        parts[1] !== finding.viewport ||
        (finding.colorScheme === undefined
          ? parts.length !== 3
          : parts.length !== 4 || parts[2] !== finding.colorScheme)
      )
        continue;
      // Metadata confirms generated-state combinations, and prevents cross-tuple reuse.
      try {
        const metadata = JSON.parse(
          await readFile(
            resolve(record.runDirectory, dirname(path), "metadata.json"),
            "utf8",
          ),
        );
        if (
          metadata.state?.id !== finding.state ||
          metadata.viewport?.name !== finding.viewport ||
          (finding.colorScheme !== undefined &&
            metadata.colorScheme !== finding.colorScheme) ||
          (metadata.combination?.label ?? undefined) !== finding.combination ||
          metadata.flow?.id !== finding.flow
        )
          continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new IdiomError(
            `cannot read observation metadata for ${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        if (finding.combination !== undefined) continue;
      }
      matching.push(path);
    }
    if (matching.length !== 1) return undefined;
    const path = resolve(record.runDirectory, matching[0] ?? "");
    let loaded = cache.get(path);
    if (loaded === undefined) {
      loaded = (async () => {
        try {
          return observationArtifactSchema.parse(
            JSON.parse(await readFile(path, "utf8")),
          );
        } catch (error) {
          throw new IdiomError(
            `invalid observations ${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
      cache.set(path, loaded);
    }
    return loaded;
  };
}
