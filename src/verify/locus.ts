import { createHash } from "node:crypto";
import type { z } from "zod";
import type { CheckTuple, ObservedElement } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import type { Finding } from "../schemas/finding.js";
import { verificationLocusSchema } from "../schemas/finding.js";
import type { ProfileRecord, SemanticProfile } from "./profile.js";

export type VerificationLocus = z.infer<typeof verificationLocusSchema>;

function identity(element: Pick<ObservedElement, "tag" | "selector">): string {
  return createHash("sha256")
    .update(`${element.tag}\0${element.selector}`)
    .digest("hex");
}

function plausibleCss(value: string): boolean {
  if (value.trim() !== value || value === "" || /[{};]/.test(value))
    return false;
  try {
    // This rejects common prose while leaving actual browser validation to capture.
    return !/\s/.test(value) || /[>+~:[.#]/.test(value);
  } catch {
    return false;
  }
}

function matchesHint(element: ObservedElement, hint: string): boolean {
  if (element.selector === hint) return true;
  const v2 = element as ObservedElement & {
    attributes?: Record<string, string>;
  };
  const classMatches = [...hint.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(
    (match) => match[1] as string,
  );
  const tag = /^([A-Za-z][A-Za-z0-9-]*)/.exec(hint)?.[1]?.toLowerCase();
  if (tag !== undefined && element.tag !== tag) return false;
  if (classMatches.length > 0) {
    const classes = new Set((v2.attributes?.class ?? "").split(/\s+/));
    return classMatches.every((name) => classes.has(name));
  }
  if (hint.startsWith("#")) return element.selector === hint;
  return false;
}

export function deriveVerificationLocus(
  tuple: CheckTuple,
  selectorHint: string,
): VerificationLocus | undefined {
  if (!plausibleCss(selectorHint) || tuple.observations === undefined)
    return undefined;
  const visible = tuple.observations.elements.filter(
    (element) => element.visible,
  );
  const targets = visible.filter((element) =>
    matchesHint(element, selectorHint),
  );
  if (targets.length !== 1) return undefined;
  const target = targets[0] as ObservedElement & {
    structuralPath?: string;
  };
  const bySelector = new Map<string, ObservedElement[]>();
  for (const element of visible) {
    const list = bySelector.get(element.selector) ?? [];
    list.push(element);
    bySelector.set(element.selector, list);
  }
  const region = target.ancestorSelectors
    .map((selector) => bySelector.get(selector) ?? [])
    .find((matches) => matches.length === 1)?.[0];
  if (region === undefined) return undefined;
  const regionV2 = region as ObservedElement & { structuralPath?: string };
  const relativePath =
    target.structuralPath !== undefined && regionV2.structuralPath !== undefined
      ? target.structuralPath
          .slice(regionV2.structuralPath.length)
          .replace(/^\//, "") || "."
      : target.selector;
  return verificationLocusSchema.parse({
    version: 1,
    target: { selector: target.selector, signature: identity(target) },
    region: { selector: region.selector, signature: identity(region) },
    relativePath,
  });
}

function uniqueRecord(
  profile: SemanticProfile,
  selector: string,
): ProfileRecord | undefined {
  const matches = profile.records.filter(
    (record) => record.selector === selector,
  );
  if (matches.length > 1)
    throw new IdiomError(
      `verification locus selector is ambiguous: ${selector}`,
    );
  return matches[0];
}

function identityForRecord(record: ProfileRecord): string {
  return createHash("sha256")
    .update(`${record.tag}\0${record.selector}`)
    .digest("hex");
}

function regionRecords(
  profile: SemanticProfile,
  region: ProfileRecord,
): ProfileRecord[] {
  return profile.records.filter(
    (record) =>
      record.path === region.path || record.path.startsWith(`${region.path}/`),
  );
}

function recordsSignature(
  profile: SemanticProfile,
  root: ProfileRecord,
  includeGeometry: boolean,
): string {
  const records = regionRecords(profile, root);
  return createHash("sha256")
    .update(
      JSON.stringify(
        records.map(({ selector: _selector, path, geometry, ...record }) => ({
          ...record,
          path: path === root.path ? "." : path.slice(root.path.length + 1),
          ...(includeGeometry && geometry !== undefined ? { geometry } : {}),
        })),
      ),
    )
    .digest("hex");
}

function rootsSharePosition(roots: ProfileRecord[]): boolean {
  const first = roots[0]?.geometry;
  return (
    first !== undefined &&
    roots.every(
      ({ geometry }) =>
        geometry !== undefined &&
        geometry.x === first.x &&
        geometry.y === first.y,
    )
  );
}

export type LocusComparison = {
  source: "declared-locus" | "legacy-evidence-anchor" | "legacy-whole-tuple";
  changed: boolean;
  target: "present" | "target-absent";
  beforeSignature: string;
  afterSignature: string;
};

export function compareFindingLocus(options: {
  finding: Finding;
  baseline: SemanticProfile;
  currentA: SemanticProfile;
  currentB: SemanticProfile;
}): LocusComparison {
  const locus = options.finding.verification.locus;
  if (locus === undefined) {
    const legacySelector = options.finding.verification.params?.selector;
    if (typeof legacySelector === "string") {
      const baselineTarget = uniqueRecord(options.baseline, legacySelector);
      if (baselineTarget !== undefined) {
        const atPath = (profile: SemanticProfile) =>
          profile.records.find((record) => record.path === baselineTarget.path);
        const targetA =
          uniqueRecord(options.currentA, legacySelector) ??
          atPath(options.currentA);
        const targetB =
          uniqueRecord(options.currentB, legacySelector) ??
          atPath(options.currentB);
        if ((targetA === undefined) !== (targetB === undefined))
          throw new IdiomError(
            "legacy evidence anchor presence differs between current captures",
          );
        let baselineRoot = baselineTarget;
        let rootA = targetA;
        let rootB = targetB;
        if (targetB === undefined) {
          const parentPath = baselineTarget.path.slice(
            0,
            baselineTarget.path.lastIndexOf("/"),
          );
          const baselineParent = options.baseline.records.find(
            (record) => record.path === parentPath,
          );
          if (baselineParent === undefined)
            throw new IdiomError(
              "legacy evidence anchor has no historical parent region",
            );
          baselineRoot = baselineParent;
          rootA = uniqueRecord(options.currentA, baselineParent.selector);
          rootB = uniqueRecord(options.currentB, baselineParent.selector);
          if (rootA === undefined || rootB === undefined)
            throw new IdiomError(
              `legacy evidence anchor parent is missing: ${baselineParent.selector}`,
            );
        }
        if (rootA === undefined || rootB === undefined)
          throw new IdiomError(
            "legacy evidence anchor comparison root is missing",
          );
        const includeGeometry = rootsSharePosition([
          baselineRoot,
          rootA,
          rootB,
        ]);
        const before = recordsSignature(
          options.baseline,
          baselineRoot,
          includeGeometry,
        );
        const afterA = recordsSignature(
          options.currentA,
          rootA,
          includeGeometry,
        );
        const afterB = recordsSignature(
          options.currentB,
          rootB,
          includeGeometry,
        );
        if (afterA !== afterB)
          throw new IdiomError(
            "legacy evidence anchor differs between current captures",
          );
        return {
          source: "legacy-evidence-anchor",
          changed: before !== afterB,
          target: targetB === undefined ? "target-absent" : "present",
          beforeSignature: before,
          afterSignature: afterB,
        };
      }
    }
    return {
      source: "legacy-whole-tuple",
      changed: options.baseline.signature !== options.currentB.signature,
      target: "present",
      beforeSignature: options.baseline.signature,
      afterSignature: options.currentB.signature,
    };
  }
  const baselineRegion = uniqueRecord(options.baseline, locus.region.selector);
  const regionA = uniqueRecord(options.currentA, locus.region.selector);
  const regionB = uniqueRecord(options.currentB, locus.region.selector);
  if (
    baselineRegion === undefined ||
    identityForRecord(baselineRegion) !== locus.region.signature
  )
    throw new IdiomError(
      `historical verification region is missing or drifting: ${locus.region.selector}`,
    );
  if (regionA === undefined || regionB === undefined)
    throw new IdiomError(
      `current verification region is missing: ${locus.region.selector}`,
    );
  if (identityForRecord(regionA) !== identityForRecord(regionB))
    throw new IdiomError(
      `current verification region identity drifts between captures: ${locus.region.selector}`,
    );
  const baselineTarget = uniqueRecord(options.baseline, locus.target.selector);
  if (
    baselineTarget === undefined ||
    identityForRecord(baselineTarget) !== locus.target.signature
  )
    throw new IdiomError(
      `historical verification target is missing or drifting: ${locus.target.selector}`,
    );
  const targetA = uniqueRecord(options.currentA, locus.target.selector);
  const targetB = uniqueRecord(options.currentB, locus.target.selector);
  if ((targetA === undefined) !== (targetB === undefined))
    throw new IdiomError(
      "verification target presence differs between current captures",
    );
  const targetAbsent = targetB === undefined;
  const baselineRoot = targetAbsent ? baselineRegion : baselineTarget;
  const rootA = targetAbsent ? regionA : targetA;
  const rootB = targetAbsent ? regionB : targetB;
  if (rootA === undefined || rootB === undefined)
    throw new IdiomError("declared locus comparison root is missing");
  const includeGeometry = rootsSharePosition([baselineRoot, rootA, rootB]);
  const before = recordsSignature(
    options.baseline,
    baselineRoot,
    includeGeometry,
  );
  const afterA = recordsSignature(options.currentA, rootA, includeGeometry);
  const afterB = recordsSignature(options.currentB, rootB, includeGeometry);
  if (afterA !== afterB)
    throw new IdiomError(
      "verification region differs between current captures",
    );
  return {
    source: "declared-locus",
    changed: before !== afterB,
    target: targetAbsent ? "target-absent" : "present",
    beforeSignature: before,
    afterSignature: afterB,
  };
}
