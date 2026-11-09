import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { reservePort } from "../src/capture/port.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { fixtureCommand } from "./support/fixture-server.js";

const exec = promisify(execFile);

const page = (html: string) =>
  `// html: ${html}\nexport default function Page() { return null; }\n`;

/**
 * A repository whose server renders each route from the checked-out source,
 * so a capture of the base (its own worktree) sees the base's markup. State
 * s1 expects #a and #b; removing either is a blocker finding.
 */
async function baseFixture() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-gate-base-"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: directory })).stdout.trim();
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  };
  const commit = async (message: string) => {
    await git("add", "-A");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  await initProject({ project: directory, yes: true });
  const reservation = await reservePort(0);
  const port = reservation.port;
  await reservation.release();
  await write(
    ".gitignore",
    ".idiom/reports/\n.idiom/cache/\n.idiom/agent-state.json\n",
  );
  await write(
    ".idiom/project.json",
    JSON.stringify({
      version: 1,
      app: { name: "Base fixture", framework: "nextjs" },
      server: {
        build: "node -e 0",
        start: fixtureCommand(
          join(import.meta.dirname, "fixtures/base-gate/server.mjs"),
        ),
        port,
        readyUrl: `http://127.0.0.1:${port}/ready`,
        env: { PORT: String(port) },
      },
      viewports: [{ name: "wide", width: 800, height: 600 }],
      colorSchemes: ["light"],
      checks: { probe: { enabled: false } },
      capture: { settleMs: 0 },
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
  );
  await write(
    ".idiom/flows/site.json",
    JSON.stringify({
      id: "site",
      title: "Site",
      setup: [],
      intent: [],
      states: [
        { id: "s0", description: "Home", url: "/r0", expect: {} },
        {
          id: "s1",
          description: "Detail",
          url: "/r1",
          expect: { selectorPresent: ["#a", "#b"] },
        },
      ],
    }),
  );
  await write("app/r0/page.tsx", page("<h1>Home</h1>"));
  await write(
    "app/r1/page.tsx",
    page('<h1>Detail</h1><p id="a">A</p><p id="b">B</p>'),
  );
  await git("init", "--quiet", "--initial-branch=main");
  await commit("initial");
  return {
    directory,
    git,
    write,
    commit,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function cli(directory: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const status = await run(["node", "idiom", "--project", directory, ...args], {
    stdout: (value) => out.push(value),
    stderr: (value) => err.push(value),
  });
  // As a verify step does: a check rewrites the tracked finding-name
  // registry, which the next gate would otherwise read as a UI change.
  await exec("git", ["checkout", "--", ".idiom/finding-names.json"], {
    cwd: directory,
  }).catch(() => undefined);
  return { status, out: out.join("\n"), err: err.join("\n") };
}

type Finding = { rule?: string; selector?: string; problem: string };
const missing = (findings: Finding[], selector: string) =>
  findings.some(
    (finding) =>
      finding.rule === "idiom:expectation-selector-present" &&
      finding.problem.includes(JSON.stringify(selector)),
  );

test("the gate judges findings against the build's base, not a baseline main has moved past", async () => {
  const f = await baseFixture();
  try {
    // A baseline recorded on main, then main adds a blocker after it.
    const baselineCommit = await f.git("rev-parse", "HEAD");
    const recorded = await cli(f.directory, ["baseline", "record", "site"]);
    expect(recorded.status, recorded.err).toBe(0);
    await f.commit("record baseline");
    await f.write("app/r1/page.tsx", page('<h1>Detail</h1><p id="b">B</p>'));
    const base = await f.commit("main drops #a");
    // A later, unrelated branch touches the same page.
    await f.git("checkout", "--quiet", "-b", "feature");
    await f.write(
      "app/r1/page.tsx",
      page('<h1>Detail</h1><p id="b">B</p><p>New copy</p>'),
    );
    await f.commit("feature: new copy");

    const first = await cli(f.directory, [
      "check",
      "--gate",
      "--fail-on",
      "major",
      "--json",
    ]);
    expect(first.status, first.err).toBe(0);
    const output = JSON.parse(first.out);
    expect(output.gate.comparisons.site).toMatchObject({
      mode: "base-capture",
      base,
      missingTuples: 1,
      baseCaptureMs: expect.any(Number),
    });
    const summary = output.checks[0].summary;
    expect(summary.baseline).toMatchObject({ source: "base-capture", base });
    expect(missing(summary.preExistingFindings, "#a")).toBe(true);
    expect(missing(summary.findings, "#a")).toBe(false);
    expect(first.err).toContain(
      `site: judged against base ${base.slice(0, 12)} (base capture, 1 tuple`,
    );
    // The committed baseline is untouched; the cache is in the Git dir.
    // (finding-names.json is the head check's own, as for any check.)
    expect(await f.git("status", "--porcelain", "--", ".idiom/baselines")).toBe(
      "",
    );
    const cachePath = (
      await exec("find", [
        join(f.directory, ".git", "idiom", "base-cache"),
        "-name",
        "site.json",
      ])
    ).stdout.trim();
    expect(cachePath).not.toBe("");

    // Again: the cached base capture, no worktree, same verdict.
    const second = await cli(f.directory, ["check", "--gate", "--json"]);
    expect(second.status, second.err).toBe(0);
    const again = JSON.parse(second.out);
    expect(again.gate.comparisons.site.mode).toBe("base-cache");
    expect(again.gate.comparisons.site.baseCaptureMs).toBeUndefined();
    expect(second.err).toContain("(cached base capture)");
    expect(missing(again.checks[0].summary.preExistingFindings, "#a")).toBe(
      true,
    );

    // check --changed shares the base comparison.
    const changed = await cli(f.directory, [
      "check",
      "site",
      "--changed",
      "--json",
      "--fail-on",
      "major",
    ]);
    expect(changed.status, changed.err).toBe(0);
    const changedSummary = JSON.parse(changed.out).checks[0].summary;
    expect(changedSummary.baseline.source).toBe("base-cache");
    expect(missing(changedSummary.preExistingFindings, "#a")).toBe(true);

    // Budget honesty: without the cache and with no time to capture the
    // base, the gate says so and charges what the old baseline lacks.
    const cached = await readFile(cachePath, "utf8");
    await rm(cachePath);
    const tight = await cli(f.directory, [
      "check",
      "--gate",
      "--budget",
      "1s",
      "--fail-on",
      "major",
      "--json",
    ]);
    expect(tight.status, tight.err).toBe(1);
    expect(tight.err).toContain(
      `comparing with baseline ${baselineCommit.slice(0, 12)}, 2 commit(s) behind base ${base.slice(0, 12)}`,
    );
    expect(tight.err).toMatch(/warning: base capture skipped \(~/);
    expect(JSON.parse(tight.out).gate.comparisons.site.mode).toBe("fallback");
    await writeFile(cachePath, cached);

    // A branch that introduces a finding still fails.
    await f.write("app/r1/page.tsx", page("<h1>Detail</h1><p>New copy</p>"));
    await f.commit("feature: drops #b");
    const introduced = await cli(f.directory, [
      "check",
      "--gate",
      "--fail-on",
      "major",
      "--json",
    ]);
    expect(introduced.status, introduced.err).toBe(1);
    const failing = JSON.parse(introduced.out).checks[0].summary;
    expect(missing(failing.findings, "#b")).toBe(true);
    expect(missing(failing.findings, "#a")).toBe(false);
    expect(missing(failing.preExistingFindings, "#a")).toBe(true);

    // baseline advance records main's tip (the cache, and the file on ask).
    const advanced = await cli(f.directory, [
      "baseline",
      "advance",
      "site",
      "--commit-file",
      "--json",
    ]);
    expect(advanced.status, advanced.err).toBe(0);
    expect(JSON.parse(advanced.out)).toMatchObject({
      flow: "site",
      target: "refs/heads/main",
      commit: base,
      tupleCount: 2,
      failedTuples: [],
    });
    const file = JSON.parse(
      await readFile(join(f.directory, ".idiom/baselines/site.json"), "utf8"),
    );
    expect(file.records[0].commit).toBe(base);
  } finally {
    await f.cleanup();
  }
}, 240_000);
