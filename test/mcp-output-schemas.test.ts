import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { critiqueResult } from "../src/critique/types.js";
import { appendDecision } from "../src/decisions/log.js";
import { mcpOutputs, mcpToolStatus } from "../src/interface/surfaces.js";
import { INTERFACE_VERSION } from "../src/interface/version.js";
import type { McpDependencies } from "../src/mcp/tools.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { commit, git } from "./baseline-support.js";
import {
  decidedBriefProject,
  fakeAbCli,
  storedCapture,
} from "./design-asset-support.js";
import { passingProject } from "./doctor-support.js";
import {
  BROWSER_TOOLS,
  PLAIN_TOOLS,
  validOutput,
} from "./mcp-output-support.js";
import { mcpClient } from "./mcp-support.js";
import { storedRun, studioProject } from "./stored-run-support.js";

const directories: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "idiom-output-")));
  directories.push(path);
  return path;
}

async function connect(project: string, dependencies?: McpDependencies) {
  const session = await mcpClient({ project, dependencies });
  cleanups.push(session.close);
  return session;
}

const call = (
  session: Awaited<ReturnType<typeof connect>>,
  name: string,
  args: Record<string, unknown> = {},
) =>
  session.client.callTool({
    name,
    arguments: args,
  }) as Promise<CallToolResult>;

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
        { id: "home", description: "Home", url: "/", expect: { status: 200 } },
      ],
    }),
  );
  for (const path of ["app/page.tsx", "app/settings/page.tsx"]) {
    await mkdir(join(project, path, ".."), { recursive: true });
    await writeFile(join(project, path), "export default () => null;\n");
  }
  await writeFile(join(project, "design.html"), "<h1>Design</h1>");
  await git(project, "init", "-q", "-b", "main");
  await commit(project, "initial");
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

/** A design-decision finding between two references, and a plain one. */
async function storeDecisionFindings(project: string) {
  const reference = (name: string, value: number) => ({
    name,
    source: `${name}.html`,
    value,
    matchesBuild: false,
    pairId: `pair-${name}`,
    designSelector: ".card",
  });
  const findings = [
    finding("finding-1", {
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
    } as Partial<Finding>),
    finding("finding-2"),
  ];
  const run = join(project, ".idiom/reports/2026-10-26T12-00-00-000Z");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "findings.json"), JSON.stringify(findings));
  return findings;
}

const triageVerdict = {
  verdict: "design decision",
  reason: "adds a per-tile control",
  questions: ["How large is the pin?"],
};

describe("MCP tool output schemas", () => {
  test("every tool advertises an object outputSchema that pins interfaceVersion", async () => {
    const session = await connect(await temporary());
    const names = session.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(Object.keys(mcpToolStatus).sort());
    // The two dedicated files together call every listed tool.
    expect([...PLAIN_TOOLS, ...BROWSER_TOOLS].sort()).toEqual(names);
    for (const tool of session.tools) {
      const schema = tool.outputSchema as Record<string, unknown> | undefined;
      expect(schema, tool.name).toBeDefined();
      expect(schema?.type, tool.name).toBe("object");
      expect(schema?.required, tool.name).toContain("interfaceVersion");
      expect(
        (schema?.properties as Record<string, unknown> | undefined)
          ?.interfaceVersion,
        tool.name,
      ).toEqual({ type: "number", const: INTERFACE_VERSION });
      expect(typeof schema?.description, tool.name).toBe("string");
    }
    console.log(
      [
        "MCP tool output status:",
        ...names.map(
          (name) =>
            `  ${name.padEnd(20)} ${mcpOutputs[name]?.status}${mcpOutputs[name]?.reason ? ` — ${mcpOutputs[name]?.reason}` : ""}`,
        ),
      ].join("\n"),
    );
  });

  test("every tool without a live capture returns structuredContent its schema accepts", async () => {
    const called = new Set<string>();
    const recorder = (session: Awaited<ReturnType<typeof connect>>) => ({
      valid: <T = Record<string, unknown>>(name: string, response: unknown) =>
        validOutput<T>(called, session.validators, name, response),
    });

    // Scaffolding, setup and readiness.
    const fresh = await connect(await temporary());
    const freshOutputs = recorder(fresh);
    freshOutputs.valid("idiom_ready", await call(fresh, "idiom_ready"));
    freshOutputs.valid("idiom_init", await call(fresh, "idiom_init"));
    freshOutputs.valid(
      "idiom_setup_prompt",
      await call(fresh, "idiom_setup_prompt"),
    );

    const { directory } = await passingProject(directories);
    const passing = await connect(await realpath(directory));
    const passingOutputs = recorder(passing);
    expect(
      passingOutputs.valid<{ ready: boolean }>(
        "idiom_ready",
        await call(passing, "idiom_ready"),
      ).ready,
    ).toBe(true);
    expect(
      passingOutputs.valid<{ ok: boolean }>(
        "idiom_doctor",
        await call(passing, "idiom_doctor"),
      ).ok,
    ).toBe(true);

    // Configured-project reads and writes.
    const project = await siteProject();
    const findings = await storeDecisionFindings(project);
    await appendDecision({
      projectDirectory: project,
      finding: findings[1] as Finding,
      decision: "accept",
      scope: "instance",
    });
    const site = await connect(project);
    const siteOutputs = recorder(site);
    siteOutputs.valid("idiom_context", await call(site, "idiom_context"));
    siteOutputs.valid("idiom_flows", await call(site, "idiom_flows"));
    siteOutputs.valid("idiom_coverage", await call(site, "idiom_coverage"));
    siteOutputs.valid(
      "idiom_coverage",
      await call(site, "idiom_coverage", { states: true }),
    );
    siteOutputs.valid(
      "idiom_baseline",
      await call(site, "idiom_baseline", { action: "show" }),
    );
    siteOutputs.valid(
      "idiom_design_add",
      await call(site, "idiom_design_add", {
        state: "home",
        source: "design.html",
      }),
    );
    siteOutputs.valid(
      "idiom_choose",
      await call(site, "idiom_choose", {
        id: "finding-1",
        reference: "figma",
        reason: "Figma is the source of truth",
      }),
    );
    for (let repeat = 0; repeat < 2; repeat += 1)
      siteOutputs.valid(
        "idiom_learn",
        await call(site, "idiom_learn", {
          observation: "section headers never use all caps",
          state: "home",
        }),
      );
    siteOutputs.valid("idiom_tickets", await call(site, "idiom_tickets"));

    // Sweep over a stored run.
    const { project: studio, commit: head } = await studioProject(directories, [
      "editor",
    ]);
    const runId = "2026-10-26T12-00-00-000Z";
    await storedRun(studio, runId, head, [
      { state: "editor", html: "before.html" },
    ]);
    const sweeping = await connect(studio, {
      review: {
        critique: { critique: async () => critiqueResult({ findings: [] }) },
      },
    });
    recorder(sweeping).valid(
      "idiom_sweep",
      await call(sweeping, "idiom_sweep", { flow: "studio-lab", from: runId }),
    );

    // The brief tools, with a fake model and a fake ab.
    const briefRoot = await temporary();
    await initProject({ project: briefRoot, yes: true });
    const brief = await connect(briefRoot, {
      brief: {
        now: () => new Date("2026-10-31T10:00:00Z"),
        invoke: async () => triageVerdict,
      },
    });
    const briefOutputs = recorder(brief);
    const triage = briefOutputs.valid<{ id: string }>(
      "idiom_brief_triage",
      await call(brief, "idiom_brief_triage", {
        request: "add a pin to every tile",
      }),
    );
    briefOutputs.valid(
      "idiom_brief_triage",
      await call(brief, "idiom_brief_triage", {
        request: "fix the typo",
        noModel: true,
      }),
    );
    briefOutputs.valid(
      "idiom_brief_plan",
      await call(brief, "idiom_brief_plan", { triage: triage.id }),
    );
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
        "utf8",
      ),
    );
    const recorded = briefOutputs.valid<{ slug: string }>(
      "idiom_brief_record",
      await call(brief, "idiom_brief_record", { brief: fixture }),
    );
    briefOutputs.valid(
      "idiom_brief_decide",
      await call(brief, "idiom_brief_decide", {
        slug: recorded.slug,
        option: "corner-pin",
      }),
    );

    const decided = await decidedBriefProject(directories);
    await storedCapture(decided, ["editor"]);
    await writeFile(join(decided, "autobuild.toml"), "[commands]\n");
    const ab = await fakeAbCli(directories);
    const attaching = await connect(decided, {
      brief: {
        environment: { PATH: `${ab.bin}:/usr/bin:/bin`, AB_LOG: ab.log },
      },
    });
    const attachOutputs = recorder(attaching);
    attachOutputs.valid(
      "idiom_brief_export",
      await call(attaching, "idiom_brief_export", {
        slug: "pinned-group",
        out: "mcp-export",
      }),
    );
    attachOutputs.valid(
      "idiom_brief_attach",
      await call(attaching, "idiom_brief_attach", {
        slug: "pinned-group",
        ticket: "file-300",
      }),
    );
    attachOutputs.valid(
      "idiom_brief_decide",
      await call(attaching, "idiom_brief_decide", {
        slug: "pinned-group",
        option: "corner-pin",
        ticket: "file-301",
      }),
    );

    expect([...called].sort()).toEqual([...PLAIN_TOOLS].sort());
  }, 120_000);

  test("a failing call stays a text-first tool error and is not held to the schema", async () => {
    const session = await connect(await siteProject());
    const response = await call(session, "idiom_check", { flow: "missing" });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.type).toBe("text");
    expect(JSON.stringify(response.content)).not.toContain(
      "Output validation error",
    );
    expect(response.structuredContent).not.toHaveProperty("interfaceVersion");
  });
});
