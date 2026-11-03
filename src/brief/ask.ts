import {
  type BriefOption,
  type CompleteStoredBrief,
  isCompleteBrief,
  type StoredBrief,
} from "../schemas/brief.js";

export const BRIEF_ASK_HEADER = "Design call";

export type BriefAskOption = {
  id: string;
  label: string;
  description: string;
  preview?: string | undefined;
};

/** The ready-to-ask question; `askUserQuestion` is Claude Code's AskUserQuestion input. */
export type BriefAsk = {
  decision: string;
  recommendation: string;
  options: BriefAskOption[];
  proceed: { allowed: boolean; reason: string };
  askUserQuestion: {
    questions: Array<{
      question: string;
      header: string;
      multiSelect: false;
      options: Array<{ label: string; description: string; preview?: string }>;
    }>;
  };
  text: string;
};

function line(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function label(option: BriefOption): string {
  if (option.label !== undefined) return line(option.label);
  if (option.kind === "dont-build") return "Don't build it";
  return line(option.title);
}

/** May the agent go ahead on the recommendation without asking? */
export function briefProceed(brief: CompleteStoredBrief): BriefAsk["proceed"] {
  const recommended = brief.options.find(
    (option) => option.id === brief.recommendation.option,
  );
  if (recommended?.kind === "dont-build")
    return {
      allowed: false,
      reason: "must ask: the recommendation is not to build it",
    };
  if (brief.requestNamedIdea && recommended?.kind !== "requester")
    return {
      allowed: false,
      reason: "must ask: the recommendation overrides the requester's own idea",
    };
  if ((brief.stakes ?? "high") === "high")
    return {
      allowed: false,
      reason:
        brief.stakes === undefined
          ? "must ask: high stakes (default)"
          : "must ask: high stakes",
    };
  if (brief.reversible !== true)
    return {
      allowed: false,
      reason:
        brief.reversible === undefined
          ? "must ask: not marked reversible (default)"
          : "must ask: not reversible",
    };
  return {
    allowed: true,
    reason: `may proceed: low-stakes and reversible; tell the requester what you chose and that \`idiom brief decide ${brief.slug} --option <id>\` can change it`,
  };
}

/**
 * Undefined once the brief is decided or superseded, or while its research is
 * incomplete: there is nothing to ask.
 */
export function briefAsk(brief: StoredBrief): BriefAsk | undefined {
  if (brief.status !== "proposed" || !isCompleteBrief(brief)) return undefined;
  const recommendedId = brief.recommendation.option;
  const ordered = [
    ...brief.options.filter((option) => option.id === recommendedId),
    ...brief.options.filter((option) => option.id !== recommendedId),
  ];
  const options = ordered.map((option): BriefAskOption => {
    const recommended = option.id === recommendedId;
    const tradeOff = recommended
      ? brief.recommendation.reason
      : (option.rejectedBecause ?? "");
    return {
      id: option.id,
      label: `${label(option)}${recommended ? " (Recommended)" : ""}`,
      description: `${line(option.summary)} — ${line(tradeOff)}`,
      ...(option.sketch === undefined ? {} : { preview: option.sketch }),
    };
  });
  const decision = line(brief.decision);
  const question = decision.endsWith("?") ? decision : `${decision}?`;
  const proceed = briefProceed(brief);
  const ask: Omit<BriefAsk, "text"> = {
    decision: question,
    recommendation: recommendedId,
    options,
    proceed,
    askUserQuestion: {
      questions: [
        {
          question,
          header: BRIEF_ASK_HEADER,
          multiSelect: false,
          options: options.map((option) => ({
            label: option.label,
            description: option.description,
            ...(option.preview === undefined
              ? {}
              : { preview: option.preview }),
          })),
        },
      ],
    },
  };
  return { ...ask, text: renderAskText(ask, brief.slug) };
}

function renderAskText(ask: Omit<BriefAsk, "text">, slug: string): string {
  return [
    ask.decision,
    ...ask.options.flatMap((option, index) => [
      `${index + 1}. ${option.label}: ${option.description}`,
      ...(option.preview === undefined
        ? []
        : [
            option.preview
              .split(/\r?\n/)
              .map((row) => `   ${row}`.trimEnd())
              .join("\n"),
          ]),
    ]),
    `Reply with a number. (Brief: ${slug})`,
  ].join("\n");
}

/** The human block printed after `idiom brief record`. */
export function renderAsk(ask: BriefAsk, slug: string): string {
  return [
    `Ask the requester: ${ask.decision}`,
    "",
    ...ask.options.flatMap((option, index) => [
      `${index + 1}. ${option.label} [${option.id}]`,
      `   ${option.description}`,
      ...(option.preview === undefined
        ? []
        : [
            "   ```",
            ...option.preview
              .split(/\r?\n/)
              .map((row) => `   ${row}`.trimEnd()),
            "   ```",
          ]),
    ]),
    "",
    ask.proceed.allowed
      ? `Proceed: ${ask.proceed.reason}`
      : `Ask: ${ask.proceed.reason}. Then run idiom brief decide ${slug} --option <id>.`,
  ].join("\n");
}
