import { readFile, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { IdiomError } from "../errors.js";
import { rulingCheckable, sentence } from "../learn/candidate.js";
import { findStateCapture } from "../learn/capture.js";
import { nextLearnedId } from "../learn/draft.js";
import {
  type IgnoredColumn,
  type IgnoredTable,
  type ImportRow,
  importChecks,
  parseImportTable,
  type SkippedRow,
} from "../learn/import-table.js";
import { interpretObservation } from "../learn/interpret.js";
import {
  evidenceCatches,
  readLearnedLog,
  runEvidence,
} from "../learn/misses.js";
import { placeObservation, type StateProposal } from "../learn/place.js";
import { resolveStoredRun } from "../review/artifacts.js";
import {
  type Checkable,
  type LearnedCandidate,
  type LearnedEntry,
  type LearnedImport,
  type LearnedPlacement,
  learnedEntrySchema,
} from "../schemas/learned.js";
import { type FlowRecord, validateProject } from "../validation.js";
import { atomicWrite } from "./learn.js";

type ProjectOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
};

/** An import's name: the file's basename, slugged. */
export function importNameOf(file: string): string {
  return basename(file, extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The import a `--import`/`--replay` value names: a readable file's derived
 * name, else the value itself, slugged. Errors with the known names when no
 * logged record belongs to it.
 */
export async function resolveImportName(
  value: string,
  entries: readonly LearnedEntry[],
  cwd: string,
): Promise<string> {
  const name =
    (await isFile(resolve(cwd, value))) || /\.(?:md|markdown)$/i.test(value)
      ? importNameOf(value)
      : importNameOf(`${value}.md`);
  if (entries.some((entry) => entry.import?.name === name)) return name;
  const known = [
    ...new Set(entries.flatMap((entry) => entry.import?.name ?? [])),
  ];
  throw new IdiomError(
    `no imported records named ${JSON.stringify(name)}; ${known.length === 0 ? "nothing has been imported yet (idiom learn --import <file.md>)" : `known imports: ${known.join(", ")}`}`,
  );
}

/** A deterministic JSON form: object keys sorted, for change detection. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}

function withoutUpdatedAt(entry: LearnedEntry): LearnedEntry {
  if (entry.import?.updatedAt === undefined) return entry;
  const { updatedAt: _updatedAt, ...rest } = entry.import;
  return { ...entry, import: rest };
}

/** The candidate rule a row carries, and how it could be checked. */
function rowCandidate(row: ImportRow): {
  candidate: LearnedCandidate;
  checks: string[];
} {
  const fromRule = interpretObservation(row.rule);
  const interpretation =
    fromRule.kind === "ruling"
      ? interpretObservation(row.observation)
      : fromRule;
  const { kind } = interpretation;
  const checks = importChecks(
    row,
    kind,
    interpretation.kind === "law" ? interpretation.law.check : undefined,
  );
  const checkable: Checkable =
    checks.length > 0 || kind !== "ruling"
      ? "deterministic"
      : rulingCheckable(`${row.observation} ${row.how ?? ""}`);
  return { candidate: { rule: sentence(row.rule), kind, checkable }, checks };
}

type Placed = {
  flow: string;
  state: string;
  placement: LearnedPlacement;
  proposal?: StateProposal | undefined;
};

type StateOutcome =
  | { placed: Placed }
  | {
      skip: { code: "ambiguous-state" | "unknown-flow"; reason: string };
    };

/** A state cell that names a declared state outright, if it does. */
function namedState(
  cell: string,
  flows: readonly FlowRecord[],
  flowId: string | undefined,
): StateOutcome | undefined {
  const qualified = /^([^/\s]+)\/([^/\s]+)$/.exec(cell);
  if (qualified?.[1] !== undefined && qualified[2] !== undefined) {
    const flow = flows.find((record) => record.flow.id === qualified[1]);
    if (flow === undefined)
      return {
        skip: {
          code: "unknown-flow",
          reason: `unknown flow ${JSON.stringify(qualified[1])} in state ${cell}`,
        },
      };
    if (flow.flow.states.some((state) => state.id === qualified[2]))
      return {
        placed: {
          flow: flow.flow.id,
          state: qualified[2],
          placement: { via: "state" },
        },
      };
    return undefined;
  }
  if (/\s/.test(cell)) return undefined;
  const declaring = flows.filter(
    (record) =>
      (flowId === undefined || record.flow.id === flowId) &&
      record.flow.states.some((state) => state.id === cell),
  );
  const [only, second] = declaring;
  if (only === undefined) return undefined;
  if (second !== undefined)
    return {
      skip: {
        code: "ambiguous-state",
        reason: `state ${cell} is declared by ${declaring.map((record) => record.flow.id).join(", ")}; pass --flow or write flow/state`,
      },
    };
  return {
    placed: { flow: only.flow.id, state: cell, placement: { via: "state" } },
  };
}

/** The description a `NEW: <description>` state cell asks for, if it does. */
export function newStateDescription(
  cell: string | undefined,
): string | undefined {
  const description = /^new\s*:\s*(.+)$/is.exec(cell?.trim() ?? "")?.[1];
  return description?.trim() || undefined;
}

export type ImportedRecordSummary = {
  id: string;
  row: string;
  surface?: string | undefined;
  flow: string;
  state: string;
  via: LearnedPlacement["via"];
  checks: string[];
};

export type LearnImportResult = {
  name: string;
  source: string;
  file: string;
  rows: number;
  created: string[];
  updated: string[];
  changed: string[];
  skipped: SkippedRow[];
  notInFile: Array<{ id: string; row: string }>;
  coveredByRule: number;
  needNewState: number;
  ignoredTables: IgnoredTable[];
  ignoredColumns: IgnoredColumn[];
  records: ImportedRecordSummary[];
};

const lineId = (line: string): unknown => {
  try {
    return line.trim() === "" ? undefined : JSON.parse(line)?.id;
  } catch {
    return undefined;
  }
};

/**
 * Import a Markdown catalog of human-found misses: one `observation` record
 * per row with its rule candidate and placement, keyed by the row id so a
 * re-import updates instead of duplicating. Writes only the learned log and
 * draft state proposals; never project config or design law, never prompts.
 */
export async function learnImportCommand(
  options: ProjectOptions & {
    file: string;
    flow?: string | undefined;
    clock?: (() => Date) | undefined;
  },
): Promise<LearnImportResult> {
  const { projectDirectory, flows } = await validateProject(options);
  if (
    options.flow !== undefined &&
    !flows.some((record) => record.flow.id === options.flow)
  )
    throw new IdiomError(`no flow ${JSON.stringify(options.flow)}`);
  const path = resolve(options.cwd ?? process.cwd(), options.file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new IdiomError(
      `cannot read ${options.file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const name = importNameOf(path);
  if (name === "")
    throw new IdiomError(
      `cannot name an import from ${options.file}; rename the file to letters, digits or hyphens`,
    );
  const fromProject = relative(projectDirectory, path);
  const source =
    fromProject.startsWith("..") || isAbsolute(fromProject)
      ? path
      : fromProject.split(sep).join("/");
  const parsed = parseImportTable(text);
  const skipped = [...parsed.skipped];

  const logPath = join(projectDirectory, ".idiom", "learned.jsonl");
  const entries = await readLearnedLog(projectDirectory, { strict: true });
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    raw = "";
  }
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const existing = new Map<string, { entry: LearnedEntry; index: number }>();
  for (const entry of entries)
    if (entry.import?.name === name && !existing.has(entry.import.row))
      existing.set(entry.import.row, {
        entry,
        index: lines.findIndex((line) => lineId(line) === entry.id),
      });

  const declared = new Map(
    flows.map((record) => [
      record.flow.id,
      new Set(record.flow.states.map((state) => state.id)),
    ]),
  );
  const recordedAt = (options.clock ?? (() => new Date()))().toISOString();
  let next = Number((await nextLearnedId(projectDirectory)).slice(8));
  const reserved = new Set<string>();
  const proposals: StateProposal[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const changed: string[] = [];
  const present: LearnedEntry[] = [];
  const records: ImportedRecordSummary[] = [];
  let logChanged = false;

  for (const row of parsed.rows) {
    const old = existing.get(row.id);
    const id = old?.entry.id ?? `learned-${next}`;
    // Keep the old placement when nothing that places the row changed.
    const replace =
      old === undefined ||
      old.entry.observation !== row.observation ||
      old.entry.import?.state !== row.state ||
      (options.flow !== undefined && old.entry.flow !== options.flow);
    let placed: Placed;
    if (!replace && old !== undefined) {
      placed = {
        flow: old.entry.flow,
        state: old.entry.state,
        placement: old.entry.placement ?? { via: "state" },
      };
    } else {
      const proposeState = newStateDescription(row.state);
      const named =
        row.state === undefined || proposeState !== undefined
          ? undefined
          : namedState(row.state, flows, options.flow);
      if (named !== undefined && "skip" in named) {
        skipped.push({ line: row.line, id: row.id, ...named.skip });
        continue;
      }
      if (named !== undefined) placed = named.placed;
      else {
        const placement = await placeObservation({
          projectDirectory,
          flows,
          flowId: options.flow,
          observation:
            row.state === undefined || proposeState !== undefined
              ? row.observation
              : `${row.observation} ${row.state}`,
          text: row.observation,
          proposeState,
          learnedId: id,
          reserved,
          ownProposal: old?.entry.id,
        });
        if (placement.matched !== undefined)
          placed = {
            flow: placement.matched.flow.flow.id,
            state: placement.matched.state,
            placement: placement.matched.placement,
          };
        else {
          reserved.add(placement.proposed.stateId);
          placed = {
            flow: placement.proposed.flowId,
            state: placement.proposed.stateId,
            placement: placement.proposed.placement,
            proposal: placement.proposed.proposal,
          };
        }
      }
    }
    const { candidate, checks } = rowCandidate(row);
    const provenance: LearnedImport = {
      name,
      source,
      row: row.id,
      line: row.line,
      ...(row.category === undefined ? {} : { category: row.category }),
      ...(row.how === undefined ? {} : { how: row.how }),
      ...(row.state === undefined ? {} : { state: row.state }),
      ...(row.surface === undefined ? {} : { surface: row.surface }),
      ...(row.date === undefined ? {} : { date: row.date }),
      ...(row.source === undefined ? {} : { rowSource: row.source }),
      rule: row.rule,
      checks,
    };
    const kept = old?.entry;
    let entry = learnedEntrySchema.parse({
      version: 1,
      id,
      recordedAt: kept?.recordedAt ?? recordedAt,
      flow: placed.flow,
      state: placed.state,
      observation: row.observation,
      kind: "observation",
      target: { file: source },
      entry: null,
      ...(kept?.capture === undefined ? {} : { capture: kept.capture }),
      ...(kept?.covered === undefined ? {} : { covered: kept.covered }),
      ...(kept?.screenshot === undefined
        ? {}
        : { screenshot: kept.screenshot }),
      ...(kept?.brief === undefined ? {} : { brief: kept.brief }),
      candidate,
      placement: placed.placement,
      import: provenance,
    });
    if (placed.proposal !== undefined) proposals.push(placed.proposal);
    if (old === undefined) {
      next += 1;
      lines.push(JSON.stringify(entry));
      created.push(id);
      logChanged = true;
    } else {
      updated.push(id);
      if (canonical(withoutUpdatedAt(old.entry)) === canonical(entry)) {
        entry = old.entry;
      } else {
        entry = learnedEntrySchema.parse({
          ...entry,
          import: { ...provenance, updatedAt: recordedAt },
        });
        lines[old.index] = JSON.stringify(entry);
        changed.push(id);
        logChanged = true;
      }
    }
    present.push(entry);
    records.push({
      id,
      row: row.id,
      ...(row.surface === undefined ? {} : { surface: row.surface }),
      flow: entry.flow,
      state: entry.state,
      via: entry.placement?.via ?? "state",
      checks,
    });
  }

  const imported = new Set(parsed.rows.map((row) => row.id));
  const skippedIds = new Set(skipped.flatMap((row) => row.id ?? []));
  const notInFile = [...existing.values()]
    .filter(
      ({ entry }) =>
        entry.import !== undefined &&
        !imported.has(entry.import.row) &&
        !skippedIds.has(entry.import.row),
    )
    .map(({ entry }) => ({ id: entry.id, row: entry.import?.row ?? "" }));

  for (const proposal of proposals)
    await atomicWrite(proposal.path, proposal.content);
  if (logChanged) await atomicWrite(logPath, `${lines.join("\n")}\n`);

  skipped.sort((a, b) => a.line - b.line);
  return {
    name,
    source,
    file: basename(path),
    rows: parsed.rows.length + parsed.skipped.length,
    created,
    updated,
    changed,
    skipped,
    notInFile,
    coveredByRule: present.filter(
      (entry) => (entry.import?.checks.length ?? 0) > 0,
    ).length,
    needNewState: present.filter(
      (entry) =>
        entry.placement?.via === "proposed" &&
        declared.get(entry.flow)?.has(entry.state) !== true,
    ).length,
    ignoredTables: parsed.ignoredTables,
    ignoredColumns: parsed.ignoredColumns,
    records,
  };
}

export function renderLearnImport(result: LearnImportResult): string {
  const imported = result.created.length + result.updated.length;
  const lines = [
    `Imported ${result.file} as "${result.name}": ${result.rows} rows — ${result.created.length} created, ${result.updated.length} updated (${result.changed.length} changed), ${result.skipped.length} skipped.`,
    `Covered by an existing rule: ${result.coveredByRule} of ${imported}. Need a new state: ${result.needNewState}${result.needNewState === 0 ? "" : " (drafts in .idiom/proposals/states/)"}.`,
  ];
  if (result.skipped.length > 0) {
    lines.push("Skipped:");
    const width = Math.max(
      1,
      ...result.skipped.map((row) => (row.id ?? "—").length),
    );
    for (const row of result.skipped)
      lines.push(
        `  line ${String(row.line).padEnd(4)} ${(row.id ?? "—").padEnd(width)}  ${row.reason}`,
      );
  }
  if (result.notInFile.length > 0)
    lines.push(
      `Not in this file (kept): ${result.notInFile.map((item) => `${item.id} (${item.row})`).join(", ")}`,
    );
  for (const table of result.ignoredTables)
    lines.push(
      `Ignored the table on line ${table.line} (${table.columns.join(" | ")}): missing ${table.missing.join(", ")}.`,
    );
  if (result.ignoredColumns.length > 0)
    lines.push(
      `Ignored columns: ${result.ignoredColumns.map((column) => `"${column.header}" (line ${column.line})`).join(", ")}.`,
    );
  lines.push(
    `Next: idiom learn --list --import ${result.name}; idiom learn --replay ${result.name}`,
  );
  if (result.created.length > 0 || result.changed.length > 0)
    lines.push(
      `Commit .idiom/learned.jsonl${result.needNewState === 0 ? "" : " and .idiom/proposals/"}.`,
    );
  return lines.join("\n");
}

export type ReplayRecord = {
  id: string;
  row: string;
  flow: string;
  state: string;
  status: "caught" | "not-caught";
  reason?: string | undefined;
  runId?: string | undefined;
  check?: string | undefined;
};

export type LearnReplayResult = {
  name: string;
  total: number;
  caught: number;
  notCaught: number;
  runs: Record<string, string[]>;
  records: ReplayRecord[];
};

/**
 * How many of an import's misses the latest checks catch: for each record,
 * the newest complete stored run that captured its flow state, and whether
 * that run has a finding from one of the record's checks there. Read-only.
 */
export async function learnReplayCommand(
  options: ProjectOptions & { importName: string },
): Promise<LearnReplayResult> {
  const { projectDirectory, flows, project } = await validateProject(options);
  const entries = await readLearnedLog(projectDirectory, { strict: true });
  const name = await resolveImportName(
    options.importName,
    entries,
    options.cwd ?? process.cwd(),
  );
  const declared = new Map(
    flows.map((record) => [record.flow.id, record] as const),
  );
  const evidenceByRun = new Map<string, ReturnType<typeof runEvidence>>();
  const records: ReplayRecord[] = [];
  const runs: Record<string, string[]> = {};
  for (const entry of entries.filter((item) => item.import?.name === name)) {
    const base = {
      id: entry.id,
      row: entry.import?.row ?? "",
      flow: entry.flow,
      state: entry.state,
    };
    const open = (reason: string, runId?: string): ReplayRecord => ({
      ...base,
      status: "not-caught",
      reason,
      ...(runId === undefined ? {} : { runId }),
    });
    const checks = entry.import?.checks ?? [];
    if (checks.length === 0) {
      records.push(open("no check named"));
      continue;
    }
    const flow = declared.get(entry.flow);
    if (
      flow === undefined ||
      !flow.flow.states.some((state) => state.id === entry.state)
    ) {
      records.push(
        open(
          `state not declared${entry.placement?.proposal === undefined ? "" : ` (${entry.placement.proposal})`}`,
        ),
      );
      continue;
    }
    const capture = await findStateCapture({
      projectDirectory,
      flow: entry.flow,
      state: entry.state,
      viewports: [
        ...(flow.flow.viewports ?? []),
        ...project.viewports.map((viewport) => viewport.name),
      ],
      colorScheme: project.capture.colorScheme,
    });
    if (capture === undefined) {
      records.push(open("never captured"));
      continue;
    }
    const flowRuns = runs[entry.flow] ?? [];
    if (!flowRuns.includes(capture.runId)) flowRuns.push(capture.runId);
    runs[entry.flow] = flowRuns;
    let evidence = evidenceByRun.get(capture.runId);
    if (evidence === undefined) {
      evidence = runEvidence(
        resolveStoredRun(projectDirectory, capture.runId),
        capture.runId,
      );
      evidenceByRun.set(capture.runId, evidence);
    }
    const check = (await evidence)
      .filter((item) => item.flow === entry.flow && item.state === entry.state)
      .map((item) => evidenceCatches(entry, item))
      .find((value) => value !== undefined);
    records.push(
      check === undefined
        ? open(
            `no ${checks.join(", ")} finding in run ${capture.runId}`,
            capture.runId,
          )
        : { ...base, status: "caught", runId: capture.runId, check },
    );
  }
  const caught = records.filter((record) => record.status === "caught").length;
  return {
    name,
    total: records.length,
    caught,
    notCaught: records.length - caught,
    runs,
    records,
  };
}

export function renderLearnReplay(result: LearnReplayResult): string {
  const id = Math.max(...result.records.map((record) => record.id.length), 1);
  const row = Math.max(...result.records.map((record) => record.row.length), 1);
  const where = Math.max(
    ...result.records.map((record) => `${record.flow}/${record.state}`.length),
    1,
  );
  const runs = Object.entries(result.runs);
  return [
    `Replay "${result.name}": the latest checks catch ${result.caught} of ${result.total}.`,
    ...result.records.map(
      (record) =>
        `  ${(record.status === "caught" ? "caught" : "open").padEnd(6)}  ${record.id.padEnd(id)}  ${record.row.padEnd(row)}  ${`${record.flow}/${record.state}`.padEnd(where)}  ${record.status === "caught" ? `${record.check} (run ${record.runId})` : record.reason}`,
    ),
    runs.length === 0
      ? "Read runs: none (no record's state has a stored capture)."
      : `Read runs: ${runs.map(([flow, ids]) => `${flow} ${ids.join(", ")}`).join("; ")}`,
    "To replay against the current checks, run idiom check <flow> (or idiom review <flow> --from <run> --deterministic-only) first.",
  ].join("\n");
}
