import { expect, test } from "vitest";
import { parseDocument } from "yaml";
import {
  cursorWriter,
  DESIGN_QA_BODY,
  DESIGN_QA_LINES,
  instructionWriter,
} from "../src/wiring/instructions.js";
import {
  markers,
  replaceSection,
  sectionSpan,
} from "../src/wiring/sections.js";

const [begin, end] = markers("design-qa", "html");
const block = `${begin}\n${DESIGN_QA_BODY}\n${end}\n`;

/** The documented manual reversal: delete the marker pair and its contents. */
function removeSection(text: string): string {
  const span = sectionSpan(text, markers("design-qa", "html"));
  if (!span) return text;
  return text.slice(0, span.start) + text.slice(span.end).replace(/^\r?\n/, "");
}

test("the block carries the four Design QA instructions", () => {
  expect(DESIGN_QA_LINES[0]).toBe("## Design QA (Idiom)");
  for (const command of [
    'idiom brief triage "<request>"',
    "idiom context",
    "idiom check --changed",
    "blocking findings",
  ])
    expect(DESIGN_QA_BODY).toContain(command);
});

test("an empty file gets the block; reruns are byte-identical", () => {
  const first = instructionWriter("").candidate;
  expect(first).toBe(block);
  expect(instructionWriter(first).candidate).toBe(first);
});

test("existing text is preserved byte for byte around the section", () => {
  for (const original of [
    "# Project\n\nUse bun.\n",
    "no trailing newline",
    "# Windows\r\nKeep CRLF.\r\n",
  ]) {
    const candidate = instructionWriter(original).candidate;
    expect(candidate.startsWith(original)).toBe(true);
    expect(instructionWriter(candidate).candidate).toBe(candidate);
    if (original.includes("\r\n"))
      expect(candidate.replace(/\r\n/g, "")).not.toContain("\n");
    // Removing the marked section restores the original, minus an added separator.
    expect(removeSection(candidate).replace(/\r?\n$/, "")).toBe(
      original.replace(/\r?\n$/, ""),
    );
  }
});

test("an outdated marked section updates in place only", () => {
  const original = `# Top\n${begin}\nold text\n${end}\n# Bottom\n`;
  const candidate = instructionWriter(original).candidate;
  expect(candidate).toBe(`# Top\n${block}# Bottom\n`);
});

test("a triage mention elsewhere is not ownership; legacy text is kept", () => {
  const legacy =
    '## Design decisions (Idiom)\nBefore writing a ticket, run `idiom brief triage "<request>"`.\n';
  const result = instructionWriter(legacy);
  expect(result.candidate).toBe(`${legacy}${block}`);
  expect(result.reason).toContain("remove it manually");
});

test("malformed markers are refused", () => {
  for (const source of [
    `${begin}\nno end\n`,
    `${end}\n${begin}\n`,
    `${block}${block}`,
    `text ${begin}\nx\n${end}\n`,
  ])
    expect(() => instructionWriter(source)).toThrow(/markers/i);
});

test("reserved destinations refuse unmarked content", () => {
  expect(() =>
    replaceSection("foreign: true\n", "github", "x: 1", { reserved: true }),
  ).toThrow(/Unmarked reserved destination/);
});

test("the Cursor rule has alwaysApply front matter and the same body", () => {
  const rule = cursorWriter("").candidate;
  const front = /^---\n([\s\S]*?)\n---\n/.exec(rule);
  expect(front).not.toBeNull();
  expect(parseDocument(front?.[1] ?? "").toJS()).toEqual({ alwaysApply: true });
  expect(rule).toContain(block);
  expect(cursorWriter(rule).candidate).toBe(rule);
});

test("a marked Cursor rule keeps other metadata and text", () => {
  const rule = cursorWriter("").candidate.replace(
    "---\n# idiom",
    "---\ndescription: team\n# idiom",
  );
  const edited = `${rule}\nLocal note.\n`;
  const candidate = cursorWriter(edited).candidate;
  expect(candidate).toBe(edited);
  expect(
    parseDocument(/^---\n([\s\S]*?)\n---/.exec(candidate)?.[1] ?? "").toJS(),
  ).toEqual({ description: "team", alwaysApply: true });
});

test("an unmarked Cursor rule is protected", () => {
  expect(() =>
    cursorWriter("---\nalwaysApply: true\n---\nTheir rule\n"),
  ).toThrow(/Unmarked or malformed/);
});
