import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { sweepCommand } from "../src/commands/sweep.js";
import { loadReviewCatalog } from "../src/review/catalog.js";
import { indexTickets } from "../src/tickets/index.js";
import { validateProject } from "../src/validation.js";
import {
  readVerificationSpec,
  selectFindingTuples,
} from "../src/verify/spec.js";
import { productFixture } from "./sweep-all-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

test("fresh two-flow deterministic sweep keeps every tuple, shared cause and independently valid verification sidecar", async () => {
  const project = await productFixture(directories);
  const summary = await sweepCommand({
    all: true,
    project,
    deterministicOnly: true,
    emitTickets: join(project, "tickets/triage"),
    dependencies: {
      createCritiqueAdapter() {
        throw new Error("model must be skipped");
      },
      capture: { now: () => new Date("2026-10-27T00:00:00Z") },
    },
  });
  expect(summary.flows.map((f) => f.flow)).toEqual(["alpha", "beta"]);
  expect(summary.outcome.kind).toBe("deterministic-only");
  for (const f of summary.flows) {
    expect(f.status).toBe("reviewed");
    if (f.status !== "reviewed") continue;
    expect(f.coverage.reportCoverage?.successfulTuples).toBe(
      f.flow === "alpha" ? 2 : 1,
    );
    expect(f.coverage.checkCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "motion", status: "ran" }),
      ]),
    );
    expect(f.coverage.scope?.probe.executed).toHaveLength(1);
    expect(f.coverage.probes?.some((p) => p.probe?.results.length)).toBe(true);
    await access(join(f.summary.runDirectory, "occurrences.json"));
  }
  const shared = summary.proposals.filter(
    (p) => p.cluster.cause?.key === "idiom-name:SharedAction",
  );
  expect(shared).toHaveLength(1);
  expect(
    new Set(shared[0]?.cluster.members.map((m) => m.record.finding.flow)),
  ).toEqual(new Set(["alpha", "beta"]));
  expect(summary.occurrenceCount).toBeGreaterThan(summary.findings.length);
  const validation = await validateProject({ project });
  let sidecars = 0;
  for (const path of summary.tickets?.createdPaths ?? []) {
    const body = await readFile(path, "utf8");
    expect(body).toContain("Paste-ready repair instruction");
    expect(body).toContain("Temporal filmstrip unavailable");
    for (const command of body.matchAll(
      /idiom verify '([^']+)' --spec '([^']+)' --project '([^']+)'/g,
    )) {
      const findings = await readVerificationSpec(command[2] as string);
      const flow = validation.flows.find((f) => f.flow.id === command[1])?.flow;
      expect(flow).toBeDefined();
      if (!flow) throw new Error("missing flow");
      const tuples = selectFindingTuples({
        findings,
        flow,
        project: validation.project,
      });
      expect(tuples.length).toBeGreaterThan(0);
      for (const finding of findings)
        for (const evidence of finding.evidence.screenshots) {
          const source = summary.flows.find((f) => f.flow === finding.flow);
          if (source?.status === "reviewed")
            await access(join(source.summary.runDirectory, evidence));
        }
      sidecars++;
    }
  }
  expect(sidecars).toBeGreaterThan(summary.tickets?.createdPaths.length ?? 0);
  const indexed = await indexTickets([join(project, "tickets")]);
  expect(indexed.length).toBe(summary.tickets?.createdPaths.length);
  const catalog = await loadReviewCatalog({ project });
  expect(catalog.runs).toHaveLength(2);
  const md = await readFile(summary.reportPath, "utf8");
  expect(md).toContain("800×600");
  expect(md).toContain("360×640");
  expect(md).toContain("Sibling coordinates have no probe evidence");
  expect(
    JSON.parse(await readFile(summary.jsonPath, "utf8")).findings,
  ).toHaveLength(summary.findings.length);
  expect(await readdir(summary.runDirectory)).toEqual([
    "polish.html",
    "polish.json",
    "polish.md",
  ]);
}, 60_000);
