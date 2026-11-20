import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import { beforeAll, describe, expect, test } from "vitest";
import { createProgram } from "../src/cli.js";
import { INTERFACE_VERSION } from "../src/interface/version.js";
import { projectFileFormats } from "../src/migrations/formats.js";

// Keeps docs/migrating-to-1.md honest against the CLI, the format registry,
// the stability page's removal list, the changelog and the upgrading page.

const repositoryRoot = join(import.meta.dirname, "..");
const removedHeading = "## Removed or changed since 0.23.0";

let doc: string;
let stabilityDoc: string;
let upgradingDoc: string;
let changelog: string;

beforeAll(async () => {
  const read = (path: string) => readFile(join(repositoryRoot, path), "utf8");
  [doc, stabilityDoc, upgradingDoc, changelog] = await Promise.all([
    read("docs/migrating-to-1.md"),
    read("docs/stability.md"),
    read("docs/upgrading.md"),
    read("CHANGELOG.md"),
  ]);
});

/** The body under a `## ` heading, up to the next `## ` heading. */
function section(contents: string, heading: string): string {
  const start = contents.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`missing heading: ${heading}`);
  const bodyStart = start + heading.length + 2;
  const next = contents.indexOf("\n## ", bodyStart);
  return contents.slice(bodyStart, next === -1 ? undefined : next);
}

/** The guide without its removed/changed section. */
function withoutRemovedSection(contents: string): string {
  const removed = section(contents, removedHeading);
  return contents.replace(removed, "\n");
}

/** Inline code spans and fenced lines, as in the repository docs test. */
function snippets(contents: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) found.push(line);
    else
      for (const span of line.matchAll(/`([^`]+)`/g))
        found.push(span[1] as string);
  }
  return found;
}

/** Inline code spans only, line by line, skipping fenced blocks. */
function codeSpans(contents: string): string[] {
  const spans: string[] = [];
  let fenced = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced)
      for (const span of line.matchAll(/`([^`]+)`/g))
        spans.push(span[1] as string);
  }
  return spans;
}

type Invocation = { text: string; command: Command; flags: string[] };

/**
 * Every `idiom …` invocation in the snippets, resolved to its commander
 * command, with the `--flags` that follow it in the same snippet (stopping at
 * a shell separator, a comment or another `idiom`).
 */
function invocations(contents: string, program: Command): Invocation[] {
  const result: Invocation[] = [];
  for (const snippet of snippets(contents)) {
    const starts = Array.from(
      snippet.matchAll(
        /(?:^|[\s`$(])(?:npx --no-install |bunx |npx )?idiom(?= |$)/g,
      ),
      (match) => (match.index ?? 0) + match[0].length,
    );
    for (const start of starts) {
      const rest = snippet.slice(start);
      const end = rest.search(/\s(?:\||;|&&|#)|\sidiom(?= |$)/);
      const words = (end === -1 ? rest : rest.slice(0, end))
        .trim()
        .split(/\s+/)
        .filter((word) => word !== "");
      // `codex mcp add idiom -- npx …` names the server, not a command.
      if (words[0] === "--") continue;
      let command = program;
      let consumed = 0;
      for (const word of words.slice(0, 2)) {
        const next = command.commands.find((child) => child.name() === word);
        if (next === undefined) break;
        command = next;
        consumed++;
      }
      const flags = words
        .slice(consumed)
        .filter((word) => /^--[a-z][a-z-]*/.test(word))
        .map((word) => word.split("=")[0] as string);
      result.push({
        text: ["idiom", ...words].join(" "),
        command,
        flags,
      });
    }
  }
  return result;
}

function acceptsFlag(command: Command, flag: string): boolean {
  if (flag === "--help" || flag === "--version") return true;
  for (let current: Command | null = command; current; current = current.parent)
    if (current.options.some((option) => option.long === flag)) return true;
  return false;
}

describe("the 1.0 migration guide", () => {
  test("every flag it names exists on the command it names", () => {
    const program = createProgram();
    const found = invocations(withoutRemovedSection(doc), program);
    const checked = found.flatMap(({ text, command, flags }) =>
      flags.map((flag) => [text, command, flag] as const),
    );
    expect(checked.length).toBeGreaterThan(0);
    for (const [text, command, flag] of checked)
      expect(acceptsFlag(command, flag), `${text}: ${flag}`).toBe(true);
    for (const { text, command } of found)
      expect(command === program && /^idiom [a-z]/.test(text), text).toBe(
        false,
      );
  });

  test("removed flags are really gone", () => {
    const program = createProgram();
    const removed = section(doc, removedHeading);
    expect(removed).toContain("`idiom brief list --json --array`");
    expect(removed).toContain("`idiom brief list --json`");
    const gone = invocations(removed, program).flatMap(({ command, flags }) =>
      flags
        .filter((flag) => !acceptsFlag(command, flag))
        .map((flag) => [command, flag] as const),
    );
    expect(gone.map(([, flag]) => flag)).toContain("--array");
    for (const [command, flag] of gone)
      expect(command.options.map((option) => option.long)).not.toContain(flag);
  });

  test("its removed list covers every removal stability.md records", () => {
    const removed = section(doc, removedHeading);
    const lines = stabilityDoc
      .split(/\r?\n/)
      .filter((line) => line.startsWith("Removed in "));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const surface = codeSpans(line)[0];
      expect(surface, line).toBeDefined();
      expect(removed).toContain(`\`${surface}\``);
    }
  });

  test("its removed/changed list covers the changelog's inline Interface notes since 0.23.0", () => {
    const removed = section(doc, removedHeading);
    const end = changelog.indexOf("\n## [v0.23.0]");
    expect(end).toBeGreaterThan(0);
    const recent = changelog.slice(0, end);
    const notes = Array.from(
      recent.matchAll(/Interface: `([^`]+)`/g),
      (match) => match[1] as string,
    );
    expect(notes).toContain("baseline advance --json");
    for (const surface of notes) expect(removed, surface).toContain(surface);
    expect(removed).toContain("`idiom baseline advance --json`");
    expect(removed).toContain(".flows");
    const advance = createProgram()
      .commands.find((command) => command.name() === "baseline")
      ?.commands.find((command) => command.name() === "advance");
    expect(advance?.options.map((option) => option.long)).toContain("--json");
  });

  test("every project file it names is in the format registry or the stability and upgrading pages", () => {
    const registered = new Set(
      projectFileFormats.flatMap((format) =>
        format.locations.map((location) => `.idiom/${location}`),
      ),
    );
    const paths = codeSpans(doc).filter(
      (span) =>
        span.startsWith(".idiom/") ||
        (!span.includes(" ") &&
          (span.startsWith(".agents/") || /\.(?:json|jsonl|md)$/.test(span))),
    );
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      if (path.startsWith(".idiom/")) {
        const trimmed = path.replace(/\/$/, "");
        expect(
          registered.has(trimmed) || stabilityDoc.includes(`\`${path}\``),
          path,
        ).toBe(true);
      } else
        expect(
          stabilityDoc.includes(path) || upgradingDoc.includes(path),
          path,
        ).toBe(true);
    }
  });

  test("its migration and interface statements match the registry", () => {
    const none = projectFileFormats.every(
      (format) => Object.keys(format.migrations).length === 0,
    );
    expect(doc.includes("No migrations are currently needed")).toBe(none);
    expect(doc).toContain(`interface version ${INTERFACE_VERSION}`);
  });

  test("its plugin and MCP steps match the upgrading page", () => {
    const steps = codeSpans(doc).filter(
      (span) =>
        span.startsWith("/plugin ") ||
        span.startsWith("/reload-plugins") ||
        span.startsWith("codex "),
    );
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(upgradingDoc, step).toContain(step);
    for (const required of [
      "/plugin update idiom@idiom",
      "codex plugin add idiom@idiom",
      "idiom mcp",
    ])
      expect(doc).toContain(required);
  });

  test("it links to Stability and Upgrading instead of copying their tables", () => {
    for (const link of [
      "](stability.md",
      "](stability.md#format-versions-and-upgrade)",
      "](upgrading.md#action-required-by-release)",
      "](upgrading.md#roll-back-to-a-pinned-version)",
    ])
      expect(doc).toContain(link);
    for (const header of [
      "| Command | Status |",
      "| File | Format version | Migrated from |",
      "| Install | Update |",
      "| Payload | Command | Status |",
      "| Tool | Status |",
    ])
      expect(doc).not.toContain(header);
  });

  test("it keeps every required section", () => {
    for (const heading of [
      "# Migrating to 1.0",
      "## What 1.0 promises",
      "## Before you start",
      removedHeading,
      "## Update the CLI and each project",
      "## What idiom upgrade migrates in .idiom/",
      "## Update plugins and MCP",
      "## Roll back",
    ])
      expect(doc.split(/\r?\n/)).toContain(heading);
  });
});
