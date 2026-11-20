import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const script = join(
  import.meta.dirname,
  "..",
  "scripts",
  "prove-idiom-fix.mjs",
);

test("the fixture build: finding, fix, re-verify, fixed in-build, then pass", async () => {
  const out = await mkdtemp(join(tmpdir(), "idiom-fix-proof-test-"));
  try {
    const { stdout } = await exec("node", [script, "--out", out], {
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(stdout).toContain("prove-idiom-fix: PASS");
    const transcript = await readFile(join(out, "transcript.md"), "utf8");
    const order = [
      "### Finding (round-0/handoff.md)",
      "### Fix",
      "### Re-verify",
      "### Result",
      "## Verify cycle 2",
    ].map((heading) => transcript.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(transcript).toContain(
      '"Buttons in a toolbar keep at least 8px apart."',
    );
    const calls = (await readFile(join(out, "ab-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; cycle: string });
    const verdicts = calls.filter((call) => call.args[0] === "verdict");
    expect(verdicts).toEqual([
      {
        cycle: "1",
        args: ["verdict", "fail", "--report", ".ab/idiom-fix/fixed.md"],
      },
      {
        cycle: "2",
        args: ["verdict", "pass", "--notes", ".ab/idiom-fix/transcript.md"],
      },
    ]);
    const branch = await readFile(join(out, "branch.diff"), "utf8");
    expect(branch).toMatch(
      /idiom-fix: finding-\d+, finding-\d+ \(verify round 1\)/,
    );
    expect(branch).toContain("-  gap: 2px;\n+  gap: 8px;");
    const artifacts = JSON.parse(
      await readFile(join(out, "artifacts.json"), "utf8"),
    ) as Array<{ kind: string; attach: boolean }>;
    expect(artifacts.map((artifact) => artifact.kind)).toContain(
      "idiom-fix-report",
    );
    expect(
      artifacts.filter((artifact) =>
        /^idiom-fix-crop-\d{3}$/.test(artifact.kind),
      ).length,
    ).toBeGreaterThanOrEqual(1);
    expect(artifacts.every((artifact) => artifact.attach)).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}, 300_000);
