import type { ProbeRegion } from "../capture/probe.js";
import type { RunRecord } from "../capture/run-record.js";
import type { GitRead } from "../changed/git.js";
import { type StoredRun, tupleKey } from "./estimate.js";

/**
 * Accepts a stored run only when it rendered the base: captured from a clean
 * tree at the base or an ancestor of it. A dirty run, or one at a later
 * commit, may already include the change (an earlier gate round, or a check
 * run after the edit), and a control the change broke would then match it
 * and go unclicked.
 */
export function reflectsBase(
  git: GitRead,
  repository: string,
  base: string,
): (record: RunRecord) => Promise<boolean> {
  const ancestry = new Map<string, Promise<boolean>>();
  return (record) => {
    if (record.source.dirty) return Promise.resolve(false);
    const commit = record.source.commit;
    let answer = ancestry.get(commit);
    if (!answer) {
      answer = git(repository, ["merge-base", "--is-ancestor", commit, base])
        .then(() => true)
        .catch(() => false);
      ancestry.set(commit, answer);
    }
    return answer;
  };
}

/**
 * The reference for one tuple's changed region: the newest run in `history`
 * that recorded fingerprints there. Pass only runs that reflect the base
 * (`reflectsBase`). None → the probe runs unscoped.
 */
export function regionReference(
  history: StoredRun[],
  state: string,
  viewport: string,
  scheme: string,
): (ProbeRegion & { controls: number }) | undefined {
  const key = tupleKey(state, viewport, scheme);
  for (const run of history) {
    const reference = run.fingerprints.get(key);
    if (reference?.size)
      return {
        reference,
        runId: run.runId,
        // Every control the reference enumerated: in a full run, controls
        // shared with other states were clicked once elsewhere and reused.
        controls: reference.size,
      };
  }
  return undefined;
}
