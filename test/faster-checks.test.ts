import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { reservePort } from "../src/capture/port.js";
import { snapshotSource } from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import { loadRunRecord } from "../src/capture/run-record.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { productionFixture } from "./production-support.js";

const git = promisify(execFile);
test("scoped CLI check captures and probes only one requested coordinate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-scope-"));
  try {
    await initProject({ project: directory, yes: true });
    const reservation = createServer();
    await new Promise<void>((accept) =>
      reservation.listen(0, "127.0.0.1", accept),
    );
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((accept) => reservation.close(() => accept()));
    const audit = join(directory, "audit.txt");
    const project = {
      version: 1,
      app: { name: "Scope fixture", framework: "other" },
      server: {
        build: "node -e 0",
        start: `node '${join(import.meta.dirname, "fixtures", "faster-checks", "server.mjs")}'`,
        port,
        readyUrl: `http://127.0.0.1:${port}`,
        env: { PORT: String(port), AUDIT_FILE: audit },
      },
      viewports: [
        { name: "wide", width: 800, height: 600 },
        { name: "narrow", width: 400, height: 600, touch: true },
      ],
      colorSchemes: ["dark", "light"],
      checks: { probe: { enabled: true, waitMs: 0 } },
      capture: { settleMs: 0 },
      design: {},
      model: { provider: "anthropic", model: "unused" },
    };
    await writeFile(
      join(directory, ".idiom/project.json"),
      JSON.stringify(project),
    );
    await writeFile(
      join(directory, ".idiom/flows/scoped.json"),
      JSON.stringify({
        id: "scoped",
        title: "Scoped",
        setup: [],
        intent: [],
        states: ["first", "second"].map((id) => ({
          id,
          description: id,
          expect: {},
          url: `/${id}`,
          steps: [{ action: "click", selector: "button" }],
        })),
      }),
    );
    await git("git", ["init", "--quiet"], { cwd: directory });
    await git(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: directory },
    );
    const output: string[] = [];
    const errors: string[] = [];
    const status = await run(
      [
        "node",
        "idiom",
        "--project",
        directory,
        "check",
        "--all",
        "scoped",
        "--states",
        "second",
        "--viewports",
        "narrow",
        "--schemes",
        "light",
        "--port",
        String(port),
        "--json",
        "--fail-on",
        "never",
      ],
      {
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
      },
    );
    expect(status, errors.join("\n")).toBe(0);
    const summary = JSON.parse(output.join("\n"));
    expect(summary.coverage).toMatchObject({
      states: ["second"],
      selectedTuples: 1,
      skippedTuples: 7,
    });
    expect(summary.scope.probe.executed).toEqual([
      { state: "second", viewport: "narrow", colorScheme: "light" },
    ]);
    expect(summary.timings.tuples).toHaveLength(1);
    expect(summary.timings.checks.status).toBe("measured");
    const metadata = JSON.parse(
      await readFile(
        join(summary.runDirectory, "second/narrow/light/metadata.json"),
        "utf8",
      ),
    );
    expect(new URL(metadata.url.origin).port).toBe(String(port));
    expect(errors.join("\n")).toMatch(/build:.*start:/s);
    expect(await readdir(summary.runDirectory)).not.toContain("first");
    expect(await readFile(audit, "utf8")).not.toContain("/first");
    expect(await readFile(summary.reportPath, "utf8")).toContain(
      "7 declared tuples intentionally skipped",
    );
    expect(
      await readFile(join(summary.runDirectory, "report.html"), "utf8"),
    ).toContain("7 declared tuples intentionally skipped");
    const original = await readFile(
      join(summary.runDirectory, "run.json"),
      "utf8",
    );
    await writeFile(
      join(directory, ".idiom/project.json"),
      JSON.stringify({
        ...project,
        viewports: [{ name: "wide", width: 1024, height: 768 }],
        colorSchemes: ["dark"],
        capture: { ...project.capture, colorScheme: "dark" },
      }),
    );
    output.length = 0;
    expect(
      await run(
        [
          "node",
          "idiom",
          "--project",
          directory,
          "check",
          "--all",
          "scoped",
          "--from",
          basename(summary.runDirectory),
          "--json",
          "--fail-on",
          "never",
        ],
        {
          stdout: (value) => output.push(value),
          stderr: (value) => errors.push(value),
        },
      ),
    ).toBe(0);
    const replay = JSON.parse(output.join("\n"));
    expect(replay.timings.historical).toBe(true);
    expect(replay.coverage).toMatchObject({
      states: ["second"],
      viewports: [{ name: "narrow", width: 400, height: 600 }],
      colorSchemes: ["light"],
      skippedTuples: 7,
    });
    expect(await readFile(join(summary.runDirectory, "run.json"), "utf8")).toBe(
      original,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test.each(["flag", "environment", "fixedPort"] as const)(
  "production reuse honours a port pinned by %s before preparing the cache",
  async (source) => {
    const f = await productionFixture({}, true);
    try {
      const reservation = await reservePort(f.project.server.port);
      const port =
        source === "fixedPort" ? f.project.server.port : reservation.port;
      await reservation.release();
      if (source === "fixedPort") f.project.server.fixedPort = true;
      const options = {
        projectDirectory: f.directory,
        project: f.project,
        flow: f.flow,
        prod: true,
        scope: { states: "home", viewports: "desktop", schemes: "light" },
        ...(source === "flag" ? { port } : {}),
        dependencies: {
          inheritedEnvironment: {
            ...process.env,
            ...(source === "environment" ? { IDIOM_PORT: String(port) } : {}),
          },
        },
      };
      const first = await runCapture(options);
      const second = await runCapture(options);
      expect(first.counts).toEqual({ passed: 1, failed: 0, total: 1 });
      expect(second.counts).toEqual(first.counts);
      expect(first.timings?.build.status).toBe("measured");
      expect(second.timings?.build.status).toBe("reused");
      const audit = await f.audit();
      expect(audit.filter((row) => row.phase === "build")).toHaveLength(1);
      expect(audit.filter((row) => row.phase === "start")).toHaveLength(2);
      expect(
        audit.filter((row) => row.phase !== "setup").map((row) => row.port),
      ).toEqual([String(port), String(port), String(port)]);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test("clean production flows and scoped reruns reuse one build with fresh setup and current clients", async () => {
  const f = await productionFixture({}, true);
  try {
    expect((await snapshotSource(f.directory)).dirty).toBe(false);
    const first = await runCapture({
      projectDirectory: f.directory,
      project: f.project,
      flow: f.flow,
      prod: true,
    });
    const second = await runCapture({
      projectDirectory: f.directory,
      project: f.project,
      flow: { ...f.flow, id: "another" },
      prod: true,
    });
    const third = await runCapture({
      projectDirectory: f.directory,
      project: f.project,
      flow: f.flow,
      prod: true,
      scope: { states: "home", viewports: "desktop", schemes: "light" },
    });
    for (const result of [first, second, third])
      expect(result.counts).toEqual({ passed: 1, failed: 0, total: 1 });
    expect(first.timings?.build.status).toBe("measured");
    expect(second.timings?.build.status).toBe("reused");
    expect(third.timings?.build.status).toBe("reused");
    const audit = await f.audit();
    expect(audit.filter((row) => row.phase === "build")).toHaveLength(1);
    expect(audit.filter((row) => row.phase === "start")).toHaveLength(3);
    const setups = audit.filter((row) => row.phase === "setup");
    expect(new Set(setups.map((row) => row.marker)).size).toBe(3);
    expect(new Set(setups.map((row) => row.data)).size).toBe(1);
    expect(
      audit.filter((row) => row.phase === "start").map((row) => row.marker),
    ).toEqual(setups.map((row) => row.marker));
    await expect(access(setups[0]?.data ?? "")).rejects.toThrow();
    expect((await snapshotSource(f.directory)).dirty).toBe(false);
    expect((await loadRunRecord(third.runDirectory))?.source.dirty).toBe(false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}, 30_000);
