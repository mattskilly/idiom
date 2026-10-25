import type {
  CheckTuple,
  InvariantObservation,
  ObservationArtifactV2,
  Rect,
} from "../src/checks/types.js";
import {
  effectiveInvariants,
  type InvariantInput,
  invariantSchema,
  invariantSelectors,
} from "../src/schemas/invariant.js";

export function invariantEvidence(
  inputs: InvariantInput[],
  boxes: Record<string, Array<Partial<Rect>>> = {},
): InvariantObservation[] {
  return effectiveInvariants(
    {
      id: "studio",
      invariants: inputs.map((input) => invariantSchema.parse(input)),
    },
    { id: "editor" },
  ).map((assertion) => ({
    ...assertion,
    selectors: invariantSelectors(assertion.declaration).map((selector) => ({
      selector,
      matches: (boxes[selector] ?? []).map((rect, index) => ({
        selector: `${selector}:nth-of-type(${index + 1})`,
        rect: { x: 0, y: 48, width: 320, height: 64, ...rect },
      })),
    })),
  }));
}
export function invariantObservations(
  invariants?: InvariantObservation[],
): ObservationArtifactV2 {
  return {
    version: 2,
    viewport: { width: 800, height: 600 },
    document: {
      scrollWidth: 800,
      scrollHeight: 600,
      clientWidth: 800,
      clientHeight: 600,
    },
    elements: [],
    headings: [],
    maskMembership: [],
    tokens: { status: "not-configured" },
    ...(invariants === undefined ? {} : { invariants }),
  };
}
export function invariantTuple(
  observations = invariantObservations(),
): CheckTuple {
  return {
    flow: "studio",
    state: "editor",
    viewport: "desktop",
    colorScheme: "dark",
    width: 800,
    height: 600,
    metadataPath: "editor/desktop/metadata.json",
    artifactPaths: ["editor/desktop/observations.json"],
    commit: "fixture",
    createdAt: "2026-10-22T00:00:00.000Z",
    observations,
    console: [],
    mismatches: [],
  };
}

type GroupList = NonNullable<InvariantObservation["groups"]>[number];
/**
 * Evidence for one group declaration: each list is `[ownerValue, items]`
 * where items are `[label, value]`; `owner: null` models an owner selector
 * that did not match exactly one element. `ownerMatches` sets how many
 * elements a declared owner selector matched.
 */
export function groupEvidence(
  input: InvariantInput,
  lists: Array<{
    owner?: string | null | { value: string | null };
    items: Array<[string, string | null]>;
  }>,
  ownerMatches = 1,
): InvariantObservation {
  const [assertion] = invariantEvidence([input]);
  if (assertion === undefined || !("group" in assertion.declaration))
    throw new Error("groupEvidence needs a group declaration");
  const d = assertion.declaration;
  const groups: GroupList[] = lists.map(({ owner, items }, index) => {
    const list = `${d.group}:nth-of-type(${index + 1})`;
    return {
      list,
      owner:
        owner === null
          ? null
          : {
              selector: d.owner ?? list,
              value:
                owner === undefined
                  ? null
                  : typeof owner === "string"
                    ? owner
                    : owner.value,
            },
      items: items.map(([label, value], item) => ({
        selector: `${list} > a:nth-of-type(${item + 1})`,
        label,
        value,
      })),
    };
  });
  return {
    ...assertion,
    selectors: assertion.selectors.map(({ selector }) => {
      const count =
        selector === d.owner
          ? ownerMatches
          : selector === d.group
            ? lists.length
            : 0;
      return {
        selector,
        matches: Array.from({ length: count }, (_, index) => ({
          selector: `${selector}:nth-of-type(${index + 1})`,
          rect: { x: 0, y: 0, width: 100, height: 20 },
        })),
      };
    }),
    groups,
  };
}
