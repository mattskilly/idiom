import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import { selectBaselineRecord } from "../baseline/resolve.js";
import {
  baselineDirectory,
  baselinePath,
  readBaselineFile,
} from "../baseline/store.js";
import { summarizeFinding } from "../baseline/summary.js";
import { selectColorSchemes, selectViewports } from "../capture/resolve.js";
import type { CaptureDependencies } from "../capture/run.js";
import {
  baselineRecordCommand,
  renderBaselineRecord,
} from "../commands/baseline.js";
import { type CheckSummary, checkWithReview } from "../commands/check.js";
import {
  checkChanged,
  renderChangedSelection,
} from "../commands/check-changed.js";
import { contextCommand } from "../commands/context.js";
import {
  coverageCommand,
  renderCoverage,
  stateCoverageCommand,
} from "../commands/coverage.js";
import { decideCommand } from "../commands/decide.js";
import { addDesignCommand } from "../commands/design.js";
import { initProject, initSummaryLines } from "../commands/init.js";
import { rulingCommand } from "../commands/ruling.js";
import { renderSweepSummary, sweepCommand } from "../commands/sweep.js";
import { verifyCommand } from "../commands/verify.js";
import { renderStateCoverage, stateCoverageLine } from "../coverage/states.js";
import { figmaToken } from "../design/figma/client.js";
import { isFigmaHost } from "../design/source.js";
import { IdiomError } from "../errors.js";
import {
  eligibleRecords,
  selectTargets,
  takeFixSnapshot,
} from "../fix/check.js";
import { repairPrompt } from "../fix/prompt.js";
import type { GenerateFlow } from "../flows/generate.js";
import { interactionTail } from "../quick/interaction.js";
import { type QuickDependencies, runQuick } from "../quick/run.js";
import { loadRunTuples } from "../review/artifacts.js";
import type { CatalogFinding } from "../review/catalog.js";
import type { ReviewDependencies, ReviewRunResult } from "../review/run.js";
import { projectIssueSummary } from "../review/summary.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import {
  emitClusterTickets,
  renderClusterTicketsResult,
} from "../tickets/emit.js";
import { resolveTicketTarget } from "../tickets/target.js";
import { loadProjectContext, validateProject } from "../validation.js";
import {
  EvidenceStore,
  evidencePath,
  findingDetail,
  insideRoot,
  result,
  safeIdentifier,
} from "./evidence.js";
import type { Execution, ToolExecutionQueue } from "./execution.js";

export type McpDependencies = {
  capture?: CaptureDependencies | undefined;
  quick?: QuickDependencies | undefined;
  /** Test seam: critique adapters and environment for sweep; capture still comes from `capture`. */
  review?: Omit<ReviewDependencies, "capture"> | undefined;
  /** Test seam: offline site-flow generation for idiom_init. */
  init?: { generateFlows?: GenerateFlow | undefined } | undefined;
};
const identifier = z
  .string()
  .trim()
  .min(1)
  .refine(safeIdentifier, "Use an identifier without path separators, . or ..");
const selection = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !value.includes(","),
    "Supply exact names as separate array items",
  );
const list = <T extends z.ZodType<string>>(item: T) =>
  z
    .array(item)
    .min(1)
    .refine(
      (values) => new Set(values).size === values.length,
      "Lists must not contain duplicates",
    );
const relativePath = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !isAbsolute(value) && !value.includes("\0"),
    "Use a path relative to the bound project root",
  );
const humanReason = z
  .string()
  .refine((value) => value.trim().length > 0, "Reason must not be blank")
  .describe("Human-supplied reason, preserved verbatim");
const httpUrl = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "URL must use HTTP(S)");
const commitGuidance =
  "Commit the baseline file deliberately; record only after intentional changes, on clean committed HEAD.";
const reference = z.strictObject({
  id: identifier.describe(
    "Original finding ID returned by check, issue or fix-plan",
  ),
  runId: identifier.describe("Exact original source run ID"),
});

export function registerIdiomTools(
  server: McpServer,
  binding: string | (() => Promise<string>),
  queue: ToolExecutionQueue,
  dependencies: McpDependencies,
) {
  const bind = typeof binding === "string" ? async () => binding : binding;
  let root = typeof binding === "string" ? binding : "";
  let evidence = new EvidenceStore(root);
  const configured = { project: root };
  /** Rebinds before each call; evidence IDs belong to the project they came from. */
  const rebind = async () => {
    const next = await bind();
    if (next === root) return;
    root = next;
    evidence = new EvidenceStore(root);
    configured.project = root;
  };
  const capture = (execution: Execution) =>
    execution.capture(dependencies.capture);
  const review = (execution: Execution): ReviewDependencies => ({
    ...dependencies.review,
    capture: capture(execution),
  });
  /** Ticket destinations, including tracker-configured ones, stay in the bound project. */
  const ticketDestination = async (out: string | undefined) => {
    const { projectDirectory } = await loadProjectContext(configured);
    if (out !== undefined) await insideRoot(root, out, "Ticket directory");
    const target = await resolveTicketTarget({
      projectDirectory,
      out,
      cwd: root,
    });
    await insideRoot(
      projectDirectory,
      target.outputDirectory,
      "Ticket output directory",
    );
    return target;
  };
  function register<S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: z.ZodObject<S>,
    readOnly: boolean,
    handler: (
      args: z.infer<z.ZodObject<S>>,
      execution: Execution,
    ) => Promise<CallToolResult>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: !readOnly,
        },
      },
      (args, ctx) =>
        queue.run(ctx, async (execution) => {
          await rebind();
          return handler(args, execution);
        }),
    );
  }
  const record = (finding: Finding, runDirectory: string): CatalogFinding => ({
    finding,
    runId: basename(runDirectory),
    runDirectory,
    findingsPath: join(runDirectory, "findings.json"),
  });
  register(
    "idiom_quick",
    "Review a public page at an absolute HTTP(S) URL with zero configuration and no model. Returns ranked Top 5 issues, complete evidence IDs and absolute report paths; writes local reports, captures desktop/mobile in light/dark and safely probes controls once per page (first viewport, light; only GET/HEAD/OPTIONS requests leave the browser; destructive-looking controls are skipped). For configured flows or intended designs use idiom_check. For requested repairs use idiom_fix_plan, then idiom_verify.",
    z.strictObject({
      url: z
        .url()
        .refine((value) => /^https?:\/\//i.test(value), "URL must use HTTP(S)")
        .describe("Absolute URL to review"),
      viewports: list(z.enum(["desktop", "mobile"]))
        .optional()
        .describe(
          "Preset viewports; defaults to both desktop (1440x900) and mobile (390x844)",
        ),
      probe: z
        .boolean()
        .optional()
        .describe(
          "Run the safe interaction probe once per page at the first viewport in light; default true",
        ),
      probeBudgetMs: z
        .number()
        .int()
        .positive()
        .max(600000)
        .optional()
        .describe(
          "Per-page probe budget in ms, default 45000 (CLI --probe-budget)",
        ),
    }),
    false,
    async (args, execution) => {
      const output = await runQuick({
        urls: [args.url],
        viewports: args.viewports,
        probe: args.probe,
        probeBudgetMs: args.probeBudgetMs,
        project: root,
        literal: true,
        materializeAllDeterministic: true,
        dependencies: {
          ...dependencies.quick,
          ...execution.capture(dependencies.quick),
        },
      });
      if (output.counts.failed) {
        const { loadCaptureRun } = await import("../review/artifacts.js");
        const loaded = await loadCaptureRun({
          runDirectory: output.runDirectory,
          expectedFlow: "quick-review",
          expectedStatusByState: new Map([["page-1", 200]]),
          stateOrder: ["page-1"],
          viewportOrder: args.viewports ?? ["desktop", "mobile"],
          legacyColorScheme: "light",
        });
        throw new IdiomError(
          `Quick capture failed: ${loaded.tuples.flatMap((tuple) => (tuple.failure ? [`${tuple.failure.stage}: ${tuple.failure.message}`] : [])).join("; ")}. Report: ${output.reportPath}`,
        );
      }
      const findings = output.findings ?? [];
      const groups = output.groups ?? [];
      const issues = output.issues ?? [];
      evidence.remember({
        runDirectory: output.runDirectory,
        findings,
        groups,
        issues,
        quick: true,
      });
      const qualify = (id: string) =>
        `quick:${basename(output.runDirectory)}:${id}`;
      const details = findings.map((finding) =>
        findingDetail(record(finding, output.runDirectory), qualify),
      );
      const issueDetails = issues.map((issue) => ({
        ...issue,
        id: qualify(issue.id),
        groups: issue.groups.map(qualify),
        ...(issue.rootCause === undefined
          ? {}
          : {
              rootCause: {
                ...issue.rootCause,
                symptoms: issue.rootCause.symptoms.map((symptom) => ({
                  ...symptom,
                  group: qualify(symptom.group),
                  findings: symptom.findings.map((finding) => ({
                    ...finding,
                    id: qualify(finding.id),
                  })),
                })),
              },
            }),
        representative: details.find(
          (detail) =>
            groups.find((group) => group.id === issue.id)?.representative ===
            detail.finding.id,
        ),
      }));
      return result(
        `Quick review: ${findings.length} findings, ${issues.length} issues, ${interactionTail(output.interaction)}. Top ${Math.min(5, issues.length)} issues returned. Report: ${output.reportPath}`,
        {
          runId: basename(output.runDirectory),
          topIssues: issueDetails.slice(0, 5),
          issues: issueDetails,
          findings: details,
          counts: {
            findings: findings.length,
            issues: issues.length,
            groups: groups.length,
            captures: output.counts,
          },
          ...(output.checkCoverage === undefined
            ? {}
            : { checkCoverage: output.checkCoverage }),
          interaction: output.interaction,
          reports: {
            markdown: output.reportPath,
            html: output.htmlReportPath,
            findings: output.findingsPath,
          },
          runDirectory: output.runDirectory,
        },
      );
    },
  );
  async function projectCheckedRun(
    flowId: string,
    all: boolean,
    summary: CheckSummary,
    output: ReviewRunResult,
  ): Promise<CallToolResult> {
    const validated = await validateProject({
      ...configured,
      flow: flowId,
    });
    const flow = validated.flows[0]?.flow;
    if (!flow) throw new IdiomError(`Unknown flow ${flowId}`);
    const loaded = await loadRunTuples(validated, flow, output.runDirectory);
    const failures = loaded.tuples.flatMap((tuple) =>
      tuple.failure ? [`${tuple.failure.stage}: ${tuple.failure.message}`] : [],
    );
    if (failures.length)
      throw new IdiomError(
        `Capture failed: ${failures.join("; ")}. Report: ${output.reportPath}`,
      );
    const originals = findingSchema
      .array()
      .parse(JSON.parse(await readFile(output.findingsPath, "utf8")));
    // Baseline summaries contain exact new occurrences, rather than capped representatives.
    const live = summary.baseline
      ? (output.deterministicOccurrences ?? originals).filter((finding) =>
          summary.findings.some(
            (item) =>
              item.id === finding.id &&
              item.where === tupleCoordinateKey(finding),
          ),
        )
      : originals.filter((finding) =>
          summary.findings.some((item) => item.id === finding.id),
        );
    const summaries = new Map(
      live.map((finding) => {
        const summary = summarizeFinding(finding, output, root);
        return [
          finding.id,
          {
            ...summary,
            ...(summary.screenshot === undefined
              ? {}
              : { screenshot: resolve(root, summary.screenshot) }),
          },
        ];
      }),
    );
    const projection = projectIssueSummary({
      findings: live,
      groups: summary.baseline ? [] : output.groups,
      summaries,
      primaryActionSelectors: output.primaryActionSelectors,
    });
    const details = originals.map((finding) =>
      findingDetail(record(finding, output.runDirectory)),
    );
    const issues = projection.issues.map((issue) => ({
      ...issue,
      representative: details.find((detail) =>
        projection.groups
          .find((group) => group.id === issue.id)
          ?.members.some((member) => member.id === detail.id),
      ),
    }));
    evidence.remember({
      runDirectory: output.runDirectory,
      findings: originals,
      groups: output.groups,
      issues: projection.issues,
      quick: false,
    });
    const questions = summary.designSystemQuestions ?? [];
    return result(
      `Check ${flowId}: ${summary.findings.length} new/live occurrences, ${issues.length} issues; ${summary.preExisting ?? 0} pre-existing, ${summary.fixed?.length ?? 0} fixed. ${summary.baselineRecorded ? "Automatically recorded the initial baseline; commit its file. " : ""}${questions.length === 0 ? "" : `Design system questions (${questions.length}), held instead of findings; answer with idiom_decide add-step|drift: ${questions.map((question) => `${question.id} — ${question.question}`).join(" ")} `}Report: ${summary.reportPath}`,
      {
        flow: flowId,
        ...(questions.length === 0 ? {} : { designSystemQuestions: questions }),
        runId: basename(output.runDirectory),
        topIssues: issues.slice(0, 5),
        ...(all ? { issues, findings: details } : {}),
        groups: projection.groups,
        verificationReferences: details.map(
          (detail) => detail.verificationReference,
        ),
        counts: {
          new: summary.findings.length,
          fixed: summary.fixed?.length ?? 0,
          preExisting: summary.preExisting ?? 0,
          findings: originals.length,
          groups: output.groups.length,
          issues: issues.length,
          blocking: summary.blocking,
          captures: { total: loaded.tuples.length, failed: 0 },
        },
        baseline: summary.baseline ?? {
          applied: false,
          reason: summary.baselineNotApplied ?? "all=true: full live findings",
        },
        baselineRecorded: summary.baselineRecorded,
        newFindings: live.map((finding) =>
          findingDetail(record(finding, output.runDirectory)),
        ),
        preExistingFindings: summary.preExistingFindings?.map((item) => ({
          ...item,
          ...(item.screenshot === undefined
            ? {}
            : { screenshot: resolve(root, item.screenshot) }),
        })),
        fixed: summary.fixed,
        coverage: summary.coverage,
        ...(summary.checkCoverage === undefined
          ? {}
          : { checkCoverage: summary.checkCoverage }),
        reports: {
          markdown: output.reportPath,
          html: output.htmlReportPath,
          findings: output.findingsPath,
        },
      },
    );
  }
  register(
    "idiom_check",
    "Capture a configured flow, run deterministic UI checks and compare declared intended designs (HTML, Figma, images or live sites). Returns ranked Top 5 issues with selectors, measurements, fix instructions, crops, counts and baseline new/fixed/pre-existing comparison. all=true reviews every live finding without recording/comparing a baseline. Attach references with idiom_design_add; a human chooses between conflicting references with idiom_choose. For requested repairs use idiom_fix_plan, then idiom_verify.",
    z.strictObject({
      flow: identifier
        .optional()
        .describe("Configured flow manifest ID; optional with changed"),
      changed: z
        .union([z.literal(true), z.string().trim().min(1)])
        .optional()
        .describe(
          "Select states affected by Git changes; true uses the default merge base, a string names a base",
        ),
      states: list(selection)
        .optional()
        .describe("Exact configured state IDs; omitted means every state"),
      viewports: list(selection)
        .optional()
        .describe(
          "Exact configured viewport names; omitted means every flow viewport",
        ),
      all: z
        .boolean()
        .default(false)
        .describe(
          "Return full live findings and bypass baseline bootstrap/comparison",
        ),
    }),
    false,
    async (args, execution) => {
      if (args.changed !== undefined) {
        const changed = await checkChanged({
          ...configured,
          flow: args.flow,
          changed: args.changed,
          all: args.all,
          scope: {
            states: args.states?.join(","),
            viewports: args.viewports?.join(","),
          },
          materializeAllDeterministic: true,
          captureFailureIsError: true,
          dependencies: review(execution),
        });
        const checks = [];
        for (const entry of changed.checks) {
          execution.signal.throwIfAborted();
          if (entry.status === "not-checked") checks.push(entry);
          else {
            const projected = await projectCheckedRun(
              entry.flow,
              args.all,
              entry.summary,
              entry.review,
            );
            checks.push({
              flow: entry.flow,
              status: entry.status,
              ...(projected.structuredContent as Record<string, unknown>),
            });
          }
        }
        return result(renderChangedSelection(changed), {
          selection: changed.selection,
          checkedStates: changed.checkedStates,
          checks,
        });
      }
      if (!args.flow)
        throw new IdiomError("flow is required unless changed is supplied");
      const { summary, review: output } = await checkWithReview({
        ...configured,
        flow: args.flow,
        all: args.all,
        scope: {
          states: args.states?.join(","),
          viewports: args.viewports?.join(","),
        },
        materializeAllDeterministic: true,
        captureFailureIsError: true,
        recordAgentCheck: true,
        dependencies: review(execution),
      });
      return projectCheckedRun(args.flow, args.all, summary, output);
    },
  );
  register(
    "idiom_issue",
    "Read full original evidence for a returned finding, group or issue ID. Includes members and sibling groups, selectors, measurements, repair instructions and the representative PNG crop as image content; performs no capture.",
    z.strictObject({
      id: identifier.describe(
        "Opaque finding/group/issue ID from a tool or project catalog",
      ),
    }),
    true,
    async ({ id }) => evidence.issue(id),
  );
  register(
    "idiom_fix_plan",
    "Capture a full flow and hand the calling agent the exact idiom fix repair prompt and selected original finding records. Excludes rejected work; never launches a repair agent or records a decision. Edit source yourself, then call idiom_verify with the returned arguments.",
    z.strictObject({
      flow: identifier.describe("Configured flow ID"),
      top: z
        .number()
        .int()
        .positive()
        .default(5)
        .describe("Maximum finding assignments, in idiom fix order"),
    }),
    false,
    async ({ flow, top }, execution) => {
      const snapshot = await takeFixSnapshot({
        ...configured,
        flow,
        dependencies: review(execution),
      });
      execution.signal.throwIfAborted();
      const eligible = await eligibleRecords(snapshot);
      const selected = selectTargets(snapshot, eligible, top);
      const prompt = await repairPrompt(snapshot, selected, eligible);
      const references = selected.map((entry) => ({
        id: entry.finding.id,
        runId: entry.runId,
      }));
      return result(
        selected.length
          ? `Repair plan: ${selected.length} finding assignments. Edit application source, then call idiom_verify.`
          : "Clean snapshot: no eligible repair assignments.",
        {
          prompt,
          records: selected.map((entry) => findingDetail(entry)),
          findings: selected.map((entry) => entry.finding),
          verificationReferences: references,
          sourceRun: basename(snapshot.runDirectory),
          runDirectory: snapshot.runDirectory,
          reports: {
            markdown: snapshot.summary.reportPath,
            findings: join(snapshot.runDirectory, "findings.json"),
            html: join(snapshot.runDirectory, "report.html"),
          },
          next: references.length
            ? {
                tool: "idiom_verify",
                arguments: { flow, findings: references },
              }
            : null,
        },
      );
    },
  );
  register(
    "idiom_verify",
    "Prove original findings fixed using two calibrated full-flow captures pinned to their source run. Reports each fixed/reproduced/unverifiable verdict and all introduced deterministic findings, including minor regressions outside the target state. Requires complete successful original coverage; quick evidence is unsupported.",
    z.strictObject({
      flow: identifier.describe(
        "Same configured flow as the original evidence",
      ),
      findings: z
        .array(reference)
        .min(1)
        .refine(
          (refs) =>
            new Set(refs.map((ref) => `${ref.runId}:${ref.id}`)).size ===
            refs.length,
          "Duplicate verification references",
        )
        .describe(
          "Unmodified verification references from check, issue or fix-plan, all from one source run",
        ),
    }),
    false,
    async ({ flow, findings }, execution) => {
      const source = await evidence.source(flow, findings);
      const temporary = await mkdtemp(join(tmpdir(), "idiom-mcp-verify-"));
      try {
        const spec = join(temporary, "findings.md");
        await writeFile(
          spec,
          source.findings
            .map(
              (finding) =>
                `\`\`\`idiom:finding\n${JSON.stringify(finding)}\n\`\`\``,
            )
            .join("\n\n"),
        );
        const output = await verifyCommand({
          ...configured,
          flow,
          spec,
          against: source.runDirectory,
          fullFlow: true,
          dependencies: { capture: capture(execution) },
        });
        const regressionFree =
          output.newFindings === undefined
            ? null
            : output.newFindings.length === 0;
        const success = output.passed && regressionFree === true;
        return result(
          `Verification ${success ? "passed" : "failed"}: ${output.verdicts?.filter((verdict) => verdict.status === "fixed").length ?? 0}/${findings.length} fixed; ${output.newFindings?.length ?? "unknown"} introduced findings. ${(output.verdicts ?? []).map((v) => `${v.finding.id}: acceptance ${v.acceptance.status} — ${v.acceptance.reason}`).join("; ")} Report: ${output.reportPath}`,
          { ...output, sourceRun: source.runId, regressionFree, success },
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
  register(
    "idiom_context",
    "Read the bounded project design brief before building UI: tokens, scales, rules/design law, craft checks, prohibitions and accepted work. Read-only; no browser or model.",
    z.strictObject({}),
    true,
    async () => {
      const brief = await contextCommand(configured);
      return result(brief, { brief });
    },
  );
  register(
    "idiom_flows",
    "List validated configured flows with their titles, ordered states, viewports and color schemes. If no manifests exist, suggests idiom_init with flows:true. Every configured tool validates first; validation errors return as tool errors. Read-only; no browser or model.",
    z.strictObject({}),
    true,
    async () => {
      const context = await loadProjectContext(configured);
      const entries = await readdir(
        join(context.projectDirectory, ".idiom", "flows"),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      if (!entries.some((name) => name.endsWith(".json")))
        return result(
          "No flows configured. Call idiom_init with flows:true (or run idiom init --flows).",
          {
            flows: [],
            guidance:
              "Call idiom_init with flows:true (or run idiom init --flows)",
          },
        );
      const validated = await validateProject(configured);
      const flows = validated.flows
        .map(({ flow }) => ({
          id: flow.id,
          title: flow.title,
          states: flow.states.map((state) => ({
            id: state.id,
            description: state.description,
          })),
          viewports: selectViewports(validated.project, flow),
          colorSchemes: selectColorSchemes(validated.project, flow),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return result(
        `${flows.length} configured flows: ${flows.map((flow) => flow.id).join(", ")}`,
        { flows },
      );
    },
  );
  register(
    "idiom_decide",
    "Record an explicit human accept/reject judgment with a reason for one canonical finding or exactly one durable group's members. Writes the project decision log with instance scope; never accepts siblings implicitly, changes Git or repairs source. Quick-only evidence cannot receive project decisions. For a design system question (a ruling-N id from idiom_check), add-step records the value as a token step for its context in the design file (token optional, defaults to the suggestion) and drift keeps reporting it as one grouped issue; skip by not answering.",
    z.strictObject({
      id: identifier.describe(
        "Canonical finding or group ID, or a design system question's ruling-N",
      ),
      decision: z
        .enum(["accept", "reject", "add-step", "drift"])
        .describe(
          "Explicit human judgment: accept/reject a finding, add-step/drift a design system question",
        ),
      token: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("add-step only: token name; defaults to the suggestion"),
      reason: humanReason,
    }),
    false,
    async ({ id, decision, token, reason }) => {
      const scaleAnswer = decision === "add-step" || decision === "drift";
      if (/^ruling-[1-9]\d*$/.test(id)) {
        if (!scaleAnswer)
          throw new IdiomError(
            `${id} is a design system question; answer it with add-step or drift`,
          );
        const output = await rulingCommand({
          ...configured,
          decision: id,
          addStep: decision === "add-step",
          drift: decision === "drift",
          ...(token === undefined ? {} : { token }),
          reason,
          // The tool call is the recorded human answer, as for decisions.
          dependencies: { confirm: async () => true },
        });
        return result(
          `Recorded ${id} (${decision}${output.resolution?.scale?.token === undefined ? "" : ` \`${output.resolution.scale.token}\``}) in ${output.path}`,
          output,
        );
      }
      if (scaleAnswer)
        throw new IdiomError(
          `${decision} answers a design system question (ruling-N); use accept or reject for ${id}`,
        );
      if (token !== undefined)
        throw new IdiomError("token is only used with add-step");
      if (id.startsWith("quick:"))
        throw new IdiomError(
          "Quick-only evidence cannot record project decisions. Initialize a flow and run idiom_check first.",
        );
      const found = await evidence.lookup(id);
      const isGroup = found.run.groups.some((group) => group.id === id);
      const output = await decideCommand({
        ...configured,
        ...(isGroup ? { group: id } : { finding: found.representative.id }),
        accept: decision === "accept",
        reject: decision === "reject",
        ...(decision === "reject" ? { scope: "instance" as const } : {}),
        reason,
        preserveReason: true,
      });
      return result(
        `Recorded ${output.accepted} accepted, ${output.rejected} rejected. Decision log: ${output.path}`,
        output,
      );
    },
  );
  register(
    "idiom_init",
    "Scaffold PRODUCT.md, DESIGN.md and .idiom in the bound project root without data loss, non-interactively (never overwrites changed files, never wires Autobuild). flows:true also generates a site flow from filesystem and running local routes. Returns files created/replaced/unchanged/preserved and next steps.",
    z.strictObject({
      flows: z
        .boolean()
        .default(false)
        .describe(
          "Generate .idiom/flows/site.json from filesystem and running local routes",
        ),
      surface: identifier
        .optional()
        .describe("Project surface for the generated site flow"),
    }),
    false,
    async ({ flows, surface }) => {
      // The default writer is process.stdout, which belongs to the protocol.
      const notes: string[] = [];
      const output = await initProject({
        project: root,
        cwd: root,
        yes: true,
        flows,
        surface,
        generateFlows: dependencies.init?.generateFlows,
        confirm: async () => false,
        write: (message) => {
          notes.push(message.trimEnd());
        },
      });
      const generated =
        "stateCount" in output.flows && output.flows.content !== undefined;
      const nextSteps = [
        "Fill PRODUCT.md and DESIGN.md with the human, then call idiom_context.",
        ...(generated
          ? ["Call idiom_flows, then idiom_check with flow site."]
          : [
              "Author a flow in .idiom/flows, or call idiom_init with flows:true while the app is running, then call idiom_flows.",
            ]),
        ...(output.systemLearning.kind === "available-noninteractive"
          ? [
              "Design-token sources detected: run idiom system --learn (CLI-only) to preview and confirm learned rules.",
            ]
          : []),
        ...(output.autobuild.kind === "available-noninteractive"
          ? [
              "Autobuild detected: run idiom init interactively (CLI-only) to review and approve verification wiring.",
            ]
          : []),
      ];
      const lines = initSummaryLines(output).map((line) =>
        line === "Next: idiom validate site; idiom capture site"
          ? "Next: idiom_flows; idiom_check site"
          : line,
      );
      const flowOutcome =
        "stateCount" in output.flows
          ? (({ content: _content, ...rest }) => rest)(output.flows)
          : output.flows;
      return result([...notes, ...lines].join("\n"), {
        projectDirectory: output.projectDirectory,
        created: output.created,
        replaced: output.replaced,
        unchanged: output.unchanged,
        skipped: output.skipped,
        autobuild: output.autobuild,
        systemLearning: output.systemLearning,
        flows: flowOutcome,
        notes,
        nextSteps,
      });
    },
  );
  register(
    "idiom_design_add",
    "Attach an intended design to an authored state in a flow manifest: a local HTML file/directory or PNG/JPEG/WebP image inside the bound root, a prototype URL, or a Figma frame URL. Writes only the flow manifest. Figma frames need FIGMA_TOKEN in the MCP server's environment; no argument accepts credentials.",
    z.strictObject({
      state: identifier.describe("Authored state ID"),
      source: z
        .string()
        .trim()
        .min(1)
        .describe(
          "HTTP(S) URL, Figma frame URL with node-id, or a path relative to the bound root",
        ),
      flow: identifier
        .optional()
        .describe("Disambiguate the state across flow manifests"),
      name: identifier
        .optional()
        .describe(
          "Add or replace a named reference, keeping the state's other references",
        ),
      viewport: selection
        .optional()
        .describe("Compare this reference only at this project viewport"),
    }),
    false,
    async (args) => {
      const figma = isFigmaHost(args.source);
      if (!/^https?:/i.test(args.source))
        await insideRoot(root, args.source, "Design source");
      if (figma)
        try {
          figmaToken();
        } catch (error) {
          throw new IdiomError(
            `${error instanceof Error ? error.message : String(error)} Set FIGMA_TOKEN in the MCP server's environment (the client config's env) and restart the server.`,
          );
        }
      const output = await addDesignCommand({
        ...args,
        project: root,
        cwd: root,
      });
      return result(
        `${output.changed ? "Set" : "Kept"} design for ${args.state}: ${output.source} (${output.file})`,
        { ...output, figma },
      );
    },
  );
  register(
    "idiom_choose",
    "Record a human's choice between disagreeing intended-design references for one idiom:design-decision finding. A human must name the intended reference and supply the reason; the tool records exactly that reference, never infers one, and preserves the reason verbatim. Writes the project decision log.",
    z.strictObject({
      id: identifier.describe(
        "Canonical idiom:design-decision finding ID (not a group)",
      ),
      reference: z
        .string()
        .trim()
        .min(1)
        .describe("Reference name the human chose, as listed in the finding"),
      reason: humanReason,
    }),
    false,
    async ({ id, reference, reason }) => {
      if (id.startsWith("quick:"))
        throw new IdiomError(
          "Quick-only evidence cannot record project decisions. Initialize a flow and run idiom_check first.",
        );
      const found = await evidence.lookup(id);
      const isGroup = found.run.groups.some((group) => group.id === id);
      const output = await decideCommand({
        ...configured,
        cwd: root,
        ...(isGroup ? { group: id } : { finding: found.representative.id }),
        choose: reference,
        reason,
        preserveReason: true,
      });
      return result(
        `Recorded design choice ${reference}. Decision log: ${output.path}`,
        { ...output, choice: reference },
      );
    },
  );
  register(
    "idiom_tickets",
    "Emit accepted findings as clustered ticket proposals (grouped by component and category) into a file-tracker triage directory inside the bound project. Only human-accepted findings become tickets; tickets land in triage, never ready, and are promoted by a human. Returns absolute ticket paths.",
    z.strictObject({
      findings: list(identifier)
        .optional()
        .describe("Accepted finding IDs; omitted means every accepted finding"),
      out: relativePath
        .optional()
        .describe(
          "Ticket directory relative to the bound root; defaults to the file tracker's triage",
        ),
    }),
    false,
    async ({ findings, out }) => {
      await ticketDestination(out);
      const output = await emitClusterTickets({
        ...configured,
        cwd: root,
        findingIds: findings,
        out,
      });
      return result(renderClusterTicketsResult(output), {
        outputDirectory: output.outputDirectory,
        createdPaths: output.createdPaths,
        outcomes: output.outcomes,
        ineligible: output.ineligible,
      });
    },
  );
  register(
    "idiom_sweep",
    "Capture a configured flow, run every deterministic check, then a per-surface model critique with crops and measured geometry. Returns every ranked finding and report paths; optionally emits clustered proposals into triage. Model credentials come only from the server's environment; a degraded critique is a completed result. Use all:true for a whole-product cleanup set; deterministicOnly runs without model credentials. maxTickets caps new tickets after grouping and deduplication.",
    z.strictObject({
      flow: identifier
        .optional()
        .describe(
          "Configured flow manifest ID; exactly one of flow or all is required",
        ),
      all: z.boolean().default(false),
      deterministicOnly: z.boolean().default(false),
      maxTickets: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .default(10),
      from: identifier
        .optional()
        .describe("Sweep this existing immutable capture run ID"),
      latest: z
        .boolean()
        .default(false)
        .describe(
          "Sweep the newest fully passing capture of this flow at HEAD",
        ),
      emitTickets: relativePath
        .optional()
        .describe(
          "Emit clustered proposals into this triage directory, relative to the bound root",
        ),
    }),
    false,
    async (
      { flow, all, deterministicOnly, maxTickets, from, latest, emitTickets },
      execution,
    ) => {
      if (emitTickets !== undefined) await ticketDestination(emitTickets);
      const summary = await sweepCommand({
        flow,
        all,
        deterministicOnly,
        maxTickets,
        project: root,
        cwd: root,
        from,
        latest: latest || undefined,
        emitTickets,
        dependencies: review(execution),
      });
      const normalizeRecord = async (record: CatalogFinding) => ({
        ...record,
        evidencePaths: await Promise.all(
          [
            ...record.finding.evidence.screenshots,
            ...(record.finding.evidence.artifacts ?? []),
          ].map((path) => evidencePath(record.runDirectory, path)),
        ),
      });
      const normalizeProposal = async (
        proposal: import("../sweep/types.js").SweepProposal,
      ) => ({
        ...proposal,
        cluster: {
          ...proposal.cluster,
          members: await Promise.all(
            proposal.cluster.members.map(async (member) => ({
              ...member,
              record: await normalizeRecord(member.record),
            })),
          ),
        },
      });
      const output = {
        ...summary,
        findings: summary.findings.map((finding) => ({
          ...finding,
          ...(finding.screenshot === undefined
            ? {}
            : { screenshot: resolve(root, finding.screenshot) }),
        })),
        ...("scope" in summary
          ? {
              flows: summary.flows.map((entry) =>
                entry.status === "failed"
                  ? entry
                  : {
                      ...entry,
                      summary: {
                        ...entry.summary,
                        findings: entry.summary.findings.map((f) => ({
                          ...f,
                          ...(f.screenshot === undefined
                            ? {}
                            : { screenshot: resolve(root, f.screenshot) }),
                        })),
                      },
                    },
              ),
            }
          : {}),
        ...("scope" in summary
          ? {
              sourceFindings: await Promise.all(
                summary.sourceFindings.map(normalizeRecord),
              ),
              occurrences: await Promise.all(
                summary.occurrences.map(normalizeRecord),
              ),
              proposals: await Promise.all(
                summary.proposals.map(normalizeProposal),
              ),
              ...(summary.tickets === undefined
                ? {}
                : {
                    tickets: {
                      ...summary.tickets,
                      selectedClusters: await Promise.all(
                        (summary.tickets.selectedClusters ?? []).map(
                          async (cluster) => ({
                            ...cluster,
                            members: await Promise.all(
                              cluster.members.map(async (member) => ({
                                ...member,
                                record: await normalizeRecord(member.record),
                              })),
                            ),
                          }),
                        ),
                      ),
                    },
                  }),
            }
          : {}),
        degraded: summary.outcome.kind === "degraded",
      };
      const serialized = JSON.stringify(output);
      if (
        [
          process.env.ANTHROPIC_API_KEY,
          process.env.OPENAI_API_KEY,
          process.env.CODEX_API_KEY,
        ].some((value) => {
          const key = value?.trim();
          return key !== undefined && key !== "" && serialized.includes(key);
        })
      )
        throw new IdiomError(
          "Sweep output unexpectedly contained a model credential; refusing to return it.",
        );
      const fallback =
        summary.outcome.kind === "full" ? summary.outcome.fallback : undefined;
      return result(
        `${renderSweepSummary(summary).trimEnd()}${output.degraded ? `\n${"scope" in summary ? "Sweep incomplete" : "Model critique degraded"}: ${summary.outcome.kind === "degraded" ? summary.outcome.reason : ""}` : ""}${fallback === undefined ? "" : `\nModel critique used fallback provider ${fallback.to} after ${fallback.from} failed: ${fallback.reason}`}`,
        output,
      );
    },
  );
  register(
    "idiom_coverage",
    "List the app's routes and which configured flows capture them, so routes no flow captures are visible (silence about an uncaptured route is not approval). Discovers app/ and pages/ routes, or crawls same-origin links from a running page. Also returns state coverage: per flow and state, which viewports, colour schemes, reduced-motion modes, network replays, interactions, and data states the latest capture observed, with the change that covers each missing one (coverage of what was reviewed, not a quality measure). Read-only; no capture or model.",
    z.strictObject({
      crawl: httpUrl
        .optional()
        .describe("Discover routes from the links on this running page"),
      states: z
        .boolean()
        .default(false)
        .describe(
          "Return only state coverage (skips route discovery, so projects without filesystem routes work)",
        ),
    }),
    true,
    async ({ crawl, states }) => {
      const stateCoverage = await stateCoverageCommand({
        project: root,
        cwd: root,
      });
      if (states)
        return result(renderStateCoverage(stateCoverage).trimEnd(), {
          states: stateCoverage,
        });
      const summary = await coverageCommand({
        project: root,
        cwd: root,
        crawl,
      });
      return result(
        [
          renderCoverage(summary).trimEnd(),
          "",
          ...stateCoverage.flows.map(
            (flow) => `${flow.flow}: ${stateCoverageLine(flow)}`,
          ),
        ].join("\n"),
        { ...summary, states: stateCoverage },
      );
    },
  );
  register(
    "idiom_baseline",
    "Show or record a flow's compact deterministic finding baseline. show reads recorded commits and which record applies at HEAD; record captures (or reuses from/latest) a clean committed HEAD and writes the baseline file. Commit that file deliberately, only after intentional changes. Never changes Git.",
    z
      .strictObject({
        action: z
          .enum(["show", "record"])
          .describe("show reads the baseline; record writes a new record"),
        flow: identifier
          .optional()
          .describe(
            "Configured flow ID; optional when exactly one flow exists",
          ),
        from: identifier
          .optional()
          .describe("record only: use this existing immutable capture run ID"),
        latest: z
          .boolean()
          .default(false)
          .describe(
            "record only: use the newest fully passing capture at HEAD",
          ),
      })
      .refine(
        (args) =>
          args.action === "record" ||
          (args.from === undefined && args.latest !== true),
        "from and latest apply only to action record",
      ),
    false,
    async ({ action, flow, from, latest }, execution) => {
      if (action === "record") {
        const output = await baselineRecordCommand({
          flow,
          project: root,
          cwd: root,
          from,
          latest: latest || undefined,
          dependencies: review(execution),
        });
        return result(`${renderBaselineRecord(output)} ${commitGuidance}`, {
          ...output,
          commitGuidance,
        });
      }
      const validated = await validateProject({ ...configured, flow });
      if (flow === undefined && validated.flows.length !== 1)
        throw new IdiomError(
          `baseline show needs a flow; choose one of: ${validated.flows.map(({ flow }) => flow.id).join(", ")}`,
        );
      const selected = validated.flows[0]?.flow;
      if (selected === undefined) throw new IdiomError(`unknown flow ${flow}`);
      const path = baselinePath(
        baselineDirectory(validated.projectDirectory, validated.project),
        selected.id,
      );
      const file = await readBaselineFile(path);
      if (file === undefined || file.records.length === 0) {
        const guidance = `No baseline recorded for ${selected.id}. On clean committed HEAD call idiom_baseline with action record (or let idiom_check record the first one), then commit ${path} deliberately.`;
        return result(guidance, {
          flow: selected.id,
          path,
          records: [],
          applied: null,
          guidance,
        });
      }
      const applied = await selectBaselineRecord({
        projectDirectory: validated.projectDirectory,
        file,
      });
      const records = file.records.map((entry) => ({
        commit: entry.commit,
        recordedAt: entry.recordedAt,
        idiomVersion: entry.idiomVersion,
        tupleCount: entry.tuples.length,
        findingCount: entry.tuples.reduce(
          (total, tuple) => total + tuple.findings.length,
          0,
        ),
      }));
      return result(
        `Baseline ${selected.id}: ${records.length} record(s) in ${path}; ${applied === undefined ? "none applies at HEAD (no recorded commit is an ancestor)" : `applies ${applied.record.commit.slice(0, 12)}, ${applied.distance} commit(s) behind HEAD`}. ${commitGuidance}`,
        {
          flow: selected.id,
          path,
          records,
          applied: applied?.record.commit ?? null,
          distance: applied?.distance ?? null,
          commitGuidance,
        },
      );
    },
  );
}
