/**
 * The one way Idiom warns about a deprecated surface at runtime. Every
 * runtime deprecation goes through `warnDeprecated` so the message is
 * consistent, goes to stderr only (never stdout, so never inside a `--json`
 * payload), prints at most once per process per surface, and can be silenced
 * with one environment variable. See docs/stability.md, "Deprecation policy".
 */

/** Set to any non-empty value except `0` to silence deprecation warnings. */
export const DEPRECATION_SILENCE_ENV = "IDIOM_NO_DEPRECATION_WARNINGS";

export interface Deprecation {
  /** Stable key and display name, e.g. `idiom brief list --json --array`. */
  surface: string;
  /** What to use instead. */
  replacement: string;
  /** The release that removes the surface, e.g. `0.24.0`. */
  removedIn: string;
}

const warned = new Set<string>();

export function deprecationMessage(deprecation: Deprecation): string {
  return `Deprecated: ${deprecation.surface} will be removed in ${deprecation.removedIn}; use ${deprecation.replacement} instead. Set ${DEPRECATION_SILENCE_ENV}=1 to silence this warning.`;
}

export function deprecationWarningsSilenced(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[DEPRECATION_SILENCE_ENV];
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Writes the deprecation warning through `writeStderr` unless silenced or
 * already written for this surface in this process. Returns true when it
 * wrote. A silenced call does not mark the surface as warned.
 */
export function warnDeprecated(
  deprecation: Deprecation,
  writeStderr: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (deprecationWarningsSilenced(env)) return false;
  if (warned.has(deprecation.surface)) return false;
  warned.add(deprecation.surface);
  writeStderr(deprecationMessage(deprecation));
  return true;
}

/** Test seam: forget which surfaces have warned in this process. */
export function resetDeprecationWarnings(): void {
  warned.clear();
}
