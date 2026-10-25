import { join, resolve } from "node:path";
import type { GitTopology } from "../verify/baseline.js";
import { primaryCheckout } from "../verify/baseline.js";

/**
 * Resolve the reachable primary checkout without making project-wide readers
 * depend on Git being available. The current checkout is always implicit.
 */
export async function resolvePrimaryCheckout(
  projectDirectory: string,
  gitTopology: GitTopology | undefined,
): Promise<string | undefined> {
  let primary: string | undefined;
  try {
    primary = await (gitTopology ?? primaryCheckout)(projectDirectory);
  } catch {
    return undefined;
  }
  if (primary === undefined) return undefined;
  const resolved = resolve(primary);
  return resolved === resolve(projectDirectory) ? undefined : resolved;
}

export async function reachableProjectStores(
  projectDirectory: string,
  gitTopology: GitTopology | undefined,
): Promise<{
  primary: string | undefined;
  additionalReportRoots: string[];
  additionalTrackerRoots: string[];
}> {
  const primary = await resolvePrimaryCheckout(projectDirectory, gitTopology);
  return {
    primary,
    additionalReportRoots:
      primary === undefined ? [] : [join(primary, ".idiom", "reports")],
    additionalTrackerRoots:
      primary === undefined ? [] : [join(primary, ".autobuild", "tickets")],
  };
}
