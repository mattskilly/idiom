/**
 * The status of every public surface, as docs/stability.md states it. The
 * contract test (test/interface-contract.test.ts) snapshots the stable ones and
 * fails on a breaking change unless INTERFACE_VERSION moves. Only tests import
 * this module; it lives in src/ so tsc checks the payload types against the
 * output contracts below.
 */
import { z } from "zod";
import { baselineFileSchema } from "../baseline/schema.js";
import type { ChangedSelection } from "../changed/select.js";
import type { CheckSummary } from "../commands/check.js";
import type {
  changedCheckJson,
  gatePlanOnlyJson,
  gateRunJson,
  gateSkipJson,
} from "../commands/check-json.js";
import type { InitValidateReport } from "../commands/init-validate.js";
import type { DoctorReport } from "../doctor/run.js";
import type { RunFailureJson } from "../errors.js";
import { mcpOutputContracts } from "../mcp/outputs.js";
import { findingNameRegistrySchema } from "../review/names.js";
import { decisionLogEntrySchema } from "../schemas/decision.js";
import { findingCategories, findingSchema } from "../schemas/finding.js";
import { flowSchema } from "../schemas/flow.js";
import { pendingDecisionSchema } from "../schemas/pending-decision.js";
import { projectSchema } from "../schemas/project.js";
import { findingSeveritySchema, rulesSchema } from "../schemas/rules.js";
import {
  changedSelectionContract,
  doctorJsonContract,
  doctorReportContract,
  runFailureContract,
  surfacesContract,
} from "./contracts.js";
import { INTERFACE_VERSION } from "./version.js";

export { doctorJsonContract };

export type SurfaceStatus = "stable" | "stable-additive" | "experimental";

/** CLI commands by path; a command's status covers its flags and arguments. */
export const commandStatus: Record<string, SurfaceStatus> = {
  init: "stable",
  upgrade: "stable",
  mcp: "stable",
  quick: "stable",
  capture: "stable",
  reference: "experimental",
  "reference add": "experimental",
  "reference list": "experimental",
  "reference remove": "experimental",
  design: "experimental",
  "design add": "experimental",
  baseline: "stable",
  "baseline record": "stable",
  "baseline accept": "stable",
  "baseline advance": "experimental",
  review: "stable",
  fix: "experimental",
  check: "stable",
  sweep: "experimental",
  coverage: "experimental",
  digest: "experimental",
  nightly: "experimental",
  bisect: "experimental",
  explore: "experimental",
  "explore resolve": "experimental",
  verify: "stable",
  compare: "experimental",
  report: "stable",
  decide: "stable",
  brief: "experimental",
  "brief triage": "experimental",
  "brief gate": "experimental",
  "brief plan": "experimental",
  "brief record": "experimental",
  "brief decide": "experimental",
  "brief export": "experimental",
  "brief attach": "experimental",
  "brief list": "experimental",
  "brief show": "experimental",
  ruling: "experimental",
  learn: "experimental",
  instruction: "experimental",
  tickets: "experimental",
  context: "stable",
  system: "experimental",
  doctor: "stable",
  validate: "stable",
};

/** `{ flow?, failure }`, printed by check and baseline record|accept when the run could not happen. */
export const runFailureJsonContract = z.looseObject({
  interfaceVersion: z.literal(INTERFACE_VERSION),
  flow: z.string().optional(),
  failure: runFailureContract,
});

/** A full run's check summary: `idiom check --json` without interfaceVersion. */
export const checkSummaryContract = z.looseObject({
  flow: z.string(),
  runDirectory: z.string(),
  reportPath: z.string(),
  verdict: z.literal("deferred").optional(),
  timedOutTuples: z
    .array(
      z.object({
        state: z.string(),
        viewport: z.string(),
        colorScheme: z.enum(["light", "dark"]),
      }),
    )
    .optional(),
  decisionNeeded: z.array(pendingDecisionSchema).optional(),
  decisionQuestion: z.string().optional(),
  captureFailures: z
    .array(
      z.object({
        state: z.string(),
        viewport: z.string(),
        colorScheme: z.enum(["light", "dark"]),
        stage: z.string(),
        message: z.string(),
        hostDeferred: z.boolean().optional(),
      }),
    )
    .optional(),
  baselineNotRecorded: z
    .object({
      failed: z.number(),
      total: z.number(),
      successful: z.number(),
      coordinates: z.array(
        z.object({
          state: z.string(),
          viewport: z.string(),
          colorScheme: z.enum(["light", "dark"]),
        }),
      ),
      message: z.string(),
    })
    .optional(),
  blocking: z.number(),
  findings: z.array(
    z.looseObject({
      id: z.string(),
      severity: findingSeveritySchema,
      category: z.enum(findingCategories),
      rule: z.string().optional(),
      where: z.string(),
      problem: z.string(),
      fix: z.array(z.string()),
    }),
  ),
  /** The flow's last five full runs, oldest first. */
  trend: z
    .looseObject({
      flow: z.string(),
      runs: z.array(
        z.looseObject({
          runId: z.string(),
          completedAt: z.string(),
          commit: z.string(),
          dirty: z.boolean(),
          blocker: z.number(),
          major: z.number(),
          minor: z.number(),
          coverageGap: z
            .looseObject({
              missing: z.number(),
              selected: z.number(),
              kinds: z.array(z.enum(["failed", "interrupted", "busy-host"])),
            })
            .optional(),
        }),
      ),
    })
    .optional(),
  /** The first development-server sign capture saw. */
  devServer: z
    .looseObject({
      kind: z.string(),
      evidence: z.string(),
      state: z.string(),
      viewport: z.string(),
      colorScheme: z.enum(["light", "dark"]),
    })
    .optional(),
});

/** `idiom check --json` for a full run. */
export const checkJsonContract = z.looseObject({
  interfaceVersion: z.literal(INTERFACE_VERSION),
  ...checkSummaryContract.shape,
});

const colorSchemeContract = z.enum(["light", "dark"]);

/** Every flow's timed-out tuples, when any checked flow deferred. */
const deferralContract = {
  verdict: z.literal("deferred").optional(),
  timedOutTuples: z
    .array(
      z.looseObject({
        flow: z.string(),
        state: z.string(),
        viewport: z.string(),
        colorScheme: colorSchemeContract,
      }),
    )
    .optional(),
};

/** One affected flow: why it was not checked, or its check summary. */
const changedEntryContract = z.union([
  z.looseObject({
    flow: z.string(),
    status: z.literal("not-checked"),
    reason: z.string(),
  }),
  z.looseObject({
    flow: z.string(),
    status: z.literal("checked"),
    summary: checkSummaryContract,
  }),
]);

const changedChecksContract = {
  selection: changedSelectionContract,
  checkedStates: z.number(),
  checks: z.array(changedEntryContract),
};

/** `idiom check --changed --json`. */
export const checkChangedJsonContract = z.looseObject({
  interfaceVersion: z.literal(INTERFACE_VERSION),
  ...deferralContract,
  ...changedChecksContract,
});

/**
 * `idiom check --gate --json`: skipped (no UI change), plan only, or ran.
 * gate.plan, gate.comparisons and gate.timing are experimental.
 */
export const checkGateJsonContract = z.union([
  z.looseObject({
    interfaceVersion: z.literal(INTERFACE_VERSION),
    gate: z.looseObject({
      skipped: z.literal(true),
      reason: z.string(),
      base: z.string(),
      line: z.string(),
      files: z.array(z.looseObject({ path: z.string() })),
      allFlows: z.array(z.string()),
    }),
  }),
  z.looseObject({
    interfaceVersion: z.literal(INTERFACE_VERSION),
    gate: z.looseObject({
      planOnly: z.literal(true),
      line: z.string(),
      /** Present; its contents are experimental planner detail. */
      plan: z.looseObject({}),
    }),
  }),
  z.looseObject({
    interfaceVersion: z.literal(INTERFACE_VERSION),
    gate: z.looseObject({
      estimateMs: z.number(),
      budgetMs: z.number(),
      skippedWork: z.array(
        z.looseObject({
          kind: z.enum([
            "probe-controls",
            "viewport",
            "scheme",
            "probe",
            "state",
          ]),
          flow: z.string(),
          state: z.string().optional(),
          viewport: z.string().optional(),
          scheme: colorSchemeContract.optional(),
          reason: z.string(),
          estimatedMs: z.number(),
        }),
      ),
      server: z.looseObject({
        mode: z.enum(["reused", "production-reuse", "fresh"]),
        reason: z.string(),
      }),
    }),
    decisionNeeded: z.array(pendingDecisionSchema),
    decisionQuestion: z.string(),
    ...deferralContract,
    ...changedChecksContract,
  }),
]);

/** `idiom init --validate --json`. */
export const initValidateJsonContract = z.looseObject({
  interfaceVersion: z.literal(INTERFACE_VERSION),
  ready: z.boolean(),
  validate: z.looseObject({ ok: z.boolean() }),
  doctor: doctorReportContract.nullable(),
  surfaces: surfacesContract.optional(),
  /** Advice that never affects ready, such as a missing tablet viewport. */
  suggestions: z.array(z.string()).optional(),
});

/** Compile-time ties: tsc fails if a payload type stops satisfying its contract. */
type Satisfies<T extends U, U> = T;
type Stamped<T> = T & { interfaceVersion: typeof INTERFACE_VERSION };
export type _CheckContract = Satisfies<
  Stamped<CheckSummary>,
  z.infer<typeof checkJsonContract>
>;
export type _DoctorContract = Satisfies<
  Stamped<DoctorReport>,
  z.infer<typeof doctorJsonContract>
>;
export type _ChangedSelectionContract = Satisfies<
  ChangedSelection,
  z.infer<typeof changedSelectionContract>
>;
export type _CheckChangedContract = Satisfies<
  Stamped<ReturnType<typeof changedCheckJson>>,
  z.infer<typeof checkChangedJsonContract>
>;
export type _GateSkipContract = Satisfies<
  Stamped<ReturnType<typeof gateSkipJson>>,
  z.infer<typeof checkGateJsonContract>
>;
export type _GatePlanOnlyContract = Satisfies<
  Stamped<ReturnType<typeof gatePlanOnlyJson>>,
  z.infer<typeof checkGateJsonContract>
>;
export type _GateRunContract = Satisfies<
  Stamped<ReturnType<typeof gateRunJson>>,
  z.infer<typeof checkGateJsonContract>
>;
export type _InitValidateContract = Satisfies<
  Stamped<InitValidateReport>,
  z.infer<typeof initValidateJsonContract>
>;
export type _RunFailureContract = Satisfies<
  Stamped<{ flow?: string; failure: RunFailureJson }>,
  z.infer<typeof runFailureJsonContract>
>;

export type JsonOutput = {
  /** The distinct payload. */
  id: string;
  /** The command path that owns the `--json` flag. */
  command: string;
  description: string;
  status: SurfaceStatus;
  /** Present exactly when status is stable-additive. */
  contract?: z.ZodType;
};

export const jsonOutputs: JsonOutput[] = [
  {
    id: "check",
    command: "check",
    description: "a full run's summary and findings",
    status: "stable-additive",
    contract: checkJsonContract,
  },
  {
    id: "check --gate",
    command: "check",
    description:
      "the gate skip or plan, or the gate that ran with decisionNeeded, decisionQuestion and the changed check",
    status: "stable-additive",
    contract: checkGateJsonContract,
  },
  {
    id: "check --changed",
    command: "check",
    description: "the changed-path selection and each affected flow's summary",
    status: "stable-additive",
    contract: checkChangedJsonContract,
  },
  {
    id: "run-failure",
    command: "check",
    description:
      "{ flow?, failure } when the run could not happen (check, baseline record, baseline accept)",
    status: "stable-additive",
    contract: runFailureJsonContract,
  },
  {
    id: "init --validate",
    command: "init",
    description: "{ ready, validate, doctor, surfaces, suggestions }",
    status: "stable-additive",
    contract: initValidateJsonContract,
  },
  {
    id: "doctor",
    command: "doctor",
    description: "{ flow?, ok, steps, failure?, surfaces? }",
    status: "stable-additive",
    contract: doctorJsonContract,
  },
  {
    id: "upgrade",
    command: "upgrade",
    description: "the skill upgrade report",
    status: "experimental",
  },
  {
    id: "baseline record",
    command: "baseline record",
    description: "the recorded baseline",
    status: "experimental",
  },
  {
    id: "baseline accept",
    command: "baseline accept",
    description: "the accepted baseline",
    status: "experimental",
  },
  {
    id: "baseline advance",
    command: "baseline advance",
    description: "the target branch tip recorded in the base cache",
    status: "experimental",
  },
  {
    id: "review",
    command: "review",
    description: "a flow review result",
    status: "experimental",
  },
  {
    id: "review --page",
    command: "review",
    description: "a page review result",
    status: "experimental",
  },
  {
    id: "sweep",
    command: "sweep",
    description: "the sweep summary",
    status: "experimental",
  },
  {
    id: "coverage",
    command: "coverage",
    description: "uncaptured routes",
    status: "experimental",
  },
  {
    id: "coverage --states",
    command: "coverage",
    description: "observed states per flow",
    status: "experimental",
  },
  {
    id: "learn list",
    command: "learn",
    description: "human-found misses and their coverage (--list)",
    status: "experimental",
  },
  {
    id: "learn harvest",
    command: "learn",
    description:
      "harvested UI corrections, ignored counts and source status (--harvest --json)",
    status: "experimental",
  },
  {
    id: "learn import",
    command: "learn",
    description:
      "an imported table of misses: created, updated, skipped (--import)",
    status: "experimental",
  },
  {
    id: "learn replay",
    command: "learn",
    description:
      "how many of an import's misses the latest checks catch (--replay)",
    status: "experimental",
  },
  {
    id: "report",
    command: "report",
    description: "{ runId, reportPath, trend, humanFound? }",
    status: "experimental",
  },
  {
    id: "digest",
    command: "digest",
    description: "the run digest",
    status: "experimental",
  },
  {
    id: "nightly",
    command: "nightly",
    description: "the scheduled full check that files new findings into triage",
    status: "experimental",
  },
  {
    id: "bisect",
    command: "bisect",
    description: "the commit that introduced a finding",
    status: "experimental",
  },
  {
    id: "decide --pending",
    command: "decide",
    description:
      "explicit unresolved decision questions and rendered escalation text",
    status: "stable-additive",
    contract: z.looseObject({
      interfaceVersion: z.literal(INTERFACE_VERSION),
      decisionNeeded: z.array(pendingDecisionSchema),
      decisionQuestion: z.string(),
    }),
  },
  {
    id: "decide --list",
    command: "decide",
    description: "finding lifecycles",
    status: "experimental",
  },
  {
    id: "compare",
    command: "compare",
    description: "the run comparison",
    status: "experimental",
  },
  {
    id: "brief research",
    command: "brief",
    description: "triage plus the stored brief",
    status: "experimental",
  },
  {
    id: "brief triage",
    command: "brief triage",
    description: "the triage verdict",
    status: "experimental",
  },
  {
    id: "brief gate",
    command: "brief gate",
    description: "the brief gate result",
    status: "experimental",
  },
  {
    id: "brief plan",
    command: "brief plan",
    description: "the research plan",
    status: "experimental",
  },
  {
    id: "brief record",
    command: "brief record",
    description: "the recorded brief",
    status: "experimental",
  },
  {
    id: "brief decide",
    command: "brief decide",
    description: "the decision",
    status: "experimental",
  },
  {
    id: "brief export",
    command: "brief export",
    description: "the exported design asset",
    status: "experimental",
  },
  {
    id: "brief attach",
    command: "brief attach",
    description: "the ticket attachment",
    status: "experimental",
  },
  {
    id: "brief list",
    command: "brief list",
    description: "{ briefs }: stored briefs, newest first",
    status: "experimental",
  },
  {
    id: "brief show",
    command: "brief show",
    description: "one stored brief",
    status: "experimental",
  },
];

/** MCP tool names and inputs. Outputs are classified in mcpOutputs below. */
export const mcpToolStatus: Record<string, SurfaceStatus> = {
  idiom_quick: "stable",
  idiom_check: "stable",
  idiom_issue: "stable",
  idiom_fix_plan: "stable",
  idiom_verify: "stable",
  idiom_context: "stable",
  idiom_flows: "stable",
  idiom_decide: "stable",
  idiom_init: "stable",
  idiom_doctor: "stable",
  idiom_baseline: "stable",
  idiom_design_add: "experimental",
  idiom_choose: "experimental",
  idiom_learn: "experimental",
  idiom_tickets: "experimental",
  idiom_sweep: "experimental",
  idiom_coverage: "experimental",
  idiom_brief_triage: "experimental",
  idiom_brief_plan: "experimental",
  idiom_brief_record: "experimental",
  idiom_brief_decide: "experimental",
  idiom_brief_export: "experimental",
  idiom_brief_attach: "experimental",
  idiom_setup_prompt: "experimental",
  idiom_ready: "experimental",
};

export type McpOutput = {
  status: SurfaceStatus;
  /** Present exactly when status is experimental: why the output is not promised. */
  reason?: string;
  /**
   * Present exactly when status is stable-additive: the promised fields
   * (mcpOutputContracts in src/mcp/outputs.ts). The advertised outputSchema
   * declares at least these, exactly, plus the experimental keys.
   */
  contract?: z.ZodType;
};

const experimentalTool = "The tool itself is experimental";

/**
 * Each MCP tool's structuredContent. An output is stable-additive once its
 * promised fields are named in a contract; the fields it does not name stay
 * experimental, and docs/stability.md says why. An output cannot be more
 * stable than its tool. Every output declares an
 * outputSchema (src/mcp/outputs.ts); structuredContent.failure on a run that
 * could not happen is the stable-additive run-failure object for every tool.
 */
export const mcpOutputs: Record<string, McpOutput> = {
  idiom_quick: {
    status: "stable-additive",
    contract: mcpOutputContracts.idiom_quick,
  },
  idiom_check: {
    status: "stable-additive",
    contract: mcpOutputContracts.idiom_check,
  },
  idiom_issue: {
    status: "stable-additive",
    contract: mcpOutputContracts.idiom_issue,
  },
  idiom_fix_plan: {
    status: "experimental",
    reason: "It mirrors idiom fix, an experimental command",
  },
  idiom_verify: {
    status: "stable-additive",
    contract: mcpOutputContracts.idiom_verify,
  },
  idiom_context: {
    status: "experimental",
    reason: "context has no --json payload to mirror",
  },
  idiom_flows: {
    status: "experimental",
    reason: "No --json payload mirrors it",
  },
  idiom_decide: {
    status: "experimental",
    reason:
      "It mirrors decide and ruling results whose JSON is experimental (only decide --pending is stable, and this tool does not return it)",
  },
  idiom_init: {
    status: "experimental",
    reason:
      "init has no stable --json payload besides init --validate; its wiring and system learning are still evolving",
  },
  idiom_doctor: {
    status: "stable-additive",
    contract: mcpOutputContracts.idiom_doctor,
  },
  idiom_baseline: {
    status: "experimental",
    reason:
      "It mirrors baseline record and baseline advance --json, which are experimental",
  },
  idiom_ready: {
    status: "experimental",
    reason:
      "The tool itself is experimental; its output is the stable-additive init --validate payload plus problem, and is promoted with the tool",
  },
  idiom_design_add: { status: "experimental", reason: experimentalTool },
  idiom_choose: { status: "experimental", reason: experimentalTool },
  idiom_learn: { status: "experimental", reason: experimentalTool },
  idiom_tickets: { status: "experimental", reason: experimentalTool },
  idiom_sweep: { status: "experimental", reason: experimentalTool },
  idiom_coverage: { status: "experimental", reason: experimentalTool },
  idiom_brief_triage: { status: "experimental", reason: experimentalTool },
  idiom_brief_plan: { status: "experimental", reason: experimentalTool },
  idiom_brief_record: { status: "experimental", reason: experimentalTool },
  idiom_brief_decide: { status: "experimental", reason: experimentalTool },
  idiom_brief_export: { status: "experimental", reason: experimentalTool },
  idiom_brief_attach: { status: "experimental", reason: experimentalTool },
  idiom_setup_prompt: { status: "experimental", reason: experimentalTool },
};

export type FileFormat = {
  id: string;
  path: string;
  /** input: you write it and Idiom reads it; output: Idiom writes it and you read it. */
  direction: "input" | "output";
  status: SurfaceStatus;
  schema?: z.ZodType;
};

export const reportFileNames = [
  "report.md",
  "report.html",
  "findings.json",
] as const;

export const fileFormats: FileFormat[] = [
  {
    id: "project",
    path: ".idiom/project.json",
    direction: "input",
    status: "stable-additive",
    schema: projectSchema,
  },
  {
    id: "flow",
    path: ".idiom/flows/<id>.json",
    direction: "input",
    status: "stable-additive",
    schema: flowSchema,
  },
  {
    id: "decisions",
    path: ".idiom/decisions.jsonl",
    direction: "input",
    status: "stable-additive",
    schema: decisionLogEntrySchema,
  },
  {
    id: "baseline",
    path: ".idiom/baselines/<flow>.json",
    direction: "input",
    status: "stable-additive",
    schema: baselineFileSchema,
  },
  {
    id: "rules",
    path: ".idiom/rules.json",
    direction: "input",
    status: "stable-additive",
    schema: rulesSchema,
  },
  {
    id: "finding-names",
    path: ".idiom/finding-names.json",
    direction: "input",
    status: "stable-additive",
    schema: findingNameRegistrySchema,
  },
  {
    id: "findings",
    path: "<run directory>/findings.json",
    direction: "output",
    status: "stable-additive",
    schema: z.array(findingSchema),
  },
  {
    id: "report names",
    path: `<run directory>/{${reportFileNames.join(",")}}`,
    direction: "output",
    status: "stable",
  },
  {
    id: "briefs",
    path: ".idiom/briefs/",
    direction: "output",
    status: "experimental",
  },
  {
    id: "rulings",
    path: "DESIGN.md rulings written by idiom ruling",
    direction: "output",
    status: "experimental",
  },
  {
    id: "capture artifacts",
    path: "<run directory>/* (other than the report names)",
    direction: "output",
    status: "experimental",
  },
];
