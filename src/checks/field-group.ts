import { ran, relation, round, unavailable, verify } from "./shared.js";
import type {
  DeterministicCheck,
  FieldGroupMember,
  FieldGroupObservation,
  FindingCandidate,
  ObservedElementV2,
  Rect,
} from "./types.js";

function union(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const clip = (text: string, length = 40) => {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > length ? `${trimmed.slice(0, length - 1)}…` : trimmed;
};

/**
 * A label, its control and the helper text after it read as one unit only
 * when they sit close together and further from the next unit: members need
 * `fieldGroups.inner` between them and groups need `fieldGroups.between`.
 */
export const fieldGroupCheck: DeterministicCheck = {
  id: "field-group",
  run({ tuple, config }) {
    const observation = tuple.observations;
    if (observation === undefined)
      return unavailable(this.id, "observations.json is unavailable");
    if (observation.version !== 2 || observation.fieldGroups === undefined)
      return unavailable(
        this.id,
        "observations predate field-group signals (recapture)",
      );
    const bySelector = new Map(
      observation.elements.map((element) => [element.selector, element]),
    );
    const { inner, between } = config.fieldGroups;
    const nameOf = (group: FieldGroupObservation) => {
      const label = group.members.find((member) => member.role === "label");
      const element =
        label === undefined ? undefined : bySelector.get(label.selector);
      return clip(element?.directText || element?.text || group.container);
    };
    const describe = (member: FieldGroupMember) => {
      const element: ObservedElementV2 | undefined = bySelector.get(
        member.selector,
      );
      if (member.role === "label") return `the label ${member.selector}`;
      if (member.role === "control")
        return `its ${element?.tag ?? "control"} ${member.selector}`;
      const text = clip(element?.text ?? "", 24);
      return text === ""
        ? `the helper ${member.selector}`
        : `the "${text}" helper (${member.selector})`;
    };
    const candidates: FindingCandidate[] = [];
    for (const group of observation.fieldGroups) {
      const name = nameOf(group);
      for (let index = 1; index < group.members.length; index += 1) {
        const first = group.members[index - 1] as FieldGroupMember;
        const second = group.members[index] as FieldGroupMember;
        const related = relation(first.rect, second.rect);
        // Negative gaps beyond a hairline are overlaps: element-overlap's.
        if (related === undefined || related.gap >= inner || related.gap < -1.5)
          continue;
        const gap = round(Math.max(0, related.gap));
        candidates.push({
          category: this.id,
          severity: related.gap <= 0.5 ? "major" : "minor",
          rule: "idiom:field-group-inner-gap",
          selectorHint: second.selector,
          fingerprintHint: `${first.selector} | ${second.selector}`,
          explanation: `In the "${name}" group, ${describe(second)} sits ${gap}px ${related.axis === "vertical" ? "below" : "beside"} ${describe(first)}; members of a field group need at least ${inner}px.`,
          acceptance: [
            `${first.selector} and ${second.selector} are at least ${inner}px apart.`,
          ],
          verification: verify(this.id, {
            selector: second.selector,
            neighbour: first.selector,
            gap,
            minimum: inner,
          }),
        });
      }
    }
    const groups = observation.fieldGroups.filter(
      (group) => group.members.length > 0,
    );
    const previousByRegion = new Map<string, FieldGroupObservation>();
    for (const second of groups) {
      const first = previousByRegion.get(second.region);
      previousByRegion.set(second.region, second);
      if (first === undefined) continue;
      const related = relation(
        union(first.members.map((member) => member.rect)),
        union(second.members.map((member) => member.rect)),
      );
      if (related === undefined || related.gap >= between || related.gap < -1.5)
        continue;
      const gap = round(Math.max(0, related.gap));
      const firstSelector = (first.members[0] as FieldGroupMember).selector;
      const secondSelector = (second.members[0] as FieldGroupMember).selector;
      candidates.push({
        category: this.id,
        severity: related.gap <= 0.5 ? "major" : "minor",
        rule: "idiom:field-group-between-gap",
        selectorHint: secondSelector,
        fingerprintHint: `${firstSelector} | ${secondSelector}`,
        explanation: `The "${nameOf(second)}" field group sits ${gap}px ${related.axis === "vertical" ? "below" : "beside"} the "${nameOf(first)}" group; separate field groups need at least ${between}px between them, more than the ${inner}px inside a group.`,
        acceptance: [
          `The "${nameOf(first)}" and "${nameOf(second)}" field groups are at least ${between}px apart.`,
        ],
        verification: verify(this.id, {
          selector: secondSelector,
          neighbour: firstSelector,
          gap,
          minimum: between,
        }),
      });
    }
    return ran(this.id, candidates);
  },
};
