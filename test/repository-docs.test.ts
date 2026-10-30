import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, test } from "vitest";
import { createProgram } from "../src/cli.js";
import {
  designDeclarationSchema,
  designDriftConfigSchema,
} from "../src/schemas/design.js";
import { flowSchema } from "../src/schemas/flow.js";
import { projectSchema } from "../src/schemas/project.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, "..");
const documentedExtractor = `awk -v heading="$release_heading" '
    index($0, heading " - ") == 1 { found = 1; next }
    found && index($0, "## [") == 1 { exit }
    found { print }
    END { if (!found) exit 1 }
  ' CHANGELOG.md > "$release_notes"`;

type PackageMetadata = {
  name: string;
  version: string;
  description: string;
  dependencies: Record<string, string>;
  bin: { idiom: string };
};

let readme: string;
let commandsDoc: string;
let configurationDoc: string;
let designGuide: string;
let mcpGuide: string;
let changelog: string;
let releaseGuide: string;
let packageMetadata: PackageMetadata;

beforeAll(async () => {
  [
    readme,
    commandsDoc,
    configurationDoc,
    designGuide,
    mcpGuide,
    changelog,
    releaseGuide,
    packageMetadata,
  ] = await Promise.all([
    readFile(join(repositoryRoot, "README.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "commands.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "configuration.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "design-compare.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "mcp.md"), "utf8"),
    readFile(join(repositoryRoot, "CHANGELOG.md"), "utf8"),
    readFile(join(repositoryRoot, "docs", "releases.md"), "utf8"),
    readFile(join(repositoryRoot, "package.json"), "utf8").then(
      (contents) => JSON.parse(contents) as PackageMetadata,
    ),
  ]);
});

function datedReleaseVersions(): string[] {
  return Array.from(
    changelog.matchAll(/^## \[v(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/gm),
    (match) => match[1] as string,
  );
}

function parsedReleaseBody(version: string): string {
  const lines = changelog.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const headingPattern = new RegExp(
    `^## \\[v${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`,
  );
  const headingIndex = lines.findIndex((line) => headingPattern.test(line));
  if (headingIndex === -1)
    throw new Error(`missing release heading: ${version}`);
  const nextHeadingOffset = lines
    .slice(headingIndex + 1)
    .findIndex((line) => line.startsWith("## ["));
  const endIndex =
    nextHeadingOffset === -1
      ? lines.length
      : headingIndex + 1 + nextHeadingOffset;
  return `${lines.slice(headingIndex + 1, endIndex).join("\n")}\n`;
}

async function extractedReleaseBody(version: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "idiom-release-notes-"),
  );
  const notesPath = join(temporaryDirectory, "notes.md");
  try {
    await execFileAsync(
      "sh",
      [
        "-c",
        `release_heading="## [v$1]"
release_notes="$2"
${documentedExtractor}`,
        "repository-docs-test",
        version,
        notesPath,
      ],
      { cwd: repositoryRoot },
    );
    return await readFile(notesPath, "utf8");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function readmeSection(heading: string): string {
  const start = readme.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`missing README heading: ${heading}`);
  const bodyStart = start + heading.length + 2;
  const next = readme.indexOf("\n## ", bodyStart);
  return readme.slice(bodyStart, next === -1 ? undefined : next);
}

test("README opens with the one-breath explanation, then install and quick", async () => {
  const lines = readme.split(/\r?\n/);
  expect(lines[0]).toBe("# Idiom");
  expect(lines[1]).toBe("");
  expect(
    lines[2]?.startsWith(packageMetadata.description.replace(/\.$/, "")),
  ).toBe(true);
  expect(lines[2]?.endsWith(".")).toBe(true);
  expect(lines[3]).toBe("");

  const headings = [
    "## Who it's for",
    "## How it works",
    "## Compare against your design",
    "## Use it from your agent",
    "## Before and after",
    "## Install",
    "## Try Idiom in two minutes",
    "## Go deeper with configured flows",
  ];
  const positions = headings.map((heading) => lines.indexOf(heading));
  for (const position of positions) expect(position).toBeGreaterThan(-1);
  for (let index = 1; index < positions.length; index += 1) {
    expect(positions[index]).toBeGreaterThan(positions[index - 1] as number);
  }
  expect(readme.indexOf("\nidiom quick ")).toBeGreaterThan(
    readme.indexOf("\n## Install\n"),
  );

  expect(readmeSection("## Who it's for")).toContain("Autobuild");

  const howItWorks = readmeSection("## How it works");
  const check = howItWorks.indexOf("**Check**");
  const fix = howItWorks.indexOf("**Fix**");
  const guard = howItWorks.indexOf("**Guard**");
  expect(check).toBeGreaterThan(-1);
  expect(fix).toBeGreaterThan(check);
  expect(guard).toBeGreaterThan(fix);

  const beforeAndAfter = readmeSection("## Before and after");
  const before = beforeAndAfter.indexOf("docs/images/benchmark-before.png");
  const after = beforeAndAfter.indexOf("docs/images/benchmark-after.png");
  expect(before).toBeGreaterThan(-1);
  expect(after).toBeGreaterThan(before);
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  for (const image of ["benchmark-before.png", "benchmark-after.png"]) {
    const bytes = await readFile(join(repositoryRoot, "docs", "images", image));
    expect(bytes.subarray(0, 8).equals(pngSignature)).toBe(true);
  }

  expect(readme).not.toContain("## Status");
  expect(readme).not.toContain("by invitation");
  expect(readme).not.toContain("git+ssh://");
});

test("README stays below 200 lines", () => {
  const lines = readme.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  expect(lines.length).toBeLessThan(200);
});

test("README exposes design and agent entry points", () => {
  const design = readmeSection("## Compare against your design");
  for (const fragment of [
    "Figma",
    "FIGMA_TOKEN",
    "HTML",
    "Claude",
    "PNG",
    "JPEG",
    "WebP",
    "Live site",
    '"site"',
    "idiom design add",
    "idiom check",
    "--design <source>",
    "idiom quick",
    "idiom decide --choose",
    "element/property",
    "](docs/design-compare.md)",
  ])
    expect(design).toContain(fragment);
  const agent = readmeSection("## Use it from your agent");
  for (const fragment of [
    "fifteen",
    "stdio",
    "/plugin marketplace add mattskilly/idiom",
    "/plugin install idiom@idiom",
    "codex plugin add idiom@idiom",
    "](docs/mcp.md)",
  ])
    expect(agent).toContain(fragment);
  expect(readmeSection("## Documentation")).toContain(
    "](docs/design-compare.md)",
  );
  for (const doc of [commandsDoc, configurationDoc, mcpGuide]) {
    expect(doc).toContain("](design-compare.md)");
  }
  for (const target of [
    "commands.md",
    "configuration.md#design-comparison",
    "rules.md#design-drift",
    "mcp.md",
  ]) {
    expect(designGuide).toContain(`](${target}`);
  }
});

function guideJson(label: string): unknown {
  const marker = `**${label}**`;
  const start = designGuide.indexOf(marker);
  expect(start, `missing guide label ${label}`).toBeGreaterThan(-1);
  const snippet = /```json\n([\s\S]*?)\n```/.exec(designGuide.slice(start));
  if (!snippet?.[1]) throw new Error(`missing JSON after ${label}`);
  return JSON.parse(snippet[1]);
}

test("the guide's actual worked flow, server and tolerance examples satisfy shipped schemas", async () => {
  const flow = flowSchema.parse(guideJson("worked flow"));
  expect(flow.id).toBe("store");
  expect(flow.target.kind).toBe("web");
  expect(flow.states).toHaveLength(1);
  expect(flow.states[0]?.id).toBe("checkout");
  expect(designDeclarationSchema.parse(flow.states[0]?.design)).toMatchObject({
    source: "designs/card.html",
    name: "approved",
  });
  const settings = designDriftConfigSchema.parse(
    guideJson("designDrift settings"),
  );
  expect(settings.tolerance).toEqual({ ratio: 0.15, px: 1, mode: "tighter" });
  expect(settings.gap).toEqual({ px: 2 });
  expect(
    projectSchema.parse({
      ...JSON.parse(
        await readFile(join(repositoryRoot, "templates/project.json"), "utf8"),
      ),
      server: guideJson("server settings"),
    }).server,
  ).toMatchObject({
    build: "true",
    start: "python3 -m http.server 3000 --bind 127.0.0.1 --directory app",
    readyUrl: "http://127.0.0.1:3000/",
    port: 3000,
  });
});

test("README links the command and configuration references", async () => {
  expect(readme).toContain("](docs/commands.md");
  expect(readme).toContain("](docs/configuration.md");

  const documents: Array<[string, string]> = [
    ["README.md", readme],
    ["docs/commands.md", commandsDoc],
    ["docs/configuration.md", configurationDoc],
    ["docs/design-compare.md", designGuide],
    ["docs/mcp.md", mcpGuide],
  ];
  const targets: string[] = [];
  for (const [path, contents] of documents) {
    for (const match of contents.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = (match[1] as string).split("#")[0] as string;
      if (target === "" || /^(?:https?|mailto):/.test(target)) continue;
      targets.push(join(repositoryRoot, dirname(path), target));
    }
  }
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets)
    await expect(access(target)).resolves.toBe(undefined);
});

function documentedInvocations(contents: string): string[][] {
  const snippets: string[] = [];
  let fenced = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) snippets.push(line);
    else
      for (const span of line.matchAll(/`([^`]+)`/g))
        snippets.push(span[1] as string);
  }
  const invocations: string[][] = [];
  for (const snippet of snippets) {
    for (const match of snippet.matchAll(
      /(?:^|[\s`$(])(?:bunx |npx )?idiom ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g,
    )) {
      invocations.push(
        [match[1], match[2]].filter(
          (word): word is string => word !== undefined,
        ),
      );
    }
  }
  return invocations;
}

test("every documented command exists", () => {
  const program = createProgram();
  // A second word must name a subcommand only where it cannot be a positional
  // argument (`idiom baseline accept`, but `idiom explore booking`).
  const commands = new Map(
    program.commands.map((command) => [
      command.name(),
      command.registeredArguments.length === 0
        ? new Set(command.commands.map((subcommand) => subcommand.name()))
        : new Set<string>(),
    ]),
  );
  const invocations = [
    readme,
    commandsDoc,
    configurationDoc,
    designGuide,
    mcpGuide,
  ].flatMap(documentedInvocations);
  expect(invocations.length).toBeGreaterThan(0);
  for (const [name, subcommand] of invocations) {
    const subcommands = commands.get(name as string);
    expect(subcommands, `idiom ${name}`).toBeDefined();
    if (subcommands !== undefined && subcommands.size > 0 && subcommand) {
      expect([...subcommands], `idiom ${name} ${subcommand}`).toContain(
        subcommand,
      );
    }
  }
  const referenced = new Set(
    documentedInvocations(commandsDoc).map(([name]) => name),
  );
  for (const name of commands.keys()) expect(referenced).toContain(name);
});

test("changelog order drives the current and preceding release literals", () => {
  for (const heading of [
    "## [Unreleased]",
    "## [v0.0.2] - 2026-08-20",
    "## [v0.0.1] - 2026-08-20",
  ]) {
    expect(
      changelog.split("\n").filter((line) => line === heading),
    ).toHaveLength(1);
  }

  const versions = datedReleaseVersions();
  const currentVersion = versions[0];
  const previousVersion = versions[1];
  if (currentVersion === undefined || previousVersion === undefined) {
    throw new Error("expected current and preceding changelog releases");
  }
  expect(currentVersion).toBe(packageMetadata.version);
  expect(releaseGuide).toMatch(
    new RegExp(`^\\s*version="${currentVersion.replaceAll(".", "\\.")}"$`, "m"),
  );
  expect(releaseGuide).toMatch(
    new RegExp(
      `^\\s*previous_version="${previousVersion.replaceAll(".", "\\.")}"$`,
      "m",
    ),
  );
});

test("README distribution commands stay aligned with package metadata", () => {
  const version = packageMetadata.version;
  expect(packageMetadata.name).toBe("@mattskilly/idiom");
  expect(packageMetadata.bin.idiom).toBe("dist/cli.js");
  expect(readme).toContain("npm install -g @mattskilly/idiom");
  expect(readme).toContain(`@mattskilly/idiom@${version}`);
  expect(readme).toContain("<version> (<short source commit>)");

  const documentedPlaywrightVersions = Array.from(
    readme.matchAll(
      /bunx playwright@([^\s]+) install(?: --with-deps)? chromium/g,
    ),
    (match) => match[1],
  );
  expect(documentedPlaywrightVersions).toHaveLength(2);
  expect(new Set(documentedPlaywrightVersions)).toEqual(
    new Set([packageMetadata.dependencies.playwright]),
  );
  expect(readme).toContain("[CHANGELOG.md](CHANGELOG.md)");
  expect(readme).toContain("[Apache License 2.0](LICENSE)");
});

test("release publication uses the tested changelog extractor in order", async () => {
  expect(releaseGuide).toContain(documentedExtractor);
  const versionVariable = "$" + "{version}";
  const tagPushIndex = releaseGuide.indexOf(
    `git push origin main "v${versionVariable}"`,
  );
  const releaseCreateIndex = releaseGuide.indexOf(
    `gh release create "v${versionVariable}"`,
  );
  const nonemptyCheckIndex = releaseGuide.indexOf(
    'if ! test -s "$release_notes"',
  );
  const firstInstallIndex = releaseGuide.indexOf("## Smoke a first install");
  expect(tagPushIndex).toBeGreaterThan(-1);
  expect(nonemptyCheckIndex).toBeGreaterThan(tagPushIndex);
  expect(releaseCreateIndex).toBeGreaterThan(nonemptyCheckIndex);
  expect(releaseCreateIndex).toBeGreaterThan(tagPushIndex);
  expect(firstInstallIndex).toBeGreaterThan(releaseCreateIndex);
  expect(releaseGuide).toContain("--verify-tag");
  expect(releaseGuide).toContain(`--title "Idiom v${versionVariable}"`);
  expect(releaseGuide).toContain('--notes-file "$release_notes"');

  const publicRelease =
    releaseGuide.split("## Publish the public snapshot and npm package")[1] ??
    "";
  const publicTagIndex = publicRelease.indexOf(
    `git push origin "v${versionVariable}"`,
  );
  const packIndex = publicRelease.indexOf("npm pack --ignore-scripts --json");
  const uploadIndex = publicRelease.indexOf(
    `gh release create "v${versionVariable}" "$tarball"`,
  );
  const readbackIndex = publicRelease.indexOf(
    'cmp "$tarball" "$packed_root/downloaded.tgz"',
  );
  const advertiseIndex = publicRelease.indexOf("git push origin main");
  expect(publicTagIndex).toBeGreaterThan(-1);
  expect(packIndex).toBeGreaterThan(publicTagIndex);
  expect(uploadIndex).toBeGreaterThan(packIndex);
  expect(readbackIndex).toBeGreaterThan(uploadIndex);
  expect(advertiseIndex).toBeGreaterThan(readbackIndex);
  expect(publicRelease).toContain(
    'node scripts/check-plugins.mjs "$packed_root/package"',
  );
  for (const version of ["0.0.1", "0.0.2"]) {
    const extracted = await extractedReleaseBody(version);
    expect(extracted.trim()).not.toBe("");
    expect(extracted).toBe(parsedReleaseBody(version));
  }
});

test("MCP setup snippets parse to the documented launchers and preserve fixed desktop roots", async () => {
  const { parse } = await import("smol-toml");
  const source = await readFile(join(repositoryRoot, "docs/mcp.md"), "utf8");
  expect(source).toContain("claude mcp add idiom -- idiom mcp");
  expect(source).toContain("/plugin install idiom@idiom");
  expect(source).toContain("codex plugin add idiom@idiom");
  const snippets = [...source.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (snippet) => JSON.parse(snippet[1] ?? ""),
  );
  const launchers = snippets.filter(
    (settings) => settings.mcpServers !== undefined,
  );
  expect(launchers).toHaveLength(2);
  for (const settings of launchers) {
    expect(settings.mcpServers.idiom).toEqual({
      command: "idiom",
      args: ["mcp", "--project", "/absolute/path/to/project"],
    });
  }
  const agentSettings = snippets.filter(
    (settings) => settings.agent !== undefined,
  );
  expect(agentSettings).toHaveLength(2);
  const template = JSON.parse(
    await readFile(join(repositoryRoot, "templates/project.json"), "utf8"),
  );
  for (const settings of agentSettings)
    projectSchema.parse({ ...template, ...settings });
  const toml = /```toml\n([\s\S]*?)\n```/.exec(source)?.[1];
  const configuration = parse(toml ?? "");
  expect(configuration).toMatchObject({
    mcp_servers: {
      idiom: {
        command: "idiom",
        args: ["mcp", "--project", "/absolute/path/to/project"],
        tool_timeout_sec: 3900,
      },
    },
  });
  expect(source).toContain("/idiom:idiom");
  expect(source).toContain("60 seconds");
  expect(source).toContain(
    "Progress notifications do not extend every client's timeout",
  );
  expect(readme).toContain("](docs/mcp.md)");
});

test("public ranking contract says severity first and retains salience × prominence within tiers", async () => {
  for (const file of [
    "README.md",
    "docs/ranking.md",
    "docs/architecture.md",
    "docs/rules.md",
    "site/docs/findings.md",
  ]) {
    const source = await readFile(join(repositoryRoot, file), "utf8");
    expect(source).toMatch(/severity(?:\*\*)? first|severity first\*\*/);
    expect(source).toContain("salience × prominence");
    expect(source).toMatch(/within\s+(?:each|a) tier/);
  }
});

test("validate reference states project discovery for explicit and omitted --project", () => {
  const start = commandsDoc.indexOf("## validate");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = commandsDoc.indexOf("\n## ", start + 1);
  const section = commandsDoc.slice(start, end === -1 ? undefined : end);
  expect(section).toMatch(/`--project` directory/);
  expect(section).toMatch(/omitted/);
  expect(section).toMatch(
    /walks upward to the nearest `\.idiom\/project\.json`/,
  );
  expect(section).not.toContain("Without `--project`, validation");
});
