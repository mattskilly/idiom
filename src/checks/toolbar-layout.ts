import { defaultChecksSettings } from "../schemas/project.js";
import {
  round,
  scanResult,
  skipped,
  unavailable,
  v2Observations,
  verify,
} from "./shared.js";
import type {
  DeterministicCheck,
  FindingCandidate,
  ToolbarControlObservation,
  ToolbarItemObservation,
  ToolbarLayoutObservation,
  ToolbarLayoutScope,
} from "./types.js";

const WRAP = "idiom:toolbar-wrap";
const OFF_CENTRE = "idiom:toolbar-off-centre";
const ODD_CONTROL = "idiom:toolbar-odd-control";

/** Heights within this many px of each other are the same height. */
const HEIGHT_TOLERANCE = 1;

const quoted = (item: { selector: string; text: string }) =>
  item.text === "" ? item.selector : `${item.selector} ("${item.text}")`;

/**
 * The centre most of a row's items share within the tolerance (the plurality
 * cluster), or the midpoint of the row's line box when no cluster is largest.
 */
export function rowReference(
  items: ReadonlyArray<
    Pick<ToolbarItemObservation, "centre" | "top" | "height">
  >,
  tolerance: number,
): number {
  const near = (a: number, b: number) => Math.abs(a - b) <= tolerance;
  const counts = items.map(
    (item) => items.filter((other) => near(other.centre, item.centre)).length,
  );
  const best = Math.max(...counts);
  const leaders = items.filter((_, index) => counts[index] === best);
  const tie = leaders.some((a) =>
    leaders.some((b) => !near(a.centre, b.centre)),
  );
  if (!tie) {
    // The leader closest to the rest of its cluster; the first on a draw.
    const spread = (centre: number) =>
      items
        .filter((other) => near(other.centre, centre))
        .reduce((sum, other) => sum + Math.abs(other.centre - centre), 0);
    return leaders.reduce((chosen, leader) =>
      spread(leader.centre) < spread(chosen.centre) ? leader : chosen,
    ).centre;
  }
  const top = Math.min(...items.map((item) => item.top));
  const bottom = Math.max(...items.map((item) => item.top + item.height));
  return (top + bottom) / 2;
}

/** Items whose centre sits more than the tolerance from their row's reference; positive offsets sit low. */
export function offCentreItems(
  items: readonly ToolbarItemObservation[],
  tolerance: number,
): Array<{ item: ToolbarItemObservation; offset: number }> {
  const rows = new Map<number, ToolbarItemObservation[]>();
  for (const item of items)
    rows.set(item.row, [...(rows.get(item.row) ?? []), item]);
  return [...rows.values()].flatMap((row) => {
    if (row.length < 2) return [];
    const reference = rowReference(row, tolerance);
    return row.flatMap((item) => {
      const offset = round(item.centre - reference);
      return Math.abs(offset) > tolerance ? [{ item, offset }] : [];
    });
  });
}

export type OddControl = {
  control: ToolbarControlObservation;
  property: "border" | "radius" | "height";
  value: string | number;
  siblings: string | number;
};

/**
 * Per property, the one control whose value differs from every sibling while
 * the siblings agree with each other. Needs at least three controls with a value.
 */
export function oddControls(
  controls: readonly ToolbarControlObservation[],
): OddControl[] {
  const found: OddControl[] = [];
  const compare = <T extends string | number>(
    property: OddControl["property"],
    read: (control: ToolbarControlObservation) => T | undefined,
    same: (a: T, b: T) => boolean,
    shared: (values: T[]) => T,
  ) => {
    const valued = controls.flatMap((control) => {
      const value = read(control);
      return value === undefined ? [] : [{ control, value }];
    });
    if (valued.length < 3) return;
    for (const candidate of valued) {
      const others = valued
        .filter((other) => other !== candidate)
        .map(({ value }) => value);
      const agree = others.every((a) => others.every((b) => same(a, b)));
      if (!agree) continue;
      const siblings = shared(others);
      if (same(candidate.value, siblings)) continue;
      found.push({
        control: candidate.control,
        property,
        value: candidate.value,
        siblings,
      });
    }
  };
  const first = <T>(values: T[]) => values[0] as T;
  compare(
    "border",
    (c) => c.border,
    (a, b) => a === b,
    first,
  );
  compare(
    "radius",
    (c) => c.radius,
    (a, b) => a === b,
    first,
  );
  compare(
    "height",
    (c) => c.height,
    (a, b) => Math.abs(a - b) <= HEIGHT_TOLERANCE,
    (values) => round(values.reduce((sum, v) => sum + v, 0) / values.length),
  );
  return found;
}

const describe = (property: OddControl["property"], value: string | number) =>
  property === "border"
    ? value === "none"
      ? "no border"
      : `a ${value} border`
    : `${property} ${value}px`;

/** A toolbar on more than one row, controls off its row's centre, or one control unlike its siblings. */
export const toolbarLayoutCheck: DeterministicCheck = {
  id: "toolbar-layout",
  run({ tuple, config }) {
    const settings =
      config.toolbarLayout ?? defaultChecksSettings.toolbarLayout;
    if (!settings.enabled) return skipped(this.id, "toolbarLayout");
    const scan = v2Observations(tuple)?.toolbarLayouts;
    if (scan === undefined)
      return unavailable(
        this.id,
        "observations predate the toolbar-layout scan (recapture)",
      );
    const scopes = settings.scopes ?? [];
    const lawsFor = (
      record: ToolbarLayoutObservation,
      law: ToolbarLayoutScope["law"],
    ) =>
      scopes.filter(
        (scope) =>
          scope.law === law && record.scopes?.includes(scope.selector) === true,
      );
    const cite = (scope: ToolbarLayoutScope | undefined) =>
      scope === undefined
        ? ""
        : ` (law: "${scope.name}", in ${scope.selector})`;
    const width = tuple.width;
    const candidates: FindingCandidate[] = scan.records.flatMap((record) => {
      const found: FindingCandidate[] = [];
      const toolbar = record.toolbar;
      if (!record.vertical && record.rows > 1) {
        const law = lawsFor(record, "one-row")[0];
        const wrapped = record.items.filter((item) => item.row > 0);
        const named = wrapped.map(
          (item) => `${quoted(item)} sits on row ${item.row + 1}`,
        );
        found.push({
          category: this.id,
          severity: "major",
          rule: WRAP,
          selectorHint: toolbar,
          fingerprintHint: `toolbar-wrap:${toolbar}`,
          explanation: `${toolbar} wraps to ${record.rows} rows at ${width}px: ${named.join("; ")}; the toolbar is ${round(record.height)}px tall against ${round(record.singleRowHeight)}px on one row${cite(law)}.`,
          acceptance: [
            `At ${width}px, every control in ${toolbar} sits on one row and the toolbar is ${round(record.singleRowHeight)}px tall.`,
          ],
          verification: verify(this.id, {
            selector: toolbar,
            wrapped: wrapped.map((item) => item.selector),
            height: round(record.height),
            singleRowHeight: round(record.singleRowHeight),
            rows: record.rows,
            viewportWidth: width,
            ...(law === undefined ? {} : { scope: law.selector }),
          }),
        });
      }
      if (!record.vertical) {
        // The strictest learned centring law for this toolbar overrides the default.
        const law = lawsFor(record, "centred").reduce<
          ToolbarLayoutScope | undefined
        >(
          (strictest, scope) =>
            strictest === undefined ||
            (scope.tolerance ?? settings.centreTolerance) <
              (strictest.tolerance ?? settings.centreTolerance)
              ? scope
              : strictest,
          undefined,
        );
        const tolerance = law?.tolerance ?? settings.centreTolerance;
        for (const { item, offset } of offCentreItems(
          record.items,
          tolerance,
        )) {
          const direction =
            offset < 0 ? `${round(-offset)}px high` : `${round(offset)}px low`;
          found.push({
            category: this.id,
            severity: "minor",
            rule: OFF_CENTRE,
            selectorHint: toolbar,
            fingerprintHint: `toolbar-off-centre:${toolbar}:${item.selector}`,
            explanation: `In ${toolbar}, ${quoted(item)} sits ${direction} of row ${item.row + 1}'s centre at ${width}px; toolbar controls share a vertical centre within ${tolerance}px${cite(law)}.`,
            acceptance: [
              `At ${width}px, ${item.selector} in ${toolbar} is vertically centred with the other controls on its row, within ${tolerance}px.`,
            ],
            verification: verify(this.id, {
              selector: toolbar,
              item: item.selector,
              offset,
              tolerance,
              row: item.row + 1,
              viewportWidth: width,
              ...(law === undefined ? {} : { scope: law.selector }),
            }),
          });
        }
      }
      for (const odd of oddControls(record.controls)) {
        const control = odd.control;
        found.push({
          category: this.id,
          severity: "minor",
          rule: ODD_CONTROL,
          selectorHint: toolbar,
          fingerprintHint: `toolbar-odd-control:${toolbar}:${odd.property}:${control.selector}`,
          explanation: `In ${toolbar}, ${quoted(control)} has ${describe(odd.property, odd.value)} where every sibling control has ${describe(odd.property, odd.siblings)} at ${width}px.`,
          acceptance: [
            `At ${width}px, ${control.selector} in ${toolbar} matches its sibling controls' ${odd.property}.`,
          ],
          verification: verify(this.id, {
            selector: toolbar,
            control: control.selector,
            property: odd.property,
            value: odd.value,
            siblings: odd.siblings,
            viewportWidth: width,
          }),
        });
      }
      return found;
    });
    return scanResult(this.id, candidates, scan);
  },
};
