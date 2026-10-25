import { createHash } from "node:crypto";
import {
  type EffectiveInvariant,
  type GroupInvariant,
  groupBasis,
  groupValue,
  invariantLabel,
  isGroupInvariant,
} from "../schemas/invariant.js";
import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

/** Declaration identity excludes captured values, item order and array position. */
function identity(
  d: GroupInvariant,
  origin: EffectiveInvariant["origin"],
): string {
  const canonical = {
    scope: origin.scope,
    id: origin.id,
    name: d.name ?? null,
    optional: d.optional,
    group: d.group,
    items: d.items,
    owner: d.owner ?? null,
    attribute: d.attribute ?? null,
    text: d.text ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 20);
}

const listed = (labels: string[], cap = 10): string =>
  labels.length > cap
    ? `${labels.slice(0, cap).join(", ")} and ${labels.length - cap} more`
    : labels.join(", ");

export const groupInvariantsCheck: DeterministicCheck = {
  id: "group-invariants",
  run({ tuple }) {
    const observations = tuple.observations;
    if (observations?.version !== 2 || observations.invariants === undefined)
      return unavailable(
        this.id,
        "group invariant evidence is unavailable; recapture to measure declared invariants",
      );
    const candidates: FindingCandidate[] = [];
    for (const assertion of observations.invariants) {
      const { declaration: d, selectors } = assertion;
      if (!isGroupInvariant(d)) continue;
      const label = invariantLabel(assertion);
      const key = identity(d, assertion.origin);
      const basis = groupBasis(d);
      const emit = (
        suffix: string,
        explanation: string,
        selector: string,
        acceptance: string,
        measured?: unknown,
      ) => {
        candidates.push({
          category: this.id,
          severity: "major",
          rule: `idiom:group-invariants:${suffix}:${key}`,
          selectorHint: selector,
          explanation,
          acceptance: [acceptance],
          verification: verify(this.id, {
            selector,
            invariant: d,
            origin: assertion.origin,
            measured,
          }),
        });
      };
      const satisfy = `Satisfy ${label}: ${JSON.stringify(d)}.`;
      const missing = selectors
        .filter(({ matches }) => matches.length === 0)
        .sort((a, b) => a.selector.localeCompare(b.selector));
      if (missing.length > 0) {
        if (!d.optional)
          emit(
            "missing-selector",
            `${label}: required selector${missing.length > 1 ? "s" : ""} matched no elements: ${missing.map(({ selector }) => selector).join(", ")}`,
            missing[0]?.selector ?? "document",
            satisfy,
          );
        continue;
      }
      if (d.owner !== undefined) {
        const owners =
          selectors.find(({ selector }) => selector === d.owner)?.matches ?? [];
        if (owners.length !== 1) {
          emit(
            "ambiguous-owner",
            `${label}: owner ${d.owner} matched ${owners.length} elements (expected exactly one)`,
            owners[0]?.selector ?? d.owner,
            satisfy,
            { count: owners.length },
          );
          continue;
        }
      }
      for (const group of assertion.groups ?? []) {
        const owner = group.owner;
        const ownerValue = owner === null ? null : groupValue(d, owner.value);
        if (owner === null || ownerValue === null) {
          const ownerSelector = owner?.selector ?? d.owner ?? group.list;
          emit(
            "owner-value",
            `${label}: owner ${ownerSelector} has no ${d.attribute === undefined ? `match for ${basis}` : basis}, so membership of ${group.list} cannot be judged`,
            ownerSelector,
            `Give the owner of ${d.group} a ${basis} value (${label}).`,
            { owner: owner?.value ?? null },
          );
          continue;
        }
        const strays = group.items.filter(
          (item) => groupValue(d, item.value) !== ownerValue,
        );
        if (strays.length === 0) continue;
        const described = strays.map(({ label: name, value }) => {
          const own = groupValue(d, value);
          return `"${name}" (${own === null ? "no value" : own})`;
        });
        emit(
          "stray",
          `${label}: ${strays.length} item${strays.length === 1 ? "" : "s"} in ${group.list} do not share ${basis} "${ownerValue}": ${listed(described)}`,
          group.list,
          `Every item matching ${d.items} inside ${d.group} shares the owner's ${basis} (${label}); move or remove: ${listed(strays.map(({ label: name }) => `"${name}"`))}.`,
          {
            owner: ownerValue,
            strays: strays.map(({ selector, label: name, value }) => ({
              selector,
              label: name,
              value,
            })),
          },
        );
      }
    }
    return ran(this.id, candidates);
  },
};
