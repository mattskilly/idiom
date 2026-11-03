import { observed } from "../findings/observation.js";
import { unavailable, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  SelectsAncestor,
} from "./types.js";

type Click = {
  selector: string;
  name: string;
  selectsAncestor: SelectsAncestor;
  row: object;
  elapsedMs?: number | undefined;
};

/**
 * A button- or link-like element whose click selected an ancestor block
 * instead of anything matching the element itself: in an editor canvas,
 * the nav link selects the whole navigation block.
 */
export const parentSelectionCheck: DeterministicCheck = {
  id: "parent-selection",
  run({ tuple }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.probe === undefined)
      return unavailable(
        this.id,
        "the interaction probe did not run (enable checks.probe or state.probe)",
      );
    const probe = observation.probe;
    const clicks: Click[] = [];
    for (const result of probe.results)
      if (result.skipped === undefined && result.selectsAncestor)
        clicks.push({
          selector: result.selector,
          name: result.name,
          selectsAncestor: result.selectsAncestor,
          row: result,
          elapsedMs: result.elapsedMs,
        });
    for (const trial of probe.selectionTrials?.trials ?? [])
      if (trial.status === "completed" && trial.selectsAncestor)
        clicks.push({
          selector: trial.selector,
          name: trial.name,
          selectsAncestor: trial.selectsAncestor,
          row: trial,
          elapsedMs: trial.elapsedMs,
        });
    // One finding per selected ancestor: the fix is one click-routing change.
    const groups = new Map<string, Click[]>();
    for (const click of clicks) {
      const key = click.selectsAncestor.ancestor;
      groups.set(key, [...(groups.get(key) ?? []), click]);
    }
    const label = (click: Click) =>
      click.name === "" ? click.selector : `“${click.name}”`;
    const candidates: FindingCandidate[] = [];
    for (const [ancestor, group] of groups) {
      const [first, ...rest] = group;
      if (first === undefined) continue;
      const { ancestorName, marker, affordance } = first.selectsAncestor;
      const look = affordance === "pointer" ? "clickable control" : affordance;
      const also =
        rest.length === 0
          ? ""
          : ` Also: ${rest
              .slice(0, 3)
              .map(label)
              .join(
                ", ",
              )}${rest.length > 3 ? ` and ${rest.length - 3} more` : ""}.`;
      candidates.push({
        observation: observed(
          {
            source: "probe-click",
            kind: "click",
            selector: first.selector,
            name: first.name,
          },
          first.row,
          first.elapsedMs === undefined
            ? undefined
            : { elapsedMs: first.elapsedMs },
        ),
        category: this.id,
        severity: "major",
        rule: "idiom:control-selects-parent",
        selectorHint: first.selector,
        fingerprintHint: `idiom:control-selects-parent|${ancestor}`,
        explanation: `Clicking ${label(first)} (${first.selector}), which looks like a ${look}, selected its ancestor ${ancestorName} (${ancestor}, ${marker}) instead of the control itself; focus and selection did not move to ${label(first)}.${also}`,
        acceptance: [
          `Clicking ${label(first)} selects or activates ${label(first)} itself (or moves focus to its editor), not ${ancestor}.`,
        ],
        verification: verify(this.id, { selector: first.selector }),
      });
    }
    const reasons = [
      probe.status === "ran" ? undefined : probe.reason,
      probe.selectionTrials?.status === "partial"
        ? probe.selectionTrials.reason
        : undefined,
    ].filter((reason): reason is string => Boolean(reason));
    return {
      coverage:
        reasons.length > 0
          ? { check: this.id, status: "ran", reason: reasons.join("; ") }
          : { check: this.id, status: "ran" },
      candidates,
    };
  },
};
