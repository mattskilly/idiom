#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import {
  baselineStaleWarning,
  renderBaselineComparison,
} from "./baseline/render.js";
import { parsePort } from "./capture/port.js";
import type { CaptureDependencies } from "./capture/run.js";
import { renderTimings } from "./capture/timings.js";
import {
  baselineRecordCommand,
  renderBaselineRecord,
} from "./commands/baseline.js";
import { captureCommand } from "./commands/capture.js";
import { checkCommand, renderCheckSummary } from "./commands/check.js";
import {
  checkChanged,
  renderChangedSelection,
} from "./commands/check-changed.js";
import { compareCommand } from "./commands/compare.js";
import {
  type ContextDependencies,
  contextCommand,
} from "./commands/context.js";
import {
  coverageCommand,
  renderCoverage,
  stateCoverageCommand,
} from "./commands/coverage.js";
import { type DecideDependencies, decideCommand } from "./commands/decide.js";
import { addDesignCommand } from "./commands/design.js";
import {
  type ExploreDependencies,
  exploreCommand,
} from "./commands/explore.js";
import { exploreResolveCommand } from "./commands/explore-resolve.js";
import { fixCommand } from "./commands/fix.js";
import {
  type Confirmation,
  initProject,
  initSummaryLines,
} from "./commands/init.js";
import { instructionCommand } from "./commands/instruction.js";
import { type LearnDependencies, learnCommand } from "./commands/learn.js";
import { quickCommand } from "./commands/quick.js";
import {
  addReferenceCommand,
  listReferencesCommand,
  removeReferenceCommand,
} from "./commands/reference.js";
import { reportCommand } from "./commands/report.js";
import { pageReviewCommand, reviewCommand } from "./commands/review.js";
import { type RulingDependencies, rulingCommand } from "./commands/ruling.js";
import { renderSweepSummary, sweepCommand } from "./commands/sweep.js";
import { systemCommand } from "./commands/system.js";
import { clusterTicketsCommand, ticketsCommand } from "./commands/tickets.js";
import {
  renderUpgrade,
  upgradeCommand,
  upgradeFailed,
} from "./commands/upgrade.js";
import { validateCommand } from "./commands/validate.js";
import { verifyCommand } from "./commands/verify.js";
import { renderStateCoverage } from "./coverage/states.js";
import { IdiomError } from "./errors.js";
import { severityGateEligible } from "./findings/gate.js";
import { renderFixSummary } from "./fix/report.js";
import type { FixDependencies } from "./fix/run.js";
import type { GenerateFlow } from "./flows/generate.js";
import { interactionTail } from "./quick/interaction.js";
import type { QuickDependencies } from "./quick/run.js";
import type { ReferenceDependencies } from "./references/run.js";
import type { OpenReportDependencies } from "./report/open.js";
import { advisoryCount } from "./review/advisory.js";
import type { PageReviewDependencies } from "./review/page.js";
import type { ReviewOutcome } from "./review/report.js";
import type { ReviewDependencies } from "./review/run.js";
import { type PageFocusArea, pageFocusAreas } from "./schemas/finding.js";
import type { CritiqueProvider } from "./schemas/project.js";
import type { UpgradeDependencies } from "./skills/upgrade.js";
import type { SystemRunDependencies } from "./system/run.js";
import { renderClusterTicketsResult } from "./tickets/emit.js";
import type { VerifyDependencies } from "./verify/run.js";
import { IDIOM_VERSION_DISPLAY } from "./version.js";

export type ProgramDependencies = {
  cwd?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  confirm?: Confirmation;
  generateFlows?: GenerateFlow;
  capture?: CaptureDependencies;
  reference?: ReferenceDependencies;
  review?: ReviewDependencies;
  decide?: DecideDependencies;
  explore?: ExploreDependencies;
  ruling?: RulingDependencies;
  learn?: LearnDependencies;
  verify?: VerifyDependencies;
  report?: OpenReportDependencies;
  context?: ContextDependencies;
  quick?: QuickDependencies;
  fix?: FixDependencies;
  page?: PageReviewDependencies;
  system?: SystemRunDependencies;
  upgrade?: UpgradeDependencies;
};

type SharedOptions = { project?: string };

function lineWriter(
  write: (message: string) => void,
): (message: string) => void {
  return (message) => write(message.endsWith("\n") ? message : `${message}\n`);
}

/** --focus values, space- or comma-separated, checked against the known areas. */
function writeFallbackWarning(
  writeErr: (message: string) => void,
  outcome: ReviewOutcome,
): void {
  if (outcome.kind === "full" && outcome.fallback !== undefined)
    writeErr(
      `Warning: Model critique used fallback provider ${outcome.fallback.to} after ${outcome.fallback.from} failed: ${outcome.fallback.reason}`,
    );
}

function parseFocus(values: string[] | undefined): PageFocusArea[] | undefined {
  if (values === undefined) return undefined;
  const areas = values.flatMap((value) =>
    value
      .split(",")
      .map((area) => area.trim())
      .filter((area) => area !== ""),
  );
  for (const area of areas)
    if (!(pageFocusAreas as readonly string[]).includes(area))
      throw new IdiomError(
        `unknown --focus area ${JSON.stringify(area)}; choose from ${pageFocusAreas.join(", ")}`,
      );
  return areas as PageFocusArea[];
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new InvalidArgumentError("must be a positive integer");
  return parsed;
}

function parsePortOption(value: string): number {
  return parsePort(value, "--port");
}

function parseMaxFindings(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new IdiomError(
      `--max-findings must be a positive integer; received ${JSON.stringify(value)}`,
    );
  return parsed;
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const writeOut = lineWriter(
    dependencies.stdout ?? ((message) => process.stdout.write(message)),
  );
  const writeErr = lineWriter(
    dependencies.stderr ?? ((message) => process.stderr.write(message)),
  );
  const captureDependencies = (
    supplied?: CaptureDependencies,
  ): CaptureDependencies => {
    const callbacks = new Set([
      dependencies.capture?.onProbeProgress,
      supplied?.onProbeProgress,
    ]);
    return {
      ...dependencies.capture,
      ...supplied,
      onProbeProgress: (event) => {
        for (const callback of callbacks) callback?.(event);
        writeErr(
          `Probe ${event.state ?? "pending"}/${event.viewport ?? "pending"}/${event.colorScheme ?? "pending"}: ${event.completed} done; ${event.selector} (${event.phase})`,
        );
      },
    };
  };
  const reviewDependencies: ReviewDependencies = {
    ...dependencies.review,
    capture: captureDependencies(dependencies.review?.capture),
  };
  const program = new Command()
    .name("idiom")
    .description("A repo-native design acceptance loop for product UI")
    .version(IDIOM_VERSION_DISPLAY)
    .addOption(new Option("--project <dir>", "target project directory"))
    .configureOutput({ writeOut, writeErr });

  program
    .command("init")
    .description("scaffold PRODUCT.md, DESIGN.md, and .idiom without data loss")
    .option("--yes", "accept scaffold defaults without prompting")
    .option(
      "--flows",
      "generate a site flow from filesystem and running local routes",
    )
    .option("--surface <id>", "project surface for the generated site flow")
    .action(async (_options, command: Command) => {
      const local = command.opts<{
        yes?: boolean;
        flows?: boolean;
        surface?: string;
      }>();
      const shared = command.optsWithGlobals<
        SharedOptions & { yes?: boolean }
      >();
      const result = await initProject({
        project: shared.project,
        cwd: dependencies.cwd,
        yes: local.yes,
        flows: local.flows,
        surface: local.surface,
        generateFlows: dependencies.generateFlows,
        confirm: dependencies.confirm,
        write: writeOut,
      });
      for (const line of initSummaryLines(result)) writeOut(line);
    });

  program
    .command("upgrade")
    .description("update vendored skills while preserving local customization")
    .option("--no-agent", "leave overlapping edits for manual resolution")
    .option(
      "--dry-run",
      "report proposed changes without writing or calling a model",
    )
    .option("--json", "print a structured upgrade report")
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals<
        SharedOptions & { agent: boolean; dryRun?: boolean; json?: boolean }
      >();
      const report = await upgradeCommand(
        {
          project: options.project,
          cwd: dependencies.cwd,
          agent: options.agent,
          dryRun: options.dryRun,
        },
        dependencies.upgrade,
      );
      writeOut(
        options.json ? JSON.stringify(report, null, 2) : renderUpgrade(report),
      );
      if (upgradeFailed(report))
        throw new CommanderError(
          1,
          "idiom.upgrade-conflicted",
          "Skill upgrade has unresolved conflicts",
        );
    });

  program
    .command("mcp")
    .description("serve Idiom tools over MCP stdio")
    .action(async (_options, command: Command) => {
      const { mcpCommand } = await import("./commands/mcp.js");
      await mcpCommand({
        project: command.optsWithGlobals<SharedOptions>().project,
        cwd: dependencies.cwd,
      });
    });

  program
    .command("quick")
    .description("review explicit public URLs without Idiom configuration")
    .argument("<url...>", "one or more HTTP(S) URLs from the same origin")
    .option("--out <dir>", "exact output directory (must not exist)")
    .option(
      "--design <source>",
      "intended design image, HTML file/directory, site URL or Figma frame URL",
    )
    .option(
      "--probe-budget <ms>",
      "per-page interaction probe budget in milliseconds (default 45000)",
    )
    .option("--no-probe", "skip the interaction probe (static review)")
    .action(
      async (
        urls: string[],
        options: {
          out?: string;
          design?: string;
          probe?: boolean;
          probeBudget?: string;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await quickCommand({
          urls,
          design: options.design,
          probe: options.probe,
          probeBudgetMs: options.probeBudget,
          project: shared.project,
          cwd: dependencies.cwd,
          out: options.out,
          dependencies: dependencies.quick,
        });
        writeOut(
          `Quick review: ${result.findingCount} finding(s), ${result.counts.total} capture(s) — ${interactionTail(result.interaction)} — Markdown: ${result.reportPath} — HTML: ${result.htmlReportPath}`,
        );
      },
    );

  program
    .command("capture")
    .description("capture every state and viewport in a flow")
    .argument("<flow>", "flow manifest id")
    .option("--prod", "capture a fresh production build")
    .option(
      "--states <ids>",
      "capture only these exact state ids (comma separated)",
    )
    .option(
      "--viewports <names>",
      "capture only these viewport names (comma separated)",
    )
    .option(
      "--schemes <schemes>",
      "capture only these colour schemes (comma separated)",
    )
    .option(
      "--port <port>",
      "serve the application on this port instead of a free one",
      parsePortOption,
    )
    .option(
      "--out <dir>",
      "exact output directory, relative to the invoking directory (must not exist)",
    )
    .option(
      "--refresh-design",
      "refetch pinned Figma frames instead of reusing .idiom/designs",
    )
    .action(
      async (
        flow: string,
        options: {
          out?: string;
          refreshDesign?: boolean;
          prod?: boolean;
          port?: number;
          states?: string;
          viewports?: string;
          schemes?: string;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await captureCommand({
          flow,
          project: shared.project,
          out: options.out,
          scope: {
            states: options.states,
            viewports: options.viewports,
            schemes: options.schemes,
          },
          prod: options.prod,
          port: options.port,
          refreshDesign: options.refreshDesign,
          cwd: dependencies.cwd,
          dependencies: captureDependencies(),
        });
        writeOut(
          `Captured ${flow}: ${result.counts.passed} passed, ${result.counts.failed} failed, ${result.counts.total} total — ${result.reportPath}`,
        );
        writeErr(renderTimings(result.timings));
        if (result.counts.failed > 0) {
          throw new IdiomError(
            `capture completed with ${result.counts.failed} failed tuple(s); see ${result.reportPath}`,
          );
        }
      },
    );

  const reference = program
    .command("reference")
    .description("manage visual references and anti-references");

  reference
    .command("add")
    .description("add a URL capture or local image to the reference catalog")
    .argument("<name>", "lowercase slug used to address the reference")
    .option("--url <url>", "capture a URL")
    .option("--file <path>", "copy a local image")
    .option("--viewport <name>", "configured viewport name for URL capture")
    .requiredOption("--note <text>", "what to take from or avoid in the image")
    .option("--anti", "store as an anti-reference")
    .action(
      async (
        name: string,
        options: {
          url?: string;
          file?: string;
          viewport?: string;
          note: string;
          anti?: boolean;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const stored = await addReferenceCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          name,
          ...options,
          dependencies: dependencies.reference,
        });
        writeOut(`Stored ${stored.label} — ${stored.metadata.note}`);
      },
    );

  reference
    .command("list")
    .description("list managed references and anti-references")
    .action(async (_options, command: Command) => {
      const shared = command.optsWithGlobals<SharedOptions>();
      const entries = await listReferencesCommand({
        project: shared.project,
        cwd: dependencies.cwd,
      });
      if (entries.length === 0) {
        writeOut("No managed references.");
        return;
      }
      for (const entry of entries) {
        const provenance =
          entry.metadata.sourceKind === "url"
            ? `${entry.metadata.source} · ${entry.metadata.capturedAt} · ${entry.metadata.viewport.name} ${entry.metadata.viewport.width}x${entry.metadata.viewport.height}`
            : entry.metadata.source;
        writeOut(`${entry.label} — ${entry.metadata.note} — ${provenance}`);
      }
    });

  reference
    .command("remove")
    .description("remove one managed reference")
    .argument("<name>", "managed reference name")
    .option("--anti", "remove an anti-reference")
    .action(
      async (name: string, options: { anti?: boolean }, command: Command) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const removed = await removeReferenceCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          name,
          anti: options.anti,
        });
        writeOut(`Removed ${removed.label}`);
      },
    );

  program
    .command("design")
    .description("Configure intended designs (HTML, images or Figma frames)")
    .command("add <state> <source>")
    .description(
      "Attach an intended design (a local HTML file/directory, prototype URL, PNG/JPEG/WebP image, or Figma frame URL) to an authored state",
    )
    .option("--flow <id>", "disambiguate the state across flow manifests")
    .option(
      "--name <name>",
      "add or replace a named reference, keeping the state's other references",
    )
    .option(
      "--viewport <name>",
      "compare this reference only at this project viewport",
    )
    .action(
      async (
        state: string,
        source: string,
        options: { flow?: string; name?: string; viewport?: string },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await addDesignCommand({
          state,
          source,
          name: options.name,
          viewport: options.viewport,
          flow: options.flow,
          project: shared.project,
          cwd: dependencies.cwd,
        });
        writeOut(
          `${result.changed ? "Set" : "Kept"} design for ${state}: ${result.source}`,
        );
      },
    );

  const baselineCommand = program
    .command("baseline")
    .description("record compact deterministic finding baselines");
  for (const name of ["record <flow>", "accept [flow]"]) {
    baselineCommand
      .command(name)
      .description(
        "record a clean captured commit; commit the resulting baseline file",
      )
      .option("--prod", "capture a fresh production build")
      .option(
        "--port <port>",
        "serve the application on this port instead of a free one",
        parsePortOption,
      )
      .option("--from <runId>", "use an existing immutable capture")
      .option("--latest", "use the newest fully passing capture at HEAD")
      .option(
        "--out <directory>",
        "write JSON and pixel baselines to this directory",
      )
      .option("--json", "print machine-readable record metadata")
      .action(
        async (
          flow: string | undefined,
          options: {
            prod?: boolean;
            port?: number;
            from?: string;
            latest?: boolean;
            json?: boolean;
            out?: string;
          },
          command: Command,
        ) => {
          const shared = command.optsWithGlobals<SharedOptions>();
          const result = await baselineRecordCommand({
            flow,
            out: options.out,
            project: shared.project,
            cwd: dependencies.cwd,
            prod: options.prod,
            port: options.port,
            from: options.from,
            latest: options.latest,
            dependencies: reviewDependencies,
          });
          writeOut(
            options.json === true
              ? JSON.stringify(result, null, 2)
              : renderBaselineRecord(result),
          );
        },
      );
  }

  program
    .command("review")
    .description(
      "review a captured flow, or a single page with --page, with deterministic and model critique",
    )
    .argument("[flow]", "flow manifest id (omit with --page)")
    .option("--deterministic-only", "run no model or external detector")
    .option("--from <runId>", "review an existing immutable capture")
    .option(
      "--latest",
      "review the newest fully passing capture of this flow at HEAD",
    )
    .option(
      "--since-baseline",
      "compare with the newest recorded baseline reachable from HEAD; gate new deterministic findings only",
    )
    .option("--json", "print machine-readable review results")
    .option(
      "--fail-on-judged",
      "include judged suggestions in severity gates",
      false,
    )
    .addOption(
      new Option(
        "--fail-on <severity>",
        "with --since-baseline, fail on new findings at least this severe",
      )
        .choices(["blocker", "major", "minor", "never"])
        .default("major"),
    )
    .option(
      "--design <source>",
      "with --page, intended HTML file/directory or prototype URL",
    )
    .option("--page <url>", "review one rendered page without a flow")
    .option(
      "--brief <file>",
      "with --page, the brief: source of truth for the offer and claims",
    )
    .option(
      "--direction <file>",
      "with --page, the art direction to hold sections to",
    )
    .option(
      "--focus <area...>",
      `with --page, critique focus areas (${pageFocusAreas.join(", ")})`,
    )
    .option(
      "--frame <reference...>",
      "with --page, reference frames: image or text files, or literal text",
    )
    .option(
      "--out <dir>",
      "with --page, exact output directory (must not exist)",
    )
    .addOption(
      new Option(
        "--provider <provider>",
        "with --page, critique provider",
      ).choices(["claude-code", "anthropic", "codex"]),
    )
    .option("--model <id>", "with --page, critique model")
    .option(
      "--max-findings <n>",
      "with --page, material findings to report (default 10)",
    )
    .option(
      "--refresh-design",
      "refetch pinned Figma frames instead of reusing .idiom/designs",
    )
    .action(
      async (
        flow: string | undefined,
        options: {
          refreshDesign?: boolean;
          from?: string;
          latest?: boolean;
          deterministicOnly?: boolean;
          sinceBaseline?: boolean;
          json?: boolean;
          failOnJudged: boolean;
          failOn: "blocker" | "major" | "minor" | "never";
          page?: string;
          design?: string;
          brief?: string;
          direction?: string;
          focus?: string[];
          frame?: string[];
          out?: string;
          provider?: CritiqueProvider;
          model?: string;
          maxFindings?: string;
        },
        command: Command,
      ) => {
        if (options.page === undefined && flow === undefined)
          throw new IdiomError(
            "review needs a flow id, or --page <url> to review a single page",
          );
        if (options.page !== undefined && flow !== undefined)
          throw new IdiomError(
            "review takes a flow id or --page <url>, not both",
          );
        if (options.page !== undefined) {
          for (const [flag, used] of [
            ["--from", options.from !== undefined],
            ["--latest", options.latest === true],
            ["--since-baseline", options.sinceBaseline === true],
          ] as const)
            if (used)
              throw new IdiomError(
                `${flag} reviews a stored flow capture and cannot be combined with --page`,
              );
          if (
            command.getOptionValueSource("failOn") === "cli" ||
            options.failOnJudged
          )
            throw new IdiomError(
              "--fail-on gates new findings against a flow baseline and cannot be combined with --page",
            );
          const shared = command.optsWithGlobals<SharedOptions>();
          const result = await pageReviewCommand({
            url: options.page,
            design: options.design,
            refreshDesign: options.refreshDesign,
            brief: options.brief,
            direction: options.direction,
            focus: parseFocus(options.focus),
            frames: options.frame,
            project: shared.project,
            cwd: dependencies.cwd,
            out: options.out,
            deterministicOnly: options.deterministicOnly,
            provider: options.provider,
            model: options.model,
            maxFindings: parseMaxFindings(options.maxFindings),
            dependencies:
              dependencies.page ??
              (dependencies.quick === undefined
                ? undefined
                : { capture: dependencies.quick }),
          });
          writeOut(
            options.json === true
              ? JSON.stringify(result, null, 2)
              : `Page review ${options.page}: ${result.findingCount} finding(s) — Markdown: ${result.reportPath} — HTML: ${result.htmlReportPath}`,
          );
          if (result.outcome.kind === "degraded")
            writeErr(
              `Warning: Model critique degraded: ${result.outcome.reason}`,
            );
          writeFallbackWarning(writeErr, result.outcome);
          return;
        }
        const pageOnly = (
          [
            ["--design", options.design],
            ["--brief", options.brief],
            ["--direction", options.direction],
            ["--focus", options.focus],
            ["--frame", options.frame],
            ["--out", options.out],
            ["--provider", options.provider],
            ["--model", options.model],
            ["--max-findings", options.maxFindings],
          ] as const
        ).find(([, value]) => value !== undefined);
        if (pageOnly !== undefined)
          throw new IdiomError(`${pageOnly[0]} requires --page <url>`);
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await reviewCommand({
          flow: flow as string,
          project: shared.project,
          cwd: dependencies.cwd,
          from: options.from,
          latest: options.latest,
          deterministicOnly: options.deterministicOnly,
          sinceBaseline: options.sinceBaseline,
          refreshDesign: options.refreshDesign,
          dependencies: reviewDependencies,
        });
        writeOut(
          options.json === true
            ? JSON.stringify(result, null, 2)
            : `Reviewed ${flow}: ${result.findingCount} finding(s), ${result.unruledDecisionCount} unruled decision(s)${result.designSystemQuestions.length === 0 ? "" : `, ${result.designSystemQuestions.length} design system question(s)`}${result.build === undefined ? "" : ` · production build ${result.build.id}`} — ${result.reportPath}`,
        );
        if (options.json !== true && result.advisory !== undefined)
          writeErr(
            `Advisory design review (does not gate): ${advisoryCount(result.advisory.review)} finding(s) across ${result.advisory.review.patterns.length} pattern(s), listed in the report's advisory section.`,
          );
        if (result.comparison !== undefined) {
          if (options.json !== true) {
            writeOut(renderBaselineComparison(result.comparison));
            writeOut(
              `Unclassified model findings: ${result.comparison.unclassified}`,
            );
            const warning = baselineStaleWarning(result.comparison.baseline);
            if (warning !== undefined) writeErr(warning);
          }
          const failing =
            options.failOn === "never"
              ? []
              : [
                  ...result.comparison.findings,
                  ...(options.failOnJudged
                    ? (result.comparison.currentJudged ?? [])
                    : []),
                ].filter((finding) =>
                  severityGateEligible(
                    finding,
                    options.failOn,
                    options.failOnJudged,
                  ),
                );
          if (failing.length > 0)
            throw new IdiomError(
              `review failed: ${failing.length} new finding(s) at or above ${options.failOn}`,
            );
        }
        if (result.outcome.kind === "degraded")
          writeErr(
            `Warning: Model critique degraded: ${result.outcome.reason}`,
          );
        writeFallbackWarning(writeErr, result.outcome);
        const violations = result.publishedBudget?.violations ?? [];
        if (violations.length > 0)
          throw new IdiomError(
            `published budget failed: ${violations.length} violation(s): ${violations
              .slice(0, 3)
              .map(({ explanation }) => explanation)
              .join("; ")}`,
          );
      },
    );

  program
    .command("fix")
    .description(
      "repair deterministic findings with your coding agent and calibrated verification",
    )
    .argument("<flow>", "flow id")
    .addOption(
      new Option("--agent <agent>", "local coding agent")
        .choices(["claude", "codex"])
        .default("claude"),
    )
    .option("--max-rounds <n>", "maximum repair attempts", parsePositiveInt, 3)
    .option(
      "--top <n>",
      "findings per repair attempt (a root cause is always attempted whole)",
      parsePositiveInt,
      5,
    )
    .option("--dry-run", "capture and print the repair prompt only")
    .action(async (flow: string, _options, command: Command) => {
      const options = command.optsWithGlobals<
        SharedOptions & {
          agent: "claude" | "codex";
          maxRounds: number;
          top: number;
          dryRun?: boolean;
        }
      >();
      const result = await fixCommand({
        flow,
        project: options.project,
        cwd: dependencies.cwd,
        agent: options.agent,
        maxRounds: options.maxRounds,
        top: options.top,
        dryRun: options.dryRun,
        dependencies: {
          review: reviewDependencies,
          verification: dependencies.verify ?? {
            capture: captureDependencies(),
          },
          ...dependencies.fix,
          progress: (message) => {
            writeErr(message);
            dependencies.fix?.progress?.(message);
          },
        },
      });
      if (result.dryRun) {
        if (result.prompt) writeOut(result.prompt);
      } else {
        writeOut(renderFixSummary(result.summary));
        if (!result.summary.passed)
          throw new IdiomError(`fix failed: ${result.summary.reason}`);
      }
    });

  program
    .command("check")
    .description(
      "capture and check for regressions; initialize clean HEAD once, then gate new findings",
    )
    .argument("[flow]", "flow manifest id (required without --changed)")
    .option(
      "--changed [base]",
      "check states affected by changes since base (default: merge base with the default branch); put flow before --changed",
    )
    .option("--prod", "capture and check a fresh production build")
    .option(
      "--states <ids>",
      "capture only these exact state ids (comma separated)",
    )
    .option(
      "--viewports <names>",
      "capture only these viewport names (comma separated)",
    )
    .option(
      "--schemes <schemes>",
      "capture only these colour schemes (comma separated)",
    )
    .option(
      "--port <port>",
      "serve the application on this port instead of a free one",
      parsePortOption,
    )
    .option("--from <runId>", "check an existing immutable capture")
    .option(
      "--latest",
      "check the newest fully passing capture of this flow at HEAD",
    )
    .option(
      "--baseline <runId>",
      "report only findings that stored run did not already have",
    )
    .option(
      "--since-baseline",
      "report new, fixed and pre-existing findings against the newest recorded baseline reachable from HEAD; gate new findings only",
    )
    .option(
      "--baseline-file <path>",
      "compare with this compact baseline file; never initialize it",
    )
    .option(
      "--emit-tickets <dir>",
      "emit clustered proposals into a file tracker triage directory",
    )
    .option(
      "--advisory",
      "also run the model's advisory design-intent review of the flow's declared patterns; never affects the exit code",
    )
    .option(
      "--top <n>",
      "how many top issues to list first (default 5)",
      parsePositiveInt,
    )
    .option("--all", "report and gate all open findings, expanding every issue")
    .option("--json", "print machine-readable findings")
    .option(
      "--ungrouped",
      "list every finding separately instead of one entry per element and rule",
    )
    .option(
      "--fail-on-judged",
      "include judged suggestions in severity gates",
      false,
    )
    .addOption(
      new Option(
        "--fail-on <severity>",
        "exit non-zero when a new finding (or any open finding with --all) is at least this severe",
      )
        .choices(["blocker", "major", "minor", "never"])
        .default("major"),
    )
    .option(
      "--refresh-design",
      "refetch pinned Figma frames instead of reusing .idiom/designs",
    )
    .action(
      async (
        flow: string | undefined,
        options: {
          changed?: true | string;
          refreshDesign?: boolean;
          from?: string;
          latest?: boolean;
          prod?: boolean;
          port?: number;
          baseline?: string;
          baselineFile?: string;
          sinceBaseline?: boolean;
          emitTickets?: string;
          advisory?: boolean;
          json?: boolean;
          ungrouped?: boolean;
          top?: number;
          all?: boolean;
          states?: string;
          viewports?: string;
          schemes?: string;
          failOnJudged: boolean;
          failOn: "blocker" | "major" | "minor" | "never";
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        if (options.changed !== undefined) {
          const output = await checkChanged({
            ...options,
            flow,
            changed: options.changed,
            project: shared.project,
            cwd: dependencies.cwd,
            scope: {
              states: options.states,
              viewports: options.viewports,
              schemes: options.schemes,
            },
            dependencies: reviewDependencies,
          });
          const checked = output.checks.filter(
            (entry) => entry.status === "checked",
          );
          writeOut(
            options.json
              ? JSON.stringify(
                  {
                    selection: output.selection,
                    checkedStates: output.checkedStates,
                    checks: output.checks.map((entry) =>
                      entry.status === "checked"
                        ? {
                            flow: entry.flow,
                            status: entry.status,
                            summary: entry.summary,
                          }
                        : entry,
                    ),
                  },
                  null,
                  2,
                )
              : [
                  renderChangedSelection(output),
                  ...checked.map((entry) =>
                    [
                      entry.summary.baselineNotApplied,
                      renderCheckSummary(entry.summary, options).trimEnd(),
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  ),
                ].join("\n"),
          );
          for (const entry of checked)
            writeErr(renderTimings(entry.summary.timings));
          const failing = checked
            .flatMap((entry) => entry.summary.findings)
            .filter((finding) =>
              severityGateEligible(
                finding,
                options.failOn,
                options.failOnJudged,
              ),
            );
          if (failing.length)
            throw new IdiomError(
              `check failed: ${failing.length} new/open finding(s) at or above ${options.failOn}`,
            );
          return;
        }
        if (!flow)
          throw new IdiomError(
            "check requires a flow unless --changed is supplied",
          );
        const summary = await checkCommand({
          flow,
          project: shared.project,
          cwd: dependencies.cwd,
          from: options.from,
          latest: options.latest,
          baseline: options.baseline,
          baselineFile: options.baselineFile,
          all: options.all,
          sinceBaseline: options.sinceBaseline,
          prod: options.prod,
          port: options.port,
          refreshDesign: options.refreshDesign,
          emitTickets: options.emitTickets,
          advisory: options.advisory,
          scope: {
            states: options.states,
            viewports: options.viewports,
            schemes: options.schemes,
          },
          dependencies: reviewDependencies,
        });
        writeOut(
          options.json === true
            ? JSON.stringify(summary, null, 2)
            : renderCheckSummary(summary, {
                ungrouped: options.ungrouped,
                top: options.top,
                all: options.all,
              }).trimEnd(),
        );
        writeErr(renderTimings(summary.timings));
        if (options.json !== true && summary.baseline !== undefined) {
          const warning = baselineStaleWarning(summary.baseline);
          if (warning !== undefined) writeErr(warning);
        }
        const failing =
          options.failOn === "never"
            ? []
            : summary.findings.filter((finding) =>
                severityGateEligible(
                  finding,
                  options.failOn,
                  options.failOnJudged,
                ),
              );
        if (failing.length > 0)
          throw new IdiomError(
            `check failed: ${failing.length} ${summary.baseline !== undefined || summary.preExisting !== undefined ? "new" : "open"} finding(s) at or above ${options.failOn}`,
          );
      },
    );

  program
    .command("sweep")
    .description(
      "capture, run every deterministic check, then a per-surface model sweep with crops and measured geometry",
    )
    .argument("[flow]", "flow manifest id")
    .option("--all", "capture and sweep every validated flow")
    .option(
      "--deterministic-only",
      "run the full check registry without model credentials",
    )
    .option(
      "--max-tickets <n>",
      "maximum new cleanup tickets (default 10)",
      Number,
      10,
    )
    .option("--prod", "capture and sweep a fresh production build")
    .option(
      "--port <port>",
      "serve the application on this port instead of a free one",
      parsePortOption,
    )
    .option("--from <runId>", "sweep an existing immutable capture")
    .option(
      "--latest",
      "sweep the newest fully passing capture of this flow at HEAD",
    )
    .option(
      "--emit-tickets <dir>",
      "emit clustered proposals into a file tracker triage directory",
    )
    .option("--json", "print machine-readable findings")
    .option(
      "--fail-on-judged",
      "include judged suggestions in severity gates",
      false,
    )
    .addOption(
      new Option(
        "--fail-on <severity>",
        "exit non-zero when an open finding is at least this severe",
      )
        .choices(["blocker", "major", "minor", "never"])
        .default("never"),
    )
    .action(
      async (
        flow: string | undefined,
        options: {
          all?: boolean;
          deterministicOnly?: boolean;
          maxTickets: number;
          from?: string;
          latest?: boolean;
          prod?: boolean;
          port?: number;
          emitTickets?: string;
          json?: boolean;
          failOnJudged: boolean;
          failOn: "blocker" | "major" | "minor" | "never";
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const summary = await sweepCommand({
          flow,
          all: options.all,
          deterministicOnly: options.deterministicOnly,
          maxTickets: options.maxTickets,
          project: shared.project,
          cwd: dependencies.cwd,
          from: options.from,
          latest: options.latest,
          prod: options.prod,
          port: options.port,
          emitTickets: options.emitTickets,
          dependencies: reviewDependencies,
        });
        writeOut(
          options.json === true
            ? JSON.stringify(summary, null, 2)
            : renderSweepSummary(summary).trimEnd(),
        );
        if (summary.outcome.kind === "degraded")
          writeErr(
            `Warning: ${"scope" in summary ? "Sweep incomplete" : "Model critique degraded"}: ${summary.outcome.reason}`,
          );
        writeFallbackWarning(writeErr, summary.outcome);
        const failing =
          options.failOn === "never"
            ? []
            : summary.findings.filter((finding) =>
                severityGateEligible(
                  finding,
                  options.failOn,
                  options.failOnJudged,
                ),
              );
        if (failing.length > 0)
          throw new IdiomError(
            `sweep failed: ${failing.length} open finding(s) at or above ${options.failOn}`,
          );
      },
    );

  program
    .command("coverage")
    .description(
      "list the app's routes that no flow captures, or (--states) which states each flow's latest capture observed",
    )
    .option("--crawl <url>", "discover routes from the links on a running page")
    .option("--states", "show which states each flow's latest capture observed")
    .option("--json", "print machine-readable coverage")
    .action(
      async (
        options: { crawl?: string; states?: boolean; json?: boolean },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        if (options.states === true) {
          if (options.crawl !== undefined)
            throw new IdiomError("--states cannot be combined with --crawl");
          const states = await stateCoverageCommand({
            project: shared.project,
            cwd: dependencies.cwd,
          });
          writeOut(
            options.json === true
              ? JSON.stringify(states, null, 2)
              : renderStateCoverage(states).trimEnd(),
          );
          return;
        }
        const summary = await coverageCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          crawl: options.crawl,
        });
        writeOut(
          options.json === true
            ? JSON.stringify(summary, null, 2)
            : renderCoverage(summary).trimEnd(),
        );
      },
    );

  const explore = program
    .command("explore")
    .description("explore three rendered design directions for one flow state")
    .argument("[flow]", "flow manifest id")
    .option("--state <state>", "exactly one state id")
    .option("--question <text>", "design question or dissatisfaction")
    .option("--decision <ruling-N>", "reviewed unruled decision to explore");

  explore.action(
    async (
      flow: string | undefined,
      options: { state?: string; question?: string; decision?: string },
      command: Command,
    ) => {
      if (flow === undefined)
        throw new IdiomError("explore generation requires <flow>");
      if (options.state === undefined)
        throw new IdiomError("explore generation requires --state <state>");
      const shared = command.optsWithGlobals<SharedOptions>();
      const result = await exploreCommand({
        flow,
        state: options.state,
        question: options.question,
        decision: options.decision,
        project: shared.project,
        cwd: dependencies.cwd,
        dependencies: dependencies.explore,
        write: writeOut,
      });
      if (result.outcome === "pending")
        writeOut(
          `Exploration generated and awaiting resolution — ${result.reportPath}`,
        );
      else if (result.outcome === "none")
        writeOut(
          "Exploration ended with no selection; no rule or candidate code was kept.",
        );
      else if (result.outcome === "cancelled")
        writeOut(
          "Exploration ruling cancelled; no rule or candidate code was kept.",
        );
      else if (result.outcome === "rule-only")
        writeOut(
          `Recorded ${result.ruling?.id}; repair tickets declined — ${result.reportPath}`,
        );
      else
        writeOut(
          `Recorded ${result.ruling?.id} and created ${result.ticketCount ?? 0} repair ticket(s) — ${result.reportPath}`,
        );
    },
  );

  explore
    .command("resolve")
    .description("record a choice against a completed exploration run")
    .argument("<run-id>", "published exploration run id")
    .option("--candidate <A|B|C>", "winning candidate label")
    .option("--none", "resolve without recording a design-law rule")
    .option("--reason <text>", "human reason for the outcome")
    .option("--yes", "confirm the exact emitted ruling diff without prompting")
    .option("--repairs", "publish and ticket repairs for the selected rule")
    .action(
      async (
        runId: string,
        options: {
          candidate?: string;
          none?: boolean;
          reason?: string;
          yes?: boolean;
          repairs?: boolean;
        },
        command: Command,
      ) => {
        const parent = command.parent?.opts<{
          state?: string;
          question?: string;
          decision?: string;
        }>();
        if (
          parent?.state !== undefined ||
          parent?.question !== undefined ||
          parent?.decision !== undefined
        )
          throw new IdiomError(
            "explore resolve does not accept generation options --state, --question, or --decision",
          );
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await exploreResolveCommand({
          runId,
          ...options,
          project: shared.project,
          cwd: dependencies.cwd,
          dependencies: dependencies.explore,
          write: writeOut,
        });
        if (result.outcome === "none")
          writeOut(
            `Resolved ${runId} with no choice; the design law was unchanged — ${result.reportPath}`,
          );
        else if (result.outcome === "rule-only")
          writeOut(
            `Recorded ${result.ruling?.id}; no repair tickets requested — ${result.reportPath}`,
          );
        else if (result.outcome === "rule-plus-tickets")
          writeOut(
            `Recorded ${result.ruling?.id} and created ${result.ticketCount ?? 0} repair ticket(s) — ${result.reportPath}`,
          );
      },
    );

  program
    .command("verify")
    .description("verify embedded findings with offline recapture evidence")
    .argument("<flow>", "flow manifest id")
    .requiredOption("--spec <path>", "spec containing idiom:finding blocks")
    .option(
      "--against <runId-or-directory>",
      "baseline capture run or directory",
    )
    .option("--out <dir>", "exact replaceable verify output directory")
    .option(
      "--refresh-design",
      "refetch pinned Figma frames instead of reusing .idiom/designs",
    )
    .action(
      async (
        flow: string,
        options: {
          spec: string;
          against?: string;
          out?: string;
          refreshDesign?: boolean;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await verifyCommand({
          flow,
          spec: options.spec,
          project: shared.project,
          cwd: dependencies.cwd,
          against: options.against,
          out: options.out,
          refreshDesign: options.refreshDesign,
          dependencies:
            dependencies.verify ??
            (dependencies.capture === undefined
              ? undefined
              : { capture: dependencies.capture }),
        });
        writeOut(
          `Verified ${flow}: ${result.outcome} (${result.findingCount} finding(s)) — ${result.reportPath}`,
        );
        for (const verdict of result.verdicts ?? [])
          writeOut(
            `${verdict.finding.id}: ${verdict.status}; acceptance ${verdict.acceptance.status} — ${verdict.acceptance.reason}`,
          );
        if (!result.passed)
          throw new IdiomError(
            `verification failed: ${result.causes.join("; ")}; see ${result.reportPath}`,
          );
      },
    );

  program
    .command("compare")
    .description(
      "write before/after composites for tuples that changed between two stored captures",
    )
    .argument("<flow>", "flow manifest id")
    .requiredOption("--from <runId>", "the after capture")
    .requiredOption("--against <runId>", "the before capture")
    .option("--out <dir>", "exact replaceable compare output directory")
    .option("--json", "print machine-readable comparison results")
    .action(
      async (
        flow: string,
        options: {
          from: string;
          against: string;
          out?: string;
          json?: boolean;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await compareCommand({
          flow,
          from: options.from,
          against: options.against,
          project: shared.project,
          cwd: dependencies.cwd,
          out: options.out,
        });
        writeOut(
          options.json === true
            ? JSON.stringify(result, null, 2)
            : `Compared ${flow}: ${result.changed.length} changed, ${result.unchanged.length} unchanged, ${result.newFindings.length} new / ${result.fixedFindings.length} fixed finding(s) — ${result.reportPath}`,
        );
      },
    );

  program
    .command("report")
    .description("open a review or verify HTML report in the default browser")
    .argument("[runId]", "report run id; defaults to the newest HTML report")
    .action(async (runId: string | undefined, _options, command: Command) => {
      const shared = command.optsWithGlobals<SharedOptions>();
      const result = await reportCommand({
        project: shared.project,
        cwd: dependencies.cwd,
        runId,
        dependencies: dependencies.report,
      });
      writeOut(`Opened report ${result.runId} — ${result.reportPath}`);
    });

  program
    .command("decide")
    .description("record accept or reject decisions for reviewed findings")
    .option("--list", "list finding lifecycles without writing decisions")
    .option("--finding <id>", "finding id to decide non-interactively")
    .option(
      "--group <id>",
      "finding group id to decide non-interactively; applies to every member",
    )
    .option("--accept", "accept the selected finding")
    .option("--reject", "reject the selected finding")
    .option(
      "--choose <reference>",
      "for a design decision, the design reference that is intended",
    )
    .addOption(
      new Option("--scope <scope>", "rejection scope").choices([
        "instance",
        "rule",
      ]),
    )
    .option("--reason <text>", "optional decision reason")
    .action(
      async (
        options: {
          finding?: string;
          group?: string;
          accept?: boolean;
          reject?: boolean;
          choose?: string;
          scope?: "instance" | "rule";
          reason?: string;
          list?: boolean;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await decideCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          finding: options.finding,
          group: options.group,
          accept: options.accept,
          reject: options.reject,
          choose: options.choose,
          scope: options.scope,
          reason: options.reason,
          list: options.list,
          dependencies: dependencies.decide,
          write: writeOut,
        });
        if (result.listed !== true)
          writeOut(
            `Decisions: ${result.accepted} accepted, ${result.rejected} rejected, ${result.skipped} skipped — ${result.path}`,
          );
      },
    );

  program
    .command("ruling")
    .description("record a reviewed design ruling or explicit no-rule outcome")
    .requiredOption("--decision <id>", "unruled decision id")
    .option("--candidate <number>", "one-based candidate ruling number")
    .option("--wording <text>", "record custom ruling wording")
    .option("--no-rule", "record that this decision deliberately needs no rule")
    .option(
      "--add-step",
      "design-system question: add the value as a step for its context",
    )
    .option(
      "--token <name>",
      "token name for --add-step (defaults to the suggestion)",
    )
    .option(
      "--drift",
      "design-system question: keep reporting the value as drift (skip by not answering)",
    )
    .action(
      async (
        options: {
          decision: string;
          candidate?: string;
          wording?: string;
          rule?: boolean;
          addStep?: boolean;
          token?: string;
          drift?: boolean;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await rulingCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          decision: options.decision,
          candidate: options.candidate,
          wording: options.wording,
          noRule: options.rule === false,
          addStep: options.addStep,
          token: options.token,
          drift: options.drift,
          dependencies: dependencies.ruling,
          write: writeOut,
        });
        writeOut(
          result.recorded
            ? `Recorded ${options.decision} — ${result.path}`
            : `Cancelled ${options.decision}; no files changed.`,
        );
      },
    );

  program
    .command("learn")
    .description(
      "turn a human-found miss into a check entry or design-law ruling (shows the diff first)",
    )
    .argument(
      "<observation>",
      'what is wrong, e.g. "the override dots should be 8px"',
    )
    .requiredOption("--state <state>", "the flow state the miss was seen on")
    .option("--flow <id>", "the flow, when several declare the state")
    .option("--screenshot <png>", "keep the screenshot the human annotated")
    .option("--from <runId>", "resolve against this stored capture")
    .option(
      "--selector <css>",
      "the element(s) meant, instead of resolving the subject (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--ruling", "record the observation as a design-law ruling")
    .option("--wording <text>", "ruling wording (with --ruling)")
    .option("--yes", "apply without the confirmation prompt")
    .action(
      async (
        observation: string,
        options: {
          state: string;
          flow?: string;
          screenshot?: string;
          from?: string;
          selector: string[];
          ruling?: boolean;
          wording?: string;
          yes?: boolean;
        },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const result = await learnCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          observation,
          state: options.state,
          flow: options.flow,
          screenshot: options.screenshot,
          from: options.from,
          selectors:
            options.selector.length === 0 ? undefined : options.selector,
          ruling: options.ruling,
          wording: options.wording,
          yes: options.yes,
          dependencies: dependencies.learn,
          write: writeOut,
        });
        writeOut(
          result.recorded
            ? `Recorded ${result.id} (${result.kind}) — ${result.paths.join(", ")}\n${result.next}`
            : "Cancelled; no files changed.",
        );
      },
    );

  program
    .command("instruction")
    .description("emit one accepted finding as a paste-ready instruction")
    .requiredOption("--finding <id>", "accepted finding id")
    .action(async (options: { finding: string }, command: Command) => {
      const shared = command.optsWithGlobals<SharedOptions>();
      writeOut(
        await instructionCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          findingId: options.finding,
        }),
      );
    });

  program
    .command("tickets")
    .description("emit accepted findings as triage tickets")
    .option(
      "--finding <id>",
      "accepted finding id (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option(
      "--cluster",
      "group accepted findings by component and category in triage",
    )
    .option("--out <dir>", "ticket output directory")
    .action(
      async (
        options: { finding: string[]; out?: string; cluster?: boolean },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        if (options.cluster === true) {
          writeOut(
            renderClusterTicketsResult(
              await clusterTicketsCommand({
                project: shared.project,
                cwd: dependencies.cwd,
                findingIds: options.finding,
                out: options.out,
              }),
            ),
          );
          return;
        }
        const result = await ticketsCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          findingIds: options.finding,
          out: options.out,
        });
        const created = result.outcomes.filter(
          (outcome) => outcome.kind === "created",
        ).length;
        const existing = result.outcomes.filter(
          (outcome) => outcome.kind === "already-emitted",
        ).length;
        const resolved = result.outcomes.filter(
          (outcome) => outcome.kind === "already-resolved",
        ).length;
        const conflicts = result.outcomes.filter(
          (outcome) => outcome.kind === "conflict",
        ).length;
        writeOut(
          `Tickets: ${created} created, ${existing} already emitted, ${resolved} already resolved, ${conflicts} conflict(s), ${result.ineligible.length} ineligible — ${result.outputDirectory}`,
        );
        for (const outcome of result.outcomes) {
          if (outcome.kind === "created")
            writeOut(`${outcome.findingId}: created ${outcome.path}`);
          else if (outcome.kind === "already-emitted")
            writeOut(
              `${outcome.findingId}: already emitted${outcome.state === undefined ? "" : ` in ${outcome.state}`} (${outcome.unchanged ? "unchanged" : "human-modified"}) — ${outcome.path}`,
            );
          else if (outcome.kind === "already-resolved")
            writeOut(
              outcome.path === undefined
                ? `${outcome.findingId}: already resolved (${outcome.status} lifecycle checkpoint)`
                : `${outcome.findingId}: already resolved as ${outcome.status} in ${outcome.state} — ${outcome.path}`,
            );
          else
            writeOut(
              `${outcome.findingId}: tracker conflict — ${outcome.paths.join(", ")}`,
            );
        }
        for (const findingId of result.ineligible)
          writeOut(`${findingId}: not accepted; no ticket emitted`);
      },
    );

  program
    .command("context")
    .description("emit a bounded design brief for write-time agent context")
    .argument("[flow]", "flow manifest id")
    .action(async (flow: string | undefined, _options, command: Command) => {
      const shared = command.optsWithGlobals<SharedOptions>();
      writeOut(
        await contextCommand({
          project: shared.project,
          flow,
          cwd: dependencies.cwd,
          dependencies: dependencies.context,
        }),
      );
    });

  program
    .command("system")
    .description("render and open the evidence-derived design system")
    .option(
      "--learn [figma-file-url]",
      "propose design rules from code, or tokens from a Figma file's variables",
    )
    .option("--yes", "apply the displayed learning without prompting")
    .option(
      "--refresh-design",
      "refetch pinned Figma frames instead of reusing .idiom/designs",
    )
    .action(async (_options, command: Command) => {
      const shared = command.optsWithGlobals<SharedOptions>();
      const local = command.opts<{
        learn?: boolean | string;
        yes?: boolean;
        refreshDesign?: boolean;
      }>();
      const result = await systemCommand({
        learn: local.learn !== undefined && local.learn !== false,
        ...(typeof local.learn === "string"
          ? { learnSource: local.learn }
          : {}),
        refreshDesign: local.refreshDesign,
        yes: local.yes,
        project: shared.project,
        cwd: dependencies.cwd,
        dependencies: {
          ...dependencies.system,
          write:
            dependencies.system?.write ??
            ((message: string) => writeOut(message)),
        },
      });
      writeOut(result.reportPath);
    });

  program
    .command("validate")
    .description("validate project configuration and flow manifests")
    .argument("[flow]", "flow manifest id")
    .action(async (flow: string | undefined, _options, command: Command) => {
      const shared = command.optsWithGlobals<SharedOptions>();
      writeOut(
        await validateCommand({
          project: shared.project,
          flow,
          cwd: dependencies.cwd,
        }),
      );
    });

  return program;
}

export async function run(
  argv: string[] = process.argv,
  dependencies: ProgramDependencies = {},
): Promise<number> {
  const program = createProgram(dependencies);
  program.exitOverride();
  for (const command of program.commands) command.exitOverride();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof IdiomError) {
      lineWriter(
        dependencies.stderr ?? ((message) => process.stderr.write(message)),
      )(`Error: ${error.message}`);
      return 1;
    }
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}

async function isEntryPoint(
  moduleUrl: string,
  argvEntry: string | undefined,
): Promise<boolean> {
  if (argvEntry === undefined) return false;

  try {
    const [modulePath, entryPath] = await Promise.all([
      realpath(fileURLToPath(moduleUrl)),
      realpath(argvEntry),
    ]);
    return modulePath === entryPath;
  } catch {
    return false;
  }
}

if (await isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = await run();
}
