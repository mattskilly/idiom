import { type GitRead, readGit } from "../changed/git.js";
import { IdiomError } from "../errors.js";
import { attributionCorrectionSchema } from "../schemas/decision.js";
import { type Actor, actorSchema } from "./actor.js";
import { effectiveAttribution } from "./attribution.js";
import {
  appendDecisionBatch,
  decisionLogPath,
  readRawDecisionLog,
} from "./log.js";

/** Range refers to observed commits on originals, never the log's introducing commit. */
export async function reattributeDecisions(options: {
  projectDirectory: string;
  range: string;
  actor: Actor;
  note: string;
  git?: GitRead | undefined;
  now?: (() => Date) | undefined;
}): Promise<{ path: string; corrected: number }> {
  const actor = actorSchema.parse(options.actor);
  if (!options.note?.trim())
    throw new IdiomError("--reattribute requires a nonblank --note");
  const endpoints = /^([^.].*?)\.\.([^.].*)$/.exec(options.range);
  if (
    !endpoints ||
    options.range.includes("...") ||
    endpoints[1]?.includes("..") ||
    endpoints[2]?.includes("..")
  )
    throw new IdiomError("--reattribute requires <from-commit>..<to-commit>");
  const git = options.git ?? readGit;
  const resolveCommit = async (ref: string) =>
    (
      await git(options.projectDirectory, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      ])
    ).trim();
  let commits: Set<string>;
  try {
    const from = await resolveCommit(endpoints[1] as string);
    const to = await resolveCommit(endpoints[2] as string);
    commits = new Set(
      (await git(options.projectDirectory, ["rev-list", `${from}..${to}`]))
        .trim()
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    throw new IdiomError(
      "--reattribute requires a Git project and two valid commit endpoints",
    );
  }
  const raw = await readRawDecisionLog(options.projectDirectory);
  const effective = effectiveAttribution(
    raw,
    decisionLogPath(options.projectDirectory),
  );
  const resolved = new Map<string, string | undefined>();
  const corrections = [];
  for (const entry of effective) {
    const record = entry.record;
    if (record.actor === actor || record.commit === "unknown") continue;
    if (!resolved.has(record.commit)) {
      let commit: string | undefined;
      try {
        commit = await resolveCommit(record.commit);
      } catch {
        /* Unresolvable historical observation. */
      }
      resolved.set(record.commit, commit);
    }
    if (!commits.has(resolved.get(record.commit) ?? "")) continue;
    corrections.push(
      attributionCorrectionSchema.parse({
        at: (options.now?.() ?? new Date()).toISOString(),
        commit: record.commit,
        findingId: record.findingId,
        fingerprint: record.fingerprint,
        decision: "reattribute",
        target: entry.source,
        actor,
        note: options.note,
      }),
    );
  }
  return {
    path: await appendDecisionBatch(options.projectDirectory, corrections),
    corrected: corrections.length,
  };
}
