import type { PendingDecision } from "../schemas/pending-decision.js";

/** Display only. Callers execute validated argument arrays, never this text. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
export function decisionQuestion(
  questions: readonly PendingDecision[],
): string {
  if (!questions.length) return "";
  return [
    "Choose an option and give an explicit human reason for each id. <wording>, <reason>, <build> and <escalation> are input slots, not answers.",
    "Commands carry the current build slug and escalation id as provenance.",
    ...questions.map((question, index) =>
      [
        `${index + 1}. ${question.id} [${question.key}] — ${question.question}`,
        `Surface: ${question.flow}; ${question.coordinates.map((c) => `${c.state}/${c.viewport}${c.colorScheme ? `/${c.colorScheme}` : ""}`).join(", ")}`,
        `Source: ${question.artifact}`,
        ...question.citations.map((c) => `Citation: ${c}`),
        ...question.evidence.map((path) => `Evidence: ${path}`),
        ...(question.missingCropEvidence
          ? ["Crop evidence: unavailable; inspect the listed screenshots."]
          : []),
        ...question.options.flatMap((option) => [
          `Option: ${option.label}${option.input === "wording" ? " (supply custom wording)" : ""}`,
          `  ${["idiom", "decide", ...option.args, "--reason", "<reason>", "--build", "<build>", "--escalation", "<escalation>"].map(shellQuote).join(" ")}`,
        ]),
      ].join("\n"),
    ),
  ].join("\n\n");
}
