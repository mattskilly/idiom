import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import { summarizeFinding } from "../baseline/summary.js";
import { selectColorSchemes, selectViewports } from "../capture/resolve.js";
import type { CaptureDependencies } from "../capture/run.js";
import { checkWithReview } from "../commands/check.js";
import { contextCommand } from "../commands/context.js";
import { decideCommand } from "../commands/decide.js";
import { verifyCommand } from "../commands/verify.js";
import { IdiomError } from "../errors.js";
import {
  eligibleRecords,
  selectTargets,
  takeFixSnapshot,
} from "../fix/check.js";
import { repairPrompt } from "../fix/prompt.js";
import { type QuickDependencies, runQuick } from "../quick/run.js";
import { loadRunTuples } from "../review/artifacts.js";
import type { CatalogFinding } from "../review/catalog.js";
import { projectIssueSummary } from "../review/summary.js";
import { type Finding, findingSchema } from "../schemas/finding.js";
import { loadProjectContext, validateProject } from "../validation.js";
import {
  EvidenceStore,
  findingDetail,
  result,
  safeIdentifier,
} from "./evidence.js";
import type { Execution, ToolExecutionQueue } from "./execution.js";

export type McpDependencies = {
  capture?: CaptureDependencies | undefined;
  quick?: QuickDependencies | undefined;
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
const reference = z.strictObject({
  id: identifier.describe(
    "Original finding ID returned by check, issue or fix-plan",
  ),
  runId: identifier.describe("Exact original source run ID"),
});

export function registerIdiomTools(
  server: McpServer,
  root: string,
  queue: ToolExecutionQueue,
  dependencies: McpDependencies,
) {
  const evidence = new EvidenceStore(root);
  const configured = { project: root };
  const capture = (execution: Execution) =>
    execution.capture(dependencies.capture);
  const review = (execution: Execution) => ({ capture: capture(execution) });
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
      (args, ctx) => queue.run(ctx, (execution) => handler(args, execution)),
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
    "Review a public page at an absolute HTTP(S) URL with zero configuration and no model. Returns ranked Top 5 issues, complete evidence IDs and absolute report paths; writes local reports and captures desktop/mobile in light/dark. For configured flows or intended designs use idiom_check. For requested repairs use idiom_fix_plan, then idiom_verify.",
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
    }),
    false,
    async (args, execution) => {
      const output = await runQuick({
        urls: [args.url],
        viewports: args.viewports,
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
        `Quick review: ${findings.length} findings, ${issues.length} issues. Top ${Math.min(5, issues.length)} issues returned. Report: ${output.reportPath}`,
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
  register(
    "idiom_check",
    "Capture a configured flow, run deterministic UI checks and compare declared intended designs (HTML, Figma, images or live sites). Returns ranked Top 5 issues with selectors, measurements, fix instructions, crops, counts and baseline new/fixed/pre-existing comparison. all=true reviews every live finding without recording/comparing a baseline. Attach references with CLI idiom design add; a human chooses conflicting references with idiom decide --choose. For requested repairs use idiom_fix_plan, then idiom_verify.",
    z.strictObject({
      flow: identifier.describe("Configured flow manifest ID"),
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
        dependencies: review(execution),
      });
      const validated = await validateProject({
        ...configured,
        flow: args.flow,
      });
      const flow = validated.flows[0]?.flow;
      if (!flow) throw new IdiomError(`Unknown flow ${args.flow}`);
      const loaded = await loadRunTuples(validated, flow, output.runDirectory);
      const failures = loaded.tuples.flatMap((tuple) =>
        tuple.failure
          ? [`${tuple.failure.stage}: ${tuple.failure.message}`]
          : [],
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
      return result(
        `Check ${args.flow}: ${summary.findings.length} new/live occurrences, ${issues.length} issues; ${summary.preExisting ?? 0} pre-existing, ${summary.fixed?.length ?? 0} fixed. ${summary.baselineRecorded ? "Automatically recorded the initial baseline; commit its file. " : ""}Report: ${summary.reportPath}`,
        {
          flow: args.flow,
          runId: basename(output.runDirectory),
          topIssues: issues.slice(0, 5),
          ...(args.all ? { issues, findings: details } : {}),
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
            reason: "all=true: full live findings",
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
          reports: {
            markdown: output.reportPath,
            html: output.htmlReportPath,
            findings: output.findingsPath,
          },
        },
      );
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
          `Verification ${success ? "passed" : "failed"}: ${output.verdicts?.filter((verdict) => verdict.status === "fixed").length ?? 0}/${findings.length} fixed; ${output.newFindings?.length ?? "unknown"} introduced findings. Report: ${output.reportPath}`,
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
    "List validated configured flows with their titles, ordered states, viewports and color schemes. If no manifests exist, suggests idiom init --flows. Read-only; no browser or model.",
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
        return result("No flows configured. Run idiom init --flows.", {
          flows: [],
          guidance: "Run idiom init --flows",
        });
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
    "Record an explicit human accept/reject judgment with a reason for one canonical finding or exactly one durable group's members. Writes the project decision log with instance scope; never accepts siblings implicitly, changes Git or repairs source. Quick-only evidence cannot receive project decisions.",
    z.strictObject({
      id: identifier.describe("Canonical finding or group ID"),
      decision: z
        .enum(["accept", "reject"])
        .describe("Explicit human judgment"),
      reason: z
        .string()
        .refine((value) => value.trim().length > 0, "Reason must not be blank")
        .describe("Human-supplied reason, preserved verbatim"),
    }),
    false,
    async ({ id, decision, reason }) => {
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
}
