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
import { renderAsk } from "./brief/ask.js";
import { gateJson, renderGate } from "./brief/gate.js";
import {
  briefInstructionLines,
  offerBriefInstruction,
} from "./brief/instruction.js";
import { parsePort } from "./capture/port.js";
import type { CaptureDependencies } from "./capture/run.js";
import {
  combineCheckTimings,
  renderTimingLine,
  renderTimings,
} from "./capture/timings.js";
import {
  baselineRecordCommand,
  renderBaselineRecord,
} from "./commands/baseline.js";
import {
  type BriefDependencies,
  briefDecideCommand,
  briefDecideJson,
  briefGateCommand,
  briefListCommand,
  briefPlanCommand,
  briefRecordCommand,
  briefRecordJson,
  briefResearchCommand,
  briefShowCommand,
  briefTriageCommand,
  renderBriefDecide,
  renderBriefList,
  renderBriefResearch,
} from "./commands/brief.js";
import { captureCommand } from "./commands/capture.js";
import { checkCommand, renderCheckSummary } from "./commands/check.js";
import {
  checkChanged,
  renderChangedSelection,
} from "./commands/check-changed.js";
import { checkGate } from "./commands/check-gate.js";
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
import { renderDoctorReport, runDoctor } from "./commands/doctor.js";
import {
  type ExploreDependencies,
  exploreCommand,
} from "./commands/explore.js";
import { exploreResolveCommand } from "./commands/explore-resolve.js";
import { fixCommand } from "./commands/fix.js";
import {
  type Confirmation,
  defaultConfirmation,
  initProject,
  initSummaryLines,
} from "./commands/init.js";
import { offerAgentSetup } from "./commands/init-agent.js";
import {
  initValidate,
  initValidateProblem,
  renderInitValidate,
} from "./commands/init-validate.js";
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
import type { CritiqueProcessRunner } from "./critique/process.js";
import { IdiomError, RUN_FAILURE_EXIT_CODE, RunFailure } from "./errors.js";
import { severityGateEligible } from "./findings/gate.js";
import { renderFixSummary } from "./fix/report.js";
import type { FixDependencies } from "./fix/run.js";
import type { GenerateFlow } from "./flows/generate.js";
import { applyHelp } from "./help.js";
import { EXIT_CODES, jsonPayload } from "./interface/version.js";
import { resolveProjectArgument } from "./project.js";
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
import {
  SETUP_AGENTS,
  type SetupAgent,
  type SetupAgentLauncher,
} from "./setup/agents.js";
import { collectSetupFacts } from "./setup/facts.js";
import { setupPrompt } from "./setup/prompt.js";
import type { UpgradeDependencies } from "./skills/upgrade.js";
import type { SystemRunDependencies } from "./system/run.js";
import { renderClusterTicketsResult } from "./tickets/emit.js";
import {
  checkForUpdate,
  renderUpdateNotice,
  type UpdateCheckDependencies,
  type UpdateNotice,
} from "./update/notice.js";
import {
  type SelfUpdateDependencies,
  selfUpdate,
} from "./update/self-update.js";
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
  brief?: BriefDependencies;
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
  /** Test seam for upgrade's CLI step: install detection, registry, runners. */
  selfUpdate?: SelfUpdateDependencies;
  updateCheck?: UpdateCheckDependencies;
  /** Test seam for agent-led setup after init: probe runner, launcher, environment. */
  setupAgent?: {
    probe?: CritiqueProcessRunner;
    launch?: SetupAgentLauncher;
    environment?: NodeJS.ProcessEnv;
  };
};

/** Commands that tell people a newer Idiom exists. */
const UPDATE_NOTICE_COMMANDS = new Set(["init", "check", "review", "doctor"]);

/**
 * The update check for one invocation: started before the action so a cold
 * fetch overlaps the command's work, rendered by `run()` after all output.
 */
type UpdateNotices = {
  start(project: string | undefined, json: boolean): void;
  /** Spreads `update` into a JSON result only when a newer version exists. */
  withUpdate<T extends object>(
    value: T,
  ): Promise<T | (T & { update: UpdateNotice })>;
  finish(write: (message: string) => void): Promise<void>;
  /** Waits out a started check, cache write included, without rendering. */
  settled(): Promise<void>;
};

function createUpdateNotices(dependencies: ProgramDependencies): UpdateNotices {
  let pending: Promise<UpdateNotice | undefined> | undefined;
  let json = false;
  return {
    start(project, jsonMode) {
      json = jsonMode;
      pending ??= checkForUpdate({
        ...dependencies.updateCheck,
        project,
        cwd: dependencies.cwd,
      });
    },
    async withUpdate(value) {
      const update = await pending;
      return update === undefined ? value : { ...value, update };
    },
    async finish(write) {
      if (pending === undefined || json) return;
      const notice = await pending;
      if (notice !== undefined) write(renderUpdateNotice(notice));
    },
    async settled() {
      await pending;
    },
  };
}

type SharedOptions = { project?: string };

function lineWriter(
  write: (message: string) => void,
): (message: string) => void {
  return (message) => write(message.endsWith("\n") ? message : `${message}\n`);
}

/**
 * With --json, a run that could not happen still prints machine-readable
 * output on stdout; the failure is then rethrown for stderr and the exit code.
 */
async function withFailureJson<T>(
  json: boolean | undefined,
  flow: string | undefined,
  writeOut: (message: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (json === true && error instanceof RunFailure)
      writeOut(
        jsonPayload({
          ...(flow === undefined ? {} : { flow }),
          failure: error.failureJson(),
        }),
      );
    throw error;
  }
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

function parseNonNegativeInt(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
    throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

/** `90s`, `3m`, `2m30s`, `180000ms`, or bare milliseconds; always positive. */
export function parseDuration(value: string): number {
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed);
  else {
    const match = /^(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?(?:(\d+)ms)?$/.exec(
      trimmed,
    );
    if (!match || trimmed === "")
      throw new InvalidArgumentError(
        "must be a duration such as 90s, 3m, 2m30s or 180000ms",
      );
    const [, hours, minutes, seconds, millis] = match;
    ms =
      Number(hours ?? 0) * 3_600_000 +
      Number(minutes ?? 0) * 60_000 +
      Number(seconds ?? 0) * 1000 +
      Number(millis ?? 0);
  }
  if (!Number.isSafeInteger(ms) || ms < 1)
    throw new InvalidArgumentError("must be a positive duration");
  return ms;
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

export function createProgram(
  dependencies: ProgramDependencies = {},
  notices: UpdateNotices = createUpdateNotices(dependencies),
): Command {
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
    const leftoverCallbacks = new Set([
      dependencies.capture?.onLeftoverServer,
      supplied?.onLeftoverServer,
    ]);
    return {
      ...dependencies.capture,
      ...supplied,
      onLeftoverServer: (message) => {
        for (const callback of leftoverCallbacks) callback?.(message);
        writeErr(message);
      },
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
  const { withUpdate } = notices;
  program.hook("preAction", (_root, action) => {
    if (action.parent !== program || !UPDATE_NOTICE_COMMANDS.has(action.name()))
      return;
    notices.start(
      action.optsWithGlobals<SharedOptions>().project,
      action.opts<{ json?: boolean }>().json === true,
    );
  });

  program
    .command("init")
    .description("scaffold PRODUCT.md, DESIGN.md, and .idiom without data loss")
    .option("--yes", "accept scaffold defaults without prompting")
    .option(
      "--flows",
      "generate a site flow from filesystem and running local routes",
    )
    .option("--surface <id>", "project surface for the generated site flow")
    .option(
      "--validate",
      "check that setup is done without changing anything; exits 0 when ready, 2 when not",
    )
    .option(
      "--flow <id>",
      "with --validate: the flow to boot (default: the first flow)",
    )
    .option("--json", "with --validate: print { ready, validate, doctor }")
    .addOption(
      new Option(
        "--agent <name>",
        "launch this coding agent for setup without asking",
      ).choices(SETUP_AGENTS),
    )
    // Defined after --agent so the default stays undefined: neither flag given.
    .option("--no-agent", "skip agent-led setup")
    .option(
      "--print-setup-prompt",
      "print only the agent setup prompt and exit",
    )
    .action(async (_options, command: Command) => {
      const local = command.opts<{
        yes?: boolean;
        flows?: boolean;
        surface?: string;
        validate?: boolean;
        flow?: string;
        json?: boolean;
        agent?: SetupAgent | false;
        printSetupPrompt?: boolean;
      }>();
      const shared = command.optsWithGlobals<
        SharedOptions & { yes?: boolean }
      >();
      if (
        local.validate === true &&
        (local.yes === true ||
          local.flows === true ||
          local.surface !== undefined ||
          local.agent !== undefined ||
          local.printSetupPrompt === true)
      )
        throw new IdiomError(
          "--validate cannot be combined with --yes, --flows, --surface, --agent, --no-agent or --print-setup-prompt",
        );
      if (
        local.printSetupPrompt === true &&
        (local.yes === true ||
          local.flows === true ||
          local.surface !== undefined ||
          local.agent !== undefined ||
          local.flow !== undefined ||
          local.json === true)
      )
        throw new IdiomError(
          "--print-setup-prompt cannot be combined with other init options",
        );
      if (
        local.validate !== true &&
        (local.flow !== undefined || local.json === true)
      )
        throw new IdiomError("--flow and --json apply only with --validate");
      if (local.validate === true) {
        const report = await initValidate({
          project: shared.project,
          cwd: dependencies.cwd,
          flow: local.flow,
          dependencies: {
            process: dependencies.capture?.process,
            inheritedEnvironment: dependencies.capture?.inheritedEnvironment,
          },
        });
        if (local.json === true) writeOut(jsonPayload(report));
        else for (const line of renderInitValidate(report)) writeOut(line);
        const problem = initValidateProblem(report);
        if (problem !== undefined)
          throw new RunFailure({
            stage: problem.stage,
            cause: problem.cause,
            headline: problem.headline,
            hint: problem.hint,
          });
        return;
      }
      if (local.printSetupPrompt === true) {
        const facts = await collectSetupFacts(
          resolveProjectArgument(shared.project, dependencies.cwd),
        );
        writeOut(setupPrompt(facts));
        return;
      }
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
      const outcome = await offerAgentSetup({
        projectDirectory: result.projectDirectory,
        agent: local.agent,
        yes: local.yes === true,
        interactive:
          dependencies.confirm !== undefined ||
          (process.stdin.isTTY === true && process.stdout.isTTY === true),
        confirm: dependencies.confirm ?? defaultConfirmation,
        write: writeOut,
        environment: dependencies.setupAgent?.environment ?? process.env,
        probe: dependencies.setupAgent?.probe,
        launch: dependencies.setupAgent?.launch,
      });
      if (outcome.kind === "unavailable")
        throw new IdiomError(`--agent ${outcome.agent}: ${outcome.reason}`);
    });

  program
    .command("upgrade")
    .description(
      "update the Idiom CLI, then its vendored skills, keeping local customization",
    )
    .option("--no-agent", "leave overlapping edits for manual resolution")
    .option(
      "--no-self-update",
      "merge skills without updating the Idiom CLI first",
    )
    .option(
      "--dry-run",
      "report proposed changes without writing or calling a model",
    )
    .option("--json", "print a structured upgrade report")
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals<
        SharedOptions & {
          agent: boolean;
          selfUpdate: boolean;
          dryRun?: boolean;
          json?: boolean;
        }
      >();
      const cli = await selfUpdate(
        {
          project: options.project,
          cwd: dependencies.cwd,
          dryRun: options.dryRun,
          selfUpdate: options.selfUpdate,
          // Everything after `node idiom`, global options included. Commander
          // records the parsed argv as `rawArgs` but leaves it out of its types.
          args: (program as Command & { rawArgs: string[] }).rawArgs.slice(2),
          write: options.json ? undefined : writeOut,
        },
        dependencies.selfUpdate,
      );
      if (cli.kind === "failed") {
        if (options.json)
          writeOut(jsonPayload({ cli: { ...cli.cli, error: cli.message } }));
        throw new IdiomError(cli.message);
      }
      if (cli.kind === "handoff") {
        // The replaced CLI already reported; pass its exit code through.
        if (cli.exitCode !== 0)
          throw new CommanderError(
            cli.exitCode,
            "idiom.upgrade-handoff",
            "The updated Idiom CLI's upgrade did not succeed",
          );
        return;
      }
      if (!options.json) for (const line of cli.lines) writeOut(line);
      const report = await upgradeCommand(
        {
          project: options.project,
          cwd: dependencies.cwd,
          agent: options.agent,
          dryRun: options.dryRun,
        },
        dependencies.upgrade,
      );
      const briefInstruction = await offerBriefInstruction({
        projectDirectory: report.projectDirectory,
        interactive:
          options.dryRun !== true &&
          options.json !== true &&
          (dependencies.confirm !== undefined || process.stdin.isTTY === true),
        confirm: dependencies.confirm ?? defaultConfirmation,
      });
      if (options.json)
        writeOut(jsonPayload({ ...report, cli: cli.cli, briefInstruction }));
      else
        writeOut(
          [renderUpgrade(report), ...briefInstructionLines(briefInstruction)]
            .filter((text) => text !== "")
            .join("\n"),
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
      .option(
        "--isolated-registry",
        "ignore the primary checkout's finding names (throwaway worktrees)",
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
            isolatedRegistry?: boolean;
          },
          command: Command,
        ) => {
          const shared = command.optsWithGlobals<SharedOptions>();
          const result = await withFailureJson(
            options.json,
            flow,
            writeOut,
            () =>
              baselineRecordCommand({
                flow,
                out: options.out,
                project: shared.project,
                cwd: dependencies.cwd,
                prod: options.prod,
                port: options.port,
                from: options.from,
                latest: options.latest,
                isolatedRegistry: options.isolatedRegistry,
                dependencies: reviewDependencies,
              }),
          );
          writeOut(
            options.json === true
              ? jsonPayload(result)
              : renderBaselineRecord(result),
          );
          if ("findingNameWarning" in result)
            writeErr(result.findingNameWarning);
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
      "--isolated-registry",
      "ignore the primary checkout's finding names (throwaway worktrees)",
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
          isolatedRegistry?: boolean;
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
              ? jsonPayload(await withUpdate(result))
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
          isolatedRegistry: options.isolatedRegistry,
          dependencies: reviewDependencies,
        });
        if (result.findingNameWarning !== undefined)
          writeErr(result.findingNameWarning);
        writeOut(
          options.json === true
            ? jsonPayload(await withUpdate(result))
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
    .argument(
      "[flow]",
      "flow manifest id (required without --changed or --gate)",
    )
    .option(
      "--gate",
      "build gate: check only what the change affects, within a time budget; skips non-UI changes",
    )
    .option(
      "--budget <duration>",
      "with --gate: wall-clock budget such as 3m or 90s (default checks.gate.budgetMs, 3m)",
      parseDuration,
    )
    .option(
      "--reuse-server",
      "use a server already answering at server.readyUrl instead of starting one",
    )
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
      "--isolated-registry",
      "ignore the primary checkout's finding names (throwaway worktrees)",
    )
    .option(
      "--refresh-design",
      "refetch pinned Figma frames instead of reusing .idiom/designs",
    )
    .option(
      "--probe-budget <ms>",
      "run target for the interaction probe in milliseconds; 0 = no target (overrides checks.probe.flowBudgetMs for this run)",
      parseNonNegativeInt,
    )
    .action(
      async (
        flow: string | undefined,
        options: {
          changed?: true | string;
          gate?: boolean;
          budget?: number;
          reuseServer?: boolean;
          refreshDesign?: boolean;
          probeBudget?: number;
          isolatedRegistry?: boolean;
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
        const changed = options.changed;
        if (options.budget !== undefined && options.gate !== true)
          throw new IdiomError("--budget requires --gate");
        if (options.gate === true) {
          const result = await withFailureJson(
            options.json,
            flow,
            writeOut,
            () =>
              checkGate({
                ...options,
                flow,
                changed,
                project: shared.project,
                cwd: dependencies.cwd,
                probeBudgetMs: options.probeBudget,
                budgetMs: options.budget,
                reuseServer: options.reuseServer,
                scope: {
                  states: options.states,
                  viewports: options.viewports,
                  schemes: options.schemes,
                },
                onPlan: (lines) => {
                  for (const line of lines) writeErr(line);
                },
                dependencies: reviewDependencies,
              }),
          );
          if (result.skipped) {
            writeOut(
              options.json
                ? jsonPayload(
                    await withUpdate({
                      gate: {
                        skipped: true,
                        reason: result.reason,
                        base: result.base,
                        files: result.files,
                      },
                    }),
                  )
                : result.line,
            );
            return;
          }
          const output = result.changed;
          const checked = output.checks.filter(
            (entry) => entry.status === "checked",
          );
          const plan = result.plan;
          writeOut(
            options.json
              ? jsonPayload(
                  await withUpdate({
                    gate: {
                      plan,
                      skippedWork: result.skippedWork,
                      estimateMs: result.estimateMs,
                      budgetMs: result.budgetMs,
                      server: result.server,
                      timing: result.timing,
                    },
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
                  }),
                )
              : [
                  `idiom check --gate: checked ${output.checkedStates} state(s).`,
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
          if (output.findingNameWarning !== undefined)
            writeErr(output.findingNameWarning);
          for (const entry of checked)
            if (entry.summary.timing && checked.length > 1)
              writeErr(renderTimingLine(entry.summary.timing, entry.flow));
          writeErr(renderTimingLine(result.timing));
          const failing =
            options.failOn === "never"
              ? []
              : checked
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
        if (changed !== undefined) {
          const output = await withFailureJson(
            options.json,
            flow,
            writeOut,
            () =>
              checkChanged({
                ...options,
                flow,
                changed,
                project: shared.project,
                cwd: dependencies.cwd,
                probeBudgetMs: options.probeBudget,
                ...(options.reuseServer ? { reuseServer: true } : {}),
                scope: {
                  states: options.states,
                  viewports: options.viewports,
                  schemes: options.schemes,
                },
                dependencies: reviewDependencies,
              }),
          );
          const checked = output.checks.filter(
            (entry) => entry.status === "checked",
          );
          writeOut(
            options.json
              ? jsonPayload(
                  await withUpdate({
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
                  }),
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
          if (output.findingNameWarning !== undefined)
            writeErr(output.findingNameWarning);
          const timings = checked.flatMap((entry) =>
            entry.summary.timing ? [entry.summary.timing] : [],
          );
          if (timings.length > 1)
            for (const entry of checked)
              if (entry.summary.timing)
                writeErr(renderTimingLine(entry.summary.timing, entry.flow));
          if (timings.length)
            writeErr(
              renderTimingLine(
                timings.length === 1
                  ? (timings[0] as (typeof timings)[number])
                  : combineCheckTimings(
                      timings,
                      timings.reduce((sum, timing) => sum + timing.totalMs, 0),
                    ),
              ),
            );
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
            "check requires a flow unless --changed or --gate is supplied",
          );
        const summary = await withFailureJson(
          options.json,
          flow,
          writeOut,
          () =>
            checkCommand({
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
              probeBudgetMs: options.probeBudget,
              ...(options.reuseServer ? { reuseServer: true } : {}),
              emitTickets: options.emitTickets,
              advisory: options.advisory,
              isolatedRegistry: options.isolatedRegistry,
              scope: {
                states: options.states,
                viewports: options.viewports,
                schemes: options.schemes,
              },
              dependencies: reviewDependencies,
            }),
        );
        writeOut(
          options.json === true
            ? jsonPayload(await withUpdate(summary))
            : renderCheckSummary(summary, {
                ungrouped: options.ungrouped,
                top: options.top,
                all: options.all,
              }).trimEnd(),
        );
        writeErr(renderTimings(summary.timings));
        if (summary.findingNameWarning !== undefined)
          writeErr(summary.findingNameWarning);
        if (options.json !== true && summary.baseline !== undefined) {
          const warning = baselineStaleWarning(summary.baseline);
          if (warning !== undefined) writeErr(warning);
        }
        if (summary.timing !== undefined)
          writeErr(renderTimingLine(summary.timing));
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
            ? jsonPayload(summary)
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
              ? jsonPayload(states)
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
            ? jsonPayload(summary)
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
          dependencies: dependencies.verify ?? {
            capture: {
              ...dependencies.capture,
              onLeftoverServer: (message: string) => {
                dependencies.capture?.onLeftoverServer?.(message);
                writeErr(message);
              },
            },
          },
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
            ? jsonPayload(result)
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

  // `--json` and `--research` live on the parent so `idiom brief "<request>"
  // --research --json` parses, and the parent consumes them wherever they
  // appear: subcommands must read them from optsWithGlobals(), not options.
  type BriefFlags = SharedOptions & { json?: boolean; research?: boolean };
  const briefFlags = (command: Command, name: string): BriefFlags => {
    const flags = command.optsWithGlobals<BriefFlags>();
    if (flags.research === true)
      throw new IdiomError(
        `--research applies only to idiom brief "<request>" --research, not idiom brief ${name}`,
      );
    return flags;
  };
  const brief = program
    .command("brief")
    .description(
      "before a UI ticket: triage the design decision, plan the research, record the brief, ask, and decide",
    )
    .argument("[request]", "the request text, or a path to a draft ticket")
    .option(
      "--research",
      "triage, research and draft options through the configured review provider, then store the brief",
    )
    .option("--json", "with --research, print the outcome as JSON")
    .action(async (request: string | undefined, _options, command: Command) => {
      if (request === undefined) {
        command.help({ error: true });
        return;
      }
      const flags = command.optsWithGlobals<BriefFlags>();
      if (flags.research !== true)
        throw new IdiomError(
          "pass --research to run research through your review provider, or use idiom brief triage",
        );
      const result = await briefResearchCommand({
        project: flags.project,
        cwd: dependencies.cwd,
        request,
        onFallback: (fallback) =>
          writeErr(
            `Warning: brief research used fallback provider ${fallback.to} after ${fallback.from} failed: ${fallback.reason}`,
          ),
        onProgress: (message) => writeErr(message),
        dependencies: dependencies.brief,
      });
      writeOut(renderBriefResearch(result, flags.json === true));
    });

  brief
    .command("triage")
    .description(
      "say whether a request or draft ticket holds a design decision, and which questions it leaves open",
    )
    .argument("<request>", "the request text, or a path to a draft ticket")
    .option("--json", "print { id, verdict, reason, questions } as JSON")
    .option(
      "--no-model",
      "print the rubric and answer shape for the calling agent to apply",
    )
    .action(
      async (
        request: string,
        options: { model?: boolean },
        command: Command,
      ) => {
        const shared = briefFlags(command, "triage");
        writeOut(
          await briefTriageCommand({
            project: shared.project,
            cwd: dependencies.cwd,
            request,
            json: shared.json,
            noModel: options.model === false,
            onFallback: (fallback) =>
              writeErr(
                `Warning: triage used fallback provider ${fallback.to} after ${fallback.from} failed: ${fallback.reason}`,
              ),
            dependencies: dependencies.brief,
          }),
        );
      },
    );

  brief
    .command("gate")
    .description(
      "warn when a ticket holds a design decision without a decided brief (exit 0 unless --strict)",
    )
    .argument("<tickets...>", "ticket Markdown files to check")
    .option("--strict", "exit 1 when any ticket needs a decided brief")
    .option("--json", "print { strict, warnings, tickets } as JSON")
    .action(
      async (
        tickets: string[],
        options: { strict?: boolean },
        command: Command,
      ) => {
        const shared = briefFlags(command, "gate");
        const result = await briefGateCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          tickets,
          strict: options.strict,
          onFallback: (fallback) =>
            writeErr(
              `Warning: triage used fallback provider ${fallback.to} after ${fallback.from} failed: ${fallback.reason}`,
            ),
          dependencies: dependencies.brief,
        });
        if (shared.json === true) writeOut(jsonPayload(gateJson(result)));
        else {
          const rendered = renderGate(result);
          if (rendered !== "") writeOut(rendered);
        }
        if (options.strict === true && result.warnings > 0)
          throw new IdiomError(
            `brief gate: ${result.warnings} ticket(s) need a decided brief`,
          );
      },
    );

  brief
    .command("plan")
    .description(
      "print research instructions for the calling agent: questions, references, checks, standards, budget and the record shape",
    )
    .argument(
      "<target>",
      "a triage id from idiom brief triage, the request text, or a path to a draft ticket",
    )
    .option(
      "--question <text>",
      "an open question to research (repeatable; skips the model triage)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--minutes <n>", "research time budget in minutes (default 10)")
    .option("--json", "print the plan as JSON")
    .action(
      async (
        target: string,
        options: { question?: string[]; minutes?: string },
        command: Command,
      ) => {
        const shared = briefFlags(command, "plan");
        writeOut(
          await briefPlanCommand({
            project: shared.project,
            cwd: dependencies.cwd,
            target,
            questions: options.question,
            minutes:
              options.minutes === undefined
                ? undefined
                : Number(options.minutes),
            json: shared.json,
            onFallback: (fallback) =>
              writeErr(
                `Warning: triage used fallback provider ${fallback.to} after ${fallback.from} failed: ${fallback.reason}`,
              ),
            dependencies: dependencies.brief,
          }),
        );
      },
    );

  brief
    .command("record")
    .description(
      "validate an agent's research and options, store the decision brief, and print the question to ask",
    )
    .argument("[file]", "brief input JSON; omit or pass - to read stdin")
    .option("--json", "print { slug, outcome, status, markdownPath, ask }")
    .action(async (file: string | undefined, _options, command: Command) => {
      const shared = briefFlags(command, "record");
      const recorded = await briefRecordCommand({
        project: shared.project,
        cwd: dependencies.cwd,
        file,
        dependencies: dependencies.brief,
      });
      if (shared.json === true) {
        writeOut(jsonPayload(briefRecordJson(recorded)));
        return;
      }
      writeOut(
        [
          `Recorded brief ${recorded.slug} (${recorded.outcome}, ${recorded.brief.status}) — ${recorded.markdownRelative}`,
          ...(recorded.ask === undefined
            ? recorded.brief.decidedBy === undefined
              ? []
              : [`Decided by ${recorded.brief.decidedBy}`]
            : ["", renderAsk(recorded.ask, recorded.slug)]),
        ].join("\n"),
      );
    });

  brief
    .command("decide")
    .description(
      "record the requester's choice and regenerate the ticket-ready brief",
    )
    .argument("<slug>", "brief name from idiom brief list")
    .requiredOption("--option <id>", "the chosen option id")
    .option("--by <name>", "who decided (default requester)")
    .option("--json", "print the decision as JSON")
    .action(
      async (
        slug: string,
        options: { option: string; by?: string },
        command: Command,
      ) => {
        const shared = briefFlags(command, "decide");
        const decided = await briefDecideCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          slug,
          option: options.option,
          by: options.by,
          dependencies: dependencies.brief,
        });
        writeOut(
          shared.json === true
            ? jsonPayload(briefDecideJson(decided))
            : renderBriefDecide(decided),
        );
      },
    );

  brief
    .command("list")
    .description("list stored decision briefs, newest first")
    .option("--json", "print the stored briefs as JSON")
    .action(async (_options, command: Command) => {
      const shared = briefFlags(command, "list");
      const entries = await briefListCommand({
        project: shared.project,
        cwd: dependencies.cwd,
      });
      writeOut(
        shared.json === true
          ? // The one --json payload that is a bare array, so it carries no
            // interfaceVersion; docs/stability.md lists it as the exception.
            JSON.stringify(
              entries.map((entry) => ("error" in entry ? entry : entry.brief)),
              null,
              2,
            )
          : renderBriefList(entries),
      );
    });

  brief
    .command("show")
    .description("print one stored decision brief")
    .argument("<slug>", "brief name from idiom brief list")
    .option("--json", "print the stored record as JSON")
    .action(async (slug: string, _options, command: Command) => {
      const shared = briefFlags(command, "show");
      writeOut(
        await briefShowCommand({
          project: shared.project,
          cwd: dependencies.cwd,
          slug,
          json: shared.json,
        }),
      );
    });

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
    .option(
      "--state <state>",
      "the flow state the miss was seen on (required unless --from-brief names one)",
    )
    .option("--flow <id>", "the flow, when several declare the state")
    .option("--from-brief <slug>", "the decided brief this rejection is about")
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
          state?: string;
          flow?: string;
          fromBrief?: string;
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
          fromBrief: options.fromBrief,
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
        const blocked = result.outcomes.filter(
          (outcome) => outcome.kind === "blocked",
        ).length;
        writeOut(
          `Tickets: ${created} created, ${existing} already emitted, ${resolved} already resolved, ${conflicts} conflict(s), ${blocked > 0 ? `${blocked} blocked, ` : ""}${result.ineligible.length} ineligible — ${result.outputDirectory}`,
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
          else if (outcome.kind === "blocked")
            writeOut(
              `${outcome.findingId}: blocked by malformed tracker ticket — ${outcome.paths.join(", ")}`,
            );
          else
            writeOut(
              `${outcome.findingId}: tracker conflict — ${outcome.paths.join(", ")}`,
            );
        }
        for (const findingId of result.ineligible)
          writeOut(`${findingId}: not accepted; no ticket emitted`);
        for (const ticket of result.malformed)
          writeOut(`malformed tracker ticket: ${ticket.error}`);
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
    .command("doctor")
    .description(
      "boot the application server once and diagnose why a run could not start",
    )
    .argument("[flow]", "flow manifest id")
    .option(
      "--port <port>",
      "serve the application on this port instead of a free one",
      parsePortOption,
    )
    .option("--json", "print the machine-readable report")
    .action(
      async (
        flow: string | undefined,
        options: { port?: number; json?: boolean },
        command: Command,
      ) => {
        const shared = command.optsWithGlobals<SharedOptions>();
        const report = await runDoctor({
          flow,
          project: shared.project,
          cwd: dependencies.cwd,
          port: options.port,
          dependencies: {
            process: dependencies.capture?.process,
            inheritedEnvironment: dependencies.capture?.inheritedEnvironment,
            // The human report prints these lines itself; --json keeps
            // stdout to the payload, so they go to stderr.
            ...(options.json === true
              ? { onLeftoverServer: (message: string) => writeErr(message) }
              : {}),
          },
        });
        writeOut(
          options.json === true
            ? jsonPayload(await withUpdate(report))
            : renderDoctorReport(report).trimEnd(),
        );
        if (report.failure !== undefined) {
          const step = report.steps.find((entry) => entry.status === "fail");
          throw new RunFailure({
            stage: report.failure.stage,
            cause: report.failure.cause,
            headline: report.failure.message,
            hint: report.failure.hint,
            detail: `idiom doctor: the ${step?.id ?? "first"} step failed`,
          });
        }
      },
    );

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

  applyHelp(program);
  return program;
}

export async function run(
  argv: string[] = process.argv,
  dependencies: ProgramDependencies = {},
): Promise<number> {
  const notices = createUpdateNotices(dependencies);
  const program = createProgram(dependencies, notices);
  program.exitOverride();
  for (const command of program.commands) command.exitOverride();
  const writeErr = lineWriter(
    dependencies.stderr ?? ((message) => process.stderr.write(message)),
  );
  let exitCode: number;
  try {
    try {
      await program.parseAsync(argv);
      exitCode = EXIT_CODES.ok;
    } catch (error) {
      if (error instanceof RunFailure) {
        // The headline is the first line a wrapper or CI log reads.
        writeErr(error.message);
        writeErr(`Fix: ${error.hint}`);
        exitCode = RUN_FAILURE_EXIT_CODE;
      } else if (error instanceof IdiomError) {
        writeErr(`Error: ${error.message}`);
        exitCode = EXIT_CODES.failed;
      } else if (error instanceof CommanderError) {
        if (error.code === "commander.version") notices.start(undefined, false);
        exitCode = error.exitCode;
      } else throw error;
    }
    // After all normal output, including a failure's Fix: line.
    await notices.finish(writeErr);
  } finally {
    // An unexpected throw or --json run leaves no cache write running.
    await notices.settled();
  }
  return exitCode;
}
