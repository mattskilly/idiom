import { createHash } from "node:crypto";
import type { CheckTuple } from "../checks/types.js";
import type { Flow } from "../schemas/flow.js";
import type { Project } from "../schemas/project.js";

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function settingsHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

/** Include declarations used at capture time by predicates, without storing URLs, env or resources. */
export function capturePredicateIdentity(project: Project, flow: Flow): string {
  // Scheduling (lane/link concurrency, capture deadline) never changes a predicate.
  const {
    concurrency: _lanes,
    maxMinutes: _deadline,
    ...capture
  } = project.capture;
  const checks = {
    ...project.checks,
    links: { ...project.checks.links, concurrency: undefined },
  };
  return settingsHash({
    checks,
    capture,
    invariants: flow.invariants,
    states: flow.states.map((state) =>
      Object.fromEntries(
        Object.entries(state).filter(
          ([key]) => !["description", "url", "urlFrom"].includes(key),
        ),
      ),
    ),
  });
}
/** Current declarations supplement evidence; immutable run settings always come from run.json. */
export function annotateDeclaredExpectations(
  tuples: CheckTuple[],
  flow: Flow,
): void {
  for (const tuple of tuples) {
    const state = [...flow.states]
      .sort((a, b) => b.id.length - a.id.length)
      .find((s) => tuple.state === s.id || tuple.state.startsWith(`${s.id}.`));
    if (state) tuple.declaredExpectations = state.expect;
  }
}
