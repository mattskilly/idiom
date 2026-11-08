import { parseDocument } from "yaml";
import { markers, newlineOf, replaceSection, sectionSpan } from "./sections.js";
import type { Writer } from "./types.js";

export const DESIGN_QA_LINES = [
  "## Design QA (Idiom)",
  'Before speccing UI, run `idiom brief triage "<request>"` and follow its guidance.',
  "Before building a new screen, read `idiom context`.",
  "After changing UI, run `idiom check --changed`.",
  "Do not call the UI task done while blocking findings remain.",
] as const;
export const DESIGN_QA_BODY = DESIGN_QA_LINES.join("\n");
export function instructionWriter(source: string): Writer {
  const span = sectionSpan(source, markers("design-qa", "html"));
  const outside = span
    ? source.slice(0, span.start) + source.slice(span.end)
    : source;
  return {
    candidate: replaceSection(source, "design-qa", DESIGN_QA_BODY, {
      format: "html",
    }),
    ...(outside.includes("idiom brief triage")
      ? {
          reason:
            "Legacy unmarked triage text preserved; remove it manually if redundant.",
        }
      : {}),
  };
}
export function cursorWriter(source: string): Writer {
  const newline = newlineOf(source);
  if (!source)
    return {
      candidate: `---${newline}${replaceSection("", "cursor-metadata", "alwaysApply: true").replace(/\n/g, newline)}---${newline}${instructionWriter("").candidate.replace(/\n/g, newline)}`,
    };
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (
    !front ||
    !sectionSpan(front[1] ?? "", markers("cursor-metadata")) ||
    !sectionSpan(source.slice(front[0].length), markers("design-qa", "html"))
  )
    throw new Error(
      "Unmarked or malformed .cursor/rules/idiom.mdc; add the rule manually",
    );
  const metadata = replaceSection(
    front[1] ?? "",
    "cursor-metadata",
    "alwaysApply: true",
  );
  const parsed = parseDocument(metadata);
  if (parsed.errors.length || parsed.toJS()?.alwaysApply !== true)
    throw new Error("Conflicting Cursor front matter");
  return {
    candidate: `---${newline}${metadata}${newline}---${newline}${instructionWriter(source.slice(front[0].length)).candidate}`,
  };
}
