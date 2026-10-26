import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { expectedCaptureTupleKeys } from "../src/capture/resolve.js";
import { runCapture } from "../src/capture/run.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { buildDeterministicDrafts } from "../src/review/findings.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { fixture } from "./benchmark-support.js";

async function files(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), {
    withFileTypes: true,
  });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(prefix, entry.name);
        return entry.isDirectory() ? files(directory, path) : [path];
      }),
    )
  )
    .flat()
    .sort();
}

// Timing is evidence about the host, not about the page or scheduler.
function withoutTiming(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTiming);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "timestamps",
              "timestamp",
              "timings",
              "elapsedMs",
              "observedMs",
            ].includes(key),
        )
        .map(([key, item]) => [key, withoutTiming(item)]),
    );
  return value;
}

test("capture lanes preserve benchmark evidence, screenshots and finding fingerprints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-lane-equivalence-"));
  try {
    await writeFile(
      join(directory, "before.html"),
      await fixture("before.html"),
    );
    await writeFile(
      join(directory, "DESIGN.md"),
      await readFile(join(import.meta.dirname, "fixtures/benchmark/DESIGN.md")),
    );
    await writeFile(
      join(directory, "server.mjs"),
      `import {createServer} from 'node:http';import {readFileSync} from 'node:fs';const html=readFileSync(new URL('./before.html',import.meta.url));createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)}).listen(Number(process.env.PORT),'127.0.0.1');`,
    );
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const flow = flowSchema.parse({
      id: "studio",
      title: "Studio",
      setup: [],
      intent: [],
      states: [
        {
          id: "editor",
          description: "Editor",
          url: "/",
          expect: { status: 200 },
        },
      ],
    });
    const run = async (concurrency: number) => {
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
        viewports: [
          { name: "desktop", width: 1440, height: 900 },
          { name: "wide", width: 1600, height: 900 },
        ],
        colorSchemes: ["light", "dark"],
        capture: { settleMs: 0, concurrency },
        design: {},
        model: { provider: "anthropic", model: "unused" },
      });
      const captured = await runCapture({
        projectDirectory: directory,
        port,
        project,
        flow,
        out: `capture-${concurrency}`,
        dependencies: {
          snapshotSource: async () => ({ commit: "fixture", dirty: false }),
          inheritedEnvironment: { PATH: process.env.PATH },
        },
      });
      expect(captured.counts).toEqual({ passed: 4, failed: 0, total: 4 });
      const loaded = await loadCaptureRun({
        runDirectory: captured.runDirectory,
        expectedFlow: flow.id,
      });
      const checks = runDeterministicChecks(
        loaded.tuples,
        expectedCaptureTupleKeys({ project, flow }),
        checksConfigFrom(project.checks),
      );
      const fingerprints = buildDeterministicDrafts({
        runId: "fixture",
        entries: checks.candidates,
      })
        .map(({ finding }) => finding.fingerprint)
        .sort();
      const artifacts: Record<string, unknown> = {};
      const screenshots: Record<string, Buffer> = {};
      for (const path of await files(captured.runDirectory)) {
        if (path.endsWith(".png"))
          screenshots[path] = await readFile(join(captured.runDirectory, path));
        else if (path.endsWith(".json"))
          artifacts[path] = withoutTiming(
            JSON.parse(
              await readFile(join(captured.runDirectory, path), "utf8"),
            ),
          );
      }
      return { artifacts, screenshots, fingerprints };
    };
    const sequential = await run(1);
    const concurrent = await run(4);
    expect(concurrent.artifacts).toEqual(sequential.artifacts);
    expect(Object.keys(concurrent.screenshots)).toHaveLength(4);
    expect(concurrent.screenshots).toEqual(sequential.screenshots);
    expect(concurrent.fingerprints).toEqual(sequential.fingerprints);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
