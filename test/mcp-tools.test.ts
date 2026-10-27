import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, test, vi } from "vitest";
import { initProject } from "../src/commands/init.js";
import { critiqueResult } from "../src/critique/types.js";
import { appendDecision, readDecisionLog } from "../src/decisions/log.js";
import type { McpDependencies } from "../src/mcp/tools.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { commit, git } from "./baseline-support.js";
import { mcpClient, toolData } from "./mcp-support.js";
import { storedRun, studioProject } from "./stored-run-support.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "idiom-mcp-")));
  directories.push(path);
  return path;
}
async function connect(project: string, dependencies?: McpDependencies) {
  const session = await mcpClient({ project, dependencies });
  cleanups.push(session.close);
  return session.client;
}
const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
const errorText = (response: CallToolResult) => {
  expect(response.isError).toBe(true);
  return JSON.stringify(response.content);
};

async function siteProject() {
  const project = await temporary();
  await initProject({ project, yes: true });
  await writeFile(
    join(project, ".idiom/flows/site.json"),
    JSON.stringify({
      id: "site",
      title: "Site",
      intent: [],
      setup: [],
      states: [
        {
          id: "home",
          description: "Home",
          url: "/",
          expect: { status: 200 },
        },
      ],
    }),
  );
  return project;
}

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return findingSchema.parse({
    id,
    fingerprint: `fingerprint-${id}`,
    createdAt: "2026-10-26T12:00:00.000Z",
    commit: "abc123",
    flow: "site",
    state: "home",
    viewport: "desktop",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    evidence: { screenshots: [] },
    explanation: `${id} is too small.`,
    acceptance: ["Actions are at least 44 by 44 CSS pixels."],
    verification: {
      kind: "deterministic-check",
      check: "target-size",
      params: { selector: `#${id}` },
    },
    status: "open",
    ...overrides,
  });
}
async function storeFindings(project: string, findings: Finding[]) {
  const run = join(project, ".idiom/reports/2026-10-26T12-00-00-000Z");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "findings.json"), JSON.stringify(findings));
  return run;
}

test("idiom_init scaffolds the bound root without touching stdout and reports next steps", async () => {
  const project = await temporary();
  const client = await connect(project, {
    init: {
      generateFlows: async () => ({
        content: `${JSON.stringify({
          id: "site",
          title: "Site",
          intent: [],
          setup: [],
          states: [{ id: "home", description: "Home", url: "/" }],
        })}\n`,
        routeCount: 1,
        stateCount: 1,
        warnings: [],
        todos: [],
        setup: [],
      }),
    },
  });
  const stdout = vi.spyOn(process.stdout, "write");
  const first = toolData<{
    created: string[];
    nextSteps: string[];
    flows: { kind: string };
  }>(await call(client, "idiom_init", {}));
  expect(stdout).not.toHaveBeenCalled();
  expect(first.created).toEqual(
    expect.arrayContaining(["PRODUCT.md", "DESIGN.md"]),
  );
  expect(first.flows).toEqual({ kind: "not-requested" });
  expect(first.nextSteps.join(" ")).toContain("idiom_context");
  const second = await call(client, "idiom_init", { flows: true });
  const data = toolData<{
    unchanged: string[];
    flows: { kind: string; content?: string };
    nextSteps: string[];
  }>(second);
  expect(data.unchanged).toContain("PRODUCT.md");
  expect(data.flows.kind).toBe("generated");
  expect(data.flows).not.toHaveProperty("content");
  expect(data.nextSteps.join(" ")).toContain("idiom_check with flow site");
  expect(JSON.stringify(second.content)).toContain(
    "Next: idiom_flows; idiom_check site",
  );
  expect(
    JSON.parse(await readFile(join(project, ".idiom/flows/site.json"), "utf8"))
      .id,
  ).toBe("site");
  expect(stdout).not.toHaveBeenCalled();
});

test("idiom_design_add stores local designs relative, refuses escapes and needs FIGMA_TOKEN in the server env", async () => {
  const project = await siteProject();
  const outside = await temporary();
  await writeFile(join(outside, "design.html"), "<h1>Outside</h1>");
  await writeFile(join(project, "design.html"), "<h1>Design</h1>");
  await symlink(outside, join(project, "linked"));
  const client = await connect(project);
  const flowPath = join(project, ".idiom/flows/site.json");
  expect(
    toolData(
      await call(client, "idiom_design_add", {
        state: "home",
        source: "design.html",
      }),
    ),
  ).toMatchObject({ changed: true, source: "design.html", figma: false });
  const before = await readFile(flowPath, "utf8");
  for (const source of [
    join(outside, "design.html"),
    "../design.html",
    "linked/design.html",
  ])
    expect(
      errorText(
        await call(client, "idiom_design_add", { state: "home", source }),
      ),
    ).toContain("inside the bound project root");
  const figma = "https://www.figma.com/design/abc/File?node-id=1-2";
  vi.stubEnv("FIGMA_TOKEN", "");
  const missing = errorText(
    await call(client, "idiom_design_add", {
      state: "home",
      source: figma,
      name: "figma",
    }),
  );
  expect(missing).toContain("FIGMA_TOKEN");
  expect(missing).toContain("restart the server");
  expect(await readFile(flowPath, "utf8")).toBe(before);
  vi.stubEnv("FIGMA_TOKEN", "figd_test");
  expect(
    toolData(
      await call(client, "idiom_design_add", {
        state: "home",
        source: figma,
        name: "figma",
      }),
    ),
  ).toMatchObject({ changed: true, figma: true });
  expect(JSON.parse(await readFile(flowPath, "utf8")).states[0].design).toEqual(
    [{ source: "design.html" }, { source: figma, name: "figma" }],
  );
});

test("idiom_choose records exactly the human's reference with the reason verbatim", async () => {
  const project = await siteProject();
  const reference = (name: string, value: number) => ({
    name,
    source: `${name}.html`,
    value,
    matchesBuild: false,
    pairId: `pair-${name}`,
    designSelector: ".card",
  });
  const decision = finding("finding-1", {
    category: "design-drift",
    rule: "idiom:design-decision",
    evidence: {
      screenshots: [],
      designDrift: {
        version: 1,
        pairId: "pair-figma",
        method: "root",
        property: "borderTopLeftRadius",
        designValue: 8,
        appValue: 4,
        designSelector: ".card",
        appSelector: ".card",
        designDecision: {
          version: 1,
          decisionKey: "home:.card:borderTopLeftRadius",
          property: "borderTopLeftRadius",
          appSelector: ".card",
          appValue: 4,
          references: [reference("figma", 8), reference("prototype", 12)],
        },
      },
    },
  } as Partial<Finding>);
  await storeFindings(project, [decision, finding("finding-2")]);
  const client = await connect(project);
  expect(
    errorText(
      await call(client, "idiom_choose", {
        id: "finding-1",
        reference: "sketch",
        reason: "Because",
      }),
    ),
  ).toContain("choose one of figma, prototype");
  expect(
    errorText(
      await call(client, "idiom_choose", {
        id: "finding-2",
        reference: "figma",
        reason: "Because",
      }),
    ),
  ).toContain("only to design decisions");
  expect(
    errorText(
      await call(client, "idiom_choose", {
        id: "quick:run:finding-1",
        reference: "figma",
        reason: "Because",
      }),
    ),
  ).toContain("Quick-only evidence");
  expect(
    (
      await call(client, "idiom_choose", {
        id: "finding-1",
        reference: "figma",
        reason: "",
      })
    ).isError,
  ).toBe(true);
  expect(await readDecisionLog(project)).toEqual([]);
  const reason = "  Figma is the source of truth  ";
  expect(
    toolData(
      await call(client, "idiom_choose", {
        id: "finding-1",
        reference: "figma",
        reason,
      }),
    ),
  ).toMatchObject({ accepted: 1, choice: "figma" });
  const [record] = await readDecisionLog(project);
  expect(record).toMatchObject({
    decision: "accept",
    reason,
    designChoice: { reference: "figma" },
  });
});

test("idiom_tickets writes accepted clusters to triage inside the bound root only", async () => {
  const project = await siteProject();
  const outside = await temporary();
  await symlink(outside, join(project, "elsewhere"));
  const findings = [finding("finding-1"), finding("finding-2")];
  await storeFindings(project, findings);
  await appendDecision({
    projectDirectory: project,
    finding: findings[0] as Finding,
    decision: "accept",
    scope: "instance",
  });
  const client = await connect(project);
  for (const out of ["../elsewhere", "elsewhere/triage"])
    expect(errorText(await call(client, "idiom_tickets", { out }))).toContain(
      "inside the bound project root",
    );
  const data = toolData<{
    outputDirectory: string;
    createdPaths: string[];
    ineligible: string[];
  }>(await call(client, "idiom_tickets", {}));
  expect(data.outputDirectory).toBe(join(project, ".autobuild/tickets/triage"));
  expect(data.createdPaths).toHaveLength(1);
  expect(data.createdPaths.every((path) => isAbsolute(path))).toBe(true);
  expect(data.createdPaths[0]?.startsWith(data.outputDirectory)).toBe(true);
  expect(data.ineligible).toEqual(["finding-2"]);
});

test("idiom_coverage lists routes no flow captures", async () => {
  const project = await siteProject();
  for (const path of ["app/page.tsx", "app/settings/page.tsx"]) {
    await mkdir(join(project, path, ".."), { recursive: true });
    await writeFile(join(project, path), "export default () => null;\n");
  }
  const client = await connect(project);
  const response = await call(client, "idiom_coverage", {});
  const data = toolData<{
    routes: Array<{ route: string; capturedBy: unknown[] }>;
  }>(response);
  expect(
    data.routes
      .filter((route) => route.capturedBy.length === 0)
      .map((route) => route.route),
  ).toEqual(["/settings"]);
  expect(JSON.stringify(response.content)).toContain("1 uncaptured");
});

test("idiom_baseline show reports recorded commits and the record applied at HEAD", async () => {
  const project = await siteProject();
  await git(project, "init", "-q", "-b", "main");
  const head = await commit(project, "initial");
  const client = await connect(project);
  const empty = toolData<{ records: unknown[]; guidance: string }>(
    await call(client, "idiom_baseline", { action: "show" }),
  );
  expect(empty.records).toEqual([]);
  expect(empty.guidance).toContain("action record");
  await mkdir(join(project, ".idiom/baselines"), { recursive: true });
  await writeFile(
    join(project, ".idiom/baselines/site.json"),
    JSON.stringify({
      version: 1,
      flow: "site",
      records: [
        {
          commit: head,
          recordedAt: "2026-10-26T12:00:00.000Z",
          idiomVersion: "test",
          configHash: `sha256:${"0".repeat(64)}`,
          tuples: [
            {
              state: "home",
              viewport: "desktop",
              findings: [
                {
                  fingerprint: "abc",
                  aliases: [],
                  category: "contrast",
                  rule: "idiom:contrast",
                  severity: "major",
                  selector: "p",
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  await commit(project, "baseline");
  const response = await call(client, "idiom_baseline", {
    action: "show",
    flow: "site",
  });
  expect(toolData(response)).toMatchObject({
    flow: "site",
    applied: head,
    distance: 1,
    records: [{ commit: head, findingCount: 1, tupleCount: 1 }],
  });
  expect(JSON.stringify(response.content)).toContain("deliberately");
});

test("idiom_sweep returns a degraded critique as a result, emits progress and confines emitted tickets", async () => {
  const { project, commit: head } = await studioProject(directories, [
    "editor",
  ]);
  const runId = "2026-10-26T12-00-00-000Z";
  await storedRun(project, runId, head, [
    { state: "editor", html: "before.html" },
  ]);
  const client = await connect(project, {
    review: {
      critique: {
        async critique() {
          throw new Error("model unavailable");
        },
      },
    },
  });
  const refused = errorText(
    await call(client, "idiom_sweep", {
      flow: "studio-lab",
      from: runId,
      emitTickets: "../triage",
    }),
  );
  expect(refused).toContain("inside the bound project root");
  const progress: string[] = [];
  const response = (await client.callTool(
    { name: "idiom_sweep", arguments: { flow: "studio-lab", from: runId } },
    { onprogress: (event) => progress.push(event.message ?? "") },
  )) as CallToolResult;
  const data = toolData<{
    degraded: boolean;
    outcome: { kind: string; reason?: string };
    findings: Array<{ screenshot?: string }>;
  }>(response);
  expect(data.degraded).toBe(true);
  expect(data.outcome.reason).toContain("model unavailable");
  expect(
    data.findings.every(
      (item) => item.screenshot === undefined || isAbsolute(item.screenshot),
    ),
  ).toBe(true);
  expect(progress).toContain("Tool complete");
  expect(JSON.stringify(response.content)).toContain("Model critique degraded");
  const healthy = await connect(project, {
    review: {
      critique: { critique: async () => critiqueResult({ findings: [] }) },
    },
  });
  expect(
    toolData<{ degraded: boolean }>(
      await call(healthy, "idiom_sweep", { flow: "studio-lab", from: runId }),
    ).degraded,
  ).toBe(false);
}, 60_000);

test("idiom_sweep all selector and budgets share command validation and deterministic-only needs no provider", async () => {
  const { productFixture } = await import("./sweep-all-support.js");
  const project = await productFixture(directories);
  const client = await connect(project, {
    review: {
      createCritiqueAdapter() {
        throw new Error("must not call provider");
      },
    },
  });
  for (const args of [
    {},
    { flow: "alpha", all: true },
    { all: true, latest: true },
    { all: true, from: "old" },
    { all: true, maxTickets: 0 },
    { all: true, maxTickets: 1.5 },
  ]) {
    expect((await call(client, "idiom_sweep", args)).isError).toBe(true);
  }
  expect(
    errorText(
      await call(client, "idiom_sweep", {
        all: true,
        emitTickets: "../outside",
      }),
    ),
  ).toMatch(/inside the bound project root/);
  const output = toolData<Record<string, unknown>>(
    await call(client, "idiom_sweep", {
      all: true,
      deterministicOnly: true,
      maxTickets: 1,
    }),
  );
  expect(output).toMatchObject({
    scope: "all",
    degraded: false,
    selectedCount: 1,
  });
  const proposals = output.proposals as Array<{
    cluster: {
      members: Array<{
        record: { runDirectory: string; evidencePaths: string[] };
      }>;
    };
  }>;
  for (const proposal of proposals)
    for (const { record } of proposal.cluster.members) {
      expect(record.evidencePaths.length).toBeGreaterThan(0);
      for (const path of record.evidencePaths) {
        expect(isAbsolute(path)).toBe(true);
        expect(path.startsWith(await realpath(record.runDirectory))).toBe(true);
      }
    }
}, 60_000);
