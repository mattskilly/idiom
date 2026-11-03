import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import type { McpDependencies } from "../src/mcp/tools.js";
import { mcpClient, toolData } from "./mcp-support.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);
const verdict = {
  verdict: "design decision",
  reason: "adds a per-tile control",
  questions: ["How large is the pin?", "How does it behave on touch?"],
};
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

async function project(): Promise<string> {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-mcp-brief-")),
  );
  directories.push(path);
  await initProject({ project: path, yes: true });
  return path;
}

async function connect(root: string, dependencies?: McpDependencies) {
  const session = await mcpClient({
    project: root,
    dependencies: {
      ...dependencies,
      brief: {
        now: () => new Date("2026-10-31T10:00:00Z"),
        ...dependencies?.brief,
      },
    },
  });
  cleanups.push(session.close);
  return session.client;
}

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

test("the brief tools tell agents to triage before writing UI tickets", async () => {
  const client = await connect(await project());
  const { tools } = await client.listTools();
  const triage = tools.find((tool) => tool.name === "idiom_brief_triage");
  expect(triage?.description).toMatch(
    /^Call before writing a ticket, spec or code that adds or changes visible UI/,
  );
  for (const name of [
    "idiom_brief_plan",
    "idiom_brief_record",
    "idiom_brief_decide",
  ])
    expect(tools.some((tool) => tool.name === name)).toBe(true);
});

test("triage stores a record and returns its id; plan reads it; noModel returns the rubric", async () => {
  const root = await project();
  const client = await connect(root, {
    brief: { invoke: async () => verdict },
  });
  const triage = toolData<{ id: string; verdict: string; warnings: string[] }>(
    await call(client, "idiom_brief_triage", {
      request: "add a pin to every tile",
    }),
  );
  expect(triage).toMatchObject({ verdict: "design decision", warnings: [] });
  expect(triage.id).toMatch(/^triage-[0-9a-f]{10}$/);
  const plan = await call(client, "idiom_brief_plan", { triage: triage.id });
  expect(toolData<{ triageId: string }>(plan).triageId).toBe(triage.id);
  expect(JSON.stringify(plan.content)).toContain("# Research plan");

  await writeFile(join(root, "draft.md"), "add a pin to every tile");
  const fromFile = toolData<{ id: string }>(
    await call(client, "idiom_brief_triage", { file: "draft.md" }),
  );
  expect(fromFile.id).toBe(triage.id);

  const rubric = toolData<{ rubric: string }>(
    await call(client, "idiom_brief_triage", {
      request: "fix the typo",
      noModel: true,
    }),
  );
  expect(rubric.rubric).toContain("# Design decision rubric");

  const both = await call(client, "idiom_brief_triage", {
    request: "x",
    file: "draft.md",
  });
  expect(both.isError).toBe(true);
  const outside = await call(client, "idiom_brief_triage", {
    file: "../escape.md",
  });
  expect(outside.isError).toBe(true);
});

test("plan accepts a request with questions and no model", async () => {
  const client = await connect(await project(), {
    brief: {
      invoke: async () => {
        throw new Error("no model expected");
      },
    },
  });
  const plan = toolData<{ questions: unknown[]; budget: { minutes: number } }>(
    await call(client, "idiom_brief_plan", {
      request: "add a pin to every tile",
      questions: ["How large is the pin?"],
      minutes: 7,
    }),
  );
  expect(plan.questions).toHaveLength(1);
  expect(plan.budget.minutes).toBe(7);
});

test("record returns the ask; invalid input lists path: message; decide re-renders", async () => {
  const root = await project();
  const client = await connect(root);
  const recorded = toolData<{
    slug: string;
    ask: { askUserQuestion: { questions: Array<{ header: string }> } };
  }>(await call(client, "idiom_brief_record", { brief: fixture }));
  expect(recorded.slug).toBe("pinned-group-in-the-add-drawer");
  expect(recorded.ask.askUserQuestion.questions[0]?.header).toBe("Design call");

  const invalid = await call(client, "idiom_brief_record", {
    brief: { ...fixture, options: fixture.options.slice(0, 1) },
  });
  expect(invalid.isError).toBe(true);
  expect(JSON.stringify(invalid.content)).toContain("options: ");

  const decided = toolData<{ chosen: string; decidedBy: string }>(
    await call(client, "idiom_brief_decide", {
      slug: recorded.slug,
      option: "corner-pin",
    }),
  );
  expect(decided).toMatchObject({
    chosen: "corner-pin",
    decidedBy: "requester",
  });
  expect(
    await readFile(
      join(root, ".idiom", "briefs", `${recorded.slug}.md`),
      "utf8",
    ),
  ).toContain("**Decision:** A small corner pin icon inside the tile");
});
