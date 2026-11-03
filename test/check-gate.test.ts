import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { serverAnswers } from "../src/capture/process.js";
import { run } from "../src/cli.js";
import { planGate } from "../src/gate/plan.js";
import { changedFixture } from "./changed-support.js";

async function cli(directory: string, flags: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const status = await run(
    ["node", "idiom", "--project", directory, "check", ...flags],
    { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
  );
  return { status, out: out.join("\n"), err: err.join("\n"), errLines: err };
}

const cardFiles = {
  "components/Card.module.css": ".card { color: rgb(10, 10, 10); }\n",
  "components/Card.tsx":
    "import styles from './Card.module.css';\nexport function Card() { return <div className={styles.card} />; }\n",
  "app/r1/page.tsx":
    "import { Card } from '../../components/Card';\nexport default function Page() { return <main><Card /></main>; }\n",
};

async function widen(f: Awaited<ReturnType<typeof changedFixture>>) {
  const path = join(f.directory, ".idiom/project.json");
  const project = JSON.parse(await readFile(path, "utf8"));
  project.viewports = [
    { name: "wide", width: 800, height: 600 },
    { name: "narrow", width: 400, height: 700 },
  ];
  project.colorSchemes = ["light", "dark"];
  await writeFile(path, JSON.stringify(project));
  await f.commit("two viewports and schemes");
}

test("a non-UI diff skips in under a second, before any graph, server or browser", async () => {
  const f = await changedFixture({});
  try {
    await f.write("README.md", "# changed\n");
    await mkdir(join(f.directory, "test"), { recursive: true });
    await f.write("test/x.test.ts", "export {};\n");
    let selected = 0;
    const started = performance.now();
    const plan = await planGate({
      project: f.directory,
      dependencies: {
        select: async () => {
          selected += 1;
          throw new Error("the import graph must not be built");
        },
      },
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(selected).toBe(0);
    expect(plan.skipped).toBe(true);
    const started2 = performance.now();
    const response = await cli(f.directory, ["--gate"]);
    expect(performance.now() - started2).toBeLessThan(1000);
    expect(response.status, response.err).toBe(0);
    expect(response.out.trim()).toMatch(
      /^no UI changes since [0-9a-f]{12}; skipped$/,
    );
    const json = await cli(f.directory, ["--gate", "--json"]);
    expect(JSON.parse(json.out).gate).toMatchObject({
      skipped: true,
      reason: "no UI changes",
    });
    await expect(access(join(f.directory, "audit.txt"))).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a CSS-only change to one component gates only the state that renders it, at one viewport and scheme", async () => {
  const f = await changedFixture(cardFiles);
  try {
    await widen(f);
    await f.write(
      "components/Card.module.css",
      ".card { color: rgb(200, 10, 10); }\n",
    );
    const plan = await planGate({ project: f.directory });
    if (plan.skipped) throw new Error(plan.line);
    expect(plan.graph.complete).toBe(true);
    expect(
      plan.files.find((file) => file.path === "components/Card.module.css"),
    ).toMatchObject({ ui: true, kind: "import", routes: ["/r1"] });
    expect(plan.tuples).toEqual([
      { flow: "site", state: "s1", viewport: "wide", scheme: "light" },
    ]);
    const response = await cli(f.directory, [
      "--gate",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const output = JSON.parse(response.out);
    expect(output.gate.plan.tuples).toHaveLength(1);
    expect(output.gate.skippedWork).toEqual([]);
    expect(output.checks[0].summary.coverage).toMatchObject({
      selectedTuples: 1,
      states: ["s1"],
    });
    expect(output.checks[0].summary.gate.plan).toContain(
      "idiom check --gate: 1 state × 1 viewport",
    );
    expect(response.errLines[0]).toContain("idiom check --gate: 1 state");
    expect(response.errLines.at(-1)?.trim()).toMatch(/^Timing: .*slowest: /);
    const audit = await readFile(join(f.directory, "audit.txt"), "utf8");
    expect(audit).toContain("/r1");
    expect(audit).not.toContain("/r0");
    expect(
      await readFile(output.checks[0].summary.reportPath, "utf8"),
    ).toContain("### Build gate");
  } finally {
    await f.cleanup();
  }
}, 60_000);

test("a responsive change widens to every viewport; the over-budget plan trims and reports it", async () => {
  const f = await changedFixture(cardFiles);
  try {
    await widen(f);
    await f.write(
      "components/Card.module.css",
      ".card { color: red; }\n@media (max-width: 500px) { .card { color: blue; } }\n",
    );
    const wide = await planGate({ project: f.directory, budgetMs: 3_600_000 });
    if (wide.skipped) throw new Error(wide.line);
    expect(wide.tuples.map((tuple) => tuple.viewport)).toEqual([
      "wide",
      "narrow",
    ]);
    const response = await cli(f.directory, [
      "--gate",
      "--budget",
      "10s",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const output = JSON.parse(response.out);
    expect(output.gate.budgetMs).toBe(10_000);
    expect(
      output.gate.skippedWork.map((skip: { kind: string }) => skip.kind),
    ).toContain("viewport");
    expect(response.err).toMatch(/skipped: viewport site @ narrow/);
    expect(output.checks[0].summary.coverage.selectedTuples).toBe(1);
    expect(output.checks[0].summary.gate.skippedWork.length).toBeGreaterThan(0);
  } finally {
    await f.cleanup();
  }
}, 60_000);

test("reuse-server captures a running server and never starts one", async () => {
  const f = await changedFixture(cardFiles);
  const project = JSON.parse(
    await readFile(join(f.directory, ".idiom/project.json"), "utf8"),
  );
  const server = spawn(
    process.execPath,
    [join(import.meta.dirname, "fixtures/faster-checks/server.mjs")],
    {
      env: {
        ...process.env,
        PORT: String(f.port),
        AUDIT_FILE: join(f.directory, "audit.txt"),
      },
      stdio: "ignore",
    },
  );
  try {
    for (let i = 0; i < 100; i++) {
      if (await serverAnswers(project.server.readyUrl)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A start command that cannot run proves capture never starts it.
    project.server.start = 'node -e "process.exit(3)"';
    project.server.build = 'node -e "process.exit(4)"';
    await writeFile(
      join(f.directory, ".idiom/project.json"),
      JSON.stringify(project),
    );
    await f.commit("unstartable server");
    await f.write(
      "components/Card.module.css",
      ".card { color: rgb(1, 2, 3); }\n",
    );
    const response = await cli(f.directory, [
      "--gate",
      "--reuse-server",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const output = JSON.parse(response.out);
    expect(output.gate.server).toMatchObject({
      mode: "reused",
      verified: false,
    });
    expect(response.errLines[0]).toContain("server reused (unverified:");
    expect(output.checks[0].summary.timings.start.status).toBe("reused");
    expect(output.checks[0].summary.timings.build.status).toBe("reused");
    expect(output.gate.timing.phases.serverStart.status).toBe("reused");
  } finally {
    server.kill();
    await f.cleanup();
  }
}, 60_000);

test("every plain check ends with the Timing line and carries the breakdown in --json", async () => {
  const f = await changedFixture({});
  try {
    const response = await cli(f.directory, [
      "site",
      "--json",
      "--fail-on",
      "never",
    ]);
    expect(response.status, response.err).toBe(0);
    const summary = JSON.parse(response.out);
    expect(summary.timing).toMatchObject({
      probeIncludedInCapture: true,
      phases: {
        build: { status: "measured" },
        serverStart: { status: "measured" },
        capture: { status: "measured" },
      },
    });
    expect(summary.timing.totalMs).toBeGreaterThan(0);
    expect(response.errLines.at(-1)?.trim()).toMatch(
      /^Timing: [\d.hms]+ — build [^,]+, server start [^,]+, capture [^,]+, checks [^;]+; slowest: (build|server start|capture|probe|checks)$/,
    );
  } finally {
    await f.cleanup();
  }
}, 60_000);

test("the changed region is measured from the base: a second gate round still clicks what the change restyled", async () => {
  // The server renders Card.module.css into the page, so the stylesheet
  // change really restyles the submit (an ordinary, region-skippable control).
  const f = await changedFixture({
    ...cardFiles,
    "server.mjs": `import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
createServer(async (req, res) => {
  const css = await readFile(new URL("./components/Card.module.css", import.meta.url), "utf8");
  res.setHeader("Content-Type", "text/html");
  res.end(\`<!doctype html><html lang="en"><title>Region</title><style>\${css}</style><body><main><form onsubmit="return false"><button class="card" type="submit">Apply</button></form></main></body></html>\`);
}).listen(Number(process.env.PORT), "127.0.0.1");
`,
  });
  try {
    const path = join(f.directory, ".idiom/project.json");
    const project = JSON.parse(await readFile(path, "utf8"));
    project.server.start = `node '${join(f.directory, "server.mjs")}'`;
    project.checks.probe = { enabled: true, waitMs: 0 };
    await writeFile(path, JSON.stringify(project));
    const base = await f.commit("probe on");
    const full = await cli(f.directory, ["site", "--fail-on", "never"]);
    expect(full.status, full.err).toBe(0);
    await f.write(
      "components/Card.module.css",
      ".card { color: rgb(200, 10, 10); }\n",
    );
    const submit = async (response: Awaited<ReturnType<typeof cli>>) => {
      expect(response.status, response.err).toBe(0);
      const output = JSON.parse(response.out);
      const run = dirname(output.checks[0].summary.reportPath);
      const observations = JSON.parse(
        await readFile(join(run, "s1", "wide", "observations.json"), "utf8"),
      );
      expect(observations.probe.results.length).toBeGreaterThan(0);
      return {
        region: output.gate.plan.states[0]?.region?.runId,
        result: observations.probe.results.find(
          (result: { name?: string }) => result.name === "Apply",
        ),
      };
    };
    const gate = ["--gate", "--changed", base, "--json", "--fail-on", "never"];
    const first = await submit(await cli(f.directory, gate));
    expect(first.region).toBeDefined();
    expect(first.result).toBeDefined();
    expect(first.result?.status).not.toBe("not-reached");
    // Round 2, same change: the dirty round-1 run must not become the
    // reference, or the restyled submit would match it and go unclicked.
    const second = await submit(await cli(f.directory, gate));
    expect(second.region).toBe(first.region);
    expect(second.result).toBeDefined();
    expect(second.result?.status).not.toBe("not-reached");
    expect(second.result?.skipped ?? "").not.toContain("gate: unchanged");
  } finally {
    await f.cleanup();
  }
}, 120_000);
