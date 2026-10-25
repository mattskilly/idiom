import { ran, unavailable, verify } from "./shared.js";
import type { DeterministicCheck, FindingCandidate } from "./types.js";

function describe(signature: string): string {
  if (signature.startsWith("open:"))
    return `opens ${signature
      .slice("open:".length)
      .split("|")
      .map((region) => {
        const [role, ...name] = region.split(":");
        const label = name.join(":").trim();
        return label === "" ? `a ${role}` : `the "${label}" ${role}`;
      })
      .join(" and ")}`;
  if (signature.startsWith("focus:"))
    return `moves focus to ${signature.slice("focus:".length).split(":").slice(1).join(":") || "the same field"}`;
  return signature;
}

/**
 * Two or more persistent controls in one view that lead to the same place.
 * Idiom does not pick the survivor: it lists every location so a human can
 * record which entry point is canonical (as a rule override or decision).
 * A control is identified by its location (selector and region), not its
 * accessible name, so two "Page settings" gears in different places are two
 * entry points. Moving focus counts as a destination only when it is each
 * control's sole effect; focus that follows another effect is a side effect.
 */
export const duplicateEntryCheck: DeterministicCheck = {
  id: "duplicate-entry",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.probe === undefined)
      return unavailable(
        this.id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      );
    const groups = new Map<string, typeof observation.probe.results>();
    for (const result of observation.probe.results) {
      const signature = result.signature;
      if (signature === undefined || result.skipped !== undefined) continue;
      // Per-row actions ("Edit" on every card) are a pattern, not entry points.
      if (result.repeated === true) continue;
      if (!signature.startsWith("open:") && !signature.startsWith("focus:"))
        continue;
      // Older artifacts carry no `primary`; they keep the legacy grouping.
      if (signature.startsWith("focus:") && result.primary === true) continue;
      if (/(?:^|\|)(?:tooltip|menu|listbox):/.test(signature.slice(5)))
        continue;
      groups.set(signature, [...(groups.get(signature) ?? []), result]);
    }
    const candidates: FindingCandidate[] = [];
    for (const [signature, members] of groups) {
      const distinct = [
        ...new Map(
          members.map((member) => [
            `${member.selector}\u0000${member.region ?? ""}`,
            member,
          ]),
        ).values(),
      ];
      if (distinct.length < 2) continue;
      const locations = distinct
        .map(
          (member) =>
            `"${member.name || member.selector}" (${member.selector}${member.region === undefined ? "" : `, in ${member.region}`}${member.persistent ? "" : ", in a menu"})`,
        )
        .join("; ");
      const first = distinct[0];
      if (first === undefined) continue;
      candidates.push({
        category: this.id,
        severity: "minor",
        rule: "idiom:redundant-entry-point",
        selectorHint: first.selector,
        explanation: `${distinct.length} controls in this view each ${describe(signature)}: ${locations}. Choose the canonical entry point; the others compete for attention or disguise themselves.`,
        acceptance: [
          `One persistent control ${describe(signature)}, or the extra entry points are recorded as deliberate (for example a shortcut).`,
        ],
        verification: verify(this.id, { signature }),
      });
    }
    return ran(this.id, candidates);
  },
};
