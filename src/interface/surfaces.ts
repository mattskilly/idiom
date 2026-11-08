/**
 * The status of every public surface, as docs/stability.md states it. The
 * contract test (test/interface-contract.test.ts) snapshots the stable ones and
 * fails on a breaking change unless INTERFACE_VERSION moves. Only tests import
 * this module; it lives in src/ so tsc checks the payload types against the
 * output contracts below.
 */
import { z } from "zod";
import { baselineFileSchema } from "../baseline/schema.js";
import type { CheckSummary } from "../commands/check.js";
import type { InitValidateReport } from "../commands/init-validate.js";
import type { DoctorReport } from "../doctor/run.js";
import { SURFACE_IDS, SURFACE_STATUSES } from "../doctor/surfaces.js";
import type { RunFailureJson } from "../errors.js";
import { findingNameRegistrySchema } from "../review/names.js";
import { decisionLogEntrySchema } from "../schemas/decision.js";
import { findingCategories, findingSchema } from "../schemas/finding.js";
import { flowSchema } from "../schemas/flow.js";
import { pendingDecisionSchema } from "../schemas/pending-decision.js";
import { projectSchema } from "../schemas/project.js";
import { findingSeveritySchema, rulesSchema } from "../schemas/rules.js";
import { INTERFACE_VERSION } from "./version.js";

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

const runFailureContract = z.looseObject({
  stage: z.enum(["preflight", "server", "capture"]),
  cause: z.string(),
  hint: z.string(),
  message: z.string(),
  paths: z.array(z.string()).optional(),
});

/** `{ flow?, failure }`, printed by check and baseline record|accept when the run could not happen. */
export const runFailureJsonContract = z.looseObject({
  interfaceVersion: z.literal(INTERFACE_VERSION),
  flow: z.string().optional(),
  failure: runFailureContract,
});

/** `idiom check --json` for a full run. */
export const checkJsonContract = z.looseObject({
  interfaceVersion: z.literal(INTERFACE_VERSION),
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
});

const surfacesContract = z.looseObject({
  root: z.string(),
  initialized: z.boolean(),
  notice: z.string().optional(),
  ms: z.number(),
  entries: z.array(
    z.looseObject({
      id: z.enum(SURFACE_IDS),
      label: z.string(),
      status: z.enum(SURFACE_STATUSES),
      path: z.string().optional(),
      detail: z.string(),
      fix: z.string().optional(),
    }),
  ),
});

const doctorReportContract = z.looseObject({
  flow: z.string().optional(),
  ok: z.boolean(),
  steps: z.array(
    z.looseObject({
      id: z.enum([
        "node",
        "config",
        "registry",
        "tree",
        "port",
        "setup",
        "build",
        "start",
        "ready",
        "shutdown",
      ]),
      status: z.enum(["pass", "fail", "warn", "skip"]),
      ms: z.number(),
      detail: z.string().optional(),
      hint: z.string().optional(),
    }),
  ),
  failure: runFailureContract.optional(),
  surfaces: surfacesContract.optional(),
});

/** `idiom doctor --json`. */
export const doctorJsonContract = doctorReportContract.extend({
  interfaceVersion: z.literal(INTERFACE_VERSION),
});

/** `idiom init --validate --json`. */
export const initValidateJsonContract = z.looseObject({
  interfaceVersion: z.literal(INTERFACE_VERSION),
  ready: z.boolean(),
  validate: z.looseObject({ ok: z.boolean() }),
  doctor: doctorReportContract.nullable(),
  surfaces: surfacesContract.optional(),
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
      "the gate plan/skip, or checked flows with decisionNeeded and decisionQuestion",
    status: "experimental",
  },
  {
    id: "check --changed",
    command: "check",
    description: "the flows the change selected and their summaries",
    status: "experimental",
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
    description: "{ ready, validate, doctor, surfaces }",
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
    description:
      "a bare array of stored briefs, the one payload without interfaceVersion",
    status: "experimental",
  },
  {
    id: "brief show",
    command: "brief show",
    description: "one stored brief",
    status: "experimental",
  },
];

/** MCP tool names and inputs. Outputs are experimental except structuredContent.failure. */
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
