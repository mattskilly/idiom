import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { PNG } from "pngjs";
import { afterEach, expect, test } from "vitest";
import { readDecisionLog } from "../src/decisions/log.js";
import {
  eligibleRecords,
  selectTargets,
  takeFixSnapshot,
} from "../src/fix/check.js";
import { repairPrompt } from "../src/fix/prompt.js";
import type { Finding } from "../src/schemas/finding.js";
import { baselineProject, commit, git } from "./baseline-support.js";
import { fixture } from "./benchmark-support.js";
import { mcpClient, toolData } from "./mcp-support.js";

type Ref = { id: string; runId: string };
type Detail = {
  id: string;
  runId: string;
  finding: Finding;
  cropPath: string;
  selector?: string;
  measurement: { explanation: string; verification: Finding["verification"] };
  fix: { instructions?: string; acceptance: string[] };
  verificationReference: Ref;
};
type Check = {
  runId: string;
  issues: Array<{ id: string; groups: string[] }>;
  topIssues: Array<{ id: string; groups: string[]; representative: Detail }>;
  findings: Detail[];
  groups: Array<{ id: string; members: Array<{ id: string }> }>;
  verificationReferences: Ref[];
  counts: {
    findings: number;
    new: number;
    fixed: number;
    preExisting: number;
    captures: { total: number };
  };
  reports: { findings: string; markdown: string; html: string };
  coverage: { states: string[]; selectedTuples: number };
  baselineRecorded?: { path: string };
  baseline: object;
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "idiom-mcp-browser-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function configured(html: string, states = ["editor"]) {
  const setup = await baselineProject({ states, required: [], maxFindings: 1 });
  cleanups.push(() => rm(setup.project, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(setup.configPath, "utf8"));
  config.server = {
    build: "node -e 0",
    start: "node server.mjs",
    port: 3299,
    readyUrl: "http://127.0.0.1:3299",
    env: {},
  };
  config.capture.settleMs = 0;
  config.checks = { probe: { enabled: false } };
  await writeFile(setup.configPath, JSON.stringify(config));
  await writeFile(join(setup.project, "page.html"), html);
  await writeFile(join(setup.project, "other.html"), html);
  await writeFile(
    join(setup.project, "server.mjs"),
    `import {createServer} from 'node:http'; import {readFile} from 'node:fs/promises';
createServer(async (req,res)=>{res.setHeader('content-type','text/html');res.end(await readFile(req.url==='/other'?'other.html':'page.html'));}).listen(Number(process.env.PORT),'127.0.0.1');`,
  );
  const flowPath = join(setup.project, ".idiom/flows/studio.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8"));
  flow.states.forEach((state: { id: string; url: string }) => {
    state.url = state.id === "other" ? "/other" : "/";
  });
  await writeFile(flowPath, JSON.stringify(flow));
  await commit(setup.project, "MCP application");
  const session = await mcpClient({ project: setup.project });
  cleanups.push(session.close);
  return { ...setup, ...session };
}

test("real benchmark quick/check/issue expose ranked complete findings and the actual crop bytes", async () => {
  const html = await fixture("before.html");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const directory = await temporary();
  const quickSession = await mcpClient({ cwd: directory });
  cleanups.push(quickSession.close);
  const quick = toolData<Check>(
    await quickSession.client.callTool({
      name: "idiom_quick",
      arguments: {
        url: `http://127.0.0.1:${address.port}`,
        viewports: ["mobile"],
      },
    }),
  );
  expect(quick.topIssues.length).toBeGreaterThan(0);
  expect(quick.topIssues.length).toBeLessThanOrEqual(5);
  expect(quick.counts.findings).toBeGreaterThan(5);
  expect(quick.counts.captures.total).toBe(2);
  expect(
    quick.findings.every(
      (detail) =>
        detail.id.startsWith(`quick:${quick.runId}:`) &&
        detail.finding.viewport === "mobile",
    ),
  ).toBe(true);
  const chosen = quick.findings.find((detail) =>
    detail.cropPath?.includes("/crops/"),
  );
  if (!chosen) throw new Error("Missing real quick crop");
  const issue = (await quickSession.client.callTool({
    name: "idiom_issue",
    arguments: { id: chosen.id },
  })) as CallToolResult;
  const image = issue.content.find((block) => block.type === "image");
  if (image?.type !== "image") throw new Error("Missing image");
  expect(Buffer.from(image.data, "base64")).toEqual(
    await readFile(chosen.cropPath),
  );
  expect(
    PNG.sync.read(Buffer.from(image.data, "base64")).width,
  ).toBeGreaterThan(0);
  expect(toolData<Detail>(issue).measurement.explanation).toBe(
    chosen.finding.explanation,
  );
  expect(
    (
      (await quickSession.client.callTool({
        name: "idiom_decide",
        arguments: { id: chosen.id, decision: "accept", reason: "test" },
      })) as CallToolResult
    ).isError,
  ).toBe(true);
  // A new HTTP server factory already exercises reload from the persisted quick index.
  expect(
    (
      (await quickSession.client.callTool({
        name: "idiom_issue",
        arguments: { id: chosen.finding.id },
      })) as CallToolResult
    ).isError,
  ).toBe(true);

  const { client, project } = await configured(
    html.replace(
      "</body>",
      `<a id="sibling-1" href="#one" aria-label="One" style="display:inline-block;width:12px;height:12px;font-size:0">One</a><a id="sibling-2" href="#two" aria-label="Two" style="display:inline-block;width:12px;height:12px;font-size:0">Two</a></body>`,
    ),
    ["editor", "other"],
  );
  const response = toolData<Check>(
    await client.callTool({
      name: "idiom_check",
      arguments: { flow: "studio", all: true },
    }),
  );
  expect(response.counts.findings).toBeGreaterThan(5);
  expect(response.coverage.selectedTuples).toBe(2);
  const stored = JSON.parse(
    await readFile(response.reports.findings, "utf8"),
  ) as Finding[];
  for (const detail of response.findings) {
    expect(detail.finding).toEqual(
      stored.find((finding) => finding.id === detail.id),
    );
    expect(detail.selector).toBe(detail.finding.verification.params?.selector);
    expect(detail.fix.acceptance).toEqual(detail.finding.acceptance);
    if (detail.cropPath) expect(isAbsolute(detail.cropPath)).toBe(true);
  }
  const group = response.groups.find((group) => group.members.length > 1);
  if (!group) throw new Error("Expected repeated group");
  const groupResponse = toolData<{
    group: { members: unknown[] };
    members: Detail[];
  }>(
    await client.callTool({ name: "idiom_issue", arguments: { id: group.id } }),
  );
  expect(groupResponse.group.members.length).toBeGreaterThan(1);
  expect(groupResponse.members.length).toBeGreaterThan(1);
  const cropped = response.findings.find((finding) =>
    finding.cropPath?.includes("/crops/"),
  );
  if (!cropped) throw new Error("No configured crop");
  const configuredImage = (
    (await client.callTool({
      name: "idiom_issue",
      arguments: { id: cropped.id },
    })) as CallToolResult
  ).content.find((content) => content.type === "image");
  expect(
    configuredImage?.type === "image" &&
      Buffer.from(configuredImage.data, "base64"),
  ).toEqual(await readFile(cropped.cropPath));
  expect(
    response.findings.every((finding) => !finding.id.startsWith("quick:")),
  ).toBe(true);
  const reason =
    "  This exact group is intentional.\nKeep the sibling judgment separate.  ";
  const decision = toolData<{ accepted: number }>(
    await client.callTool({
      name: "idiom_decide",
      arguments: { id: group.id, decision: "accept", reason },
    }),
  );
  expect(decision.accepted).toBe(group.members.length);
  expect(
    (await readDecisionLog(project)).every((entry) => entry.reason === reason),
  ).toBe(true);
  const siblings = response.issues.find((issue) => issue.groups.length > 1);
  expect(siblings).toBeDefined();
  const siblingId = siblings?.groups[0];
  if (!siblingId) throw new Error("No sibling issue");
  const siblingDetail = toolData<{
    siblingGroups: Array<{ id: string }>;
    group: { members: Array<{ id: string }> };
  }>(
    await client.callTool({
      name: "idiom_issue",
      arguments: { id: siblingId },
    }),
  );
  expect(siblingDetail.siblingGroups.length).toBeGreaterThan(0);
  const rejection = toolData<{ rejected: number }>(
    await client.callTool({
      name: "idiom_decide",
      arguments: {
        id: siblingId,
        decision: "reject",
        reason: "Intentional exact group",
      },
    }),
  );
  expect(rejection.rejected).toBe(siblingDetail.group.members.length);
  const rejectedIds = new Set(
    siblingDetail.group.members.map((member) => member.id),
  );
  const loggedRejections = (await readDecisionLog(project)).filter(
    (entry) => entry.decision === "reject",
  );
  expect(loggedRejections).toHaveLength(rejectedIds.size);
  const prompt = toolData<{ findings: Finding[]; prompt: string }>(
    await client.callTool({
      name: "idiom_fix_plan",
      arguments: { flow: "studio", top: 100 },
    }),
  );
  expect(prompt.findings.every((finding) => !rejectedIds.has(finding.id))).toBe(
    true,
  );
  const scoped = toolData<Check>(
    await client.callTool({
      name: "idiom_check",
      arguments: {
        flow: "studio",
        all: true,
        states: ["other"],
        viewports: ["desktop"],
      },
    }),
  );
  expect(scoped.coverage.states).toEqual(["other"]);
  expect(scoped.coverage.selectedTuples).toBe(1);
  const incomplete = (await client.callTool({
    name: "idiom_verify",
    arguments: {
      flow: "studio",
      findings: scoped.verificationReferences.slice(0, 1),
    },
  })) as CallToolResult;
  expect(incomplete.isError).toBe(true);
  expect(JSON.stringify(incomplete.content)).toContain("full-flow");
  const invalid = (await client.callTool({
    name: "idiom_check",
    arguments: { flow: "studio", all: true, states: ["unknown"] },
  })) as CallToolResult;
  expect(invalid.isError).toBe(true);
}, 180000);

const page = (size: number, extra = "") =>
  `<!doctype html><html lang="en"><head><title>Repair</title><style>body{background:#fff;color:#111;font:16px sans-serif;margin:32px}button{width:${size}px;height:${size}px;padding:0;border:0;font-size:10px}main{width:300px}</style></head><body><main><h1>Repair</h1><span style="display:inline-flex;align-items:center;gap:4px"><button id="target" aria-label="Toggle" onclick="this.setAttribute('aria-pressed',this.getAttribute('aria-pressed')!=='true')">+</button><button aria-label="Neighbor" style="width:44px;height:44px"></button></span>${extra}</main></body></html>`;

test("baseline bootstrap, exact fix prompt and calibrated full-flow handoff preserve original identities across checks", async () => {
  const { client, project } = await configured(page(12), ["editor", "other"]);
  const initial = toolData<Check>(
    await client.callTool({
      name: "idiom_check",
      arguments: { flow: "studio" },
    }),
  );
  expect(initial.baselineRecorded?.path).toBeDefined();
  expect(initial.counts.new).toBe(0);
  expect(initial.counts.preExisting).toBeGreaterThan(0);
  await commit(project, "Record initial baseline");
  const unchanged = toolData<Check>(
    await client.callTool({
      name: "idiom_check",
      arguments: { flow: "studio" },
    }),
  );
  expect(unchanged.counts.new).toBe(0);
  expect(unchanged.topIssues).toEqual([]);
  const snapshot = await takeFixSnapshot({ project, flow: "studio" });
  const eligible = await eligibleRecords(snapshot);
  const selected = selectTargets(snapshot, eligible, 1);
  const expectedPrompt = await repairPrompt(snapshot, selected, eligible);
  const status = await git(project, "status", "--porcelain");
  const head = await git(project, "rev-parse", "HEAD");
  const plan = toolData<{
    prompt: string;
    findings: Finding[];
    sourceRun: string;
    next: { arguments: { flow: string; findings: Ref[] } };
  }>(
    await client.callTool({
      name: "idiom_fix_plan",
      arguments: { flow: "studio", top: 1 },
    }),
  );
  expect(plan.prompt.replaceAll(plan.sourceRun, "SOURCE")).toBe(
    expectedPrompt.replaceAll(selected[0]?.runId ?? "", "SOURCE"),
  );
  expect(plan.findings[0]?.verification).toEqual(
    selected[0]?.finding.verification,
  );
  expect(await git(project, "status", "--porcelain")).toBe(status);
  expect(await git(project, "rev-parse", "HEAD")).toBe(head);
  const original = plan.findings[0];
  if (!original) throw new Error("Expected target");
  const noOp = toolData<{
    passed: boolean;
    verdicts: Array<{ status: string }>;
  }>(
    await client.callTool({
      name: "idiom_verify",
      arguments: plan.next.arguments,
    }),
  );
  expect(noOp.passed).toBe(false);
  expect(noOp.verdicts[0]?.status).toBe("reproduced");
  await writeFile(join(project, "page.html"), page(48));
  await writeFile(join(project, "other.html"), page(48));
  await client.callTool({
    name: "idiom_check",
    arguments: { flow: "studio", all: true },
  });
  const progress: number[] = [];
  const verified = toolData<{
    success: boolean;
    regressionFree: boolean;
    verdicts: Array<{ finding: Finding; status: string }>;
    newFindings: unknown[];
    coverage: { selectedTuples: number };
    reportPath: string;
  }>(
    await client.callTool(
      { name: "idiom_verify", arguments: plan.next.arguments },
      { onprogress: (event) => progress.push(event.progress) },
    ),
  );
  expect(verified.verdicts[0]?.finding).toEqual(original);
  expect(verified.verdicts[0]?.status).toBe("fixed");
  expect(verified.success).toBe(true);
  expect(verified.regressionFree).toBe(true);
  expect(verified.newFindings).toEqual([]);
  expect(verified.coverage.selectedTuples).toBe(2);
  expect(progress.length).toBeGreaterThan(12);
  expect(
    progress.every(
      (value, index) => index === 0 || value > (progress[index - 1] ?? 0),
    ),
  ).toBe(true);
  await writeFile(
    join(project, "other.html"),
    page(
      48,
      '<span style="display:inline-flex;align-items:center;gap:4px"><button id="introduced" style="width:10px;height:10px" aria-label="Small">x</button><button aria-label="Neighbor introduced" style="width:44px;height:44px"></button></span><div style="width:1500px">Overflow</div>',
    ),
  );
  const regressed = toolData<{
    success: boolean;
    regressionFree: boolean;
    newFindings: Array<{ severity: string; coordinate: { state: string } }>;
  }>(
    await client.callTool({
      name: "idiom_verify",
      arguments: plan.next.arguments,
    }),
  );
  expect(regressed.success).toBe(false);
  expect(regressed.regressionFree).toBe(false);
  expect(
    regressed.newFindings.some(
      (finding) =>
        finding.severity === "minor" && finding.coordinate.state === "other",
    ),
  ).toBe(true);
  expect(
    regressed.newFindings.some(
      (finding) =>
        finding.severity === "major" && finding.coordinate.state === "other",
    ),
  ).toBe(true);
  const mixed = (await client.callTool({
    name: "idiom_verify",
    arguments: {
      flow: "studio",
      findings: [
        plan.next.arguments.findings[0],
        {
          ...plan.next.arguments.findings[0],
          id: "finding-other",
          runId: initial.runId,
        },
      ],
    },
  })) as CallToolResult;
  expect(mixed.isError).toBe(true);
  const unknown = (await client.callTool({
    name: "idiom_verify",
    arguments: {
      flow: "studio",
      findings: [{ id: "finding-unknown", runId: plan.sourceRun }],
    },
  })) as CallToolResult;
  expect(unknown.isError).toBe(true);
  await writeFile(
    join(project, "page.html"),
    page(
      48,
      '<p id="changing"></p><script>document.getElementById("changing").textContent=String(Math.random())</script>',
    ),
  );
  const undecidable = toolData<{
    regressionFree: null;
    success: boolean;
    verdicts?: unknown[];
    causes: string[];
  }>(
    await client.callTool({
      name: "idiom_verify",
      arguments: plan.next.arguments,
    }),
  );
  expect(undecidable.success).toBe(false);
  expect(undecidable.regressionFree).toBeNull();
  expect(undecidable.verdicts).toBeUndefined();
  expect(undecidable.causes.join(" ")).toContain("nondeterministic");
  const screenshot = original.evidence.screenshots[0];
  if (!screenshot) throw new Error("Expected evidence");
  await rm(join(project, ".idiom/reports", plan.sourceRun, screenshot));
  const missingEvidence = (await client.callTool({
    name: "idiom_verify",
    arguments: plan.next.arguments,
  })) as CallToolResult;
  expect(missingEvidence.isError).toBe(true);
}, 180000);

test("stored capture failures remain actionable before automatic baseline bootstrap", async () => {
  const { project } = await configured(page(48));
  const session = await mcpClient({
    project,
    dependencies: {
      capture: {
        browserLauncher: async () => ({
          version: "missing browser fixture",
          capture: async () => ({
            ok: false,
            stage: "launch",
            message: "Executable doesn't exist; playwright install chromium",
            console: [],
            mismatches: [],
            startedAt: "2026-10-25T00:00:00.000Z",
            endedAt: "2026-10-25T00:00:01.000Z",
          }),
          close: async () => {},
        }),
      },
    },
  });
  cleanups.push(session.close);
  const response = (await session.client.callTool({
    name: "idiom_check",
    arguments: { flow: "studio" },
  })) as CallToolResult;
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain(
    "npx playwright install chromium",
  );
  expect(JSON.stringify(response.content)).toContain("report.html");
  expect(
    toolData<{ flows: unknown[] }>(
      await session.client.callTool({ name: "idiom_flows", arguments: {} }),
    ).flows.length,
  ).toBeGreaterThan(0);
}, 30000);
