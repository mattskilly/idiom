import { spawn } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { isPortOpen } from "../src/capture/process.js";
import { productionFixture } from "./production-support.js";

const fixtureScript = join(
  import.meta.dirname,
  "fixtures",
  "probe-timeouts",
  "server.mjs",
);
async function cli(directory: string, args: string[], timeoutMs = 12000) {
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dirname, "..", "dist", "cli.js"),
      "--project",
      directory,
      ...args,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  const chunks: Array<{ stream: string; text: string }> = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    chunks.push({ stream: "stdout", text: chunk.toString() });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    chunks.push({ stream: "stderr", text: chunk.toString() });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`CLI exceeded outer test timeout: ${stderr}`));
      }, timeoutMs);
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr, chunks };
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
}

test("built CLI exits after a whole-capture timeout, releases the server port and removes staging", async () => {
  const f = await productionFixture();
  try {
    const project = {
      ...f.project,
      server: {
        ...f.project.server,
        fixedPort: true,
        start: `node '${fixtureScript}'`,
      },
      capture: { ...f.project.capture, maxMinutes: 0.045 },
    };
    const flow = {
      ...f.flow,
      states: [
        { id: "editor", description: "Editor", url: "/no-headers", expect: {} },
      ],
    };
    await writeFile(
      join(f.directory, ".idiom", "project.json"),
      JSON.stringify(project),
    );
    await writeFile(
      join(f.directory, ".idiom", "flows", "fixture.json"),
      JSON.stringify(flow),
    );
    const started = performance.now();
    const result = await cli(f.directory, ["capture", "fixture"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "Capture exceeded capture.maxMinutes=0.045: state editor, viewport desktop, scheme light, step navigation",
    );
    expect(performance.now() - started).toBeLessThan(8500);
    expect(await isPortOpen(f.project.server.port)).toBe(false);
    const reports = await readdir(join(f.directory, ".idiom", "reports"));
    expect(reports.filter((name) => name.includes(".staging-"))).toEqual([]);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}, 15000);

test("multi-state check JSON stays parseable while live progress precedes the result on stderr", async () => {
  const f = await productionFixture();
  try {
    const project = {
      ...f.project,
      server: { ...f.project.server, start: `node '${fixtureScript}'` },
      capture: { ...f.project.capture, settleMs: 0, maxMinutes: 0.4 },
      checks: {
        probe: {
          enabled: true,
          waitMs: 2500,
          controlTimeoutMs: 1500,
          stateTimeoutMs: 2100,
        },
      },
    };
    const flow = {
      ...f.flow,
      states: ["editor", "later"].map((id) => ({
        id,
        description: id,
        url: "/",
        expect: {},
      })),
    };
    await writeFile(
      join(f.directory, ".idiom", "project.json"),
      JSON.stringify(project),
    );
    await writeFile(
      join(f.directory, ".idiom", "flows", "fixture.json"),
      JSON.stringify(flow),
    );
    const result = await cli(
      f.directory,
      ["check", "--all", "fixture", "--json"],
      20000,
    );
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("timings");
    expect(result.stderr).toContain("Probe editor/desktop/light: 0 done");
    expect(result.stderr).toContain("Probe later/desktop/light: 0 done");
    expect(result.stderr).toMatch(/\d+ done; #print/);
    expect(
      result.chunks.find((chunk) => /Probe editor/.test(chunk.text))?.stream,
    ).toBe("stderr");
    expect(
      result.chunks.findIndex((chunk) => chunk.stream === "stdout"),
    ).toBeGreaterThan(
      result.chunks.findIndex((chunk) => /Probe later/.test(chunk.text)),
    );
    expect(result.stdout).not.toContain("Probe editor/");
    const record = JSON.parse(
      await readFile(join(parsed.runDirectory, "run.json"), "utf8"),
    );
    expect(record.probe.executed).toHaveLength(2);
    expect(
      record.timings.slowestControls.some(
        (control: { outcome: string }) => control.outcome === "timed-out",
      ),
    ).toBe(true);
    const replay = await cli(f.directory, [
      "check",
      "--all",
      "fixture",
      "--from",
      basename(parsed.runDirectory),
      "--json",
    ]);
    const historical = JSON.parse(replay.stdout);
    expect(historical.timings.historical).toBe(true);
    expect(historical.timings.slowestControls).toEqual(
      parsed.timings.slowestControls,
    );
    expect(replay.stderr).not.toContain("0 done");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}, 25000);
