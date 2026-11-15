/**
 * The declared output of every Idiom MCP tool. The server advertises each as
 * the tool's `outputSchema` and validates every successful result against it;
 * a mismatch becomes a tool error, so a schema stricter than its handler
 * breaks a working call. docs/stability.md says which outputs are stable;
 * src/interface/surfaces.ts classifies them for the contract test.
 *
 * Schema rules:
 * - The root is always one loose object starting with `interfaceVersion`.
 *   Never a union, transform, pipe or `.default()`: a root without
 *   `type: "object"` makes 2025-era clients see `{ result: … }` instead.
 * - Declare every top-level key the handler can return. A key is required
 *   only when every success branch returns it with a defined value (the JSON
 *   roundtrip in result() drops undefined).
 * - Never embed schemas with transforms (findingSchema): output-mode JSON
 *   Schema conversion fails on them when tools/list runs.
 * - No format validators (z.url(), z.email(), z.iso.*): clients validate
 *   formats, and paths are not URIs.
 * - Experimental outputs and experimental fields keep nested values loose and
 *   never use strict enums, so a new value never turns a success into an
 *   error. A stable-additive output is exact for every promised field: its
 *   contract in mcpOutputContracts names only the promised fields, and its
 *   advertised schema here is that same promised shape plus the loosely typed
 *   experimental keys. A strict enum appears only where the source type is
 *   exactly that enum.
 * - The type ties at the bottom fail tsc when a typed handler result gains,
 *   loses or retypes a top-level key the schema does not match.
 */
import { z } from "zod";
import type { BriefPlan } from "../brief/plan.js";
import type { noModelTriage } from "../brief/triage.js";
import type {
  BaselineAdvanceResult,
  baselineRecordCommand,
} from "../commands/baseline.js";
import type {
  briefAttachJson,
  briefDecideJson,
  briefExportJson,
  briefRecordJson,
} from "../commands/brief.js";
import type { CoverageSummary } from "../commands/coverage.js";
import type { DecideResult } from "../commands/decide.js";
import type { addDesignCommand } from "../commands/design.js";
import type {
  InitValidateReport,
  initValidateProblem,
} from "../commands/init-validate.js";
import type { rulingCommand } from "../commands/ruling.js";
import type { SweepSummary } from "../commands/sweep.js";
import type { StateCoverageSummary } from "../coverage/states.js";
import type { DoctorReport } from "../doctor/run.js";
import {
  changedSelectionContract,
  doctorJsonContract,
  updateNoticeContract,
} from "../interface/contracts.js";
import { INTERFACE_VERSION } from "../interface/version.js";
import type { CheckIssue } from "../review/issues.js";
import type { BriefTriageResult } from "../schemas/brief.js";
import { findingCategories } from "../schemas/finding.js";
import type {
  LearnedCandidate,
  LearnedEntry,
  LearnedPlacement,
} from "../schemas/learned.js";
import { findingSeveritySchema } from "../schemas/severity.js";
import type { SetupFacts } from "../setup/facts.js";
import type { ProductSweepSummary } from "../sweep/types.js";
import type { UpdateNotice } from "../update/notice.js";
import type { VerifyRunResult } from "../verify/run.js";
import type { findingDetail } from "./evidence.js";

const output = <S extends z.ZodRawShape>(description: string, shape: S) =>
  z
    .looseObject({ interfaceVersion: z.literal(INTERFACE_VERSION), ...shape })
    .describe(description);

const text = z.string();
const count = z.number();
const flag = z.boolean();
const list = z.array(z.unknown());
const record = z.record(z.string(), z.unknown());
const colorScheme = z.enum(["light", "dark"]);
const severity = findingSeveritySchema;

/* ---------- Promised fields of the stable-additive outputs ---------- */

export const reportsContract = z.looseObject({
  markdown: z.string(),
  html: z.string().optional(),
  findings: z.string(),
});
const reports = reportsContract;

/** `{ id, runId }`: pass it unmodified to idiom_verify. */
export const verificationReferenceContract = z.looseObject({
  id: text,
  runId: text,
});

const coordinateContract = z.looseObject({
  state: text,
  viewport: text,
  colorScheme: colorScheme.optional(),
  combination: text.optional(),
});

/**
 * One finding's detail (findingDetail in src/mcp/evidence.ts), shared by
 * idiom_quick, idiom_check and idiom_issue. Promised: identity, the finding's
 * rule id, severity and title (explanation), its coordinate, the fix
 * guidance and the evidence paths. Everything else it carries (basis,
 * acceptance, selector, measurement, filmstrip, timeline, the rest of
 * finding) is experimental.
 */
export const findingDetailContract = z.looseObject({
  id: text,
  runId: text,
  flow: text,
  verificationReference: verificationReferenceContract,
  finding: z.looseObject({
    id: text,
    category: z.enum(findingCategories),
    rule: text.optional(),
    severity,
    explanation: text,
    state: text,
    viewport: text,
    colorScheme: colorScheme.optional(),
    fix: text.optional(),
  }),
  coordinate: coordinateContract,
  fix: z.looseObject({ instructions: text.optional() }),
  evidencePaths: z.array(text),
  cropPath: text.optional(),
  evidenceStatus: text,
});

/** One ranked issue. Its ranking fields and rootCause are experimental. */
export const issueContract = z.looseObject({
  id: text,
  severity,
  category: text,
  rule: text.optional(),
  groups: z.array(text),
  findings: count,
  representative: findingDetailContract.optional(),
});

const quickPromised = {
  runId: text,
  runDirectory: text,
  reports,
  counts: z.looseObject({ findings: count, issues: count, groups: count }),
  findings: z.array(findingDetailContract),
  topIssues: z.array(issueContract),
  issues: z.array(issueContract),
};

/** idiom_check's single-flow fields; every key is optional at the root. */
const checkFlowPromised = {
  flow: text.optional(),
  runId: text.optional(),
  topIssues: z.array(issueContract).optional(),
  issues: z.array(issueContract).optional(),
  findings: z.array(findingDetailContract).optional(),
  newFindings: z.array(findingDetailContract).optional(),
  verificationReferences: z.array(verificationReferenceContract).optional(),
  counts: z
    .looseObject({
      new: count,
      fixed: count,
      preExisting: count,
      findings: count,
      issues: count,
      blocking: count,
    })
    .optional(),
  reports: reports.optional(),
  verdict: z.literal("deferred").optional(),
  /** Each carries flow in the changed form. */
  timedOutTuples: z
    .array(
      z.looseObject({
        flow: text.optional(),
        state: text,
        viewport: text,
        colorScheme,
      }),
    )
    .optional(),
};

/** One affected flow of idiom_check's changed form. */
export const checkEntryContract = z.union([
  z.looseObject({
    flow: text,
    status: z.literal("not-checked"),
    reason: text,
  }),
  z.looseObject({
    ...checkFlowPromised,
    flow: text,
    status: z.literal("checked"),
  }),
]);
export type McpCheckEntry = z.output<typeof checkEntryContract>;

const checkPromised = {
  ...checkFlowPromised,
  selection: changedSelectionContract.optional(),
  checkedStates: count.optional(),
  checks: z.array(checkEntryContract).optional(),
};

const issuePromised = {
  ...findingDetailContract.shape,
  members: z.array(findingDetailContract),
};

const verifyPromised = {
  reportPath: text,
  htmlReportPath: text,
  outputDirectory: text,
  outcome: z.enum(["fixed", "failed", "no-findings"]),
  passed: flag,
  findingCount: count,
  causes: z.array(text),
  /** The per-finding outcomes; their locus and acceptance.contract are experimental. */
  verdicts: z
    .array(
      z.looseObject({
        status: z.enum(["fixed", "reproduced", "unverifiable"]),
        reason: text,
        finding: z.looseObject({
          id: text,
          category: z.enum(findingCategories),
          rule: text.optional(),
          severity,
        }),
        acceptance: z.looseObject({
          status: z.enum(["passed", "failed", "not-recheckable"]),
          reason: text,
        }),
      }),
    )
    .optional(),
  /** Deterministic findings the fix introduced, anywhere in the flow. */
  newFindings: z
    .array(
      z.looseObject({
        key: text,
        coordinate: coordinateContract,
        category: text,
        rule: text,
        severity,
      }),
    )
    .optional(),
  sourceRun: text,
  regressionFree: flag.nullable(),
  success: flag,
};

const descriptions = {
  idiom_quick:
    "Quick review: ranked issues, finding details with evidence IDs, counts, interaction probe summary and report paths",
  idiom_check:
    "One flow's check (issues, finding details, counts, baseline comparison, report paths) or, with changed, the selection and one entry per affected flow",
  idiom_issue:
    "Full original evidence for one finding, group or issue: the finding, measurement, fix, coordinate, evidence paths, group members and sibling groups",
  idiom_verify:
    "Verification of original findings against their source run: per-finding verdicts, introduced findings, regression-free and overall success",
};

const doctorOutput = doctorJsonContract
  .extend({
    leftovers: z
      .array(
        z.looseObject({
          pid: z.number(),
          port: z.number(),
          command: z.string(),
          outcome: z.enum(["stopped", "failed"]),
        }),
      )
      .optional(),
    update: updateNoticeContract.optional(),
  })
  .describe(
    "The idiom doctor --json report: pass/fail per boot step with timings and fixes, the run failure when one stopped it, and the surfaces present; update when a newer version is available",
  );

/**
 * The promised fields of each stable-additive output: what the contract test
 * snapshots. Each advertised schema below declares at least these, exactly.
 */
export const mcpOutputContracts = {
  idiom_doctor: doctorOutput,
  idiom_quick: output(descriptions.idiom_quick, quickPromised),
  idiom_check: output(descriptions.idiom_check, checkPromised),
  idiom_issue: output(descriptions.idiom_issue, issuePromised),
  idiom_verify: output(descriptions.idiom_verify, verifyPromised),
};

export const mcpOutputSchemas = {
  idiom_quick: output(descriptions.idiom_quick, {
    ...quickPromised,
    checkCoverage: list.optional(),
    interaction: record,
    captureFailures: list.optional(),
  }),
  idiom_check: output(descriptions.idiom_check, {
    ...checkPromised,
    captureFailures: list.optional(),
    baselineNotRecorded: record.optional(),
    designSystemQuestions: list.optional(),
    groups: list.optional(),
    baseline: record.optional(),
    baselineRecorded: record.optional(),
    acknowledgedFindings: list.optional(),
    acknowledgementLapses: list.optional(),
    preExistingFindings: list.optional(),
    fixed: list.optional(),
    coverage: record.optional(),
    checkCoverage: list.optional(),
    update: updateNoticeContract.optional(),
  }),
  idiom_issue: output(descriptions.idiom_issue, {
    ...issuePromised,
    basis: text,
    basisDetails: record,
    acceptance: z.union([record, z.array(text)]),
    selector: z.unknown().optional(),
    measurement: record,
    filmstrip: record.optional(),
    timeline: record.optional(),
    group: record.optional(),
    siblingGroups: list,
  }),
  idiom_fix_plan: output(
    "The idiom fix repair prompt, the selected original finding records, their verification references and the idiom_verify call to make next (null when nothing is eligible)",
    {
      prompt: text,
      records: list,
      findings: list,
      verificationReferences: list,
      sourceRun: text,
      runDirectory: text,
      reports,
      next: z.looseObject({ tool: text, arguments: record }).nullable(),
    },
  ),
  idiom_verify: output(descriptions.idiom_verify, {
    ...verifyPromised,
    newBlockers: list.optional(),
    coverage: record.optional(),
    designAssets: record.optional(),
  }),
  idiom_context: output("The project design brief as Markdown", {
    brief: text,
  }),
  idiom_flows: output(
    "Configured flows with titles, ordered states, viewports and color schemes; guidance when none are configured",
    {
      flows: z.array(
        z.looseObject({
          id: text,
          title: text,
          states: z.array(z.looseObject({ id: text, description: text })),
          viewports: z.array(
            z.looseObject({ name: text, width: count, height: count }),
          ),
          colorSchemes: z.array(text),
        }),
      ),
      guidance: text.optional(),
    },
  ),
  idiom_decide: output(
    "The recorded decision: accept/reject counts, the acknowledgement written or removed, or the design system question's resolution; always the decision log path",
    {
      path: text,
      projectDirectory: text.optional(),
      corrected: count.optional(),
      accepted: count.optional(),
      rejected: count.optional(),
      skipped: count.optional(),
      acknowledged: count.optional(),
      unacknowledged: count.optional(),
      acknowledgement: record.optional(),
      decisionNeeded: list.optional(),
      decisionQuestion: text.optional(),
      listed: flag.optional(),
      lifecycles: list.optional(),
      recorded: flag.optional(),
      resolution: record.optional(),
      compiled: record.optional(),
    },
  ),
  idiom_init: output(
    "Files created, replaced, unchanged and preserved, the detected wiring plan, system learning, the flow outcome and next steps",
    {
      projectDirectory: text,
      created: z.array(text),
      replaced: z.array(text),
      unchanged: z.array(text),
      skipped: z.array(text),
      autobuild: record,
      skills: list.optional(),
      briefInstruction: list,
      wiring: record.optional(),
      systemLearning: record,
      flows: record,
      notes: z.array(text),
      nextSteps: z.array(text),
    },
  ),
  idiom_setup_prompt: output(
    "The versioned setup prompt and the repository facts it was built from",
    { version: text, prompt: text, facts: record },
  ),
  idiom_ready: output(
    "The idiom init --validate verdict (ready, validate, doctor, surfaces, suggestions) and, when not ready, the first problem and its fix",
    {
      ready: flag,
      validate: record,
      doctor: record.nullable(),
      surfaces: record,
      suggestions: z.array(text),
      problem: record.optional(),
    },
  ),
  idiom_design_add: output(
    "The flow manifest written, whether it changed, the recorded source and whether it is a Figma frame",
    { file: text, changed: flag, source: text, figma: flag },
  ),
  idiom_choose: output(
    "The recorded design choice, decision counts and the decision log path",
    {
      projectDirectory: text,
      path: text,
      corrected: count.optional(),
      accepted: count,
      rejected: count,
      skipped: count,
      acknowledged: count.optional(),
      unacknowledged: count.optional(),
      acknowledgement: record.optional(),
      decisionNeeded: list.optional(),
      decisionQuestion: text.optional(),
      listed: flag.optional(),
      lifecycles: list.optional(),
      choice: text,
    },
  ),
  idiom_tickets: output(
    "Ticket proposals written to triage: directory, created paths, per-cluster outcomes, and ineligible or malformed findings",
    {
      outputDirectory: text,
      createdPaths: z.array(text),
      outcomes: list,
      ineligible: list,
      malformed: list,
    },
  ),
  idiom_sweep: output(
    "Every ranked finding with report paths, for one flow or (all) every flow with proposals and occurrences; degraded when the critique did not complete",
    {
      scope: text.optional(),
      flow: text.optional(),
      build: record.optional(),
      runDirectory: text,
      reportPath: text,
      htmlReportPath: text,
      sweepPath: text.optional(),
      jsonPath: text.optional(),
      outcome: record,
      surfaces: list.optional(),
      flows: list.optional(),
      findings: list,
      sourceFindings: list.optional(),
      occurrences: list.optional(),
      proposals: list.optional(),
      proposalCount: count.optional(),
      selectedCount: count.optional(),
      omittedCount: count.optional(),
      occurrenceCount: count.optional(),
      severityCounts: record.optional(),
      ruleCounts: record.optional(),
      blocking: count,
      tickets: record.optional(),
      degraded: flag,
    },
  ),
  idiom_coverage: output(
    "Routes and the flows that capture them, plus state coverage per flow; with states, only state coverage",
    {
      routes: list.optional(),
      unresolvedStates: list.optional(),
      discoveredFrom: text.optional(),
      excluded: list.optional(),
      disclosures: list.optional(),
      emptyContainers: list.optional(),
      states: z.looseObject({ flows: list }),
    },
  ),
  idiom_doctor: doctorOutput,
  idiom_baseline: output(
    "show: recorded commits and which applies at HEAD; record: the written baseline; advance: the target tip recorded in the base cache",
    {
      flow: text,
      path: text.optional(),
      records: list.optional(),
      applied: text.nullable().optional(),
      distance: count.nullable().optional(),
      guidance: text.optional(),
      commitGuidance: text.optional(),
      commit: text.optional(),
      configHash: text.optional(),
      replaced: flag.optional(),
      findingCount: count.optional(),
      tupleCount: count.optional(),
      pixelCount: count.optional(),
      pixelDirectory: text.optional(),
      findingNameWarning: text.optional(),
      target: text.optional(),
      failedTuples: z.array(text).optional(),
      cachePath: text.optional(),
    },
  ),
  idiom_brief_triage: output(
    "The triage verdict with its id and open questions or, with noModel, the rubric and answer shape; fallback warnings",
    {
      id: text.optional(),
      verdict: text.optional(),
      reason: text.optional(),
      questions: list.optional(),
      rubricVersion: count.optional(),
      rubric: text.optional(),
      request: text.optional(),
      context: record.optional(),
      answerShape: record.optional(),
      rules: list.optional(),
      warnings: z.array(text),
    },
  ),
  idiom_brief_plan: output(
    "Research instructions: questions, references by tier, checks, standards, budget and the input idiom_brief_record accepts",
    {
      request: text,
      triageId: text.optional(),
      noDecision: flag.optional(),
      inventoryInstructions: z.array(text),
      stateChecklist: z.array(text),
      questions: list,
      references: record,
      referencesNote: text.optional(),
      checks: list,
      standards: list,
      budget: record,
      rules: z.array(text),
      recordShape: record,
      recordRules: z.array(text),
      next: z.array(text),
    },
  ),
  idiom_brief_record: output(
    "The stored brief's slug, outcome, status and Markdown path, and the question to ask the human (null when none)",
    {
      slug: text,
      outcome: text,
      status: text,
      markdownPath: text,
      ask: record.nullable(),
    },
  ),
  idiom_brief_decide: output(
    "The decided option, the recommendation, who decided and the regenerated Markdown path; attach when a ticket was given",
    {
      slug: text,
      outcome: text,
      chosen: text,
      recommended: text,
      decidedBy: text.optional(),
      markdownPath: text,
      warning: text.optional(),
      attach: record.optional(),
    },
  ),
  idiom_brief_export: output(
    "The exported design asset directory, its files and the screenshots and states it covers",
    {
      slug: text,
      out: text,
      files: z.array(text),
      screenshots: count,
      states: count,
    },
  ),
  idiom_brief_attach: output(
    "The ticket the brief was attached to, the design asset name and the screenshots and states it carries",
    {
      slug: text,
      ticket: text,
      asset: record,
      screenshots: count,
      states: count,
      ab: z.unknown().optional(),
    },
  ),
  idiom_learn: output(
    "The learned record a person's catch became (or the one it repeats), its matched or proposed flow state, its rule candidate and the absolute paths written",
    {
      recorded: flag,
      repeated: flag,
      id: text,
      kind: text,
      flow: text,
      state: text,
      placement: record.optional(),
      proposal: text.optional(),
      candidate: record.optional(),
      record: record,
      paths: z.array(text),
      next: text,
    },
  ),
} satisfies Record<string, z.ZodObject>;

export type McpToolName = keyof typeof mcpOutputSchemas;

export const isMcpToolName = (name: string): name is McpToolName =>
  Object.hasOwn(mcpOutputSchemas, name);

/** The data a handler passes to result(), before interfaceVersion is stamped. */
export type McpOutputData<N extends McpToolName> = Omit<
  z.output<z.ZodObject<(typeof mcpOutputSchemas)[N]["shape"]>>,
  "interfaceVersion"
>;

/* ---------- Compile-time ties ---------- */

type Stamped<T> = T & { interfaceVersion: typeof INTERFACE_VERSION };
type AllKeys<T> = T extends unknown ? keyof T : never;
/** Keys whose value is always defined, so they survive the JSON roundtrip. */
type DefinedKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];
type SometimesMissing<T, All = T> = T extends unknown
  ? Exclude<AllKeys<All>, DefinedKeys<T>>
  : never;
/** Keys every variant of T always defines. */
type AlwaysDefined<T> = Exclude<AllKeys<T>, SometimesMissing<T>>;
type ShapeOf<N extends McpToolName> = z.output<
  z.ZodObject<(typeof mcpOutputSchemas)[N]["shape"]>
>;
/**
 * tsc fails unless every variant of T satisfies the schema, the schema
 * declares exactly T's keys, and it requires exactly the keys every variant
 * always defines.
 */
type Tie<N extends McpToolName, T extends ShapeOf<N>> = [
  Exclude<AllKeys<T>, keyof ShapeOf<N>>,
  Exclude<keyof ShapeOf<N>, AllKeys<T>>,
  Exclude<AlwaysDefined<T>, AlwaysDefined<ShapeOf<N>>>,
  Exclude<AlwaysDefined<ShapeOf<N>>, AlwaysDefined<T>>,
] extends [never, never, never, never]
  ? true
  : {
      undeclared: Exclude<AllKeys<T>, keyof ShapeOf<N>>;
      unreturned: Exclude<keyof ShapeOf<N>, AllKeys<T>>;
      shouldBeRequired: Exclude<AlwaysDefined<T>, AlwaysDefined<ShapeOf<N>>>;
      shouldBeOptional: Exclude<AlwaysDefined<ShapeOf<N>>, AlwaysDefined<T>>;
    };
type Holds<T extends true> = T;
type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

/** Nested promised shapes no handler `satisfies` reaches on its own. */
type Satisfies<T extends U, U> = T;
export type _FindingDetailContract = Satisfies<
  ReturnType<typeof findingDetail>,
  z.output<typeof findingDetailContract>
>;
export type _IssueContract = Satisfies<
  CheckIssue & { representative?: ReturnType<typeof findingDetail> },
  z.output<typeof issueContract>
>;

export type _DoctorOutput = Holds<
  Tie<"idiom_doctor", Stamped<DoctorReport & { update?: UpdateNotice }>>
>;
export type _ReadyOutput = Holds<
  Tie<
    "idiom_ready",
    Stamped<
      InitValidateReport & {
        problem?: ReturnType<typeof initValidateProblem>;
      }
    >
  >
>;
export type _IssueOutput = Holds<
  Tie<
    "idiom_issue",
    Stamped<
      ReturnType<typeof findingDetail> & {
        group?: Record<string, unknown> | undefined;
        siblingGroups: unknown[];
        members: ReturnType<typeof findingDetail>[];
      }
    >
  >
>;
export type _VerifyOutput = Holds<
  Tie<
    "idiom_verify",
    Stamped<
      VerifyRunResult & {
        sourceRun: string;
        regressionFree: boolean | null;
        success: boolean;
      }
    >
  >
>;
export type _DecideOutput = Holds<
  Tie<"idiom_decide", Stamped<Result<typeof rulingCommand> | DecideResult>>
>;
/** idiom_learn's data: a fresh record, or the stored one a call repeats. */
export type LearnToolData = {
  recorded: boolean;
  repeated: boolean;
  id: string;
  kind: string;
  flow: string;
  state: string;
  placement?: LearnedPlacement | undefined;
  proposal?: string | undefined;
  candidate?: LearnedCandidate | undefined;
  record: LearnedEntry;
  paths: string[];
  next: string;
};
export type _LearnOutput = Holds<Tie<"idiom_learn", Stamped<LearnToolData>>>;
export type _ChooseOutput = Holds<
  Tie<"idiom_choose", Stamped<DecideResult & { choice: string }>>
>;
export type _SetupPromptOutput = Holds<
  Tie<
    "idiom_setup_prompt",
    Stamped<{
      version: string;
      prompt: string;
      facts: SetupFacts & { projectDirectory: string };
    }>
  >
>;
export type _DesignAddOutput = Holds<
  Tie<
    "idiom_design_add",
    Stamped<Result<typeof addDesignCommand> & { figma: boolean }>
  >
>;
export type _SweepOutput = Holds<
  Tie<
    "idiom_sweep",
    Stamped<(SweepSummary | ProductSweepSummary) & { degraded: boolean }>
  >
>;
export type _CoverageOutput = Holds<
  Tie<
    "idiom_coverage",
    Stamped<
      | { states: StateCoverageSummary }
      | (CoverageSummary & { states: StateCoverageSummary })
    >
  >
>;
export type _BaselineOutput = Holds<
  Tie<
    "idiom_baseline",
    Stamped<
      | {
          flow: string;
          path: string;
          records: unknown[];
          applied: null;
          guidance: string;
        }
      | {
          flow: string;
          path: string;
          records: unknown[];
          applied: string | null;
          distance: number | null;
          commitGuidance: string;
        }
      | (Result<typeof baselineRecordCommand> & { commitGuidance: string })
      | BaselineAdvanceResult
    >
  >
>;
export type _BriefTriageOutput = Holds<
  Tie<
    "idiom_brief_triage",
    Stamped<
      (
        | ReturnType<typeof noModelTriage>
        | ({ id: string } & Pick<
            BriefTriageResult,
            "verdict" | "reason" | "questions"
          >)
      ) & { warnings: string[] }
    >
  >
>;
export type _BriefPlanOutput = Holds<
  Tie<"idiom_brief_plan", Stamped<BriefPlan>>
>;
export type _BriefRecordOutput = Holds<
  Tie<"idiom_brief_record", Stamped<ReturnType<typeof briefRecordJson>>>
>;
export type _BriefDecideOutput = Holds<
  Tie<
    "idiom_brief_decide",
    Stamped<
      ReturnType<typeof briefDecideJson> & {
        attach?: ReturnType<typeof briefAttachJson>;
      }
    >
  >
>;
export type _BriefExportOutput = Holds<
  Tie<"idiom_brief_export", Stamped<ReturnType<typeof briefExportJson>>>
>;
export type _BriefAttachOutput = Holds<
  Tie<"idiom_brief_attach", Stamped<ReturnType<typeof briefAttachJson>>>
>;
