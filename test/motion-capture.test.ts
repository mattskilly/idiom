import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { writeTupleArtifacts } from "../src/capture/artifacts.js";
import { createBrowserLauncher } from "../src/capture/browser.js";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import { runDeterministicChecks } from "../src/checks/registry.js";
import { timelineEvidence } from "../src/checks/shared.js";
import type { MotionArtifact } from "../src/checks/types.js";
import { initProject } from "../src/commands/init.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { runReview } from "../src/review/run.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";
import { required } from "./motion-support.js";

// Real web capture, then offline review by run ID after the source is gone.
test("web-step evidence survives screenshot, storage, offline review and combined probe replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "idiom-motion-"));
  const html = `<!doctype html><html lang="en"><title>Motion</title><style>
    aside{height:180px;width:240px;overflow:hidden} aside.closed{display:none}
    </style><button id="toggle" aria-controls="layers">Toggle Layers</button>
    <aside id="layers" aria-label="Layers panel">Layers</aside>
    <button id="fade" aria-controls="tooltip">Help</button><div role="tooltip" id="tooltip">Help text</div>
    <script>toggle.onclick=()=>layers.classList.toggle('closed');fade.onclick=()=>tooltip.animate([{opacity:1},{opacity:.2}],{duration:400,fill:'forwards'});</script></html>`;
  const server = createServer((_, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no port");
  const url = `http://127.0.0.1:${address.port}/`;
  const browser = await chromium.launch();
  const session = await createBrowserLauncher({
    launch: async () => browser,
    createAxe: () => ({ analyze: async () => ({ violations: [] }) }),
  })();
  try {
    await initProject({ project: directory, yes: true });
    const project = projectSchema.parse({
      version: 1,
      app: { name: "Motion", framework: "other" },
      server: {
        build: "node -e 0",
        start: "node -e 0",
        readyUrl: url,
        port: address.port,
        env: {},
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      capture: { settleMs: 0, reducedMotion: false },
      design: {},
      model: { provider: "anthropic", model: "unused", maxFindings: 5 },
    });
    const flow = flowSchema.parse({
      id: "motion",
      title: "Motion",
      intent: [],
      setup: [],
      states: [
        {
          id: "closed",
          description: "Collapsed",
          url: "/",
          steps: [
            { action: "click", selector: "#toggle" },
            { action: "click", selector: "#fade" },
          ],
          expect: {},
        },
      ],
    });
    const state = required(flow.states[0]);
    const viewport = required(project.viewports[0]);
    const snapshots: MotionArtifact[] = [];
    for (let round = 0; round < 2; round++) {
      const result = await session.capture({
        project,
        state,
        viewport,
        navigationUrl: url,
      });
      expect(result.ok).toBe(true);
      expect(result.observations?.version).toBe(2);
      if (result.observations?.version !== 2 || !result.observations.motion)
        throw Error("missing temporal evidence");
      expect(
        observationArtifactSchema.parse(
          JSON.parse(JSON.stringify(result.observations)),
        ),
      ).toEqual(result.observations);
      const motion = result.observations.motion;
      expect(
        motion.actions.map((a) => [a.source, a.stepIndex, a.selector]),
      ).toEqual([
        ["web-step", 1, "#toggle"],
        ["web-step", 2, "#fade"],
      ]);
      expect(
        motion.actions[0]?.changes.find((c) => c.selector === "#layers"),
      ).toMatchObject({
        animated: false,
        toggled: true,
        after: { rendered: false },
      });
      expect(
        motion.actions[1]?.changes.find((c) => c.selector === "#tooltip")
          ?.effects[0],
      ).toMatchObject({ durationMs: 400, started: true });
      snapshots.push(motion);
      if (round === 0) {
        const stagingDirectory = join(directory, ".idiom/reports/motion-run");
        await mkdir(stagingDirectory, { recursive: true });
        await writeTupleArtifacts({
          stagingDirectory,
          tuple: { flow, state, viewport, result },
          source: { commit: "fixture", dirty: false },
          browserVersion: "test",
          fallbackTimestamp: new Date().toISOString(),
        });
      }
    }
    const keys = (motion: MotionArtifact) =>
      runDeterministicChecks([
        {
          flow: "motion",
          state: "closed",
          viewport: "desktop",
          width: 800,
          height: 600,
          metadataPath: "x",
          artifactPaths: [],
          commit: "fixture",
          createdAt: new Date().toISOString(),
          console: [],
          mismatches: [],
          observations: {
            version: 2,
            viewport: { width: 800, height: 600 },
            document: {
              scrollWidth: 800,
              scrollHeight: 600,
              clientWidth: 800,
              clientHeight: 600,
            },
            headings: [],
            elements: [],
            tokens: { status: "not-configured" },
            maskMembership: [],
            motion,
          },
        },
      ])
        .candidates.filter((c) => c.candidate.category === "motion")
        .map((c) => c.candidate.fingerprintHint);
    expect(keys(required(snapshots[0]))).toEqual(keys(required(snapshots[1])));
    const combined = await session.capture({
      project,
      state,
      viewport,
      navigationUrl: url,
      probe: true,
    });
    expect(combined.ok).toBe(true);
    if (combined.observations?.version !== 2)
      throw Error("no combined evidence");
    expect(
      combined.observations.motion?.actions.filter(
        (a) => a.source === "web-step",
      ),
    ).toHaveLength(2);
    expect(
      combined.observations.motion?.actions.some(
        (a) => a.source === "probe-click",
      ),
    ).toBe(true);
    expect(combined.dom).toContain(
      'id="layers" aria-label="Layers panel" class="closed"',
    );
    // Replay runner actions are absent from step evidence, and the duplicate slow
    // fade observed by the probe and step has just one finding per direction.
    const combinedCandidates = keys(required(combined.observations.motion));
    expect(new Set(combinedCandidates).size).toBe(combinedCandidates.length);
    // Timelines: the load, both steps and the probe's clicks, never replays.
    const ids = combined.timelines?.actions.map((action) => action.id) ?? [];
    expect(ids.slice(0, 3)).toEqual(["load", "step-1", "step-2"]);
    expect(ids.filter((id) => id?.startsWith("probe-")).length).toBeGreaterThan(
      0,
    );
    expect(JSON.stringify(combined.observations.probe)).not.toContain(
      "timelines",
    );
    await writeFile(
      join(directory, ".idiom/project.json"),
      JSON.stringify(project),
    );
    await writeFile(
      join(directory, ".idiom/flows/motion.json"),
      JSON.stringify(flow),
    );
    await session.close();
    await new Promise<void>((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
    const loaded = await loadCaptureRun({
      runDirectory: join(directory, ".idiom/reports/motion-run"),
      expectedFlow: "motion",
    });
    expect(
      runDeterministicChecks(loaded.tuples).candidates.filter(
        (c) => c.candidate.category === "motion",
      ),
    ).toHaveLength(2);
    const stored = required(loaded.tuples[0]);
    expect(stored.timelines?.actions.map((action) => action.id)).toEqual([
      "load",
      "step-1",
      "step-2",
    ]);
    expect(stored.artifactPaths).toContain("closed/desktop/timelines.json");
    expect(timelineEvidence(stored).status).toBe("ran");
    // A run captured before timelines loads unchanged and asks for recapture.
    const timelinesPath = join(
      directory,
      ".idiom/reports/motion-run/closed/desktop/timelines.json",
    );
    const timelinesBytes = await readFile(timelinesPath);
    await rm(timelinesPath);
    const legacy = await loadCaptureRun({
      runDirectory: join(directory, ".idiom/reports/motion-run"),
      expectedFlow: "motion",
    });
    const legacyTuple = required(legacy.tuples[0]);
    expect(legacyTuple.timelines).toBeUndefined();
    expect(legacyTuple.artifactPaths).not.toContain(
      "closed/desktop/timelines.json",
    );
    expect(timelineEvidence(legacyTuple)).toEqual({
      status: "unavailable",
      reason: "unavailable: recapture (no action timelines in this capture)",
    });
    expect(
      runDeterministicChecks(legacy.tuples).candidates.map(
        (c) => c.candidate.fingerprintHint ?? c.candidate.selectorHint,
      ),
    ).toEqual(
      runDeterministicChecks(loaded.tuples).candidates.map(
        (c) => c.candidate.fingerprintHint ?? c.candidate.selectorHint,
      ),
    );
    await writeFile(timelinesPath, timelinesBytes);
    const review = await runReview({
      project: directory,
      flow: "motion",
      from: "motion-run",
      deterministicOnly: true,
    });
    const findings = JSON.parse(
      await readFile(review.findingsPath, "utf8"),
    ) as Array<{ category: string; explanation: string; rule: string }>;
    expect(findings.filter((f) => f.category === "motion")).toHaveLength(2);
    expect(await readFile(review.reportPath, "utf8")).toContain(
      "400ms exceeds 150ms limit",
    );
    expect(await readFile(review.htmlReportPath, "utf8")).toContain(
      "Layers panel collapse: no transition",
    );
  } finally {
    await session.close().catch(() => undefined);
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
