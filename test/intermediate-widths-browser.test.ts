import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCapture } from "../src/capture/run.js";
import { checkTiming, renderTimingLine } from "../src/capture/timings.js";
import {
  checksConfigFrom,
  runDeterministicChecks,
} from "../src/checks/registry.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { fixtureCommand } from "./support/fixture-server.js";

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}

test("an opted-in state captures 900 and 1024 in light only and reports the wrap at 900", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-intermediate-"));
  try {
    await writeFile(
      join(directory, "editor.html"),
      await readFile(
        join(import.meta.dirname, "fixtures/intermediate-widths/editor.html"),
      ),
    );
    await writeFile(
      join(directory, "server.mjs"),
      `import {createServer} from 'node:http';import {readFileSync} from 'node:fs';const html=readFileSync(new URL('./editor.html',import.meta.url));createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)}).listen(Number(process.env.PORT),'127.0.0.1');`,
    );
    const port = await freePort();
    const project = projectSchema.parse({
      version: 1,
      app: { name: "Fixture", framework: "other" },
      server: {
        build: "node -e 0",
        start: fixtureCommand("server.mjs"),
        readyUrl: `http://127.0.0.1:${port}/`,
        port,
        env: {},
      },
      viewports: [
        { name: "tablet", width: 768, height: 1024 },
        { name: "desktop", width: 1280, height: 800 },
      ],
      colorSchemes: ["light", "dark"],
      capture: { settleMs: 0 },
      design: {},
      model: { provider: "anthropic", model: "unused" },
    });
    const flowWith = (intermediateWidths?: boolean) =>
      flowSchema.parse({
        id: "editor",
        title: "Editor",
        setup: [],
        intent: [],
        states: [
          {
            id: "draft",
            description: "Draft with formatting toolbar",
            url: "/",
            expect: { status: 200 },
            ...(intermediateWidths === undefined ? {} : { intermediateWidths }),
          },
        ],
      });
    const run = async (label: string, intermediateWidths?: boolean) => {
      const flow = flowWith(intermediateWidths);
      const captured = await runCapture({
        projectDirectory: directory,
        port,
        project,
        flow,
        out: `capture-${label}`,
        dependencies: {
          snapshotSource: async () => ({ commit: "fixture", dirty: false }),
          inheritedEnvironment: { PATH: process.env.PATH },
          readHost: () => ({
            load: [0, 0, 0] as [number, number, number],
            coreCount: 8,
          }),
          measureReadyUrl: async () => 1,
        },
      });
      const loaded = await loadCaptureRun({
        runDirectory: captured.runDirectory,
        expectedFlow: flow.id,
      });
      const record = loaded.record;
      if (record === undefined) throw new Error("no run record");
      const checks = runDeterministicChecks(
        loaded.tuples,
        record.selected.map(
          (tuple) => `${tuple.state}\0${tuple.viewport}\0${tuple.colorScheme}`,
        ),
        checksConfigFrom(project.checks),
      );
      const wraps = checks.candidates
        .filter((entry) => entry.candidate.rule === "idiom:toolbar-wrap")
        .map((entry) => `${entry.tuple.viewport}/${entry.tuple.colorScheme}`);
      const declared = checks.candidates
        .filter((entry) => entry.tuple.intermediateWidth !== true)
        .map(
          (entry) =>
            `${entry.tuple.viewport}/${entry.tuple.colorScheme}/${entry.candidate.rule}/${entry.candidate.fingerprintHint ?? ""}`,
        )
        .sort();
      const timingLine = renderTimingLine(
        checkTiming(record.timings, captured.timings?.capture?.ms ?? 0),
      );
      if (process.env.IDIOM_EVIDENCE === "1")
        console.log(`${label}: ${timingLine}`);
      return { captured, loaded, record, wraps, declared, timingLine };
    };

    const without = await run("without");
    expect(without.captured.counts.total).toBe(4);
    expect(without.record.viewports.map((v) => v.name)).toEqual([
      "tablet",
      "desktop",
    ]);
    expect(without.record.selected).toHaveLength(4);
    expect(without.wraps).toEqual([]);
    expect(without.timingLine).not.toContain("intermediate widths");
    // The scan records how full the one-row toolbar is: 952px of 1248px.
    const desktop = without.loaded.tuples.find(
      (tuple) => tuple.viewport === "desktop" && tuple.colorScheme === "light",
    );
    const observed =
      desktop?.observations?.version === 2
        ? desktop.observations.toolbarLayouts?.records[0]
        : undefined;
    expect(observed?.rows).toBe(1);
    expect(observed?.fill).toBeCloseTo(952 / 1248, 2);

    const opted = await run("with", true);
    expect(opted.record.viewports).toEqual([
      { name: "tablet", width: 768, height: 1024 },
      { name: "desktop", width: 1280, height: 800 },
      { name: "intermediate-900", width: 900, height: 800, intermediate: true },
      {
        name: "intermediate-1024",
        width: 1024,
        height: 800,
        intermediate: true,
      },
    ]);
    const intermediateSelected = opted.record.selected.filter((tuple) =>
      tuple.viewport.startsWith("intermediate-"),
    );
    expect(intermediateSelected).toEqual([
      { state: "draft", viewport: "intermediate-900", colorScheme: "light" },
      { state: "draft", viewport: "intermediate-1024", colorScheme: "light" },
    ]);
    expect(
      opted.record.timings.tuples
        .filter((tuple) => tuple.intermediate === true)
        .map((tuple) => tuple.viewport),
    ).toEqual(["intermediate-900", "intermediate-1024"]);
    expect(
      [...opted.record.probe.intended, ...opted.record.probe.executed].some(
        (tuple) => tuple.viewport.startsWith("intermediate-"),
      ),
    ).toBe(false);
    expect(
      opted.loaded.tuples
        .filter((tuple) => tuple.intermediateWidth === true)
        .map((tuple) => tuple.viewport),
    ).toEqual(["intermediate-900", "intermediate-1024"]);
    expect(opted.wraps).toEqual(["intermediate-900/light"]);
    expect(opted.declared).toEqual(without.declared);
    expect(opted.timingLine).toMatch(
      /intermediate widths \+[0-9.]+s: draft \+[0-9.]+s over 2 widths/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
