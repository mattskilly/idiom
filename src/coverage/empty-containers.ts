import type {
  CheckTuple,
  RepeatedContainerObservation,
} from "../checks/types.js";

export type AlwaysEmptyContainer = {
  selector: string;
  kind: RepeatedContainerObservation["kind"];
  name: string;
  /** State labels the container was captured empty in, in flow order. */
  states: string[];
};

/**
 * Lists, grids, tables, feeds and editors on captured surfaces, and which of
 * them never held an item in any captured state. A container only ever seen
 * empty is one no check has seen filled: seed data so the flow shows it.
 */
export type EmptyContainerCoverage =
  | { status: "unavailable"; reason: string }
  | {
      status: "ran";
      total: number;
      populated: number;
      alwaysEmpty: AlwaysEmptyContainer[];
    };

type ContainerTuple = Pick<CheckTuple, "state" | "observations">;

const EMPTY_SHOWN = 10;

export function computeEmptyContainerCoverage(
  tuples: readonly ContainerTuple[],
  stateLabels: Readonly<Record<string, string>> = {},
): EmptyContainerCoverage {
  const observed = tuples.flatMap((tuple) =>
    tuple.observations?.version === 2 &&
    (tuple.observations.elements?.length ?? 0) > 0
      ? [{ tuple, observations: tuple.observations }]
      : [],
  );
  if (observed.length === 0)
    return { status: "unavailable", reason: "no captured surfaces" };
  if (observed.some(({ observations }) => !observations.repeatedContainers))
    return {
      status: "unavailable",
      reason: "capture predates the container inventory; recapture",
    };
  type Group = {
    container: RepeatedContainerObservation;
    states: string[];
    filled: boolean;
  };
  const groups = new Map<string, Group>();
  for (const { tuple, observations } of observed)
    for (const container of observations.repeatedContainers ?? []) {
      const key = `${container.kind}\0${container.selector}`;
      const group = groups.get(key) ?? { container, states: [], filled: false };
      groups.set(key, group);
      if (container.items > 0) group.filled = true;
      else {
        const label = stateLabels[tuple.state] ?? tuple.state;
        if (!group.states.includes(label)) group.states.push(label);
      }
      if (!group.container.name && container.name) group.container = container;
    }
  const alwaysEmpty = [...groups.values()]
    .filter((group) => !group.filled)
    .map(({ container, states }) => ({
      selector: container.selector,
      kind: container.kind,
      name: container.name,
      states,
    }));
  return {
    status: "ran",
    total: groups.size,
    populated: groups.size - alwaysEmpty.length,
    alwaysEmpty,
  };
}

/** Text lines shared by `idiom coverage`, `--states` and the report. */
export function emptyContainerCoverageLines(
  coverage: EmptyContainerCoverage,
): string[] {
  if (coverage.status === "unavailable")
    return [`Repeated content: unavailable (${coverage.reason}).`];
  const head = `Repeated content: ${coverage.populated} of ${coverage.total} containers showed items${coverage.alwaysEmpty.length === 0 ? "." : "; empty in every captured state (seed data so the checks see them filled):"}`;
  return [
    head,
    ...coverage.alwaysEmpty
      .slice(0, EMPTY_SHOWN)
      .map(
        (entry) =>
          `- ${entry.name || entry.selector} (${entry.kind}; empty in ${entry.states.join(", ")})`,
      ),
    ...(coverage.alwaysEmpty.length > EMPTY_SHOWN
      ? [`- +${coverage.alwaysEmpty.length - EMPTY_SHOWN} more`]
      : []),
  ];
}
