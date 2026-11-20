import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { type BriefAsk, briefAsk } from "../brief/ask.js";
import {
  type ComparableCapture,
  type ComparableResearch,
  runComparableResearch,
} from "../brief/comparable-research.js";
import { formatNumber } from "../brief/comparables.js";
import {
  type DesignAssetExport,
  exportDesignAsset,
} from "../brief/design-asset-export.js";
import {
  classifyBriefs,
  classifyTriage,
  findTicketBriefs,
  type GateBrief,
  type GateResult,
  type GateTicket,
  type TicketBriefRef,
  triageFailed,
} from "../brief/gate.js";
import {
  type CriterionWarning,
  DEFAULT_LINT_CONTEXT,
  type LintContext,
  type LintFile,
  type LintResult,
  lintCriteria,
  lintMarkdown,
  lintResult,
  renderWarning,
} from "../brief/lint.js";
import {
  createTriageInvoker,
  type TriageFallback,
  type TriageInvoker,
} from "../brief/model.js";
import {
  type BriefPlan,
  buildBriefPlan,
  renderBriefPlan,
} from "../brief/plan.js";
import { renderBrief, researchCostLine } from "../brief/render.js";
import { runBriefResearch } from "../brief/research.js";
import {
  createResearchCaller,
  type ResearchCaller,
  researchCapableProviders,
} from "../brief/research-model.js";
import { readBriefRubric } from "../brief/rubric.js";
import {
  type DecidedBrief,
  decideBrief,
  type ListedBrief,
  listBriefs,
  type RecordedBrief,
  readBrief,
  readTriage,
  recordBrief,
  recordBriefTicket,
  saveTriage,
  storeResearchedBrief,
} from "../brief/store.js";
import {
  briefTriage,
  MAX_TRIAGE_REQUEST_BYTES,
  noModelTriage,
  renderNoModelTriage,
  renderTriage,
  resolveTriageRequest,
  triageContext,
} from "../brief/triage.js";
import type { CaptureDependencies } from "../capture/run.js";
import { IdiomError } from "../errors.js";
import { jsonPayload } from "../interface/version.js";
import {
  findOptionalProjectDirectory,
  resolveProjectArgument,
} from "../project.js";
import { readEffectiveLaw } from "../rulings/effective.js";
import {
  BRIEF_TRIAGE_ID_PATTERN,
  BRIEF_TRIAGE_MAX_QUESTIONS,
  type BriefTriageResult,
  briefInputSchema,
  type ResearchRun,
  type StoredTriage,
  ticketIdSchema,
} from "../schemas/brief.js";
import { briefSettings, type Project } from "../schemas/project.js";
import { findAutobuildRoot } from "../tickets/target.js";
import {
  validateProject,
  validateProjectConfiguration,
} from "../validation.js";
import { executableOnPath } from "../wiring/detect.js";

export const MAX_BRIEF_INPUT_BYTES = 1024 * 1024;

export type BriefDependencies = {
  invoke?: TriageInvoker;
  readStdin?: () => Promise<string>;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  research?: ResearchCaller;
  /** Milliseconds, for the research run's duration. */
  clock?: () => number;
  /** For `export --capture` and `attach --capture`. */
  capture?: CaptureDependencies | undefined;
  /** For `brief research`: captures and measures one comparable page. */
  captureComparable?: ComparableCapture | undefined;
};

type ProjectOptions = {
  project?: string | undefined;
  cwd?: string | undefined;
};

/** `--no-model` works anywhere; context comes from a project when there is one. */
async function optionalContext(options: ProjectOptions) {
  const projectDirectory = await findOptionalProjectDirectory(
    resolveProjectArgument(options.project, options.cwd),
  );
  if (projectDirectory === undefined) return triageContext(undefined);
  const { project } = await validateProjectConfiguration({
    project: projectDirectory,
  });
  return triageContext({
    projectDirectory,
    productFile: project.design.productFile,
    references: briefSettings(project).references,
  });
}

type TriageOptions = ProjectOptions & {
  noModel?: boolean | undefined;
  onFallback?: ((fallback: TriageFallback) => void) | undefined;
  dependencies?: BriefDependencies | undefined;
};

export type BriefTriageRun =
  | {
      mode: "model";
      request: string;
      result: BriefTriageResult;
      stored: StoredTriage;
    }
  | { mode: "no-model"; triage: ReturnType<typeof noModelTriage> };

function noProjectHint(alternative: string) {
  return (error: unknown): never => {
    if (
      error instanceof IdiomError &&
      /no \.idiom\/project\.json/.test(error.message)
    )
      throw new IdiomError(
        `${error.message}; run idiom init to configure a review provider, or ${alternative}`,
      );
    throw error;
  };
}

/** Triage a request already resolved to text; model mode stores the result. */
export async function runBriefTriage(
  options: TriageOptions & {
    request: string;
    noProjectAlternative?: string | undefined;
  },
): Promise<BriefTriageRun> {
  const rubric = await readBriefRubric();
  if (options.noModel === true)
    return {
      mode: "no-model",
      triage: noModelTriage({
        rubric,
        request: options.request,
        context: await optionalContext(options),
      }),
    };
  const { projectDirectory, project } = await validateProjectConfiguration({
    project: options.project,
    cwd: options.cwd,
  }).catch(
    noProjectHint(
      options.noProjectAlternative ??
        "pass --no-model to apply the rubric yourself",
    ),
  );
  const context = await triageContext({
    projectDirectory,
    productFile: project.design.productFile,
    references: briefSettings(project).references,
  });
  const invoke =
    options.dependencies?.invoke ??
    createTriageInvoker({
      model: project.model,
      projectDirectory,
      environment: options.dependencies?.environment,
      onFallback: options.onFallback,
    });
  const result = await briefTriage({
    rubric,
    request: options.request,
    context,
    invoke,
  });
  const stored = await saveTriage({
    projectDirectory,
    request: options.request,
    rubricVersion: rubric.version,
    result,
    now: now(options.dependencies),
  });
  return { mode: "model", request: options.request, result, stored };
}

export function triageJson(run: BriefTriageRun): object {
  if (run.mode === "no-model") return run.triage;
  return {
    id: run.stored.id,
    verdict: run.result.verdict,
    reason: run.result.reason,
    questions: run.result.questions,
  };
}

export function renderTriageRun(run: BriefTriageRun): string {
  if (run.mode === "no-model") return renderNoModelTriage(run.triage);
  return [
    renderTriage(run.result),
    "",
    `Triage id: ${run.stored.id}`,
    ...(run.result.verdict === "design decision"
      ? [`Next: idiom brief plan ${run.stored.id}`]
      : []),
  ].join("\n");
}

export async function briefTriageCommand(
  options: TriageOptions & {
    request: string;
    json?: boolean | undefined;
  },
): Promise<string> {
  const request = await resolveTriageRequest(
    options.request,
    options.cwd ?? process.cwd(),
  );
  const run = await runBriefTriage({ ...options, request: request.text });
  return options.json === true
    ? jsonPayload(triageJson(run))
    : renderTriageRun(run);
}

async function readTicket(path: string, cwd: string): Promise<string> {
  const absolute = resolveProjectArgument(path, cwd);
  const info = await stat(absolute).catch(() => undefined);
  if (info?.isFile() !== true)
    throw new IdiomError(`no ticket file at ${path}`);
  if (info.size > MAX_TRIAGE_REQUEST_BYTES)
    throw new IdiomError(
      `ticket ${path} is larger than ${MAX_TRIAGE_REQUEST_BYTES / 1024} KB`,
    );
  const text = await readFile(absolute, "utf8");
  if (text.trim() === "") throw new IdiomError(`ticket ${path} is empty`);
  return text;
}

async function resolveLink(
  projectDirectory: string,
  slug: string,
): Promise<GateBrief> {
  try {
    const { brief } = await readBrief(projectDirectory, slug);
    return {
      source: "link",
      slug,
      status: brief.status,
      ...(brief.supersededBy === undefined
        ? {}
        : { supersededBy: brief.supersededBy }),
    };
  } catch (error) {
    if (!(error instanceof IdiomError)) throw error;
    return { source: "link", slug, status: "missing", error: error.message };
  }
}

/**
 * `idiom brief gate`: a ticket that carries a brief is judged by the brief
 * alone (no model call); one that carries none is triaged. Warn-first: the
 * caller decides whether warnings fail.
 */
export async function briefGateCommand(
  options: TriageOptions & { tickets: string[]; strict?: boolean | undefined },
): Promise<GateResult> {
  if (options.tickets.length === 0)
    throw new IdiomError("pass at least one ticket file");
  const cwd = options.cwd ?? process.cwd();
  // Read every ticket first so a usage error fails before any model call.
  const tickets: { path: string; text: string; refs: TicketBriefRef[] }[] = [];
  for (const path of options.tickets) {
    const text = await readTicket(path, cwd);
    tickets.push({ path, text, refs: findTicketBriefs(text) });
  }
  const needsTriage = tickets.some((ticket) => ticket.refs.length === 0);
  const needsProject =
    needsTriage ||
    tickets.some((ticket) => ticket.refs.some((ref) => ref.source === "link"));
  // Resolve the project up front so a configuration error is a usage error,
  // never swallowed as a failed triage.
  const projectDirectory = needsProject
    ? (
        await validateProjectConfiguration({
          project: options.project,
          cwd: options.cwd,
        }).catch(
          noProjectHint(
            needsTriage
              ? "pass the ticket to idiom brief triage --no-model and apply the rubric yourself"
              : "paste the brief's Markdown into the ticket instead of linking it",
          ),
        )
      ).projectDirectory
    : undefined;
  const results: GateTicket[] = [];
  for (const ticket of tickets) {
    if (ticket.refs.length > 0) {
      const briefs: GateBrief[] = [];
      for (const ref of ticket.refs)
        briefs.push(
          ref.source === "embedded"
            ? ref
            : await resolveLink(projectDirectory as string, ref.slug),
        );
      results.push(classifyBriefs(ticket.path, briefs));
      continue;
    }
    try {
      const run = await runBriefTriage({
        ...options,
        noModel: false,
        request: ticket.text,
      });
      if (run.mode !== "model") throw new Error("unreachable: model triage");
      results.push(classifyTriage(ticket.path, run.stored.id, run.result));
    } catch (error) {
      results.push(triageFailed(ticket.path, error));
    }
  }
  return {
    strict: options.strict === true,
    warnings: results.filter((ticket) => ticket.outcome !== "pass").length,
    tickets: results,
  };
}

/** The lint's numbers from a project's config and rulings. */
export async function projectLintContext(
  projectDirectory: string,
  project: Pick<Project, "checks" | "viewports" | "design">,
  onWarning?: ((message: string) => void) | undefined,
): Promise<LintContext> {
  const wide = project.viewports
    .map((viewport) => viewport.width)
    .filter((width) => width >= 768);
  let rulings: LintContext["rulings"] = [];
  try {
    const law = await readEffectiveLaw(
      join(projectDirectory, project.design.designFile),
      projectDirectory,
    );
    rulings = law.resolutions.flatMap((resolution) =>
      resolution.outcome === "rule" && resolution.wording !== undefined
        ? [{ id: resolution.id, wording: resolution.wording }]
        : [],
    );
  } catch (error) {
    onWarning?.(
      `Warning: could not read rulings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    controlGapMin: project.checks.controlGap.min,
    targetSize: project.checks.targetSize ?? DEFAULT_LINT_CONTEXT.targetSize,
    rowWidth:
      wide.length === 0 ? DEFAULT_LINT_CONTEXT.rowWidth : Math.min(...wide),
    rowWidthSource: wide.length === 0 ? "default" : "viewports",
    rulings,
  };
}

/** A project's lint context when there is one; Idiom's defaults otherwise. */
async function optionalLintContext(
  options: ProjectOptions & {
    onWarning?: ((message: string) => void) | undefined;
  },
): Promise<LintContext> {
  const projectDirectory = await findOptionalProjectDirectory(
    resolveProjectArgument(options.project, options.cwd),
  );
  if (projectDirectory === undefined) return DEFAULT_LINT_CONTEXT;
  const { project } = await validateProjectConfiguration({
    project: projectDirectory,
  });
  return projectLintContext(projectDirectory, project, options.onWarning);
}

/**
 * `idiom brief lint`: acceptance criteria that cap a size, time, count or
 * length with no floor or outcome. Deterministic, no model, no project
 * required. Warn-first: the caller decides whether warnings fail.
 */
export async function briefLintCommand(
  options: ProjectOptions & {
    files: string[];
    strict?: boolean | undefined;
    onWarning?: ((message: string) => void) | undefined;
  },
): Promise<LintResult> {
  if (options.files.length === 0)
    throw new IdiomError("pass at least one ticket or spec file");
  const cwd = options.cwd ?? process.cwd();
  // Read every file first so a usage error fails before any output.
  const texts: { path: string; text: string }[] = [];
  for (const path of options.files)
    texts.push({ path, text: await readTicket(path, cwd) });
  const context = await optionalLintContext(options);
  const files: LintFile[] = texts.map(({ path, text }) =>
    lintMarkdown(path, text, context),
  );
  return lintResult(files, options.strict === true);
}

/** Lint a brief's criterion statements; `line` is the 1-based index. */
export async function lintBriefCriteria(
  projectDirectory: string,
  project: Pick<Project, "checks" | "viewports" | "design">,
  statements: string[],
  onWarning?: ((message: string) => void) | undefined,
): Promise<CriterionWarning[]> {
  return lintCriteria(
    statements.map((text, index) => ({ text, line: index + 1 })),
    await projectLintContext(projectDirectory, project, onWarning),
  );
}

function now(dependencies: BriefDependencies | undefined): Date {
  return (dependencies?.now ?? (() => new Date()))();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BRIEF_INPUT_BYTES)
      throw new IdiomError("brief input is larger than 1 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readBriefInput(
  file: string | undefined,
  cwd: string,
  dependencies: BriefDependencies | undefined,
): Promise<string> {
  if (file === undefined || file === "-") {
    const text = await (dependencies?.readStdin ?? readStdin)();
    if (Buffer.byteLength(text) > MAX_BRIEF_INPUT_BYTES)
      throw new IdiomError("brief input is larger than 1 MB");
    return text;
  }
  const path = resolveProjectArgument(file, cwd);
  const info = await stat(path).catch(() => undefined);
  if (info?.isFile() !== true)
    throw new IdiomError(`no brief input file at ${file}`);
  if (info.size > MAX_BRIEF_INPUT_BYTES)
    throw new IdiomError("brief input is larger than 1 MB");
  return readFile(path, "utf8");
}

async function projectSettings(options: ProjectOptions) {
  const { projectDirectory, project } =
    await validateProjectConfiguration(options);
  return { projectDirectory, settings: briefSettings(project) };
}

/** The project's flows, loaded only when a brief carries assertions. */
function projectFlows(projectDirectory: string) {
  return async () =>
    (await validateProject({ project: projectDirectory })).flows;
}

export type BriefRecordResult = RecordedBrief & {
  markdownRelative: string;
  ask: BriefAsk | undefined;
  /** Criteria that cap with no floor or outcome; `line` is the 1-based index. */
  lint: CriterionWarning[];
};

/** Validates and stores already-parsed input; the CLI and MCP share it. */
export async function recordBriefInput(
  options: ProjectOptions & {
    input: unknown;
    dependencies?: BriefDependencies | undefined;
    onWarning?: ((message: string) => void) | undefined;
  },
): Promise<BriefRecordResult> {
  const { projectDirectory, project } =
    await validateProjectConfiguration(options);
  const settings = briefSettings(project);
  const rubric = await readBriefRubric();
  const recorded = await recordBrief({
    projectDirectory,
    input: options.input,
    now: now(options.dependencies),
    rubricVersion: rubric.version,
    settings,
    flows: projectFlows(projectDirectory),
  });
  return {
    ...recorded,
    markdownRelative: relative(projectDirectory, recorded.markdownPath),
    ask: briefAsk(recorded.brief),
    lint: await lintBriefCriteria(
      projectDirectory,
      project,
      (recorded.brief.acceptanceCriteria ?? []).map(
        (criterion) => criterion.statement,
      ),
      options.onWarning,
    ),
  };
}

export async function briefRecordCommand(
  options: ProjectOptions & {
    file?: string | undefined;
    dependencies?: BriefDependencies | undefined;
    onWarning?: ((message: string) => void) | undefined;
  },
): Promise<BriefRecordResult> {
  // Fail on a missing project before waiting on stdin.
  await projectSettings(options);
  const text = await readBriefInput(
    options.file,
    options.cwd ?? process.cwd(),
    options.dependencies,
  );
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new IdiomError(
      `brief input is not valid JSON: ${(error as Error).message}`,
    );
  }
  return recordBriefInput({ ...options, input });
}

export function briefRecordJson(recorded: BriefRecordResult) {
  return {
    slug: recorded.slug,
    outcome: recorded.outcome,
    status: recorded.brief.status,
    markdownPath: recorded.markdownRelative,
    ask: recorded.ask ?? null,
    ...(recorded.lint.length === 0 ? {} : { lint: recorded.lint }),
  };
}

export const BRIEF_PLAN_MAX_MINUTES = 60;

function checkedMinutes(minutes: number | undefined): number | undefined {
  if (minutes === undefined) return undefined;
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > BRIEF_PLAN_MAX_MINUTES
  )
    throw new IdiomError(
      `--minutes must be a whole number from 1 to ${BRIEF_PLAN_MAX_MINUTES}`,
    );
  return minutes;
}

function checkedQuestions(questions: string[] | undefined): string[] {
  const cleaned = (questions ?? []).map((question) => question.trim());
  if (cleaned.some((question) => question === ""))
    throw new IdiomError("--question must not be empty");
  if (cleaned.length > BRIEF_TRIAGE_MAX_QUESTIONS)
    throw new IdiomError(
      `at most ${BRIEF_TRIAGE_MAX_QUESTIONS} questions; triage a narrower request`,
    );
  return cleaned;
}

async function planReferences(options: ProjectOptions) {
  const projectDirectory = await findOptionalProjectDirectory(
    resolveProjectArgument(options.project, options.cwd),
  );
  if (projectDirectory === undefined) return [];
  const { project } = await validateProjectConfiguration({
    project: projectDirectory,
  });
  return briefSettings(project).references;
}

function planFromTriage(
  triage: Pick<StoredTriage, "id" | "request"> & BriefTriageResult,
  references: Awaited<ReturnType<typeof planReferences>>,
  minutes: number | undefined,
): BriefPlan {
  return buildBriefPlan({
    request: triage.request,
    questions: triage.questions,
    triage: { id: triage.id, verdict: triage.verdict, reason: triage.reason },
    references,
    minutes,
  });
}

/**
 * Research instructions for the calling agent: from a stored triage, from
 * questions the agent supplies, or from a fresh (stored) model triage.
 */
export async function runBriefPlan(
  options: TriageOptions & {
    target?: string | undefined;
    request?: string | undefined;
    questions?: string[] | undefined;
    minutes?: number | undefined;
  },
): Promise<BriefPlan> {
  const minutes = checkedMinutes(options.minutes);
  const questions = checkedQuestions(options.questions);
  const target = options.target?.trim();
  if (target !== undefined && BRIEF_TRIAGE_ID_PATTERN.test(target)) {
    if (questions.length > 0)
      throw new IdiomError(
        "a triage id already carries its questions; drop --question",
      );
    const { projectDirectory, project } =
      await validateProjectConfiguration(options);
    const triage = await readTriage(projectDirectory, target);
    return planFromTriage(triage, briefSettings(project).references, minutes);
  }
  const request =
    options.request ??
    (target === undefined
      ? undefined
      : (await resolveTriageRequest(target, options.cwd ?? process.cwd()))
          .text);
  if (request === undefined || request.trim() === "")
    throw new IdiomError(
      "pass a triage id from idiom brief triage, or the request text",
    );
  if (questions.length > 0)
    return buildBriefPlan({
      request,
      questions,
      references: await planReferences(options),
      minutes,
    });
  const run = await runBriefTriage({
    ...options,
    noModel: false,
    request,
    noProjectAlternative:
      "pass --question for each open question to plan without a model",
  });
  if (run.mode !== "model") throw new Error("unreachable: model triage");
  return planFromTriage(
    { ...run.result, id: run.stored.id, request },
    await planReferences(options),
    minutes,
  );
}

export async function briefPlanCommand(
  options: Parameters<typeof runBriefPlan>[0] & { json?: boolean | undefined },
): Promise<string> {
  const plan = await runBriefPlan(options);
  return options.json === true ? jsonPayload(plan) : renderBriefPlan(plan);
}

export type BriefDecideResult = DecidedBrief & { markdownRelative: string };

export async function briefDecideCommand(
  options: ProjectOptions & {
    slug: string;
    option: string;
    by?: string | undefined;
    dependencies?: BriefDependencies | undefined;
  },
): Promise<BriefDecideResult> {
  const { projectDirectory, settings } = await projectSettings(options);
  const decided = await decideBrief({
    projectDirectory,
    slug: options.slug,
    option: options.option,
    by: options.by,
    now: now(options.dependencies),
    settings,
    flows: projectFlows(projectDirectory),
  });
  return {
    ...decided,
    markdownRelative: relative(projectDirectory, decided.markdownPath),
  };
}

export function briefDecideJson(decided: BriefDecideResult) {
  return {
    slug: decided.slug,
    outcome: decided.outcome,
    chosen: decided.chosen.id,
    recommended: decided.recommended.id,
    decidedBy: decided.brief.decidedBy,
    markdownPath: decided.markdownRelative,
    ...(decided.criteriaWarning === undefined
      ? {}
      : { warning: decided.criteriaWarning }),
  };
}

export function renderBriefDecide(decided: BriefDecideResult): string {
  return [
    `Decided brief ${decided.slug}: ${decided.chosen.title.trim()} (by ${decided.brief.decidedBy}) — ${decided.markdownRelative}`,
    ...(decided.criteriaWarning === undefined
      ? []
      : [`Warning: ${decided.criteriaWarning}`]),
  ].join("\n");
}

/** `brief list --json --array` was deprecated in 0.23.0 and removed in 0.24.0. */
export const BRIEF_LIST_ARRAY_REMOVED =
  "--array was removed in 0.24.0; use idiom brief list --json and read .briefs from { interfaceVersion, briefs }";

export async function briefListCommand(
  options: ProjectOptions,
): Promise<ListedBrief[]> {
  const { projectDirectory } = await validateProjectConfiguration(options);
  return listBriefs(projectDirectory);
}

export function renderBriefList(entries: ListedBrief[]): string {
  if (entries.length === 0) return "No briefs.";
  return entries
    .map((entry) =>
      "error" in entry
        ? `${entry.slug}  invalid  ${entry.error}`
        : `${entry.slug}  ${entry.brief.status}${entry.brief.decidedBy === undefined ? "" : ` by ${entry.brief.decidedBy}`}  ${entry.brief.title}${entry.brief.researchRun?.incomplete === undefined ? "" : " (research incomplete)"}`,
    )
    .join("\n");
}

export async function briefShowCommand(
  options: ProjectOptions & { slug: string; json?: boolean | undefined },
): Promise<string> {
  const { projectDirectory, settings } = await projectSettings(options);
  const { brief, markdown } = await readBrief(projectDirectory, options.slug);
  if (options.json === true) return jsonPayload(brief);
  return (markdown ?? renderBrief(brief, settings)).trimEnd();
}

export type BriefResearchOutcome =
  | { outcome: "no-decision"; triage: BriefTriageResult }
  | {
      outcome: "stored";
      triage: BriefTriageResult;
      recorded: RecordedBrief & { markdownRelative: string };
      researchRun: ResearchRun;
      incomplete: boolean;
      /** Criteria that cap with no floor or outcome; `line` is the 1-based index. */
      lint: CriterionWarning[];
    };

/** `idiom brief "<request>" --research`: research and options without an agent. */
export async function briefResearchCommand(
  options: ProjectOptions & {
    request: string;
    onFallback?: ((fallback: TriageFallback) => void) | undefined;
    onProgress?: ((message: string) => void) | undefined;
    onWarning?: ((message: string) => void) | undefined;
    dependencies?: BriefDependencies | undefined;
  },
): Promise<BriefResearchOutcome> {
  const request = await resolveTriageRequest(
    options.request,
    options.cwd ?? process.cwd(),
  );
  const requestCheck = briefInputSchema.shape.request.safeParse(request.text);
  if (!requestCheck.success)
    throw new IdiomError(
      "the request is longer than a brief stores (20,000 characters); research a shorter request",
    );
  const { projectDirectory, project } = await validateProjectConfiguration({
    project: options.project,
    cwd: options.cwd,
  }).catch(
    noProjectHint(
      "use idiom brief triage --no-model and research with your own agent",
    ),
  );
  const providers = researchCapableProviders(project.model);
  if (providers.length === 0)
    throw new IdiomError(
      "--research needs model.provider (or model.fallback) claude-code or codex; the anthropic API provider has no web access in Idiom. Use idiom brief triage and research with your own agent.",
    );
  const settings = briefSettings(project);
  const context = await triageContext({
    projectDirectory,
    productFile: project.design.productFile,
    references: settings.references,
  });
  const environment = options.dependencies?.environment;
  const rubric = await readBriefRubric();
  const result = await runBriefResearch({
    request: request.text,
    rubric,
    context,
    triageInvoke:
      options.dependencies?.invoke ??
      createTriageInvoker({
        model: project.model,
        projectDirectory,
        environment,
        onFallback: options.onFallback,
      }),
    call:
      options.dependencies?.research ??
      createResearchCaller({ projectDirectory, environment }),
    providers,
    settings,
    clock: options.dependencies?.clock,
    onFallback: options.onFallback,
    onProgress: options.onProgress,
  });
  if (result.kind === "no-decision")
    return { outcome: "no-decision", triage: result.triage };
  const recorded = await storeResearchedBrief({
    projectDirectory,
    brief: result.brief,
    researchRun: result.researchRun,
    now: now(options.dependencies),
    rubricVersion: rubric.version,
    settings,
  });
  return {
    outcome: "stored",
    triage: result.triage,
    recorded: {
      ...recorded,
      markdownRelative: relative(projectDirectory, recorded.markdownPath),
    },
    researchRun: result.researchRun,
    incomplete: result.kind === "incomplete",
    lint: await lintBriefCriteria(
      projectDirectory,
      project,
      (recorded.brief.acceptanceCriteria ?? []).map(
        (criterion) => criterion.statement,
      ),
      options.onWarning,
    ),
  };
}

/** A stored brief's lint warnings, for human output. */
export function renderBriefLint(lint: CriterionWarning[]): string[] {
  return lint.flatMap((warning) =>
    renderWarning(`criterion ${warning.line}`, warning),
  );
}

export function renderBriefResearch(
  result: BriefResearchOutcome,
  json: boolean,
): string {
  if (json)
    return jsonPayload(
      result.outcome === "no-decision"
        ? { outcome: result.outcome, triage: result.triage }
        : {
            outcome: result.outcome,
            triage: result.triage,
            slug: result.recorded.slug,
            markdown: result.recorded.markdownRelative,
            status: result.recorded.brief.status,
            researchRun: result.researchRun,
            ...(result.lint.length === 0 ? {} : { lint: result.lint }),
          },
    );
  if (result.outcome === "no-decision")
    return `${renderTriage(result.triage)}\nNo design decision; no research run.`;
  const { recorded, researchRun } = result;
  return [
    `Recorded brief ${recorded.slug} (${recorded.outcome}, ${recorded.brief.status}${result.incomplete ? ", research incomplete" : ""}) — ${recorded.markdownRelative}`,
    `Cost: ${researchCostLine(researchRun)}`,
    ...(researchRun.incomplete === undefined
      ? []
      : [researchRun.incomplete.note]),
    ...renderBriefLint(result.lint),
  ].join("\n");
}

/** `idiom brief research "<request>"`: comparables, references and criteria. */
export async function briefComparablesCommand(
  options: ProjectOptions & {
    request: string;
    viewport?: string | undefined;
    dependencies?: BriefDependencies | undefined;
  },
): Promise<ComparableResearch> {
  const { projectDirectory, project } =
    await validateProjectConfiguration(options);
  return runComparableResearch({
    projectDirectory,
    project,
    cwd: options.cwd ?? process.cwd(),
    request: options.request,
    viewport: options.viewport,
    dependencies: {
      now: options.dependencies?.now,
      captureComparable: options.dependencies?.captureComparable,
    },
  });
}

export function renderComparableResearch(
  result: ComparableResearch,
  json: boolean,
): string {
  if (json) return jsonPayload(result);
  const lines: string[] = [`Comparables for "${result.request}":`];
  for (const comparable of result.comparables) {
    lines.push(
      `- ${comparable.name} (${comparable.tier}): ${comparable.reason}`,
    );
    if (comparable.page !== undefined)
      lines.push(
        `  page: ${comparable.page.url}${comparable.page.surface === undefined ? "" : ` (${comparable.page.surface})`}`,
      );
    lines.push(
      `  status: ${comparable.status === "not-reachable" ? `not reachable — ${comparable.notReachable}` : comparable.status}`,
    );
  }
  const captured = result.comparables.filter(
    (comparable) => comparable.reference !== undefined,
  );
  if (captured.length > 0) {
    lines.push("", "Measurements:");
    for (const comparable of captured) {
      const reference = comparable.reference;
      if (reference === undefined) continue;
      lines.push(
        `- ${comparable.name} — ${reference.label}, ${reference.source} (${reference.viewport.name} ${reference.viewport.width}×${reference.viewport.height}, captured ${reference.capturedAt})`,
      );
      for (const measurement of comparable.measurements)
        lines.push(
          `  ${measurement.subject} ${measurement.property}: ${formatNumber(measurement.value)}${measurement.unit} — ${measurement.selector} at ${measurement.url}`,
        );
      if (comparable.measurements.length === 0)
        lines.push(
          "  nothing measured: no element carried the request's words",
        );
      if (comparable.unmatched.length > 0)
        lines.push(
          `  not found on the page: ${comparable.unmatched.join(", ")}`,
        );
    }
  }
  const unreachable = result.comparables.filter(
    (comparable) => comparable.status !== "captured",
  );
  if (unreachable.length > 0) {
    lines.push("", "Not reachable:");
    for (const comparable of unreachable)
      lines.push(
        comparable.status === "no-public-page"
          ? `- ${comparable.name}: no public page listed (add a url or pages entry)`
          : `- ${comparable.name}: ${comparable.page?.url} — ${comparable.notReachable}`,
      );
  }
  lines.push("", "Proposed acceptance criteria:");
  if (result.criteria.length === 0)
    lines.push("(none: nothing was measured on a captured comparable)");
  for (const criterion of result.criteria) lines.push(`- ${criterion.text}`);
  if (captured.length > 0)
    lines.push(
      "",
      `References stored: ${captured.map((comparable) => comparable.reference?.label).join(", ")}`,
    );
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

type ExportOptions = ProjectOptions & {
  slug: string;
  capture?: boolean | undefined;
  dependencies?: BriefDependencies | undefined;
};

/** `idiom brief export`: a decided brief as a self-contained design asset. */
export async function briefExportCommand(
  options: ExportOptions & { out: string },
): Promise<DesignAssetExport> {
  const validated = await validateProject({
    project: options.project,
    cwd: options.cwd,
  });
  return exportDesignAsset({
    projectDirectory: validated.projectDirectory,
    project: validated.project,
    flows: validated.flows.map((record) => record.flow),
    slug: options.slug,
    out: options.out,
    cwd: options.cwd,
    capture: options.capture,
    dependencies: { capture: options.dependencies?.capture },
  });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function renderBriefExport(
  exported: DesignAssetExport,
  cwd: string,
): string {
  return `Exported brief ${exported.slug} to ${relative(cwd, exported.out) || "."}: ${plural(exported.screenshots, "screenshot")} of ${plural(exported.states, "state")}`;
}

export function briefExportJson(exported: DesignAssetExport, cwd: string) {
  return {
    slug: exported.slug,
    out: relative(cwd, exported.out) || ".",
    files: exported.files,
    screenshots: exported.screenshots,
    states: exported.states,
  };
}

export type BriefAttachResult = {
  slug: string;
  ticket: string;
  asset: { kind: "design"; name: string };
  screenshots: number;
  states: number;
  /** What `ab ticket attach --json` printed, when it printed JSON. */
  ab: unknown;
};

const execFileAsync = promisify(execFile);

/**
 * `idiom brief attach`: export the brief and pin it to an autobuild ticket
 * as a design asset with `ab ticket attach`. Idiom runs no other `ab` verb,
 * so the ticket's state never moves.
 */
export async function briefAttachCommand(
  options: ExportOptions & { ticket: string },
): Promise<BriefAttachResult> {
  const ticket = ticketIdSchema.safeParse(options.ticket);
  if (!ticket.success)
    throw new IdiomError(
      `invalid ticket id ${JSON.stringify(options.ticket)}; pass the autobuild ticket id, such as file-281`,
    );
  const { projectDirectory, settings } = await projectSettings(options);
  // Both refusals come before any export or capture.
  const autobuildRoot = await findAutobuildRoot(projectDirectory);
  if (autobuildRoot === undefined)
    throw new IdiomError(
      `idiom brief attach needs an autobuild project (no autobuild.toml above ${projectDirectory}); use idiom brief export ${options.slug} --out <dir>`,
    );
  const environment = options.dependencies?.environment ?? process.env;
  if (!(await executableOnPath("ab", { environment })))
    throw new IdiomError(
      `idiom brief attach needs the autobuild CLI (ab) on PATH; export with idiom brief export ${options.slug} --out <dir> and attach it with ab ticket attach ${ticket.data} design <dir>`,
    );
  const staging = await mkdtemp(join(tmpdir(), "idiom-design-"));
  try {
    const exported = await briefExportCommand({
      ...options,
      out: join(staging, options.slug),
    });
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        "ab",
        [
          "ticket",
          "attach",
          ticket.data,
          "design",
          exported.out,
          "--name",
          exported.slug,
          "--json",
        ],
        { cwd: autobuildRoot, env: environment },
      ));
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      const stderr =
        typeof failure.stderr === "string" ? failure.stderr.trim() : "";
      throw new IdiomError(
        `ab ticket attach failed (exit ${typeof failure.code === "number" ? failure.code : "unknown"}): ${stderr || (error as Error).message}`,
      );
    }
    await recordBriefTicket({
      projectDirectory,
      slug: exported.slug,
      ticket: ticket.data,
      settings,
    });
    let ab: unknown;
    try {
      ab = JSON.parse(stdout);
    } catch {
      ab = undefined;
    }
    return {
      slug: exported.slug,
      ticket: ticket.data,
      asset: { kind: "design", name: exported.slug },
      screenshots: exported.screenshots,
      states: exported.states,
      ab,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function renderBriefAttach(attached: BriefAttachResult): string {
  return `Attached brief ${attached.slug} to ticket ${attached.ticket} as design asset ${attached.asset.name} (${plural(attached.screenshots, "screenshot")}). The ticket's state is unchanged.`;
}

export function briefAttachJson(attached: BriefAttachResult) {
  return {
    slug: attached.slug,
    ticket: attached.ticket,
    asset: attached.asset,
    screenshots: attached.screenshots,
    states: attached.states,
    ...(attached.ab === undefined ? {} : { ab: attached.ab }),
  };
}
