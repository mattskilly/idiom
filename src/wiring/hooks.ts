import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { markedBlock, markers, newlineOf, sectionSpan } from "./sections.js";
import type { Writer } from "./types.js";

export const HOOK_COMMAND = "idiom check --gate --fail-on blocker";
export function huskyWriter(source: string): Writer {
  const span = sectionSpan(source, markers("husky"));
  const clean = span
    ? source.slice(0, span.start) + source.slice(span.end).replace(/^\r?\n/, "")
    : source;
  let position = 0;
  const lines = clean.match(/[^\n]*(?:\n|$)/g) ?? [];
  for (const line of lines) {
    const text = line.trim();
    if (
      !text ||
      text.startsWith("#") ||
      /^\.\s+["']?\$\(dirname\s+["']?\$0["']?\)\/_\/husky\.sh["']?$/.test(text)
    )
      position += line.length;
    else break;
  }
  const newline = newlineOf(source);
  const prefix = clean.slice(0, position);
  return {
    candidate:
      prefix +
      (prefix && !prefix.endsWith("\n") ? newline : "") +
      markedBlock("husky", `${HOOK_COMMAND} || exit $?`, newline) +
      newline +
      clean.slice(position),
    reason: `Pre-push: ${HOOK_COMMAND}; a nonzero result prevents push.`,
  };
}

function mapping(value: unknown, name: string): YAMLMap {
  if (
    !isMap(value) ||
    value.flow ||
    value.items.some((pair) => isScalar(pair.key) && pair.key.value === "<<")
  )
    throw new Error(
      `Unsupported ${name}; use a block mapping without aliases or merge keys, or add '${HOOK_COMMAND}' manually`,
    );
  return value;
}
function endOfLine(source: string, position: number): number {
  if (position > 0 && source[position - 1] === "\n") return position;
  const end = source.indexOf("\n", position);
  return end === -1 ? source.length : end + 1;
}
/** Narrow source-range insertion: never serializes the user's configuration. */
export function lefthookWriter(source: string): Writer {
  const span = sectionSpan(source, markers("lefthook"));
  const clean = span
    ? source.slice(0, span.start) + source.slice(span.end).replace(/^\r?\n/, "")
    : source;
  const document = parseDocument(clean, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(`Invalid lefthook YAML: ${document.errors[0]?.message}`);
  const root =
    document.contents === null
      ? undefined
      : mapping(document.contents, "lefthook root");
  const preValue = root?.get("pre-push", true);
  const pre =
    preValue === undefined ? undefined : mapping(preValue, "pre-push");
  const jobs = pre?.get("jobs", true);
  const commands = pre?.get("commands", true);
  if (jobs !== undefined && commands !== undefined)
    throw new Error(
      "Ambiguous pre-push jobs and commands; add the Idiom run manually",
    );
  let position: number;
  let indent: number;
  let body: string;
  if (jobs !== undefined) {
    if (!isSeq(jobs) || jobs.flow)
      throw new Error(
        "pre-push.jobs must be a block sequence; add the Idiom run manually",
      );
    for (const job of jobs.items) {
      const map = mapping(job, "pre-push.jobs entry");
      if (map.get("name") === "idiom")
        throw new Error(
          "Foreign idiom job is occupied; add the gate manually or move it aside",
        );
    }
    const offset = jobs.range?.[0];
    if (offset === undefined)
      throw new Error("Cannot locate pre-push.jobs source");
    indent = offset - (clean.lastIndexOf("\n", offset - 1) + 1);
    position = endOfLine(clean, jobs.range?.[1] ?? offset);
    body = `- name: idiom\n  run: ${HOOK_COMMAND}`;
  } else if (commands !== undefined) {
    const map = mapping(commands, "pre-push.commands");
    if (map.has("idiom"))
      throw new Error(
        "Foreign pre-push.commands.idiom is occupied; add the gate manually or move it aside",
      );
    const offset = map.range?.[0];
    if (offset === undefined)
      throw new Error("Cannot locate pre-push.commands source");
    indent = offset - (clean.lastIndexOf("\n", offset - 1) + 1);
    position = endOfLine(clean, map.range?.[1] ?? offset);
    body = `idiom:\n  run: ${HOOK_COMMAND}`;
  } else if (pre) {
    const offset = pre.range?.[0];
    if (offset === undefined) throw new Error("Cannot locate pre-push source");
    indent = offset - (clean.lastIndexOf("\n", offset - 1) + 1);
    position = endOfLine(clean, pre.range?.[1] ?? offset);
    body = `commands:\n  idiom:\n    run: ${HOOK_COMMAND}`;
  } else {
    indent = 0;
    position = clean.length;
    body = `pre-push:\n  commands:\n    idiom:\n      run: ${HOOK_COMMAND}`;
  }
  const newline = newlineOf(source);
  const block = markedBlock("lefthook", body, newline)
    .split(newline)
    .map((line) => " ".repeat(indent) + line)
    .join(newline);
  const prefix = clean.slice(0, position);
  const candidate =
    prefix +
    (prefix && !prefix.endsWith("\n") ? newline : "") +
    block +
    newline +
    clean.slice(position);
  const result = parseDocument(candidate, { uniqueKeys: true });
  if (result.errors.length)
    throw new Error(
      `Unsafe lefthook insertion: ${result.errors[0]?.message}. Add '${HOOK_COMMAND}' manually`,
    );
  const before = document.toJS() ?? {};
  const after = result.toJS();
  // Verify the patch changed exactly the intended command/job (and introduced containers).
  if (jobs !== undefined)
    after["pre-push"].jobs = after["pre-push"].jobs.filter(
      (job: { name?: string }) => job.name !== "idiom",
    );
  else {
    delete after["pre-push"].commands.idiom;
    if (commands === undefined) delete after["pre-push"].commands;
  }
  if (pre === undefined) delete after["pre-push"];
  if (!isDeepStrictEqual(before, after))
    throw new Error(
      "Lefthook edit changes unrelated configuration; add the gate manually",
    );
  return {
    candidate,
    reason: `Pre-push: ${HOOK_COMMAND}; no hook manager is installed.`,
  };
}
