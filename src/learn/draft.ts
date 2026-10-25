import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { IdiomError } from "../errors.js";
import {
  normalizeChoiceKey,
  rulingFingerprint,
} from "../rulings/fingerprint.js";
import { appendRuling, rulingDiff } from "../rulings/law.js";
import {
  loadRulingNames,
  type RulingNamesState,
  reserveRulingFingerprint,
} from "../rulings/names.js";
import { flowSchema } from "../schemas/flow.js";
import {
  type LearnedEntry,
  type LearnedKind,
  learnedEntrySchema,
} from "../schemas/learned.js";
import { type Project, projectSchema } from "../schemas/project.js";
import type { RulingResolution } from "../schemas/ruling.js";
import type { FlowRecord } from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";
import type { StateCapture } from "./capture.js";
import { fileDiff } from "./diff.js";
import { type Interpretation, singularize } from "./interpret.js";
import { appendJsonArrayItem } from "./json-edit.js";
import { type BrowserLaunch, resolveSubject } from "./target.js";

export type LearnWrite = {
  path: string;
  displayPath: string;
  before?: string | undefined;
  after: string;
};

export type LearnDraft = {
  kind: LearnedKind;
  id: string;
  writes: LearnWrite[];
  copies: Array<{ from: string; to: string }>;
  diff: string;
  entry: LearnedEntry;
  rulingNames?: RulingNamesState | undefined;
  ruling?: RulingResolution | undefined;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function optionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The edited file text: a targeted append that leaves the rest of the file as
 * written when possible, else the whole value re-serialised.
 */
function edited(
  before: string,
  path: Array<string | number>,
  item: unknown,
  value: unknown,
): string {
  const appended = appendJsonArrayItem(before, path, item);
  return appended !== undefined &&
    isDeepStrictEqual(JSON.parse(appended), value)
    ? appended
    : json(value);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(parent: Record<string, unknown>, key: string): unknown[] {
  const current = parent[key];
  if (Array.isArray(current)) return current;
  const created: unknown[] = [];
  parent[key] = created;
  return created;
}

function issues(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("; ");
}

function sentence(observation: string): string {
  const trimmed = observation.trim().replace(/\s+/g, " ");
  const capitalised = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/**
 * Turn an interpreted observation into the exact file changes it implies,
 * without touching disk. The caller shows `diff` and writes only after the
 * human confirms it.
 */
export async function draftLearning(options: {
  projectDirectory: string;
  project: Project;
  flow: FlowRecord;
  state: string;
  observation: string;
  interpretation: Interpretation;
  capture?: StateCapture | undefined;
  selectors?: string[] | undefined;
  screenshot?: string | undefined;
  wording?: string | undefined;
  recordedAt: string;
  launch?: BrowserLaunch | undefined;
  gitTopology?: GitTopology | undefined;
}): Promise<LearnDraft> {
  const { projectDirectory, interpretation } = options;
  const display = (path: string) => relative(projectDirectory, path);
  const writes: LearnWrite[] = [];
  const copies: Array<{ from: string; to: string }> = [];
  const diffs: string[] = [];

  // Validate the human's screenshot before any other work.
  if (options.screenshot !== undefined) {
    let source: Buffer;
    try {
      source = await readFile(options.screenshot);
    } catch (error) {
      throw new IdiomError(
        `cannot read --screenshot ${options.screenshot}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!source.subarray(0, 8).equals(PNG_SIGNATURE))
      throw new IdiomError(`--screenshot ${options.screenshot} is not a PNG`);
  }

  let html: string | undefined;
  const resolveSelector = async (subject: string, index: number) => {
    const given = options.selectors?.[index];
    if (given !== undefined) return given;
    if (options.capture === undefined)
      throw new IdiomError(
        `no capture of ${options.flow.flow.id}/${options.state} found; run idiom capture ${options.flow.flow.id} or pass --selector`,
      );
    html ??= await readFile(options.capture.domPath, "utf8");
    return (await resolveSubject({ html, subject, launch: options.launch }))
      .selector;
  };
  const expectSelectors = (count: number) => {
    if (
      options.selectors !== undefined &&
      options.selectors.length > 0 &&
      options.selectors.length !== count
    )
      throw new IdiomError(
        `this observation needs ${count} --selector value(s), got ${options.selectors.length}`,
      );
  };

  const projectPath = join(projectDirectory, ".idiom", "project.json");
  const editProject = async (
    path: string[],
    item: unknown,
    edit: (checks: Record<string, unknown>) => void,
  ) => {
    const before = await readFile(projectPath, "utf8");
    const value = record(JSON.parse(before));
    if (value.checks === undefined) value.checks = {};
    edit(record(value.checks));
    const after = edited(before, ["checks", ...path], item, value);
    const parsed = projectSchema.safeParse(value);
    if (!parsed.success)
      throw new IdiomError(
        `the learned entry would make .idiom/project.json invalid: ${issues(parsed.error)}`,
      );
    writes.push({
      path: projectPath,
      displayPath: display(projectPath),
      before,
      after,
    });
    diffs.push(fileDiff(display(projectPath), before, after));
  };

  let entry: unknown;
  let target: LearnedEntry["target"];
  let rulingNames: RulingNamesState | undefined;
  let ruling: RulingResolution | undefined;

  switch (interpretation.kind) {
    case "component": {
      expectSelectors(1);
      const selector = await resolveSelector(interpretation.subject, 0);
      const name = singularize(interpretation.subject).toLowerCase();
      entry = {
        name,
        selector,
        width: interpretation.width,
        height: interpretation.height,
      };
      await editProject(["components"], entry, (checks) => {
        const components = list(checks, "components");
        const existing = components
          .map(record)
          .find(
            (component) =>
              component.selector === selector || component.name === name,
          );
        if (existing !== undefined)
          throw new IdiomError(
            `checks.components already declares ${JSON.stringify(existing.name)} (${String(existing.selector)}); edit it in .idiom/project.json`,
          );
        components.push(entry);
      });
      target = { file: display(projectPath), selector };
      break;
    }
    case "invariant": {
      expectSelectors(1);
      const selector = await resolveSelector(interpretation.subject, 0);
      entry = {
        name: interpretation.subject,
        selector,
        ...(interpretation.width === undefined
          ? {}
          : { width: interpretation.width }),
        ...(interpretation.height === undefined
          ? {}
          : { height: interpretation.height }),
      };
      const path = options.flow.file;
      const before = await readFile(path, "utf8");
      const value = record(JSON.parse(before));
      const state = (Array.isArray(value.states) ? value.states : [])
        .map(record)
        .find((candidate) => candidate.id === options.state);
      if (state === undefined)
        throw new IdiomError(
          `${display(path)} declares no state ${JSON.stringify(options.state)}`,
        );
      list(state, "invariants").push(entry);
      const index = (value.states as unknown[]).findIndex(
        (candidate) => record(candidate).id === options.state,
      );
      const after = edited(
        before,
        ["states", index, "invariants"],
        entry,
        value,
      );
      const parsed = flowSchema.safeParse(value);
      if (!parsed.success)
        throw new IdiomError(
          `the learned invariant would make ${display(path)} invalid: ${issues(parsed.error)}`,
        );
      writes.push({ path, displayPath: display(path), before, after });
      diffs.push(fileDiff(display(path), before, after));
      target = { file: display(path), selector };
      break;
    }
    case "glossary": {
      entry = {
        term: interpretation.term,
        preferred: interpretation.preferred,
      };
      await editProject(["copy", "glossary"], entry, (checks) => {
        const copy = record(checks.copy);
        checks.copy = copy;
        const glossary = list(copy, "glossary");
        if (
          glossary
            .map(record)
            .some(
              (item) =>
                typeof item.term === "string" &&
                item.term.toLowerCase() === interpretation.term.toLowerCase(),
            )
        )
          throw new IdiomError(
            `checks.copy.glossary already has ${JSON.stringify(interpretation.term)}; edit it in .idiom/project.json`,
          );
        glossary.push(entry);
      });
      target = { file: display(projectPath) };
      break;
    }
    case "mirrored": {
      expectSelectors(2);
      const [first, second] = interpretation.subjects;
      const a = await resolveSelector(first, 0);
      const b = await resolveSelector(second, 1);
      entry = { name: `${first} / ${second}`, a, b, axis: interpretation.axis };
      await editProject(["mirrored"], entry, (checks) => {
        const pairs = list(checks, "mirrored");
        if (
          pairs
            .map(record)
            .some(
              (pair) =>
                (pair.a === a && pair.b === b) ||
                (pair.a === b && pair.b === a),
            )
        )
          throw new IdiomError(
            `checks.mirrored already pairs ${a} and ${b}; edit it in .idiom/project.json`,
          );
        pairs.push(entry);
      });
      target = { file: display(projectPath), selector: `${a}, ${b}` };
      break;
    }
    case "ruling": {
      const designPath = join(
        projectDirectory,
        options.project.design.designFile,
      );
      const before = await optionalText(designPath);
      if (before === undefined)
        throw new IdiomError(
          `cannot record a ruling: ${options.project.design.designFile} does not exist`,
        );
      const choiceKey = normalizeChoiceKey(options.observation);
      const fingerprint = rulingFingerprint(choiceKey);
      rulingNames = await loadRulingNames({
        projectDirectory,
        gitTopology: options.gitTopology,
      });
      ruling = {
        id: reserveRulingFingerprint(rulingNames, fingerprint),
        fingerprint,
        choiceKey,
        outcome: "rule",
        wording: options.wording?.trim() || sentence(options.observation),
        reason: `Learned from human review of ${options.flow.flow.id}/${options.state}`,
        recordedAt: options.recordedAt,
      };
      const after = appendRuling(before, ruling);
      writes.push({
        path: designPath,
        displayPath: display(designPath),
        before,
        after,
      });
      diffs.push(rulingDiff(display(designPath), before, after));
      entry = { id: ruling.id, wording: ruling.wording };
      target = { file: display(designPath), rulingId: ruling.id };
      break;
    }
  }

  const logPath = join(projectDirectory, ".idiom", "learned.jsonl");
  const logBefore = await optionalText(logPath);
  const count = (logBefore ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  const id = `learned-${count + 1}`;
  let screenshot: string | undefined;
  if (options.screenshot !== undefined) {
    const to = join(projectDirectory, ".idiom", "learned", `${id}.png`);
    screenshot = display(to);
    copies.push({ from: options.screenshot, to });
  }
  const learned = learnedEntrySchema.parse({
    version: 1,
    id,
    recordedAt: options.recordedAt,
    flow: options.flow.flow.id,
    state: options.state,
    observation: options.observation.trim(),
    kind: interpretation.kind,
    target,
    entry,
    ...(options.capture === undefined
      ? {}
      : {
          capture: {
            runId: options.capture.runId,
            viewport: options.capture.viewport,
            ...(options.capture.screenshot === undefined
              ? {}
              : { screenshot: options.capture.screenshot }),
          },
        }),
    ...(screenshot === undefined ? {} : { screenshot }),
  });
  const logAfter = `${logBefore ?? ""}${logBefore === undefined || logBefore.endsWith("\n") || logBefore === "" ? "" : "\n"}${JSON.stringify(learned)}\n`;
  writes.push({
    path: logPath,
    displayPath: display(logPath),
    before: logBefore,
    after: logAfter,
  });
  diffs.push(fileDiff(display(logPath), logBefore, logAfter));
  for (const copy of copies)
    diffs.push(
      `Binary file ${display(copy.to)} added (copied from ${copy.from})\n`,
    );

  return {
    kind: interpretation.kind,
    id,
    writes,
    copies,
    diff: diffs.join("\n"),
    entry: learned,
    ...(rulingNames === undefined ? {} : { rulingNames }),
    ...(ruling === undefined ? {} : { ruling }),
  };
}
