import { expect, test } from "vitest";
import type { SetupFacts } from "../src/setup/facts.js";
import {
  delimitedSetupPrompt,
  SETUP_PROMPT_BEGIN,
  SETUP_PROMPT_END,
  SETUP_PROMPT_HEADINGS,
  setupPrompt,
} from "../src/setup/prompt.js";

const facts: SetupFacts = {
  idiomVersion: "9.9.9",
  projectDirectory: "/private/absolute/project",
  packageManager: "bun",
  runScript: "bun run",
  scripts: [
    { name: "dev", command: "vite --port 5173" },
    { name: "seed:demo", command: "bun scripts/seed.ts" },
  ],
  frameworks: ["vite"],
  server: {
    start: "npm start",
    build: "npm run build",
    port: 3000,
    readyUrl: "http://127.0.0.1:3000/",
    scaffoldDefaults: true,
  },
  flows: [{ id: "site", states: 2 }],
  siteRoutes: [{ state: "home", path: "/" }, { state: "settings" }],
  scaffoldFiles: { product: "scaffold", design: "edited" },
  seedCandidates: ["scripts/seed.ts", "tests/fixtures"],
  envExample: ".env.example",
};

function sections(prompt: string): Map<string, string> {
  const result = new Map<string, string>();
  let current = "";
  for (const line of prompt.split("\n")) {
    if (/^#{1,2} /.test(line)) current = line;
    result.set(current, `${result.get(current) ?? ""}${line}\n`);
  }
  return result;
}

test("the prompt is versioned, starts with #, and has every heading in order", () => {
  const prompt = setupPrompt(facts);
  expect(prompt.startsWith("# ")).toBe(true);
  expect(prompt.split("\n")[0]).toContain("idiom 9.9.9 setup prompt");
  const positions = SETUP_PROMPT_HEADINGS.map((heading) =>
    prompt.split("\n").indexOf(heading),
  );
  for (const position of positions) expect(position).toBeGreaterThan(0);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(SETUP_PROMPT_HEADINGS.at(-2)).toBe(
    "## Finish line: idiom init --validate must print ready",
  );
  expect(SETUP_PROMPT_HEADINGS.at(-1)).toBe("## Rules");
  expect(prompt).not.toContain(facts.projectDirectory);
});

test("the finish line requires idiom init --validate to print ready and a reported problem otherwise", () => {
  const finish = sections(setupPrompt(facts)).get(
    "## Finish line: idiom init --validate must print ready",
  );
  expect(finish).toContain("`idiom init --validate`");
  expect(finish).toContain("`idiom_ready`");
  expect(finish).toContain("prints `ready`");
  expect(finish).toContain("report the exact `not ready: …` line");
  expect(finish).toContain("as the remaining problem");
  expect(finish).toContain(
    "Do not say setup is done unless it printed `ready`.",
  );
});

test("the steps cover server, seeding without real credentials, routes, a 3–8 state flow and the design docs", () => {
  const parts = sections(setupPrompt(facts));
  expect(
    parts.get("## 1. Start the app: server command, port and readyUrl"),
  ).toContain("`server.readyUrl`");
  expect(parts.get("## 2. Seed data and test accounts")).toContain(
    "**Never use, invent or ask for real credentials, production data or personal accounts.**",
  );
  expect(parts.get("## 3. Find routes")).toContain(
    "`idiom init --flows --yes --no-agent`",
  );
  const flow = parts.get("## 4. Write a first flow of 3–8 states") ?? "";
  expect(flow).toContain("3 to 8 named states");
  expect(flow).toContain("`data-testid`");
  expect(
    parts.get("## 5. Fill PRODUCT.md and DESIGN.md from the repository"),
  ).toContain(".agents/skills/idiom/init.md");
});

test("commit, push, disable and skip appear only as prohibitions under Rules", () => {
  const prompt = setupPrompt(facts);
  const rules = prompt.indexOf("\n## Rules\n");
  expect(rules).toBeGreaterThan(0);
  for (const line of prompt.slice(0, rules).split("\n"))
    expect(line).not.toMatch(/\b(git commit|commit|push|disable|skip)\b/i);
  const ruleLines = prompt
    .slice(rules)
    .split("\n")
    .filter((line) => /\b(commit|push|disable|skip)\b/i.test(line));
  expect(ruleLines.length).toBeGreaterThan(0);
  for (const line of ruleLines) expect(line).toMatch(/^- Do not /);
});

test("facts render: scripts, routes, seed candidates, env example and doc ownership", () => {
  const prompt = setupPrompt(facts);
  for (const fragment of [
    "`seed:demo`: `bun scripts/seed.ts`",
    "`home` → `/`",
    "`settings`",
    "scripts/seed.ts, tests/fixtures",
    ".env.example",
    "These are still the scaffold defaults; replace them.",
    "PRODUCT.md: scaffold; DESIGN.md: edited",
    "2 route(s) are already listed above.",
  ])
    expect(prompt).toContain(fragment);
});

test("output is deterministic and bounded for a large repository", () => {
  expect(setupPrompt(facts)).toBe(setupPrompt(structuredClone(facts)));
  const large: SetupFacts = {
    ...facts,
    scripts: Array.from({ length: 20 }, (_, index) => ({
      name: `seed:${index}`,
      command: "x".repeat(200),
    })),
    siteRoutes: Array.from({ length: 30 }, (_, index) => ({
      state: `route-${index}`,
      path: `/${"p".repeat(100)}/${index}`,
    })),
    flows: Array.from({ length: 20 }, (_, index) => ({
      id: `flow-${index}`,
      states: 8,
    })),
  };
  expect(Buffer.byteLength(setupPrompt(large))).toBeLessThan(16 * 1024);
});

test("delimitedSetupPrompt wraps the prompt in copy-ready BEGIN/END lines", () => {
  const prompt = setupPrompt(facts);
  const lines = delimitedSetupPrompt(prompt);
  expect(lines).toEqual([
    SETUP_PROMPT_BEGIN,
    prompt.trimEnd(),
    SETUP_PROMPT_END,
  ]);
});
