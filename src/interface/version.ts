/**
 * The interface version: the one number integrations compare to detect a
 * breaking change in a stable surface (CLI, exit codes, `--json`, MCP tools,
 * `.idiom/` files). It is separate from the package version. Changing a stable
 * surface incompatibly requires bumping it; additive changes never do. See
 * docs/stability.md.
 */
export const INTERFACE_VERSION = 1;

/**
 * Documented process exit codes (docs/commands.md, "Exit codes and setup failures").
 * - `ok`: the command succeeded and nothing blocks.
 * - `failed`: blocking findings, a failed gate or verification, or a usage or other error.
 * - `run-failure`: the run could not happen (a refused precondition, a server that
 *   never became ready, or a capture that could not start).
 */
export const EXIT_CODES = {
  ok: 0,
  failed: 1,
  "run-failure": 2,
  deferred: 3,
  "decision-needed": 4,
} as const;

/**
 * Serialises a `--json` payload with `interfaceVersion` as its first key.
 * Arrays are refused at the type level: they cannot carry a top-level key.
 */
export function jsonPayload<T extends object>(
  value: T extends readonly unknown[] ? never : T,
): string {
  return JSON.stringify(
    { interfaceVersion: INTERFACE_VERSION, ...value },
    null,
    2,
  );
}
