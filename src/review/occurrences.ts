export type Occurrence = {
  key: string;
  fingerprint: string;
  aliases: string[];
};

/** IDs are run-local presentation; identity is an alias at an exact coordinate. */
export function sameOccurrence(left: Occurrence, right: Occurrence): boolean {
  return (
    left.key === right.key &&
    [left.fingerprint, ...left.aliases].some((identity) =>
      [right.fingerprint, ...right.aliases].includes(identity),
    )
  );
}

export function compareOccurrences<T extends Occurrence>(
  before: T[],
  after: T[],
) {
  return {
    fixed: before.filter(
      (item) => !after.some((other) => sameOccurrence(item, other)),
    ),
    stillOpen: after.filter((item) =>
      before.some((other) => sameOccurrence(item, other)),
    ),
    introduced: after.filter(
      (item) => !before.some((other) => sameOccurrence(item, other)),
    ),
  };
}
