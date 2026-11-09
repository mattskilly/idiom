import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { readGit } from "../changed/git.js";
import {
  latestAcknowledgement,
  parseUntil,
} from "../decisions/acknowledgements.js";
import {
  type Actor,
  type ActorDependencies,
  resolveActor,
} from "../decisions/actor.js";
import {
  acknowledgements as acknowledgementEntries,
  appendAcknowledgement,
  appendDecision,
  appendRulingDecision,
  decisionLogPath,
  judgments,
  readDecisionLogEntries,
} from "../decisions/log.js";
import { pendingDecisions } from "../decisions/pending.js";
import { decisionQuestion } from "../decisions/question.js";
import { reattributeDecisions } from "../decisions/reattribute.js";
import { IdiomError } from "../errors.js";
import { acceptanceText } from "../findings/presentation.js";
import { findProjectDirectory, resolveProjectArgument } from "../project.js";
import {
  type CatalogFinding,
  findCatalogFinding,
  findCatalogLineage,
  loadReviewCatalog,
  newestOpenFindings,
  persistCatalogFindingNames,
} from "../review/catalog.js";
import { type FindingGroup, readGroups } from "../review/groups.js";
import {
  type FindingLifecycle,
  reduceLifecycles,
  renderLifecycleList,
} from "../review/lifecycle.js";
import { type RulingAnswer, rulingAnswer } from "../rulings/answer.js";
import { readEffectiveLaw } from "../rulings/effective.js";
import { lookupUnruledDecision } from "../rulings/lookup.js";
import type { Decision } from "../schemas/decision.js";
import type { Finding } from "../schemas/finding.js";
import type { PendingDecision } from "../schemas/pending-decision.js";
import { loadProjectContext } from "../validation.js";

export type PromptedDecision =
  | { action: "accept"; reason?: string | undefined }
  | { action: "choose"; reference: string; reason?: string | undefined }
  | {
      action: "reject";
      scope: "instance" | "rule";
      reason?: string | undefined;
    }
  | { action: "skip" }
  | { action: "quit" };

export type DecisionPrompt = (
  record: CatalogFinding,
) => Promise<PromptedDecision>;

export type DecideDependencies = {
  actor?: ActorDependencies | undefined;
  prompt?: DecisionPrompt | undefined;
  now?: (() => Date) | undefined;
};

export type DecideResult = {
  projectDirectory: string;
  path: string;
  corrected?: number | undefined;
  accepted: number;
  rejected: number;
  skipped: number;
  /** Set by --ack / --unack only. */
  acknowledged?: number | undefined;
  unacknowledged?: number | undefined;
  /** The acknowledgement --ack wrote or --unack removed. */
  acknowledgement?:
    | { findingId: string; reference: string; until?: string | undefined }
    | undefined;
  decisionNeeded?: PendingDecision[] | undefined;
  decisionQuestion?: string | undefined;
  listed?: boolean | undefined;
  /** Set by --list: every lineage's lifecycle. */
  lifecycles?: FindingLifecycle[] | undefined;
};

function trimmedReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const value = reason.trim();
  if (value === "") throw new IdiomError("--reason must not be blank");
  return value;
}

export function promptHeader(record: CatalogFinding): string {
  const finding = record.finding;
  return [
    `\n${finding.id} — ${finding.category} (${finding.severity})`,
    finding.explanation,
    `Surface: ${finding.flow} / ${finding.state} / ${finding.viewport}${finding.colorScheme === undefined ? "" : ` / ${finding.colorScheme}`}`,
    "Acceptance:",
    ...acceptanceText(finding).map((criterion) => `- ${criterion}`),
  ].join("\n");
}

/** The `designChoice` a `--choose` records, or an error for anything but a design decision. */
export function designChoiceFor(
  finding: Finding,
  reference: string,
): NonNullable<Decision["designChoice"]> {
  const decision = finding.evidence.designDrift?.designDecision;
  if (finding.rule !== "idiom:design-decision" || !decision)
    throw new IdiomError(
      `--choose applies only to design decisions (idiom:design-decision); ${finding.id} is ${finding.rule ?? finding.category}`,
    );
  const names = decision.references.map((r) => r.name);
  if (!names.includes(reference))
    throw new IdiomError(
      `unknown design reference ${JSON.stringify(reference)} for ${finding.id}; choose one of ${names.join(", ")}`,
    );
  return {
    flow: finding.flow,
    state: finding.state,
    ...(finding.colorScheme === undefined
      ? {}
      : { colorScheme: finding.colorScheme }),
    decisionKey: decision.decisionKey,
    reference,
  };
}

function defaultPrompt(write: (message: string) => void): DecisionPrompt {
  return async (record) => {
    write(promptHeader(record));
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      const decision = record.finding.evidence.designDrift?.designDecision;
      if (record.finding.rule === "idiom:design-decision" && decision) {
        const names = decision.references.map((r) => r.name);
        let answer: string;
        do {
          answer = (
            await readline.question(
              `Choose a reference (${names.join(", ")}), skip, or quit? `,
            )
          ).trim();
        } while (![...names, "s", "skip", "q", "quit"].includes(answer));
        if (answer === "s" || answer === "skip") return { action: "skip" };
        if (answer === "q" || answer === "quit") return { action: "quit" };
        const reasonInput = (
          await readline.question("Reason (optional): ")
        ).trim();
        return {
          action: "choose",
          reference: answer,
          ...(reasonInput === "" ? {} : { reason: reasonInput }),
        };
      }
      let action: string;
      do {
        action = (
          await readline.question("Accept, reject, skip, or quit? [a/r/s/q] ")
        )
          .trim()
          .toLowerCase();
      } while (
        !new Set(["a", "accept", "r", "reject", "s", "skip", "q", "quit"]).has(
          action,
        )
      );
      if (action === "s" || action === "skip") return { action: "skip" };
      if (action === "q" || action === "quit") return { action: "quit" };
      const reasonInput = (
        await readline.question("Reason (optional): ")
      ).trim();
      const reason = reasonInput === "" ? undefined : reasonInput;
      if (action === "a" || action === "accept")
        return {
          action: "accept",
          ...(reason === undefined ? {} : { reason }),
        };
      let scope: string;
      do {
        scope = (
          await readline.question(
            "Reject this instance or the rule? [instance/rule] ",
          )
        )
          .trim()
          .toLowerCase();
        if (scope === "") scope = "instance";
      } while (scope !== "instance" && scope !== "rule");
      return {
        action: "reject",
        scope,
        ...(reason === undefined ? {} : { reason }),
      };
    } finally {
      readline.close();
    }
  };
}

/** The group in the newest run that recorded it. */
async function findGroup(
  runs: Array<{ runDirectory: string }>,
  id: string,
): Promise<FindingGroup> {
  for (const run of [...runs].reverse()) {
    const group = (await readGroups(run.runDirectory))?.find(
      (candidate) => candidate.id === id,
    );
    if (group !== undefined) return group;
  }
  throw new IdiomError(`unknown group id ${JSON.stringify(id)}`);
}

export async function decideCommand(
  options: RulingAnswer & {
    actor?: Actor | undefined;
    source?: "cli" | "mcp" | undefined;
    reattribute?: string | undefined;
    pending?: boolean | undefined;
    decision?: string | undefined;
    build?: string | undefined;
    escalation?: string | undefined;
    project?: string | undefined;
    cwd?: string | undefined;
    finding?: string | undefined;
    /** A finding group (#52): one decision per member. */
    group?: string | undefined;
    accept?: boolean | undefined;
    reject?: boolean | undefined;
    /** A design decision's chosen reference; recorded as an accept with designChoice. */
    choose?: string | undefined;
    scope?: "instance" | "rule" | undefined;
    reason?: string | undefined;
    /** Internal adapter option: validate without normalizing human text. */
    preserveReason?: boolean | undefined;
    list?: boolean | undefined;
    /** With --list: the caller prints the lifecycles as JSON instead. */
    json?: boolean | undefined;
    /** Acknowledge the finding as tracked elsewhere under this reference. */
    ack?: string | undefined;
    /** Remove the finding's acknowledgement. */
    unack?: boolean | undefined;
    /** --ack only: free text recorded with the acknowledgement. */
    note?: string | undefined;
    /** --ack only: the last day (YYYY-MM-DD, inclusive) it holds. */
    until?: string | undefined;
    dependencies?: DecideDependencies | undefined;
    write?: ((message: string) => void) | undefined;
  },
): Promise<DecideResult> {
  const rulingFlags = [
    options.candidate,
    options.wording,
    options.noRule,
    options.addStep,
    options.token,
    options.drift,
  ].some((value) => value !== undefined);
  const attributionFor = (projectDirectory: string) =>
    resolveActor({
      actor: options.actor,
      source: options.source,
      cwd: options.cwd,
      projectDirectory,
      dependencies: options.dependencies?.actor,
    });
  if (options.reattribute !== undefined) {
    if (
      [
        options.finding,
        options.group,
        options.accept,
        options.reject,
        options.choose,
        options.scope,
        options.pending,
        options.list,
        options.decision,
        options.build,
        options.escalation,
        options.reason,
        options.ack,
        options.unack,
        options.until,
      ].some((value) => value !== undefined) ||
      rulingFlags
    )
      throw new IdiomError(
        "--reattribute cannot be combined with other decision modes or answer flags",
      );
    if (!options.actor)
      throw new IdiomError("--reattribute requires an explicit --actor");
    if (!options.note?.trim())
      throw new IdiomError("--reattribute requires a nonblank --note");
    const projectDirectory = await findProjectDirectory(
      resolveProjectArgument(options.project, options.cwd),
    );
    const result = await reattributeDecisions({
      projectDirectory,
      range: options.reattribute,
      actor: options.actor,
      note: options.note,
      now: options.dependencies?.now,
    });
    return {
      ...result,
      projectDirectory,
      accepted: 0,
      rejected: 0,
      skipped: 0,
    };
  }
  if (options.escalation !== undefined && !options.build?.trim())
    throw new IdiomError("--escalation requires --build");
  if (options.build !== undefined && !options.build.trim())
    throw new IdiomError("--build must not be blank");
  if (options.escalation !== undefined && !options.escalation.trim())
    throw new IdiomError("--escalation must not be blank");
  const provenance = options.build
    ? {
        build: options.build,
        ...(options.escalation ? { escalation: options.escalation } : {}),
      }
    : undefined;
  const otherMode = [
    options.finding,
    options.group,
    options.accept,
    options.reject,
    options.choose,
    options.scope,
    options.ack,
    options.unack,
    options.note,
    options.until,
  ].some((value) => value !== undefined);
  if (options.pending) {
    if (
      otherMode ||
      rulingFlags ||
      options.decision ||
      options.list ||
      options.reason !== undefined ||
      provenance
    )
      throw new IdiomError(
        "--pending is read-only and cannot be combined with other decision modes",
      );
    const context = await loadProjectContext(options);
    const decisionNeeded = await pendingDecisions(options);
    const text = decisionQuestion(decisionNeeded);
    if (!options.json) options.write?.(text || "No pending decisions.");
    return {
      projectDirectory: context.projectDirectory,
      path: decisionLogPath(context.projectDirectory),
      accepted: 0,
      rejected: 0,
      skipped: 0,
      listed: true,
      decisionNeeded,
      decisionQuestion: text,
    };
  }
  if (options.decision !== undefined) {
    if (otherMode || options.list)
      throw new IdiomError(
        "--decision cannot be combined with finding, group or listing modes",
      );
    const reason = trimmedReason(options.reason);
    if (!reason)
      throw new IdiomError(
        "ruling answers require an explicit nonblank --reason",
      );
    const context = await loadProjectContext(options);
    const designPath = join(
      context.projectDirectory,
      context.project.design.designFile,
    );
    const decision = await lookupUnruledDecision({
      projectDirectory: context.projectDirectory,
      designPath,
      id: options.decision,
      allowResolved: true,
    });
    const at = (options.dependencies?.now?.() ?? new Date()).toISOString();
    const resolution = rulingAnswer(decision, options, at);
    const law = await readEffectiveLaw(designPath, context.projectDirectory);
    const entries = await readDecisionLogEntries(context.projectDirectory);
    const retry =
      provenance?.escalation &&
      entries.some(
        (entry) =>
          entry.decision === "ruling" &&
          entry.fingerprint === decision.fingerprint &&
          entry.provenance?.build === provenance.build &&
          entry.provenance?.escalation === provenance.escalation,
      );
    if (
      !retry &&
      law.resolutions.some((r) => r.fingerprint === decision.fingerprint)
    )
      throw new IdiomError(
        `ruling ${decision.id} has already been recorded in the design law`,
      );
    let commit = "unknown";
    try {
      commit = (
        await readGit(context.projectDirectory, ["rev-parse", "HEAD"])
      ).trim();
    } catch {
      /* A project need not be a Git checkout. */
    }
    const attribution = await attributionFor(context.projectDirectory);
    const path = await appendRulingDecision(context.projectDirectory, {
      at,
      commit,
      findingId: decision.id,
      fingerprint: decision.fingerprint,
      decision: "ruling",
      ...attribution,
      reason,
      resolution,
      ...(provenance ? { provenance } : {}),
    });
    return {
      projectDirectory: context.projectDirectory,
      path,
      accepted: 0,
      rejected: 0,
      skipped: 0,
    };
  }
  if (rulingFlags)
    throw new IdiomError("ruling answer flags require --decision");
  if (provenance && options.choose === undefined)
    throw new IdiomError(
      "--build and --escalation require --choose or --decision",
    );
  if (provenance && !trimmedReason(options.reason))
    throw new IdiomError(
      "external answers require an explicit nonblank --reason",
    );
  const catalog = await loadReviewCatalog(options);
  const attribution = await attributionFor(catalog.projectDirectory);
  const entries = await readDecisionLogEntries(catalog.projectDirectory);
  const decisions = judgments(entries);
  const acknowledgementMode =
    options.ack !== undefined ||
    options.unack === true ||
    options.note !== undefined ||
    options.until !== undefined;
  const flagMode =
    options.finding !== undefined ||
    options.group !== undefined ||
    options.accept !== undefined ||
    options.reject !== undefined ||
    options.choose !== undefined ||
    options.scope !== undefined ||
    options.reason !== undefined;
  let accepted = 0;
  let rejected = 0;
  let skipped = 0;
  let path = decisionLogPath(catalog.projectDirectory);

  if (options.list === true) {
    if (flagMode || acknowledgementMode)
      throw new IdiomError(
        "--list cannot be combined with --finding, --group, --accept, --reject, --scope, --reason, --ack, --unack, --note, or --until",
      );
    const lifecycles = await reduceLifecycles({
      catalog,
      decisions,
      acknowledgements: acknowledgementEntries(entries),
      introductions: true,
      now: options.dependencies?.now?.() ?? new Date(),
    });
    if (options.json !== true)
      (options.write ?? (() => undefined))(renderLifecycleList(lifecycles));
    return {
      projectDirectory: catalog.projectDirectory,
      path,
      accepted,
      rejected,
      skipped,
      listed: true,
      lifecycles,
    };
  }

  if (acknowledgementMode) {
    const now = options.dependencies?.now?.() ?? new Date();
    if (options.ack !== undefined && options.unack === true)
      throw new IdiomError("provide only one of --ack or --unack");
    if (options.ack === undefined && options.unack !== true)
      throw new IdiomError(
        options.note !== undefined
          ? "--note applies only to --ack"
          : "--until applies only to --ack",
      );
    const flag = options.ack !== undefined ? "--ack" : "--unack";
    if (
      options.accept !== undefined ||
      options.reject !== undefined ||
      options.choose !== undefined
    )
      throw new IdiomError(
        `${flag} records no judgment; it cannot be combined with --accept, --reject or --choose`,
      );
    if (options.scope !== undefined)
      throw new IdiomError(
        `${flag} applies to one finding; --scope does not apply`,
      );
    if (options.reason !== undefined)
      throw new IdiomError(
        options.ack !== undefined
          ? "--ack records a note with --note, not --reason"
          : "--unack takes no --reason",
      );
    if (options.group !== undefined)
      throw new IdiomError(`${flag} applies to one --finding, not a --group`);
    if (options.unack === true && options.note !== undefined)
      throw new IdiomError("--note applies only to --ack");
    if (options.unack === true && options.until !== undefined)
      throw new IdiomError("--until applies only to --ack");
    if (options.finding === undefined)
      throw new IdiomError(`${flag} requires a finding id`);
    let note: string | undefined;
    if (options.note !== undefined) {
      if (options.note.trim() === "")
        throw new IdiomError("--note must not be blank");
      // MCP records the human's reason verbatim, as it does for judgments.
      note = options.preserveReason ? options.note : options.note.trim();
    }
    let reference: string | undefined;
    if (options.ack !== undefined) {
      reference = options.ack.trim();
      if (reference === "") throw new IdiomError("--ack needs a reference");
      if (/[\r\n]/.test(reference))
        throw new IdiomError("--ack reference must be a single line");
      if (reference.length > 500)
        throw new IdiomError("--ack reference must be at most 500 characters");
    }
    const until =
      options.until === undefined ? undefined : parseUntil(options.until, now);
    const lineage = findCatalogLineage(catalog, options.finding);
    const latest = lineage.latest.finding;
    if (reference === undefined) {
      const current = latestAcknowledgement(
        lineage,
        acknowledgementEntries(entries),
      );
      if (current?.decision !== "acknowledge")
        throw new IdiomError(`${lineage.id} has no acknowledgement to remove`);
      await persistCatalogFindingNames(catalog);
      const result = await appendAcknowledgement({
        attribution,
        projectDirectory: catalog.projectDirectory,
        finding: { ...latest, id: lineage.id },
        kind: "unacknowledge",
        reference: current.reference,
        now: options.dependencies?.now,
      });
      return {
        projectDirectory: catalog.projectDirectory,
        path: result.path,
        accepted,
        rejected,
        skipped,
        unacknowledged: 1,
        acknowledgement: {
          findingId: lineage.id,
          reference: current.reference,
        },
      };
    }
    await persistCatalogFindingNames(catalog);
    const result = await appendAcknowledgement({
      attribution,
      projectDirectory: catalog.projectDirectory,
      finding: { ...latest, id: lineage.id },
      kind: "acknowledge",
      reference,
      ...(until === undefined ? {} : { until }),
      ...(note === undefined ? {} : { note }),
      evidence: {
        severity: latest.severity,
        ...(latest.rule === undefined ? {} : { rule: latest.rule }),
        category: latest.category,
      },
      now: options.dependencies?.now,
    });
    return {
      projectDirectory: catalog.projectDirectory,
      path: result.path,
      accepted,
      rejected,
      skipped,
      acknowledged: 1,
      acknowledgement: {
        findingId: lineage.id,
        reference,
        ...(until === undefined ? {} : { until }),
      },
    };
  }

  if (flagMode) {
    if (options.finding !== undefined && options.group !== undefined)
      throw new IdiomError("provide only one of --finding or --group");
    if (options.finding === undefined && options.group === undefined)
      throw new IdiomError(
        "non-interactive decisions require --finding <id> or --group <id>",
      );
    if (
      [options.accept, options.reject, options.choose !== undefined].filter(
        Boolean,
      ).length !== 1
    )
      throw new IdiomError(
        "provide exactly one of --accept, --reject or --choose",
      );
    if (options.choose !== undefined && options.group !== undefined)
      throw new IdiomError("--choose applies to one --finding, not a --group");
    if (options.choose !== undefined && options.scope !== undefined)
      throw new IdiomError("--scope applies only to --reject");
    const normalizedReason = trimmedReason(options.reason);
    const reason = options.preserveReason ? options.reason : normalizedReason;
    if (options.accept && options.scope !== undefined)
      throw new IdiomError("--scope applies only to --reject");
    if (options.group !== undefined) {
      const group = await findGroup(catalog.runs, options.group);
      await persistCatalogFindingNames(catalog);
      for (const member of group.members) {
        const lineage = catalog.lineages.find((candidate) =>
          candidate.ids.includes(member.id),
        );
        // Members past the review cap are in no findings.json; their
        // registry id and fingerprint are what suppression matches on.
        const result = await appendDecision({
          attribution,
          projectDirectory: catalog.projectDirectory,
          finding:
            lineage === undefined
              ? member
              : {
                  ...findCatalogLineage(catalog, member.id).latest.finding,
                  id: lineage.id,
                },
          decision: options.accept ? "accept" : "reject",
          scope: options.accept ? "instance" : (options.scope ?? "instance"),
          ...(reason === undefined ? {} : { reason }),
          now: options.dependencies?.now,
        });
        path = result.path;
        if (options.accept) accepted += 1;
        else rejected += 1;
      }
      return {
        projectDirectory: catalog.projectDirectory,
        path,
        accepted,
        rejected,
        skipped,
      };
    }
    if (options.finding === undefined)
      throw new IdiomError("non-interactive decisions require --finding <id>");
    const record = findCatalogFinding(catalog, options.finding);
    const lineage = findCatalogLineage(catalog, options.finding);
    const designChoice =
      options.choose === undefined
        ? undefined
        : designChoiceFor(record.finding, options.choose);
    await persistCatalogFindingNames(catalog);
    const result = await appendDecision({
      attribution,
      projectDirectory: catalog.projectDirectory,
      finding: { ...record.finding, id: lineage.id },
      decision: options.reject ? "reject" : "accept",
      scope: options.reject ? (options.scope ?? "instance") : "instance",
      ...(reason === undefined ? {} : { reason }),
      ...(designChoice === undefined ? {} : { designChoice }),
      ...(provenance ? { provenance } : {}),
      now: options.dependencies?.now,
    });
    path = result.path;
    if (!options.reject) accepted += 1;
    else rejected += 1;
    return {
      projectDirectory: catalog.projectDirectory,
      path,
      accepted,
      rejected,
      skipped,
    };
  }

  const prompt =
    options.dependencies?.prompt ??
    defaultPrompt(options.write ?? (() => undefined));
  for (const record of newestOpenFindings(catalog, decisions)) {
    const lineage = findCatalogLineage(catalog, record.finding.id);
    const presentation = {
      ...record,
      finding: {
        ...record.finding,
        id: lineage.id,
        ...(lineage.ids.filter((id) => id !== lineage.id).length === 0
          ? {}
          : { idAliases: lineage.ids.filter((id) => id !== lineage.id) }),
      },
    };
    const response = await prompt(presentation);
    if (response.action === "quit") break;
    if (response.action === "skip") {
      skipped += 1;
      continue;
    }
    const reason = response.reason?.trim();
    const designChoice =
      response.action === "choose"
        ? designChoiceFor(record.finding, response.reference)
        : undefined;
    await persistCatalogFindingNames(catalog);
    const result = await appendDecision({
      attribution,
      projectDirectory: catalog.projectDirectory,
      finding: { ...record.finding, id: lineage.id },
      decision: response.action === "reject" ? "reject" : "accept",
      scope: response.action === "reject" ? response.scope : "instance",
      ...(reason === undefined || reason === "" ? {} : { reason }),
      ...(designChoice === undefined ? {} : { designChoice }),
      ...(provenance ? { provenance } : {}),
      now: options.dependencies?.now,
    });
    path = result.path;
    if (response.action !== "reject") accepted += 1;
    else rejected += 1;
  }
  return {
    projectDirectory: catalog.projectDirectory,
    path,
    accepted,
    rejected,
    skipped,
  };
}
