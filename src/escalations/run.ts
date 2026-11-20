import { join } from "node:path";
import { type LockOptions, withFileLock } from "../baseline/lock.js";
import {
  classifyQuestion,
  type QuestionClass,
} from "../learn/harvest-classify.js";
import type { Exec } from "../learn/harvest-sources.js";
import type { EscalationAnswer } from "../schemas/escalation-answer.js";
import { answerBuild, type OpenEscalation, readOpenEscalations } from "./ab.js";
import { guidanceText, summaryParagraph } from "./guidance.js";
import {
  answerKey,
  appendEscalationAnswer,
  readEscalationAnswers,
} from "./log.js";
import { type Match, rankMatches, verdictFor } from "./match.js";
import { loadPrecedent } from "./precedent.js";

export type EscalationVerdict =
  | "decisive"
  | "open"
  | "not-design"
  | "answered-before";

export type EscalationItem = {
  build: string;
  buildStatus: string;
  id: string;
  phase: string;
  source: string;
  question: string;
  classification: QuestionClass;
  /** Matching precedent, best first, each with why it matched. */
  matches: Match[];
  verdict: EscalationVerdict;
  /** Why an escalation was left open. */
  reason?: string | undefined;
  /** One paragraph for the human, when left open. */
  summary?: string | undefined;
  /** The guidance a decisive escalation is (or would be) answered with. */
  guidance?: string | undefined;
  /** True once `ab answer` succeeded this pass. */
  answered?: boolean | undefined;
};

export type EscalationPass =
  | {
      status: "read";
      items: EscalationItem[];
      answered: EscalationAnswer[];
      warnings: string[];
    }
  | {
      status: "unavailable";
      reason: string;
      items: EscalationItem[];
      answered: EscalationAnswer[];
      warnings: string[];
    };

export type EscalationPassOptions = {
  projectDirectory: string;
  stateProjectDirectory: string;
  designFile: string;
  /** Answer decisive escalations through `ab answer`; otherwise only list. */
  answer: boolean;
  environment: NodeJS.ProcessEnv;
  exec?: Exec | undefined;
  now?: (() => Date) | undefined;
  lock?: Partial<LockOptions> | undefined;
};

export const escalationLockPath = (stateProjectDirectory: string) =>
  join(stateProjectDirectory, ".idiom", "escalations.lock");

/** Only an agent can ask a design question; stall and policy raises are process. */
function classify(escalation: OpenEscalation): QuestionClass {
  const classification = classifyQuestion(escalation.question);
  return escalation.source === "agent"
    ? classification
    : { ...classification, design: false };
}

/**
 * One pass over the repository's open autobuild escalations: classify each,
 * match design questions against recorded precedent, and (with `answer`)
 * answer the ones precedent settles. Never answers a non-design escalation,
 * a paused build, a build with more than one open escalation, or a build
 * Idiom already answered; never retries, dismisses, revises or aborts.
 */
export async function runEscalationPass(
  options: EscalationPassOptions,
): Promise<EscalationPass> {
  const now = options.now ?? (() => new Date());
  const pass = async (): Promise<EscalationPass> => {
    const read = await readOpenEscalations({
      root: options.projectDirectory,
      environment: options.environment,
      exec: options.exec,
    });
    if (read.status === "unavailable")
      return {
        status: "unavailable",
        reason: read.reason,
        items: [],
        answered: [],
        warnings: [],
      };
    const warnings = read.skipped.map(
      (skip) => `escalations not read: ${skip}`,
    );
    const corpus = await loadPrecedent({
      projectDirectory: options.projectDirectory,
      stateProjectDirectory: options.stateProjectDirectory,
      designFile: options.designFile,
    });
    const history = await readEscalationAnswers(options.stateProjectDirectory);
    const answeredKeys = new Set(
      history.map((record) => answerKey(record.build, record.escalation)),
    );
    const answeredBuilds = new Set(history.map((record) => record.build));

    const items: EscalationItem[] = [];
    for (const build of read.builds) {
      for (const escalation of build.escalations) {
        const base = {
          build: build.slug,
          buildStatus: build.status,
          id: escalation.id,
          phase: escalation.phase,
          source: escalation.source,
          question: escalation.question,
        };
        const classification = classify(escalation);
        if (answeredKeys.has(answerKey(build.slug, escalation.id))) {
          items.push({
            ...base,
            classification,
            matches: [],
            verdict: "answered-before",
          });
          continue;
        }
        if (!classification.design) {
          items.push({
            ...base,
            classification,
            matches: [],
            verdict: "not-design",
          });
          continue;
        }
        const matches = rankMatches(escalation.question, corpus);
        const verdict = verdictFor(matches);
        let open: { reason: string; closest?: Match | undefined } | undefined =
          "open" in verdict
            ? { reason: verdict.open, closest: verdict.closest }
            : undefined;
        if (open === undefined && "decisive" in verdict) {
          // Precedent settles it; the build must still be safe to answer.
          const guard =
            build.status === "paused"
              ? "build is paused"
              : build.status !== "blocked"
                ? `build is ${build.status}`
                : build.escalations.length !== 1
                  ? `build has ${build.escalations.length} open escalations`
                  : answeredBuilds.has(build.slug)
                    ? "Idiom already answered an escalation on this build"
                    : undefined;
          if (guard !== undefined)
            open = { reason: guard, closest: verdict.decisive };
        }
        if (open !== undefined) {
          items.push({
            ...base,
            classification,
            matches,
            verdict: "open",
            reason: open.reason,
            summary: summaryParagraph({
              build: build.slug,
              escalation,
              reason: open.reason,
              closest: open.closest,
            }),
          });
          continue;
        }
        const decisive = (verdict as { decisive: Match }).decisive;
        items.push({
          ...base,
          classification,
          matches,
          verdict: "decisive",
          guidance: guidanceText(decisive),
        });
      }
    }

    const answered: EscalationAnswer[] = [];
    if (options.answer) {
      for (const item of items) {
        if (item.verdict !== "decisive" || item.guidance === undefined)
          continue;
        const [precedent] = item.matches;
        if (precedent === undefined) continue;
        try {
          await answerBuild({
            root: options.projectDirectory,
            environment: options.environment,
            exec: options.exec,
            slug: item.build,
            text: item.guidance,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          warnings.push(reason);
          item.verdict = "open";
          item.reason = reason;
          item.summary = summaryParagraph({
            build: item.build,
            escalation: item,
            reason,
            closest: precedent,
          });
          continue;
        }
        // Recorded only after `ab answer` succeeded; the escalation is then
        // closed in autobuild, so a crash here loses a history line, never
        // causes a second answer.
        const record: EscalationAnswer = {
          version: 1,
          at: now().toISOString(),
          build: item.build,
          escalation: item.id,
          phase: item.phase,
          question: item.question,
          guidance: item.guidance,
          precedent: {
            kind: precedent.kind,
            id: precedent.id,
            where: precedent.where,
            text: precedent.text,
            ...(precedent.stance === undefined
              ? {}
              : { stance: precedent.stance }),
            score: precedent.score,
            sharedTerms: precedent.sharedTerms,
          },
          actor: "idiom",
        };
        await appendEscalationAnswer(options.stateProjectDirectory, record);
        item.answered = true;
        answered.push(record);
      }
    }
    return { status: "read", items, answered, warnings };
  };

  if (!options.answer) return pass();
  return withFileLock(
    escalationLockPath(options.stateProjectDirectory),
    {
      waitMs: 0,
      staleMs: 10 * 60_000,
      holderLabel: "another idiom escalations pass",
      describe: "answering autobuild escalations",
      ...options.lock,
    },
    pass,
  );
}
