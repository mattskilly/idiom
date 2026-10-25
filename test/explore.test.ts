import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { afterEach, expect, test, vi } from "vitest";
import type { CaptureRunResult } from "../src/capture/types.js";
import {
  type ExploreDependencies,
  exploreCommand,
} from "../src/commands/explore.js";
import { exploreResolveCommand } from "../src/commands/explore-resolve.js";
import { initProject } from "../src/commands/init.js";
import type { ClaudeCodeRunRequest } from "../src/critique/claude-code.js";
import type { ExplorationAdapter } from "../src/explore/types.js";
import { loadCaptureRun } from "../src/review/artifacts.js";
import { writeUnruledDecisions } from "../src/rulings/artifacts.js";
import type { ExplorationCandidate } from "../src/schemas/exploration.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function png(red: number, green: number, blue: number): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = red;
    image.data[offset + 1] = green;
    image.data[offset + 2] = blue;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

function candidate(label: "A" | "B" | "C", references: string[] = []) {
  return {
    label,
    direction: `Direction ${label}`,
    choiceKey: `clear-hierarchy-${label}`,
    rule: `Use direction ${label} when grouping primary and secondary controls.`,
    reason: `Direction ${label} makes the primary path clear.`,
    category: "hierarchy" as const,
    repair: `Regroup existing controls following direction ${label}.`,
    references,
    edits: [{ path: "src/app.tsx", oldText: "old", newText: label }],
  };
}

async function fixture(
  colorSchemes: Array<"light" | "dark"> = ["light"],
  provider: "anthropic" | "claude-code" = "anthropic",
  withReference = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-explore-command-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "app.tsx"), "old\n");
  if (withReference)
    await writeFile(
      join(directory, ".idiom", "references", "managed-density.md"),
      "Use a compact editorial hierarchy.\n",
    );
  await writeFile(
    join(directory, ".idiom", "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "fixture", framework: "other" },
      server: {
        build: "true",
        start: "true",
        readyUrl: "http://127.0.0.1:3000/",
        port: 3000,
        env: {},
      },
      viewports: [{ name: "desktop", width: 800, height: 600 }],
      colorSchemes,
      capture: {},
      design: {},
      model: { provider, model: "fake", maxFindings: 5 },
    }),
  );
  await writeFile(
    join(directory, ".idiom", "flows", "fixture.json"),
    JSON.stringify({
      id: "fixture",
      title: "Fixture",
      intent: ["Make the next action clear."],
      setup: [],
      states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
    }),
  );
  await execFileAsync("git", ["init"], { cwd: directory });
  await execFileAsync("git", ["add", "."], { cwd: directory });
  return directory;
}

function fakeCapture(preflight: () => boolean) {
  return vi.fn(
    async (
      options: Parameters<NonNullable<ExploreDependencies["runCapture"]>>[0],
    ): Promise<CaptureRunResult> => {
      expect(preflight()).toBe(true);
      const out = options.out as string;
      const source = await readFile(
        join(options.projectDirectory, "src", "app.tsx"),
        "utf8",
      );
      const color = source.includes("AR")
        ? [255, 128, 0]
        : source.includes("A")
          ? [255, 0, 0]
          : source.includes("B")
            ? [0, 255, 0]
            : source.includes("C")
              ? [0, 0, 255]
              : [255, 255, 255];
      const selections = options.tuples ?? [
        { state: "ready", viewport: "desktop", colorScheme: "light" as const },
      ];
      const colorSchemeAxis =
        new Set(selections.map((selection) => selection.colorScheme ?? "light"))
          .size > 1;
      for (const selection of selections) {
        const scheme = selection.colorScheme ?? "light";
        const tuple = join(
          out,
          selection.state,
          selection.viewport,
          ...(colorSchemeAxis ? [scheme] : []),
        );
        await mkdir(tuple, { recursive: true });
        await writeFile(
          join(tuple, "screenshot.png"),
          png(color[0] ?? 0, color[1] ?? 0, color[2] ?? 0),
        );
        await writeFile(join(tuple, "dom.html"), "<main></main>");
        await writeFile(join(tuple, "console.jsonl"), "");
        await writeFile(
          join(tuple, "axe.json"),
          JSON.stringify({ violations: [] }),
        );
        await writeFile(
          join(tuple, "observations.json"),
          JSON.stringify({
            version: 2,
            viewport: { width: 800, height: 600 },
            document: {
              scrollWidth: 800,
              scrollHeight: 600,
              clientWidth: 800,
              clientHeight: 600,
            },
            elements: [],
            headings: [],
            tokens: { status: "not-configured" },
            maskMembership: [],
          }),
        );
        await writeFile(
          join(tuple, "metadata.json"),
          JSON.stringify({
            source: { commit: "abc", dirty: false },
            flow: { id: "fixture", title: "Fixture" },
            state: { id: selection.state, description: "Ready" },
            viewport: {
              name: selection.viewport,
              width: 800,
              height: 600,
            },
            colorScheme: scheme,
            colorSchemeAxis,
            timestamps: {
              startedAt: "2026-08-27T12:00:00.000Z",
              endedAt: "2026-08-27T12:00:01.000Z",
            },
            status: 200,
            url: {
              kind: "literal",
              origin: "http://127.0.0.1:3000",
              url: "http://127.0.0.1:3000/",
            },
            expectations: { passed: true, mismatches: [] },
            failure: null,
            platform: {
              platform: "test",
              architecture: "test",
              release: "test",
            },
            browserVersion: "test",
          }),
        );
      }
      await writeFile(join(out, "baseline.md"), "# Baseline\n");
      return {
        reportPath: join(out, "baseline.md"),
        runDirectory: out,
        counts: {
          passed: selections.length,
          failed: 0,
          total: selections.length,
        },
      };
    },
  );
}

function adapter(onPreflight: () => void): ExplorationAdapter {
  return {
    async preflight() {
      onPreflight();
    },
    async proposeCandidates() {
      return [candidate("A"), candidate("B"), candidate("C")];
    },
    async refineCandidate() {
      throw new Error("not requested");
    },
  };
}

function claudeResult(structuredOutput: unknown) {
  return {
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: structuredOutput,
    }),
    stderr: "",
    exitCode: 0,
    signal: null,
  };
}

test("command repairs observed nonconforming candidate labels and completes", async () => {
  const directory = await fixture(["light"], "claude-code");
  let ready = false;
  const calls: ClaudeCodeRunRequest[] = [];
  const outputs = [
    { available: true },
    {
      candidates: [
        { ...candidate("A"), label: "Direction one" },
        { ...candidate("B"), label: "Direction two" },
        { ...candidate("C"), label: "Direction three" },
      ],
    },
    { candidates: [candidate("A"), candidate("B"), candidate("C")] },
  ];
  const runner = vi.fn(async (request: ClaudeCodeRunRequest) => {
    calls.push(request);
    ready = true;
    return claudeResult(outputs.shift());
  });

  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      claudeCodeRunner: runner,
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-28T12:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });

  expect(result.outcome).toBe("rule-only");
  expect(calls).toHaveLength(3);
  expect(calls[2]?.stdin).toContain(
    'received ["Direction one","Direction two","Direction three"]',
  );
});

test("command preserves exhausted label repair evidence and reports sanitized labels", async () => {
  const directory = await fixture(["light"], "claude-code");
  let ready = false;
  const secretLabel = "sk-ant-command-secret";
  const rejected = {
    candidates: [
      candidate("A"),
      candidate("B"),
      { ...candidate("C"), label: secretLabel },
    ],
  };
  const outputs = [{ available: true }, rejected, rejected];
  const runner = vi.fn(async () => {
    ready = true;
    return claudeResult(outputs.shift());
  });
  const runDirectory = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-28T12-01-00-000Z-explore-fixture-ready",
  );
  const artifact = join(
    runDirectory,
    "provider-output",
    "candidates-rejected.json",
  );

  const failure: unknown = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      claudeCodeRunner: runner,
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-28T12:01:00.000Z"),
      gitTopology: async () => undefined,
    },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  const message = failure instanceof Error ? failure.message : "";
  expect(message).toContain(
    'repaired output returned labels ["A","B","[redacted]"]',
  );
  expect(message).toContain(`rejected output preserved at ${artifact}`);
  expect(message).not.toContain(secretLabel);
  expect(runner).toHaveBeenCalledTimes(3);
  const evidence = await readFile(artifact, "utf8");
  expect(evidence).toContain(secretLabel);
  expect(JSON.parse(evidence).attempts).toHaveLength(2);
});

test("citation repair finishes before candidate rendering begins", async () => {
  const directory = await fixture(["light"], "anthropic", true);
  let ready = false;
  const managedLabel = "reference:managed-density.md";
  const designCitation =
    "DESIGN.md: Timezone lines are a pattern, not a one-off decision.";
  const runCapture = fakeCapture(() => ready);
  const proposeCandidates = vi.fn<ExplorationAdapter["proposeCandidates"]>(
    async (input) => {
      if (input.rejected === undefined)
        return [
          candidate("A", [designCitation]),
          candidate("B", [managedLabel]),
          candidate("C", [managedLabel]),
        ];
      expect(runCapture).toHaveBeenCalledTimes(1);
      expect(input.rejected.issues.join("\n")).toContain(designCitation);
      expect(input.rejected.issues.join("\n")).toContain(managedLabel);
      await expect(
        access(join(input.evidence.runDirectory, "candidates")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      return [
        candidate("A", ["REFERENCE:MANAGED-DENSITY.MD"]),
        candidate("B", [managedLabel]),
        candidate("C", [managedLabel]),
      ];
    },
  );
  let chosen: ExplorationCandidate[] = [];

  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: {
        async preflight() {
          ready = true;
        },
        proposeCandidates,
        async refineCandidate() {
          throw new Error("not requested");
        },
      },
      runCapture,
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-28T12:02:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async (candidates) => {
          chosen = candidates;
          return "A";
        },
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });

  expect(result.outcome).toBe("rule-only");
  expect(proposeCandidates).toHaveBeenCalledTimes(2);
  expect(runCapture).toHaveBeenCalledTimes(4);
  expect(chosen[0]?.references).toEqual([managedLabel]);
  const report = await readFile(result.reportPath as string, "utf8");
  expect(report).toContain(managedLabel);
  expect(report).not.toContain("REFERENCE:MANAGED-DENSITY.MD");
});

test("an empty reference catalog completes with empty citation lists", async () => {
  const directory = await fixture();
  let ready = false;
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: adapter(() => {
        ready = true;
      }),
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-28T12:03:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });
  expect(result.outcome).toBe("rule-only");
});

test("live resolution matches case-insensitive provider labels to persisted candidates", async () => {
  const directory = await fixture();
  let ready = false;
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: {
        async preflight() {
          ready = true;
        },
        async proposeCandidates() {
          return [
            { ...candidate("A"), label: "a" },
            { ...candidate("B"), label: "b" },
            { ...candidate("C"), label: "c" },
          ];
        },
        async refineCandidate() {
          throw new Error("not requested");
        },
      },
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-28T13:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "a",
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });

  expect(result.outcome).toBe("rule-only");
  expect(result.ruling?.choiceKey).toBe("clear-hierarchy-a");
});

test("exhausted citation repair preserves both batches before rendering", async () => {
  const directory = await fixture(["light"], "anthropic", true);
  let ready = false;
  const designCitation = "DESIGN.md: not a managed citation";
  const rejected = [
    candidate("A", [designCitation]),
    candidate("B", [designCitation]),
    candidate("C", [designCitation]),
  ];
  const proposeCandidates = vi.fn(async () => rejected);
  const runCapture = fakeCapture(() => ready);
  const runDirectory = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-28T12-04-00-000Z-explore-fixture-ready",
  );
  const artifact = join(
    runDirectory,
    "provider-output",
    "candidates-rejected.json",
  );

  const failure: unknown = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: {
        async preflight() {
          ready = true;
        },
        proposeCandidates,
        async refineCandidate() {
          throw new Error("not requested");
        },
      },
      runCapture,
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-28T12:04:00.000Z"),
      gitTopology: async () => undefined,
    },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(
    `rejected output preserved at ${artifact}`,
  );
  expect(proposeCandidates).toHaveBeenCalledTimes(2);
  expect(runCapture).toHaveBeenCalledTimes(1);
  await expect(access(join(runDirectory, "candidates"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const evidence = JSON.parse(await readFile(artifact, "utf8"));
  expect(evidence.attempts).toHaveLength(2);
  expect(JSON.stringify(evidence)).toContain(designCitation);
});

test("choosing none removes the exploration and never touches source or law", async () => {
  const directory = await fixture();
  let ready = false;
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: adapter(() => {
        ready = true;
      }),
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      prompts: {
        choose: async () => undefined,
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });
  expect(result).toEqual({ outcome: "none" });
  expect(await readFile(join(directory, "src", "app.tsx"), "utf8")).toBe(
    "old\n",
  );
  await expect(
    access(
      join(
        directory,
        ".idiom",
        "reports",
        "2026-08-27T12-00-00-000Z-explore-fixture-ready",
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("a chosen direction records only the reasoned rule and comparison evidence", async () => {
  const directory = await fixture();
  let ready = false;
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: adapter(() => {
        ready = true;
      }),
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async () => "It makes the primary path obvious.",
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });
  expect(result.outcome).toBe("rule-only");
  expect(await readFile(join(directory, "src", "app.tsx"), "utf8")).toBe(
    "old\n",
  );
  expect(await readFile(join(directory, "DESIGN.md"), "utf8")).toContain(
    "Reason: It makes the primary path obvious.",
  );
  expect(await readFile(result.reportPath as string, "utf8")).toContain(
    "data:image/png;base64",
  );
  await expect(access(join(directory, "findings.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a chosen direction can be refined once and records the refined rule", async () => {
  const directory = await fixture();
  let ready = false;
  const refineCandidate = vi.fn<ExplorationAdapter["refineCandidate"]>(
    async (input) => {
      expect(input.candidate.label).toBe("A");
      expect(input.instruction).toBe("make it tighter");
      expect(input.rejected).toBeUndefined();
      const evidencePaths = input.evidence.readablePaths.filter((path) =>
        path.includes(".idiom-explore-evidence"),
      );
      expect(evidencePaths.map((path) => basename(path)).sort()).toEqual([
        "baseline-001-screenshot.png",
        "selected-001-screenshot.png",
      ]);
      const [baselineImage, selectedImage] = await Promise.all(
        evidencePaths.map((path) => readFile(path)),
      );
      expect(baselineImage?.equals(selectedImage as Buffer)).toBe(false);
      return {
        direction: "Direction A, tighter",
        choiceKey: "clear-hierarchy-a-tight",
        rule: "Use tighter direction A when grouping primary and secondary controls.",
        reason: "The tighter direction keeps the primary path clear.",
        category: "hierarchy",
        repair: "Regroup existing controls following tighter direction A.",
        references: [],
        edits: [{ path: "src/app.tsx", oldText: "A", newText: "AR" }],
      };
    },
  );
  const runCapture = fakeCapture(() => ready);
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: {
        async preflight() {
          ready = true;
        },
        async proposeCandidates() {
          return [candidate("A"), candidate("B"), candidate("C")];
        },
        refineCandidate,
      },
      runCapture,
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => "make it tighter",
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });
  expect(result.outcome).toBe("rule-only");
  expect(refineCandidate).toHaveBeenCalledTimes(1);
  expect(runCapture).toHaveBeenCalledTimes(5);
  expect(result.ruling).toMatchObject({
    choiceKey: "clear-hierarchy-a-tight",
    wording:
      "Use tighter direction A when grouping primary and secondary controls.",
  });
  expect(await readFile(join(directory, "DESIGN.md"), "utf8")).toContain(
    "Use tighter direction A",
  );
  expect(await readFile(result.reportPath as string, "utf8")).toContain(
    "Direction A, tighter",
  );
  await expect(
    access(
      join(result.runDirectory as string, "candidates", "candidate-a-refined"),
    ),
  ).resolves.toBeUndefined();
  expect(await readFile(join(directory, "src", "app.tsx"), "utf8")).toBe(
    "old\n",
  );
});

test("accepted exploration repairs become ordinary accepted findings and tickets", async () => {
  const directory = await fixture();
  let ready = false;
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: adapter(() => {
        ready = true;
      }),
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => true,
      },
      gitTopology: async () => undefined,
    },
  });
  expect(result).toMatchObject({
    outcome: "rule-plus-tickets",
    ticketCount: 1,
  });
  const stagingTuple = join(
    result.runDirectory as string,
    "candidates",
    ".candidate-a.staging-test",
    "ready",
    "desktop",
  );
  await mkdir(stagingTuple, { recursive: true });
  await writeFile(
    join(stagingTuple, "metadata.json"),
    await readFile(
      join(
        result.runDirectory as string,
        "candidates",
        "candidate-a",
        "ready",
        "desktop",
        "metadata.json",
      ),
    ),
  );
  const baseline = await loadCaptureRun({
    runDirectory: result.runDirectory as string,
    expectedFlow: "fixture",
    stateOrder: ["ready"],
    viewportOrder: ["desktop"],
    colorSchemeOrder: ["light"],
    legacyColorScheme: "light",
  });
  expect(baseline.tuples.map((tuple) => tuple.metadataPath)).toEqual([
    "ready/desktop/metadata.json",
  ]);
  const findings = JSON.parse(
    await readFile(
      join(result.runDirectory as string, "findings.json"),
      "utf8",
    ),
  ) as Array<{ id: string; status: string }>;
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ status: "ticketed" });
  const decisions = await readFile(
    join(directory, ".idiom", "decisions.jsonl"),
    "utf8",
  );
  expect(decisions).toContain(findings[0]?.id);
  expect(decisions).toContain('"decision":"accept"');
  const tickets = await readdir(
    join(directory, ".autobuild", "tickets", "triage"),
  );
  expect(tickets).toHaveLength(1);
  expect(
    await readFile(
      join(directory, ".autobuild", "tickets", "triage", tickets[0] as string),
      "utf8",
    ),
  ).toContain(findings[0]?.id);
  expect(await readFile(join(directory, "src", "app.tsx"), "utf8")).toBe(
    "old\n",
  );
});

test("candidate collisions repair the collided direction instead of the last candidate", async () => {
  const directory = await fixture();
  let ready = false;
  const proposeCandidates = vi.fn<ExplorationAdapter["proposeCandidates"]>(
    async (input) => {
      if (input.rejected === undefined) {
        const duplicateB: ExplorationCandidate = candidate("B");
        duplicateB.edits = [
          { path: "src/app.tsx", oldText: "old", newText: "A\n" },
        ];
        return [candidate("A"), duplicateB, candidate("C")];
      }
      expect(input.rejected.candidate.label).toBe("B");
      expect(input.rejected.issues.join(" ")).toContain(
        "candidates A and B render identically",
      );
      return [candidate("A"), candidate("B"), candidate("C")];
    },
  );
  const runCapture = fakeCapture(() => ready);
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: {
        async preflight() {
          ready = true;
        },
        proposeCandidates,
        async refineCandidate() {
          throw new Error("not requested");
        },
      },
      runCapture,
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });
  expect(result.outcome).toBe("rule-only");
  expect(proposeCandidates).toHaveBeenCalledTimes(2);
  expect(runCapture).toHaveBeenCalledTimes(5);
});

test("multi-scheme exploration roots load only baseline tuples after candidates exist", async () => {
  const directory = await fixture(["light", "dark"]);
  let ready = false;
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: adapter(() => {
        ready = true;
      }),
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });
  const loaded = await loadCaptureRun({
    runDirectory: result.runDirectory as string,
    expectedFlow: "fixture",
    stateOrder: ["ready"],
    viewportOrder: ["desktop"],
    colorSchemeOrder: ["light", "dark"],
    legacyColorScheme: "light",
  });
  expect(loaded.tuples.map((tuple) => tuple.metadataPath)).toEqual([
    "ready/desktop/light/metadata.json",
    "ready/desktop/dark/metadata.json",
  ]);
  expect(
    loaded.tuples.every((tuple) => !tuple.metadataPath.includes("candidates/")),
  ).toBe(true);
});

test("decision steering reuses the reviewed question and ruling identity", async () => {
  const directory = await fixture();
  const reviewRun = join(directory, ".idiom", "reports", "review-run");
  await mkdir(reviewRun, { recursive: true });
  await writeUnruledDecisions(reviewRun, [
    {
      id: "ruling-7",
      fingerprint: "reviewed-fingerprint",
      choiceKey: "reviewed-choice",
      question: "Which hierarchy should govern?",
      nearestLawExcerpt: "Keep actions clear.",
      occurrences: [
        {
          state: "ready",
          viewport: "desktop",
          screenshot: "ready/desktop/screenshot.png",
        },
        {
          state: "other",
          viewport: "desktop",
          screenshot: "other/desktop/screenshot.png",
        },
      ],
      candidates: [],
    },
  ]);
  let ready = false;
  const proposeCandidates = vi.fn<ExplorationAdapter["proposeCandidates"]>(
    async (input) => {
      expect(input.context.question).toBe("Which hierarchy should govern?");
      expect(input.context.decision?.id).toBe("ruling-7");
      return [candidate("A"), candidate("B"), candidate("C")];
    },
  );
  const result = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    decision: "ruling-7",
    dependencies: {
      adapter: {
        async preflight() {
          ready = true;
        },
        proposeCandidates,
        async refineCandidate() {
          throw new Error("not requested");
        },
      },
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async (reason) => reason,
        repairs: async () => false,
      },
      gitTopology: async () => undefined,
    },
  });
  expect(proposeCandidates).toHaveBeenCalledTimes(1);
  expect(result.ruling).toMatchObject({
    id: "ruling-7",
    fingerprint: "reviewed-fingerprint",
    choiceKey: "reviewed-choice",
  });
  expect(await readFile(join(directory, "DESIGN.md"), "utf8")).toContain(
    "reviewed-fingerprint",
  );
  expect(await readFile(join(directory, "src", "app.tsx"), "utf8")).toBe(
    "old\n",
  );
});

test("detached generation publishes complete evidence and resolves to the same ruling as live", async () => {
  const liveDirectory = await fixture();
  const deferredDirectory = await fixture();
  const now = () => new Date("2026-08-29T12:00:00.000Z");
  const reason = "It makes the primary path obvious.";
  const makeDependencies = (ready: { value: boolean }) => ({
    adapter: adapter(() => {
      ready.value = true;
    }),
    runCapture: fakeCapture(() => ready.value),
    capture: {
      snapshotSource: async () => ({ commit: "abc", dirty: false }),
    },
    clock: now,
    decide: { now },
    gitTopology: async () => undefined,
  });
  const liveReady = { value: false };
  const liveDiffs: string[] = [];
  const live = await exploreCommand({
    project: liveDirectory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    write: (message) => liveDiffs.push(message),
    dependencies: {
      ...makeDependencies(liveReady),
      hasTTY: () => true,
      confirm: async () => true,
      prompts: {
        choose: async () => "A",
        refinement: async () => undefined,
        reason: async () => reason,
        repairs: async () => true,
      },
    },
  });

  const deferredReady = { value: false };
  const prompt = vi.fn(async () => {
    throw new Error("detached generation must not prompt");
  });
  const messages: string[] = [];
  const pending = await exploreCommand({
    project: deferredDirectory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    write: (message) => messages.push(message),
    dependencies: {
      ...makeDependencies(deferredReady),
      hasTTY: () => false,
      prompts: {
        choose: prompt,
        refinement: prompt,
        reason: prompt,
        repairs: prompt,
      },
    },
  });
  expect(pending.outcome).toBe("pending");
  expect(prompt).not.toHaveBeenCalled();
  expect(messages.join("\n")).toContain("idiom explore resolve");
  const runId = basename(pending.runDirectory as string);
  for (const artifact of ["exploration.json", "exploration.md", "report.html"])
    await expect(
      access(join(pending.runDirectory as string, artifact)),
    ).resolves.toBeUndefined();

  const deferredDiffs: string[] = [];
  const deferred = await exploreResolveCommand({
    project: deferredDirectory,
    runId,
    candidate: "A",
    reason,
    yes: true,
    repairs: true,
    dependencies: {
      clock: now,
      decide: { now },
      gitTopology: async () => undefined,
    },
    write: (message) => deferredDiffs.push(message),
  });
  expect(deferred.outcome).toBe("rule-plus-tickets");
  expect(live.outcome).toBe("rule-plus-tickets");
  expect(deferred.ruling).toEqual(live.ruling);
  expect(await readFile(join(deferredDirectory, "DESIGN.md"), "utf8")).toBe(
    await readFile(join(liveDirectory, "DESIGN.md"), "utf8"),
  );
  expect(deferredDiffs.at(-1)).toBe(liveDiffs.at(-1));
  expect(
    await readFile(
      join(deferred.runDirectory as string, "findings.json"),
      "utf8",
    ),
  ).toBe(
    await readFile(join(live.runDirectory as string, "findings.json"), "utf8"),
  );
  expect(
    JSON.parse(
      await readFile(
        join(pending.runDirectory as string, "exploration.json"),
        "utf8",
      ),
    ).resolution,
  ).toMatchObject({ outcome: "rule", selected: "A", repairs: true });
});

test("deferred no-choice changes only lifecycle state and cannot be recorded twice", async () => {
  const directory = await fixture();
  let ready = false;
  const beforeLaw = await readFile(join(directory, "DESIGN.md"), "utf8");
  const pending = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "The hierarchy is weak",
    dependencies: {
      adapter: adapter(() => {
        ready = true;
      }),
      runCapture: fakeCapture(() => ready),
      capture: {
        snapshotSource: async () => ({ commit: "abc", dirty: false }),
      },
      clock: () => new Date("2026-08-29T13:00:00.000Z"),
      hasTTY: () => false,
      gitTopology: async () => undefined,
    },
  });
  const runId = basename(pending.runDirectory as string);
  const result = await exploreResolveCommand({
    project: directory,
    runId,
    none: true,
    reason: "None establishes a useful reusable rule.",
    yes: true,
    dependencies: {
      clock: () => new Date("2026-08-29T14:00:00.000Z"),
    },
  });
  expect(result.outcome).toBe("none");
  expect(await readFile(join(directory, "DESIGN.md"), "utf8")).toBe(beforeLaw);
  const manifest = JSON.parse(
    await readFile(
      join(pending.runDirectory as string, "exploration.json"),
      "utf8",
    ),
  );
  expect(manifest.resolution).toEqual({
    outcome: "none",
    reason: "None establishes a useful reusable rule.",
    recordedAt: "2026-08-29T14:00:00.000Z",
  });
  await expect(
    exploreResolveCommand({
      project: directory,
      runId,
      candidate: "A",
      reason: "Changed my mind.",
      yes: true,
    }),
  ).rejects.toThrow("already resolved");
  expect(await readFile(join(directory, "DESIGN.md"), "utf8")).toBe(beforeLaw);
});

test("a ruling for one candidate does not resolve later runs that merely offered it", async () => {
  const directory = await fixture();
  let ready = false;
  const shared = {
    adapter: adapter(() => {
      ready = true;
    }),
    runCapture: fakeCapture(() => ready),
    capture: {
      snapshotSource: async () => ({ commit: "abc", dirty: false }),
    },
    confirm: async () => true,
    gitTopology: async () => undefined,
  };
  const prompts = (choice: "A" | "B") => ({
    choose: async () => choice,
    refinement: async () => undefined,
    reason: async (reason: string) => reason,
    repairs: async () => false,
  });
  const first = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "First question",
    dependencies: {
      ...shared,
      clock: () => new Date("2026-08-29T15:00:00.000Z"),
      prompts: prompts("A"),
    },
  });
  expect(first.ruling?.choiceKey).toBe("clear-hierarchy-a");

  const second = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "Different question",
    dependencies: {
      ...shared,
      clock: () => new Date("2026-08-29T16:00:00.000Z"),
      prompts: prompts("B"),
    },
  });
  expect(second.outcome).toBe("rule-only");
  expect(second.ruling).toMatchObject({
    id: "ruling-2",
    choiceKey: "clear-hierarchy-b",
  });

  const pending = await exploreCommand({
    project: directory,
    flow: "fixture",
    state: "ready",
    question: "No direction is suitable",
    dependencies: {
      ...shared,
      clock: () => new Date("2026-08-29T17:00:00.000Z"),
      hasTTY: () => false,
    },
  });
  const none = await exploreResolveCommand({
    project: directory,
    runId: basename(pending.runDirectory as string),
    none: true,
    reason: "None should govern this surface.",
    yes: true,
    dependencies: {
      clock: () => new Date("2026-08-29T18:00:00.000Z"),
    },
  });
  expect(none.outcome).toBe("none");
});
