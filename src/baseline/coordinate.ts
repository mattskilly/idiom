import type { CheckTuple } from "../checks/types.js";

export type TupleCoordinate = {
  state: string;
  viewport: string;
  colorScheme?: "light" | "dark" | undefined;
  combination?: string | undefined;
};

export function tupleCoordinate(tuple: CheckTuple): TupleCoordinate {
  return {
    state: tuple.state,
    viewport: tuple.viewport,
    ...(tuple.colorSchemeAxis ? { colorScheme: tuple.colorScheme } : {}),
    ...(tuple.combination === undefined
      ? {}
      : { combination: tuple.combination }),
  };
}

export function tupleCoordinateKey(tuple: TupleCoordinate): string {
  return `${tuple.state}/${tuple.viewport}${tuple.colorScheme === undefined ? "" : `/${tuple.colorScheme}`}${tuple.combination === undefined ? "" : `#${tuple.combination}`}`;
}
