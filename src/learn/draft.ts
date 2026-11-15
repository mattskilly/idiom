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
  type LearnedPlacement,
  learnedEntrySchema,
} from "../schemas/learned.js";
import { type Project, projectSchema } from "../schemas/project.js";
import type { RulingResolution } from "../schemas/ruling.js";
import type { FlowRecord } from "../validation.js";
import type { GitTopology } from "../verify/baseline.js";
import { candidateFor, sentence } from "./candidate.js";
import type { StateCapture } from "./capture.js";
import { fileDiff } from "./diff.js";
import { type Interpretation, singularize } from "./interpret.js";
import { appendJsonArrayItem } from "./json-edit.js";
import { lawConfigEdit, lawEditText, lawSummary } from "./law.js";
import { type BrowserLaunch, resolveSubject } from "./target.js";

export type LearnWrite = {
  path: string;
  displayPath: string;
  before?: string | undefined;
  after: string;
};

/** A decided brief's size assertion, promoted to a state invariant. */
export type PromotedInvariant = {
  name: string;
  selector: string;
  width?: number | { min: number; max: number } | undefined;
  height?: number | { min: number; max: number } | undefined;
  tolerance: number;
};

export type DraftInterpretation =
  | Interpretation
  | { kind: "brief-invariants"; invariants: PromotedInvariant[] };

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

/**
 * The entry an observation keeps for when its state exists: the interpreted
 * entry, minus the selector only the state's DOM can resolve. A ruling keeps
 * nothing; its wording is the candidate rule.
 */
export function observationEntry(interpretation: DraftInterpretation): unknown {
  switch (interpretation.kind) {
    case "component":
      return {
        name: singularize(interpretation.subject).toLowerCase(),
        width: interpretation.width,
        height: interpretation.height,
      };
    case "invariant":
      return {
        name: interpretation.subject,
        ...(interpretation.width === undefined
          ? {}
          : { width: interpretation.width }),
        ...(interpretation.height === undefined
          ? {}
          : { height: interpretation.height }),
      };
    case "brief-invariants":
      return interpretation.invariants;
    case "mirrored":
      return {
        name: interpretation.subjects.join(" / "),
        axis: interpretation.axis,
      };
    case "glossary":
      return { term: interpretation.term, preferred: interpretation.preferred };
    case "law":
      return interpretation.law;
    case "ruling":
      return null;
  }
}

const logFile = (projectDirectory: string) =>
  join(projectDirectory, ".idiom", "learned.jsonl");

/** The id the next learned record gets: the log's line count plus one. */
export async function nextLearnedId(projectDirectory: string): Promise<string> {
  const count = ((await optionalText(logFile(projectDirectory))) ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  return `learned-${count + 1}`;
}

/**
 * Turn an interpreted observation into the exact file changes it implies,
 * without touching disk. The caller shows `diff` and writes only after the
 * human confirms it.
 */
export async function draftLearning(options: {
  projectDirectory: string;
  project: Project;
  /** The flow, unless the state is only proposed and no flow is declared. */
  flow?: FlowRecord | undefined;
  /** The flow id the record names; defaults to `flow`'s. */
  flowId?: string | undefined;
  state: string;
  /** The learned id, allocated once by the caller; defaults to the next. */
  id?: string | undefined;
  /** How the state was found; recorded on the entry. */
  placement?: LearnedPlacement | undefined;
  /** A draft flow state to write alongside the record (state proposed). */
  proposal?: { path: string; displayPath: string; content: string } | undefined;
  /**
   * The state does not exist yet: record what needs it as an `observation`
   * that changes no config, against the proposal file.
   */
  asObservation?: boolean | undefined;
  observation: string;
  interpretation: DraftInterpretation;
  capture?: StateCapture | undefined;
  /** The decided brief the rejection is about; recorded as provenance. */
  brief?: string | undefined;
  selectors?: string[] | undefined;
  screenshot?: string | undefined;
  wording?: string | undefined;
  recordedAt: string;
  launch?: BrowserLaunch | undefined;
  gitTopology?: GitTopology | undefined;
}): Promise<LearnDraft> {
  const { projectDirectory, interpretation } = options;
  const display = (path: string) => relative(projectDirectory, path);
  const flowId = options.flowId ?? options.flow?.flow.id;
  if (flowId === undefined) throw new IdiomError("unreachable: no flow");
  const stateLabel = `${flowId}/${options.state}`;
  const writes: LearnWrite[] = [];
  const copies: Array<{ from: string; to: string }> = [];
  const diffs: string[] = [];
  /** One-line notes shown above the file diffs. */
  const headers: string[] = [];

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
        `no capture of ${stateLabel} found; run idiom capture ${flowId} or pass --selector`,
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
  const editStateInvariants = async (items: unknown[]) => {
    if (options.flow === undefined)
      throw new IdiomError(`no flow declares ${stateLabel}`);
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
    const index = (value.states as unknown[]).findIndex(
      (candidate) => record(candidate).id === options.state,
    );
    let after = before;
    for (const item of items) {
      list(state, "invariants").push(item);
      after = edited(after, ["states", index, "invariants"], item, value);
    }
    const parsed = flowSchema.safeParse(value);
    if (!parsed.success)
      throw new IdiomError(
        `the learned invariant would make ${display(path)} invalid: ${issues(parsed.error)}`,
      );
    writes.push({ path, displayPath: display(path), before, after });
    diffs.push(fileDiff(display(path), before, after));
    return display(path);
  };

  if (options.proposal !== undefined) {
    writes.push({
      path: options.proposal.path,
      displayPath: options.proposal.displayPath,
      after: options.proposal.content,
    });
    diffs.push(
      fileDiff(
        options.proposal.displayPath,
        undefined,
        options.proposal.content,
      ),
    );
  }

  const observing =
    options.asObservation === true &&
    interpretation.kind !== "glossary" &&
    interpretation.kind !== "ruling";
  if (observing) {
    // Kept for when the state exists: the interpreted entry, minus the
    // selector only the state's DOM can resolve.
    if (options.proposal === undefined)
      throw new IdiomError("unreachable: an observation needs a proposal");
    entry = observationEntry(interpretation);
    target = { file: options.proposal.displayPath };
  } else
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
        target = { file: await editStateInvariants([entry]), selector };
        break;
      }
      case "brief-invariants": {
        entry = interpretation.invariants;
        target = {
          file: await editStateInvariants(interpretation.invariants),
          selector: interpretation.invariants
            .map((invariant) => invariant.selector)
            .join(", "),
        };
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
        entry = {
          name: `${first} / ${second}`,
          a,
          b,
          axis: interpretation.axis,
        };
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
      case "law": {
        const { law } = interpretation;
        let selector: string | undefined;
        if (law.scope !== undefined) {
          selector = law.scope.selector;
          if (selector === undefined) {
            expectSelectors(1);
            selector = await resolveSelector(law.scope.surface, 0);
          }
        }
        const before = await readFile(projectPath, "utf8");
        const value = record(JSON.parse(before));
        const compiled = lawConfigEdit(
          value,
          law,
          sentence(options.observation),
          selector,
        );
        headers.push(lawSummary(law, selector));
        if (compiled.edit === undefined)
          headers.push(
            `${law.check} already enforces this as configured; .idiom/project.json is unchanged.`,
          );
        else {
          const { edit } = compiled;
          const parsed = projectSchema.safeParse(value);
          if (!parsed.success)
            throw new IdiomError(
              `the learned law would make .idiom/project.json invalid: ${issues(parsed.error)}`,
            );
          const after = lawEditText(before, edit, value);
          writes.push({
            path: projectPath,
            displayPath: display(projectPath),
            before,
            after,
          });
          diffs.push(fileDiff(display(projectPath), before, after));
        }
        entry = compiled.entry;
        target = {
          file: display(projectPath),
          check: compiled.check,
          ...(compiled.scope === undefined ? {} : { scope: compiled.scope }),
        };
        break;
      }
      case "ruling": {
        if (interpretation.notCompiled !== undefined)
          headers.push(
            `Not compiled to a check: ${interpretation.notCompiled}. Recorded as a ruling for the model reviewer.`,
          );
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
          wording:
            options.wording?.trim() ||
            (options.brief === undefined
              ? sentence(options.observation)
              : `${sentence(options.observation).replace(/[.!?]$/, "")} (from brief ${options.brief}).`),
          reason:
            options.placement?.via === "proposed"
              ? `Learned from human review (state proposed: ${stateLabel})`
              : `Learned from human review of ${stateLabel}${options.brief === undefined ? "" : ` against brief ${options.brief}`}`,
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

  const learnedKind: LearnedKind = observing
    ? "observation"
    : interpretation.kind === "brief-invariants"
      ? "invariant"
      : interpretation.kind;
  const logPath = logFile(projectDirectory);
  const logBefore = await optionalText(logPath);
  const id = options.id ?? (await nextLearnedId(projectDirectory));
  const candidate = candidateFor(
    interpretation,
    options.observation,
    ruling?.wording ?? options.wording,
  );
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
    flow: flowId,
    state: options.state,
    observation: options.observation.trim(),
    kind: learnedKind,
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
    ...(options.brief === undefined ? {} : { brief: options.brief }),
    candidate,
    ...(options.placement === undefined
      ? {}
      : { placement: options.placement }),
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
    kind: learnedKind,
    id,
    writes,
    copies,
    diff: [
      ...(headers.length === 0 ? [] : [`${headers.join("\n")}\n`]),
      ...diffs,
    ].join("\n"),
    entry: learned,
    ...(rulingNames === undefined ? {} : { rulingNames }),
    ...(ruling === undefined ? {} : { ruling }),
  };
}
