import { realpath, rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { captureBaseRecords } from "../src/baseline/base.js";
import { baselineProject, git } from "./baseline-support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("several flows at the base share one worktree and one lease", async () => {
  const created = await baselineProject();
  roots.push(created.project);
  const root = await realpath(created.project);
  const addWorktree = vi.fn(async (cwd: string, tree: string, sha: string) => {
    await git(cwd, "worktree", "add", "--detach", tree, sha);
  });
  const leaseServer = vi.fn(async () => undefined);
  const batch = await captureBaseRecords(
    {
      base: created.commit,
      project: root,
      flows: [
        // The base declares none of these states: nothing to capture.
        { flow: "studio", scope: { states: "not-at-base" } },
        // Unknown at the base: reported for this flow, not fatal to the batch.
        { flow: "ghost", scope: {} },
      ],
      leaseServer,
    },
    { addWorktree },
  );
  expect(addWorktree).toHaveBeenCalledTimes(1);
  expect(leaseServer).toHaveBeenCalledTimes(1);
  expect(batch.servers).toBe(0);
  const studio = batch.results.get("studio");
  expect(studio && !("error" in studio) ? studio.record : "error").toBe(
    undefined,
  );
  const ghost = batch.results.get("ghost");
  expect(ghost && "error" in ghost ? String(ghost.error) : "").toMatch(
    /unknown flow ghost at base/,
  );
});
