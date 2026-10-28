import { access, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { run } from "../src/cli.js";
import { checkCommand } from "../src/commands/check.js";
import { checkChanged } from "../src/commands/check-changed.js";
import { changedFixture } from "./changed-support.js";
import { mcpClient, toolData } from "./mcp-support.js";

async function cli(directory: string, flags: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const status = await run(
    ["node", "idiom", "--project", directory, "check", ...flags],
    { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
  );
  return { status, out: out.join("\n"), err: err.join("\n") };
}

test("20-state public CLI captures only the changed route and never bootstraps a dirty partial baseline", async () => {
  const f = await changedFixture({}, 20);
  try {
    await f.write(
      "app/r7/page.tsx",
      "export default function Page() { return <article /> }",
    );
    const response = await cli(f.directory, [
      "site",
      "--changed",
      "--all",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const output = JSON.parse(response.out);
    expect(output.checkedStates).toBe(1);
    expect(output.selection.selected).toEqual([{ flow: "site", state: "s7" }]);
    expect(output.selection.skipped).toHaveLength(19);
    const summary = output.checks[0].summary;
    expect(summary.coverage).toMatchObject({
      selectedTuples: 1,
      successfulTuples: 1,
      skippedTuples: 19,
      states: ["s7"],
    });
    expect(summary.timings.tuples).toHaveLength(1);
    expect(
      (await readdir(summary.runDirectory)).filter((path) =>
        /^s\d+$/.test(path),
      ),
    ).toEqual(["s7"]);
    const audit = (
      await readFile(join(f.directory, "audit.txt"), "utf8")
    ).split("\n");
    expect(audit).toContain("/r7");
    for (let i = 0; i < 20; i++)
      if (i !== 7) expect(audit).not.toContain(`/r${i}`);
    expect(await readFile(summary.reportPath, "utf8")).toContain(
      "19 declared tuples intentionally skipped",
    );
    const defaultMode = await cli(f.directory, [
      "site",
      "--changed=HEAD",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(defaultMode.status, defaultMode.err).toBe(0);
    expect(
      JSON.parse(defaultMode.out).checks[0].summary.baselineNotApplied,
    ).toContain("never initialize");
    await expect(
      access(join(f.directory, ".idiom/baselines/site.json")),
    ).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
}, 60_000);

test("no-op and explicit empty intersections launch nothing; invalid combinations fail before setup", async () => {
  const f = await changedFixture();
  try {
    for (const flags of [
      ["--changed"],
      ["--changed=HEAD"],
      ["--changed", "main"],
    ]) {
      const response = await cli(f.directory, [...flags, "--json"]);
      expect(response.status, response.err).toBe(0);
      const output = JSON.parse(response.out);
      expect(output.checkedStates).toBe(0);
      expect(output.checks).toEqual([
        { flow: "site", status: "not-checked", reason: expect.any(String) },
      ]);
    }
    await f.write("app/r0/page.tsx", "export default 2");
    const empty = await checkChanged({
      project: f.directory,
      flow: "site",
      changed: true,
      scope: { states: "s1" },
    });
    expect(empty.selection.selected).toEqual([]);
    expect(empty.checks[0]?.status).toBe("not-checked");
    for (const flags of [
      [],
      ["--changed", "--from", "old"],
      ["--changed", "--latest"],
      ["--changed", "--states", "s0"],
      ["--changed", "--baseline", "old"],
      ["site", "--changed", "--states", "missing"],
      ["site", "--changed", "--since-baseline"],
      ["site", "--changed", "--all", "--since-baseline"],
    ]) {
      const response = await cli(f.directory, flags);
      expect(response.status, flags.join(" ")).toBe(1);
    }
    await expect(access(join(f.directory, "audit.txt"))).rejects.toThrow();
    const text = await cli(f.directory, [
      "site",
      "--changed",
      "--states",
      "s1",
    ]);
    expect(text.out).toContain("checked 0 of 2 states");
    expect(text.out).toContain("site/s0: not checked");
  } finally {
    await f.cleanup();
  }
});

test("flowless checking skips unaffected flows and MCP shares selection and registers only real evidence", async () => {
  const f = await changedFixture();
  let close: (() => Promise<unknown>) | undefined;
  try {
    await f.write(
      ".idiom/flows/other.json",
      JSON.stringify({
        id: "other",
        title: "Other",
        setup: [],
        intent: [],
        states: [
          { id: "unaffected", description: "Other", url: "/other", expect: {} },
        ],
      }),
    );
    await f.commit();
    await f.write("app/r0/page.tsx", "export default 2");
    const response = await cli(f.directory, [
      "--changed",
      "--all",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const output = JSON.parse(response.out);
    expect(
      output.checks.find((entry: { flow: string }) => entry.flow === "other"),
    ).toEqual({
      flow: "other",
      status: "not-checked",
      reason: expect.any(String),
    });
    const session = await mcpClient({ project: f.directory });
    close = session.close;
    const mcp = toolData<typeof output>(
      await session.client.callTool({
        name: "idiom_check",
        arguments: { changed: true, all: true },
      }),
    );
    expect(mcp.selection).toEqual(output.selection);
    expect(
      mcp.checks.find((entry: { flow: string }) => entry.flow === "site"),
    ).toMatchObject({
      status: "checked",
      runId: expect.any(String),
      reports: { markdown: expect.any(String) },
      coverage: { selectedTuples: 1 },
      verificationReferences: expect.any(Array),
    });
    expect(
      mcp.checks.find((entry: { flow: string }) => entry.flow === "other"),
    ).not.toHaveProperty("reports");
    for (const args of [
      {},
      { changed: false },
      { changed: "" },
      { changed: 1 },
      { flow: "../site", changed: true },
    ]) {
      expect(
        (
          await session.client.callTool({
            name: "idiom_check",
            arguments: args,
          })
        ).isError,
      ).toBe(true);
    }
  } finally {
    await close?.();
    await f.cleanup();
  }
}, 60_000);

test("recorded and legacy baselines apply only to selected states and remain unchanged", async () => {
  const f = await changedFixture();
  try {
    const full = await checkCommand({ project: f.directory, flow: "site" });
    expect(full.baselineRecorded).toBeDefined();
    const baselinePath = join(f.directory, ".idiom/baselines/site.json");
    const bytes = await readFile(baselinePath, "utf8");
    await f.commit("record baseline");
    await f.write("app/r0/page.tsx", "export default 2");
    const response = await cli(f.directory, [
      "site",
      "--changed",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const summary = JSON.parse(response.out).checks[0].summary;
    expect(summary.baseline.uncoveredTuples).toEqual(["s1/wide"]);
    expect(
      summary.fixed.every((finding: { where: string }) =>
        finding.where.startsWith("s0/"),
      ),
    ).toBe(true);
    expect(await readFile(baselinePath, "utf8")).toBe(bytes);
    const legacy = await checkChanged({
      project: f.directory,
      flow: "site",
      changed: true,
      baseline: basename(full.runDirectory),
    });
    expect(legacy.checks[0]).toMatchObject({
      status: "checked",
      summary: { findings: [], preExisting: expect.any(Number) },
    });
    const live = await cli(f.directory, [
      "site",
      "--changed",
      "--all",
      "--json",
      "--fail-on",
      "minor",
    ]);
    const findings = JSON.parse(live.out).checks[0].summary.findings;
    expect(live.status).toBe(findings.length ? 1 : 0);
  } finally {
    await f.cleanup();
  }
}, 60_000);

test("a failed later flow cannot publish batch hook success; a successful batch publishes once", async () => {
  const f = await changedFixture();
  const hookPath = join(f.directory, ".idiom/agent-hooks/state.json");
  try {
    await f.write(
      ".idiom/flows/zzz.json",
      JSON.stringify({
        id: "zzz",
        title: "Later",
        setup: [{ run: "node -e 'process.exit(7)'" }],
        intent: [],
        states: [{ id: "later", description: "Later", url: "/r0", expect: {} }],
      }),
    );
    await f.commit();
    const noOp = await checkChanged({
      project: f.directory,
      changed: true,
      all: true,
    });
    expect(noOp.checkedStates).toBe(0);
    await expect(access(hookPath)).rejects.toThrow();
    await f.write("app/r0/page.tsx", "export default 2");
    await expect(
      checkChanged({ project: f.directory, changed: true, all: true }),
    ).rejects.toThrow();
    // The first flow captured successfully, but the later setup failed.
    await expect(access(hookPath)).rejects.toThrow();
    await f.write(
      ".idiom/flows/zzz.json",
      JSON.stringify({
        id: "zzz",
        title: "Later",
        setup: [],
        intent: [],
        states: [{ id: "later", description: "Later", url: "/r0", expect: {} }],
      }),
    );
    const response = await cli(f.directory, [
      "--changed",
      "--all",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    expect(response.out).toContain("checked 3 of 3 states");
    expect(response.out).toContain("fallback: all states");
    expect(response.out).toContain('".idiom/flows/zzz.json"');
    expect(JSON.parse(await readFile(hookPath, "utf8")).check.flow).toBe(
      "changed",
    );
  } finally {
    await f.cleanup();
  }
}, 60_000);

test("a failed selected capture remains in coverage and is never counted as checked", async () => {
  const f = await changedFixture();
  try {
    await f.write(
      ".idiom/flows/site.json",
      JSON.stringify({
        id: "site",
        title: "Site",
        setup: [],
        intent: [],
        states: [
          {
            id: "failed",
            description: "Failed navigation",
            url: "http://127.0.0.1:1/r0",
            expect: {},
          },
        ],
      }),
    );
    const response = await cli(f.directory, [
      "site",
      "--changed",
      "--all",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const output = JSON.parse(response.out);
    expect(output.selection.selected).toEqual([
      { flow: "site", state: "failed" },
    ]);
    expect(output.checkedStates).toBe(0);
    expect(output.checks[0]).toMatchObject({
      status: "checked",
      summary: {
        coverage: {
          selectedTuples: 1,
          successfulTuples: 0,
        },
      },
    });
    const coverage = output.checks[0].summary.coverage;
    expect([...coverage.failedTuples, ...coverage.unresolvedTuples]).toEqual([
      expect.objectContaining({ state: "failed" }),
    ]);
    expect(output.checks[0].summary.findings.length).toBeGreaterThan(0);
    await expect(
      access(join(f.directory, ".idiom/agent-hooks/state.json")),
    ).rejects.toThrow();
    await expect(
      checkChanged({
        project: f.directory,
        flow: "site",
        changed: true,
        all: true,
        captureFailureIsError: true,
      }),
    ).rejects.toThrow("Capture failed");
  } finally {
    await f.cleanup();
  }
}, 60_000);
