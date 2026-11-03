import type {
  CheckTuple,
  DisclosureObservation,
  ProbeResult,
} from "../checks/types.js";

export type UnopenedDisclosure = {
  state: string;
  label?: string | undefined;
  name: string;
  kind: DisclosureObservation["kind"];
  selector: string;
  reason: string;
};

/**
 * Disclosures (details, popups, expanders) present on captured surfaces and
 * whether any flow state showed them open or the probe opened them. A
 * disclosure nobody opened hides a state no check has seen.
 */
export type DisclosureCoverage =
  | { status: "unavailable"; reason: string }
  | {
      status: "ran";
      total: number;
      opened: number;
      unopened: UnopenedDisclosure[];
    };

type DisclosureTuple = Pick<CheckTuple, "state" | "observations">;

const UNOPENED_SHOWN = 10;

function matches(result: ProbeResult, disclosure: DisclosureObservation) {
  return (
    result.selector === disclosure.path ||
    (disclosure.id !== undefined && result.selector === disclosure.id)
  );
}

function notOpenedReason(result: ProbeResult): string {
  if (result.skipped) return result.skipped;
  if (result.status === "timed-out") return "timed out";
  if (result.status === "not-reached") return "not reached";
  return "the click opened nothing";
}

export function computeDisclosureCoverage(
  tuples: readonly DisclosureTuple[],
  stateLabels: Readonly<Record<string, string>> = {},
): DisclosureCoverage {
  const observed = tuples.flatMap((tuple) =>
    tuple.observations?.version === 2 &&
    (tuple.observations.elements?.length ?? 0) > 0
      ? [{ tuple, observations: tuple.observations }]
      : [],
  );
  if (observed.length === 0)
    return { status: "unavailable", reason: "no captured surfaces" };
  if (observed.some(({ observations }) => !observations.disclosures))
    return {
      status: "unavailable",
      reason: "capture predates the disclosure inventory; recapture",
    };
  const shownOpen = new Set<string>();
  for (const { observations } of observed)
    for (const disclosure of observations.disclosures ?? [])
      if (disclosure.open)
        shownOpen.add(`${disclosure.kind}\0${disclosure.name}`);
  type Group = {
    state: string;
    disclosure: DisclosureObservation;
    results: ProbeResult[];
    probed: boolean;
  };
  const groups = new Map<string, Group>();
  for (const { tuple, observations } of observed) {
    const probe = observations.probe;
    for (const disclosure of observations.disclosures ?? []) {
      const key = [
        tuple.state,
        disclosure.kind,
        disclosure.name,
        disclosure.path,
      ].join("\0");
      const group = groups.get(key) ?? {
        state: tuple.state,
        disclosure,
        results: [],
        probed: false,
      };
      groups.set(key, group);
      if (probe === undefined) continue;
      group.probed = true;
      group.results.push(
        ...probe.results.filter((result) => matches(result, disclosure)),
      );
    }
  }
  let opened = 0;
  const unopened: UnopenedDisclosure[] = [];
  for (const group of groups.values()) {
    const { disclosure } = group;
    const done = group.results.some(
      (result) =>
        (result.status === undefined || result.status === "completed") &&
        !result.skipped &&
        result.effects.length > 0,
    );
    if (
      done ||
      disclosure.open ||
      shownOpen.has(`${disclosure.kind}\0${disclosure.name}`)
    ) {
      opened += 1;
      continue;
    }
    const result = group.results[0];
    const label = stateLabels[group.state];
    unopened.push({
      state: group.state,
      ...(label === undefined || label === group.state ? {} : { label }),
      name: disclosure.name,
      kind: disclosure.kind,
      selector: disclosure.selector,
      reason:
        result !== undefined
          ? notOpenedReason(result)
          : group.probed
            ? "no probe result for this control"
            : "the probe did not run at this state",
    });
  }
  return { status: "ran", total: groups.size, opened, unopened };
}

/** Text lines shared by `idiom coverage`, `--states` and the report. */
export function disclosureCoverageLines(
  coverage: DisclosureCoverage,
): string[] {
  if (coverage.status === "unavailable")
    return [`Disclosures: unavailable (${coverage.reason}).`];
  const head = `Disclosures: ${coverage.opened} of ${coverage.total} opened${coverage.unopened.length === 0 ? "." : "; never opened:"}`;
  return [
    head,
    ...coverage.unopened
      .slice(0, UNOPENED_SHOWN)
      .map(
        (entry) =>
          `- ${entry.label ?? entry.state} › ${entry.name || entry.selector} (${entry.kind}; ${entry.reason})`,
      ),
    ...(coverage.unopened.length > UNOPENED_SHOWN
      ? [`- +${coverage.unopened.length - UNOPENED_SHOWN} more`]
      : []),
  ];
}
