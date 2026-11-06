// No imports: the launcher loads this before anything else, so it must run on any Node old enough to parse it.

export const MINIMUM_NODE_MAJOR = 22;
export const MINIMUM_NODE_MINOR = 12;
export const MINIMUM_NODE = `${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}`;

export const NODE_UPGRADE_HINT = `Install Node ${MINIMUM_NODE}+ (https://nodejs.org) and run again.`;

/**
 * Returns the message for a Node too old to run Idiom, or undefined when the
 * version is new enough. Only the leading major.minor is read, so prerelease
 * suffixes don't matter. An unreadable version string (or minor) passes:
 * refusing to start over it would be worse than the error the gate exists to
 * replace.
 */
export function nodeVersionProblem(version: string): string | undefined {
  const parsed = /^(\d+)(?:\.(\d+))?/.exec(version);
  if (parsed === null) return undefined;
  const major = Number(parsed[1]);
  if (major > MINIMUM_NODE_MAJOR) return undefined;
  if (
    major === MINIMUM_NODE_MAJOR &&
    (parsed[2] === undefined || Number(parsed[2]) >= MINIMUM_NODE_MINOR)
  )
    return undefined;
  return `Idiom needs Node ${MINIMUM_NODE} or newer; this is Node ${version}. ${NODE_UPGRADE_HINT}`;
}
