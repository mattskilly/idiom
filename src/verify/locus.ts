import { createHash } from "node:crypto";
import type { z } from "zod";
import type { CheckTuple, ObservedElement } from "../checks/types.js";
import { IdiomError } from "../errors.js";
import type { Finding } from "../schemas/finding.js";
import { verificationLocusSchema } from "../schemas/finding.js";
import {
  type ProfileRecord,
  type SemanticProfile,
  signatureWithoutText,
} from "./profile.js";

export type VerificationLocus = z.infer<typeof verificationLocusSchema>;

function anchorIdentity(tag: string, selector: string): string {
  return createHash("sha256").update(`${tag}\0${selector}`).digest("hex");
}

function identity(element: Pick<ObservedElement, "tag" | "selector">): string {
  return anchorIdentity(element.tag, element.selector);
}

/** Landmark elements that anchor a region by bare tag when unique in the capture. */
const LANDMARK_TAGS: ReadonlySet<string> = new Set([
  "main",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "section",
  "article",
  "dialog",
]);

/**
 * Id and stable-attribute selectors survive styling-only class repairs. The
 * attribute list mirrors `stableAttributes` in src/checks/observe.ts.
 */
function attributeAnchor(selector: string): boolean {
  return (
    selector.startsWith("#") ||
    /^[a-z][a-z0-9-]*\[(?:data-testid|data-test|data-id|name|aria-label|role)=/.test(
      selector,
    )
  );
}

function landmarkSelector(selector: string): boolean {
  return LANDMARK_TAGS.has(selector);
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
  const visibleTagCounts = new Map<string, number>();
  for (const element of visible)
    visibleTagCounts.set(
      element.tag,
      (visibleTagCounts.get(element.tag) ?? 0) + 1,
    );
  const candidates = target.ancestorSelectors.flatMap((selector) => {
    const matches = bySelector.get(selector) ?? [];
    return matches.length === 1
      ? [{ selector, element: matches[0] as ObservedElement }]
      : [];
  });
  // Prefer the nearest durable anchor of either kind; without one, keep the
  // nearest unique selector so its loss still fails closed.
  let chosen: { selector: string; element: ObservedElement } | undefined;
  for (const candidate of candidates) {
    if (attributeAnchor(candidate.selector)) {
      chosen = candidate;
      break;
    }
    const tag = candidate.element.tag;
    if (LANDMARK_TAGS.has(tag) && visibleTagCounts.get(tag) === 1) {
      chosen = { selector: tag, element: candidate.element };
      break;
    }
  }
  chosen ??= candidates[0];
  if (chosen === undefined) return undefined;
  const region = chosen.element;
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
    region: {
      selector: chosen.selector,
      signature: anchorIdentity(region.tag, chosen.selector),
    },
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
  return anchorIdentity(record.tag, record.selector);
}

/**
 * Resolves a declared region exactly first; a bare landmark-tag selector then
 * resolves to the single record with that tag, so class changes on the
 * landmark keep it resolvable. Ambiguity still throws.
 */
function regionRecord(
  profile: SemanticProfile,
  selector: string,
): ProfileRecord | undefined {
  const exact = uniqueRecord(profile, selector);
  if (exact !== undefined || !landmarkSelector(selector)) return exact;
  const matches = profile.records.filter((record) => record.tag === selector);
  if (matches.length > 1)
    throw new IdiomError(
      `verification locus selector is ambiguous: ${selector}`,
    );
  return matches[0];
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

function relativePath(root: ProfileRecord, path: string): string {
  return path === root.path ? "." : path.slice(root.path.length + 1);
}

function relativeBoundaryPaths(
  profile: SemanticProfile,
  root: ProfileRecord,
): string[] {
  return profile.reductions.boundaryPaths
    .filter((path) => path === root.path || path.startsWith(`${root.path}/`))
    .map((path) => relativePath(root, path));
}

/**
 * Boundary suppression applies to the compared pair as a unit: a subtree that
 * reaches the text boundary on any side has its text omitted on every side.
 */
function pairSuppression(
  sides: Array<[SemanticProfile, ProfileRecord]>,
): ReadonlySet<string> {
  return new Set(
    sides.flatMap(([profile, root]) => relativeBoundaryPaths(profile, root)),
  );
}

function recordsSignature(
  profile: SemanticProfile,
  root: ProfileRecord,
  includeGeometry: boolean,
  suppressed: ReadonlySet<string>,
): { signature: string; stripped: number } {
  let stripped = 0;
  const records = regionRecords(profile, root).map(
    ({ selector: _selector, path, geometry, ...record }) => {
      const relative = relativePath(root, path);
      let kept: Omit<ProfileRecord, "selector" | "path" | "geometry"> = record;
      if (suppressed.has(relative) && record.text !== undefined) {
        const { text: _text, ...rest } = record;
        kept = rest;
        stripped += 1;
      }
      return {
        ...kept,
        path: relative,
        ...(includeGeometry && geometry !== undefined ? { geometry } : {}),
      };
    },
  );
  return {
    signature: createHash("sha256")
      .update(JSON.stringify(records))
      .digest("hex"),
    stripped,
  };
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

export type PairTextSuppression = {
  /** Sorted union, relative to the compared root ("." = root); absolute for whole-tuple. */
  paths: string[];
  /** Historical records whose text was present but omitted for the pair. */
  historicalRecords: number;
  /** Current records whose text was present but omitted for the pair. */
  currentRecords: number;
};

export type LocusComparison = {
  source: "declared-locus" | "legacy-whole-tuple";
  changed: boolean;
  target: "present" | "target-absent";
  beforeSignature: string;
  afterSignature: string;
  pairTextSuppression: PairTextSuppression;
};

function compareRoots(
  options: {
    baseline: SemanticProfile;
    currentA: SemanticProfile;
    currentB: SemanticProfile;
  },
  baselineRoot: ProfileRecord,
  rootA: ProfileRecord,
  rootB: ProfileRecord,
  mismatch: string,
): {
  before: string;
  after: string;
  pairTextSuppression: PairTextSuppression;
} {
  const includeGeometry = rootsSharePosition([baselineRoot, rootA, rootB]);
  const suppressed = pairSuppression([
    [options.baseline, baselineRoot],
    [options.currentA, rootA],
    [options.currentB, rootB],
  ]);
  const before = recordsSignature(
    options.baseline,
    baselineRoot,
    includeGeometry,
    suppressed,
  );
  const afterA = recordsSignature(
    options.currentA,
    rootA,
    includeGeometry,
    suppressed,
  );
  const afterB = recordsSignature(
    options.currentB,
    rootB,
    includeGeometry,
    suppressed,
  );
  if (afterA.signature !== afterB.signature) throw new IdiomError(mismatch);
  return {
    before: before.signature,
    after: afterB.signature,
    pairTextSuppression: {
      paths: [...suppressed].sort(),
      historicalRecords: before.stripped,
      currentRecords: afterB.stripped,
    },
  };
}

export function compareFindingLocus(options: {
  finding: Finding;
  baseline: SemanticProfile;
  currentA: SemanticProfile;
  currentB: SemanticProfile;
}): LocusComparison {
  const locus = options.finding.verification.locus;
  if (locus === undefined) {
    // Locus-less visual findings compare the whole tuple; verification.params
    // is a deterministic-check concern and is deliberately ignored here.
    const suppressed = new Set(
      [options.baseline, options.currentA, options.currentB].flatMap(
        (profile) => profile.reductions.boundaryPaths,
      ),
    );
    const stripped = (profile: SemanticProfile) =>
      profile.records.filter(
        (record) => suppressed.has(record.path) && record.text !== undefined,
      ).length;
    const before = signatureWithoutText(options.baseline, suppressed);
    const after = signatureWithoutText(options.currentB, suppressed);
    return {
      source: "legacy-whole-tuple",
      changed: before !== after,
      target: "present",
      beforeSignature: before,
      afterSignature: after,
      pairTextSuppression: {
        paths: [...suppressed].sort(),
        historicalRecords: stripped(options.baseline),
        currentRecords: stripped(options.currentB),
      },
    };
  }
  const baselineRegion = regionRecord(options.baseline, locus.region.selector);
  const regionA = regionRecord(options.currentA, locus.region.selector);
  const regionB = regionRecord(options.currentB, locus.region.selector);
  const regionIdentity = (record: ProfileRecord) =>
    anchorIdentity(record.tag, locus.region.selector);
  if (
    baselineRegion === undefined ||
    regionIdentity(baselineRegion) !== locus.region.signature
  )
    throw new IdiomError(
      `historical verification region is missing or drifting: ${locus.region.selector}`,
    );
  if (regionA === undefined || regionB === undefined)
    throw new IdiomError(
      `current verification region is missing: ${locus.region.selector}`,
    );
  if (regionIdentity(regionA) !== regionIdentity(regionB))
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
  const compared = compareRoots(
    options,
    baselineRoot,
    rootA,
    rootB,
    "verification region differs between current captures",
  );
  return {
    source: "declared-locus",
    changed: compared.before !== compared.after,
    target: targetAbsent ? "target-absent" : "present",
    beforeSignature: compared.before,
    afterSignature: compared.after,
    pairTextSuppression: compared.pairTextSuppression,
  };
}
