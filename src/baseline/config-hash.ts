import { createHash } from "node:crypto";
import { deterministicCheckIds } from "../checks/types.js";
import type { Project } from "../schemas/project.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** Call with the complete schema-normalized checks block, including capture settings. */
export function checksConfigHash(checks: Project["checks"]): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          checks,
          checkIds: [...deterministicCheckIds].sort(),
        }),
      ),
    )
    .digest("hex")}`;
}
