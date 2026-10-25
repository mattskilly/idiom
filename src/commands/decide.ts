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

export type PromptedDecision =
  | { action: "accept"; reason?: string | undefined }
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

function defaultPrompt(write: (message: string) => void): DecisionPrompt {
  return async (record) => {
    write(promptHeader(record));
    const readline = createInterface({ input: stdin, output: stdout });
    try {
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
  scope?: "instance" | "rule" | undefined;
  reason?: string | undefined;
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
    if (Boolean(options.accept) === Boolean(options.reject))
      throw new IdiomError("provide exactly one of --accept or --reject");
    const reason = trimmedReason(options.reason);
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
    await persistCatalogFindingNames(catalog);
    const result = await appendDecision({
      projectDirectory: catalog.projectDirectory,
      finding: { ...record.finding, id: lineage.id },
      decision: options.accept ? "accept" : "reject",
      scope: options.accept ? "instance" : (options.scope ?? "instance"),
      ...(reason === undefined ? {} : { reason }),
      now: options.dependencies?.now,
    });
    path = result.path;
    if (options.accept) accepted += 1;
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
    await persistCatalogFindingNames(catalog);
    const result = await appendDecision({
      projectDirectory: catalog.projectDirectory,
      finding: { ...record.finding, id: lineage.id },
      decision: response.action,
      scope: response.action === "reject" ? response.scope : "instance",
      ...(reason === undefined || reason === "" ? {} : { reason }),
      now: options.dependencies?.now,
    });
    path = result.path;
    if (response.action === "accept") accepted += 1;
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
