import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { expectedCaptureTupleKeys } from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import type { ObservationArtifact } from "../src/checks/types.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

/**
 * Probe clicks per control across states, from the recorded timelines. The
 * server sees more: the held replay repeats a click that sent requests (and
 * activates it once more while a non-safe request is held), so its click
 * counts no longer measure how often the probe itself clicked.
 */
async function probeClicks(runDirectory: string, name: string) {
  let count = 0;
  for (const id of ["a", "b"]) {
    const artifact = JSON.parse(
      await readFile(join(runDirectory, id, "desktop/timelines.json"), "utf8"),
    ) as { actions: Array<{ source: string; name: string }> };
    count += artifact.actions.filter(
      (action) =>
        action.source === "probe-click" && action.name.startsWith(name),
    ).length;
  }
  return count;
}

test.each([false, true])(
  "a planned flow retains local coverage and mutation protection (failed probe context: %s)",
  async (failProbe) => {
    const directory = await mkdtemp(join(tmpdir(), "idiom-probe-flow-"));
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    try {
      await writeFile(
        join(directory, "server.mjs"),
        `
import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
createServer((req,res)=>{
  if(req.url.startsWith('/clicked')) { appendFileSync('clicks.txt',req.url+'\\n');res.end('ok');return; }
  if(req.method==='POST') { appendFileSync('mutations.txt',req.url+'\\n');res.end('mutated');return; }
  res.setHeader('content-type','text/html');
  res.end(${JSON.stringify(`<!doctype html><html><body><header role="toolbar"><button id="shared" onfocus="fetch('/mutate-focus',{method:'POST'})" onclick="fetch('/clicked?shared&'+location.pathname);fetch('/mutate',{method:'POST'})">Shared</button><button id="popup" onclick="const f=document.createElement('form');f.target='_blank';f.method='POST';f.action='/mutate';document.body.append(f);f.submit()">Popup action</button><button id="help" aria-label="Layers help">?</button></header><main><button id="own" onclick="fetch('/clicked?own&'+location.pathname)">Own</button><script>document.querySelector('#own').id+='-'+location.pathname.slice(1);document.querySelector('main button').textContent+=' '+location.pathname;</script></main></body></html>`)});
}).listen(Number(process.env.PORT),'127.0.0.1');
`,
      );
      const flow = flowSchema.parse({
        id: "planned",
        title: "Planned",
        setup: [],
        intent: [],
        states: ["a", "b"].map((id) => ({
          id,
          description: id,
          url: `/${id}`,
          expect: { status: 200 },
        })),
      });
      const project = projectSchema.parse({
        version: 1,
        app: { name: "Fixture", framework: "other" },
        server: {
          build: "node -e 0",
          start: "node server.mjs",
          readyUrl: `http://127.0.0.1:${port}/`,
          port,
          env: {},
        },
        viewports: [{ name: "desktop", width: 1000, height: 800 }],
        colorSchemes: ["light"],
        capture: { settleMs: 0, concurrency: 4 },
        design: {},
        model: { provider: "anthropic", model: "unused" },
      });
      const captured = await runCapture({
        projectDirectory: directory,
        port,
        project,
        flow,
        out: "capture",
        dependencies: {
          browserLauncher: async (hooks) => {
            const session = await createBrowserLauncher()(hooks);
            return {
              ...session,
              capture: async (tuple) => {
                if (failProbe && !tuple.enumerateProbe)
                  return {
                    ok: false,
                    stage: "navigation",
                    message: "injected replay failure",
                    console: [],
                    mismatches: [],
                    startedAt: new Date().toISOString(),
                    endedAt: new Date().toISOString(),
                  };
                return session.capture(tuple);
              },
            };
          },
          snapshotSource: async () => ({ commit: "fixture", dirty: false }),
          inheritedEnvironment: { PATH: process.env.PATH },
        },
      });
      expect(captured.counts).toEqual({ passed: 2, failed: 0, total: 2 });
      if (failProbe) {
        await expect(
          readFile(join(directory, "clicks.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const loaded = await loadCaptureRun({
          runDirectory: captured.runDirectory,
          expectedFlow: flow.id,
        });
        for (const tuple of loaded.tuples) {
          if (tuple.observations?.version !== 2)
            throw new Error("missing observation");
          expect(tuple.observations.probe?.results).toHaveLength(4);
          expect(
            tuple.observations.probe?.results.every(
              (result) =>
                result.status === "not-reached" &&
                /injected replay failure|not completed in any state that shows it/.test(
                  result.skipped ?? "",
                ),
            ),
          ).toBe(true);
        }
        expect(captured.scope?.probe.executed).toEqual([]);
        return;
      }
      const clicks = (await readFile(join(directory, "clicks.txt"), "utf8"))
        .trim()
        .split("\n");
      expect(
        clicks.filter((line) => line.includes("shared")).length,
      ).toBeGreaterThan(0);
      expect(await probeClicks(captured.runDirectory, "Shared")).toBe(1);
      expect(await probeClicks(captured.runDirectory, "Own")).toBe(2);
      await expect(
        readFile(join(directory, "mutations.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const observations: ObservationArtifact[] = await Promise.all(
        ["a", "b"].map(async (id) =>
          JSON.parse(
            await readFile(
              join(captured.runDirectory, id, "desktop/observations.json"),
              "utf8",
            ),
          ),
        ),
      );
      const results = observations.flatMap((o) =>
        o.version === 2 ? (o.probe?.results ?? []) : [],
      );
      const shared = results.filter((result) => result.name === "Shared");
      expect(shared).toHaveLength(2);
      expect(
        shared.every(
          (result) =>
            result.selector === "#shared" && result.status === "completed",
        ),
      ).toBe(true);
      expect(shared.filter((result) => result.reusedFrom)).toHaveLength(1);
      expect(
        shared.find((result) => !result.reusedFrom)?.timings,
      ).toMatchObject({
        replayMs: 0,
      });
      const loaded = await loadCaptureRun({
        runDirectory: captured.runDirectory,
        expectedFlow: flow.id,
      });
      const checked = runDeterministicChecks(
        loaded.tuples,
        expectedCaptureTupleKeys({ project, flow }),
        checksConfigFrom(project.checks),
      );
      expect(
        checked.candidates.filter(
          (entry) => entry.candidate.category === "unexplained-control",
        ),
      ).toHaveLength(2);
      expect(
        results
          .filter((result) => result.name.startsWith("Own "))
          .every(
            (result) => !result.reusedFrom && result.status === "completed",
          ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);

test("an assigned state that leaves a shared control unprobed hands it to another state that shows it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-probe-steal-"));
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  try {
    // Each state's own text action outranks the shared ordinary switch, and
    // maxControls 1 leaves the shared switch unprobed in its assigned state.
    await writeFile(
      join(directory, "server.mjs"),
      `
import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
createServer((req,res)=>{
  if(req.url.startsWith('/clicked')) { appendFileSync('clicks.txt',req.url+'\\n');res.end('ok');return; }
  res.setHeader('content-type','text/html');
  res.end(${JSON.stringify(`<!doctype html><html><body><header role="toolbar"><button id="shared" role="switch" aria-checked="false" onclick="fetch('/clicked?shared&'+location.pathname)">Shared</button></header><main><button id="own" onclick="fetch('/clicked?own&'+location.pathname)">Own</button><script>document.querySelector('main button').textContent+=' '+location.pathname;</script></main></body></html>`)});
}).listen(Number(process.env.PORT),'127.0.0.1');
`,
    );
    const flow = flowSchema.parse({
      id: "steal",
      title: "Steal",
      setup: [],
      intent: [],
      states: ["a", "b"].map((id) => ({
        id,
        description: id,
        url: `/${id}`,
        expect: { status: 200 },
      })),
    });
    const project = projectSchema.parse({
      version: 1,
      app: { name: "Fixture", framework: "other" },
      server: {
        build: "node -e 0",
        start: "node server.mjs",
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: {},
      },
      viewports: [{ name: "desktop", width: 1000, height: 800 }],
      colorSchemes: ["light"],
      capture: { settleMs: 0, concurrency: 4 },
      checks: { probe: { maxControls: 1 } },
      design: {},
      model: { provider: "anthropic", model: "unused" },
    });
    const captured = await runCapture({
      projectDirectory: directory,
      port,
      project,
      flow,
      out: "capture",
      dependencies: {
        snapshotSource: async () => ({ commit: "fixture", dirty: false }),
        inheritedEnvironment: { PATH: process.env.PATH },
      },
    });
    expect(captured.counts).toEqual({ passed: 2, failed: 0, total: 2 });
    const clicks = (await readFile(join(directory, "clicks.txt"), "utf8"))
      .trim()
      .split("\n");
    expect(
      clicks.filter((line) => line.includes("shared")).length,
    ).toBeGreaterThan(0);
    expect(await probeClicks(captured.runDirectory, "Shared")).toBe(1);
    expect(await probeClicks(captured.runDirectory, "Own")).toBe(2);
    const results = (
      await Promise.all(
        ["a", "b"].map(async (id) => {
          const observation: ObservationArtifact = JSON.parse(
            await readFile(
              join(captured.runDirectory, id, "desktop/observations.json"),
              "utf8",
            ),
          );
          return observation.version === 2
            ? (observation.probe?.results ?? [])
            : [];
        }),
      )
    ).flat();
    const shared = results.filter((result) => result.name === "Shared");
    expect(shared.map((result) => result.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(shared.filter((result) => result.reusedFrom)).toHaveLength(1);
    expect(
      results.some((result) => /did not complete/.test(result.skipped ?? "")),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);
