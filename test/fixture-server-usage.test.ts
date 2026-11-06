import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

// Every test-started fixture server goes through test/support/fixture-server.ts,
// so it dies with the test process. This guard keeps that true.

const root = import.meta.dirname;

/** Occurrences that are configuration data only and never run. */
const ALLOWED: Array<{ file: string; snippet: string }> = [
  // Generated-flow data compared as text; no server starts.
  { file: "flow-generation.test.ts", snippet: 'start: "node server.mjs"' },
  // A field-test target's dev command, recorded, never run.
  { file: "field-test.test.ts", snippet: '"node server.mjs --port 4410"' },
  // A build step that only syntax-checks the server file and exits.
  { file: "github-action.test.ts", snippet: '"node --check server.mjs"' },
  { file: "distribution.test.ts", snippet: '"node --check server.mjs"' },
  // A start command that exits at once, proving --reuse-server never runs it.
  { file: "check-gate.test.ts", snippet: `'node -e "process.exit(3)"'` },
];

const RULES: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "a fixture server spawned directly (use spawnFixtureServer)",
    pattern:
      /spawn\(\s*process\.execPath\s*,\s*\[[^\]]*(?:server\.[cm]?js|serverPath|serverScript)/g,
  },
  {
    name: "a server.start that runs node without the lifeline (use fixtureCommand)",
    pattern: /\bstart\s*[:=]\s*["'`]node\b(?!\s+-e\s+0["'`])/g,
  },
  {
    name: "a node command that runs a server file (use fixtureCommand)",
    pattern: /["'`]node\s+[^"'`\n]*server\.[cm]?js/g,
  },
  {
    name: "a server command interpolating a script path (use fixtureCommand)",
    pattern: /\bcommand\s*=\s*`node '?\$\{/g,
  },
];

async function testFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "support" || entry.name === "fixtures") continue;
      files.push(...(await testFiles(path)));
    } else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("every test-started fixture server goes through the shared helper", async () => {
  const violations: string[] = [];
  for (const path of await testFiles(root)) {
    const file = relative(root, path);
    if (file === "fixture-server-usage.test.ts") continue;
    const text = await readFile(path, "utf8");
    for (const rule of RULES)
      for (const match of text.matchAll(rule.pattern)) {
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        const lineEnd = text.indexOf("\n", match.index);
        const line = text.slice(
          lineStart,
          lineEnd === -1 ? undefined : lineEnd,
        );
        if (
          ALLOWED.some(
            (allowed) =>
              allowed.file === file && line.includes(allowed.snippet),
          )
        )
          continue;
        const number = text.slice(0, match.index).split("\n").length;
        violations.push(`${file}:${number}: ${rule.name}: ${line.trim()}`);
      }
  }
  expect(violations).toEqual([]);
});

test("the guard catches the patterns it names", () => {
  const open = "$" + "{";
  const samples = [
    'spawn(process.execPath, [join(fixture, "server.mjs")], {})',
    'start: "node server.mjs"',
    `start: \`node '${open}script}'\``,
    `start: \`node ${open}JSON.stringify(serverScript)}\``,
    `const command = \`node '${open}join(fixture, "server.mjs")}'\``,
  ];
  for (const sample of samples)
    expect(
      RULES.some((rule) => new RegExp(rule.pattern.source).test(sample)),
      sample,
    ).toBe(true);
  expect(
    RULES.some((rule) =>
      new RegExp(rule.pattern.source).test('start: "node -e 0"'),
    ),
  ).toBe(false);
});
