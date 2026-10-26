import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  appendDecision,
  decisionLogPath,
  readDecisionLog,
} from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import {
  type CatalogFinding,
  findCatalogFinding,
  findCatalogLineage,
  loadReviewCatalog,
  newestOpenFindings,
  persistCatalogFindingNames,
} from "../review/catalog.js";
import { type FindingGroup, readGroups } from "../review/groups.js";
import { reduceLifecycles, renderLifecycleList } from "../review/lifecycle.js";
import type { Decision } from "../schemas/decision.js";
import type { Finding } from "../schemas/finding.js";

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
  prompt?: DecisionPrompt | undefined;
  now?: (() => Date) | undefined;
};

export type DecideResult = {
  projectDirectory: string;
  path: string;
  accepted: number;
  rejected: number;
  skipped: number;
  listed?: boolean | undefined;
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
    ...finding.acceptance.map((criterion) => `- ${criterion}`),
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

export async function decideCommand(options: {
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
  dependencies?: DecideDependencies | undefined;
  write?: ((message: string) => void) | undefined;
}): Promise<DecideResult> {
  const catalog = await loadReviewCatalog(options);
  const decisions = await readDecisionLog(catalog.projectDirectory);
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
    if (flagMode)
      throw new IdiomError(
        "--list cannot be combined with --finding, --group, --accept, --reject, --scope, or --reason",
      );
    const lifecycles = await reduceLifecycles({ catalog, decisions });
    (options.write ?? (() => undefined))(renderLifecycleList(lifecycles));
    return {
      projectDirectory: catalog.projectDirectory,
      path,
      accepted,
      rejected,
      skipped,
      listed: true,
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
      projectDirectory: catalog.projectDirectory,
      finding: { ...record.finding, id: lineage.id },
      decision: options.reject ? "reject" : "accept",
      scope: options.reject ? (options.scope ?? "instance") : "instance",
      ...(reason === undefined ? {} : { reason }),
      ...(designChoice === undefined ? {} : { designChoice }),
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
      projectDirectory: catalog.projectDirectory,
      finding: { ...record.finding, id: lineage.id },
      decision: response.action === "reject" ? "reject" : "accept",
      scope: response.action === "reject" ? response.scope : "instance",
      ...(reason === undefined || reason === "" ? {} : { reason }),
      ...(designChoice === undefined ? {} : { designChoice }),
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
