import type { CandidateRequest, RefinementRequest } from "./types.js";

function context(
  input: Pick<CandidateRequest, "context" | "evidence">,
): string {
  const value = input.context;
  const referenceLabels = value.references.map((reference) => reference.label);
  const citationContract =
    referenceLabels.length === 0
      ? "There are no managed references or anti-references. Every references array must be exactly []."
      : `The exact permitted citation labels are:\n${JSON.stringify(referenceLabels, null, 2)}\nEvery references array must contain at least one of these labels and no other values.`;
  return [
    "You are proposing source edits for a design-system elicitation. Return only the requested structured output.",
    "Change the running product's existing components. Grouping, order, disclosure, and styling may change. Do not invent copy, data, controls, features, or standalone mockups.",
    "Each edit must be an exact replacement in an existing regular file: project-relative path, oldText occurring exactly once, and newText. Do not name output paths.",
    "The three directions must be materially distinct. Each rule must be generalized design law, not a one-screen implementation instruction.",
    `Citation contract:\n${citationContract}\nPRODUCT.md, DESIGN.md, recorded rulings, flow context, and visible evidence ground the direction, rule, reason, repair, and edits; they are not citation labels and must not appear in references.`,
    `Flow: ${value.flow.id}\nState: ${value.state.id}\nQuestion: ${value.question}`,
    `Flow intent:\n${value.flow.intent.join("\n")}`,
    `PRODUCT.md:\n${value.productMd}`,
    `DESIGN.md:\n${value.designMd}`,
    `Recorded rulings:\n${JSON.stringify(value.rulings, null, 2)}`,
    `References and anti-references:\n${JSON.stringify(
      value.references.map((reference) => ({
        label: reference.label,
        polarity: reference.polarity,
        kind: reference.kind,
        ...(reference.kind === "text"
          ? { content: reference.content }
          : { note: reference.note }),
      })),
      null,
      2,
    )}`,
    `Readable source and evidence paths (all contained by the working mirror):\n${JSON.stringify(input.evidence.readablePaths, null, 2)}`,
  ].join("\n\n");
}

export function candidatePrompt(input: CandidateRequest): string {
  return [
    context(input),
    ...(input.rejected === undefined
      ? []
      : [
          `A prior batch was rejected:\n${JSON.stringify(input.rejected.candidate, null, 2)}\nIssues:\n${input.rejected.issues.join("\n")}\nReturn a complete replacement batch.`,
        ]),
    "Return exactly three candidates labeled A, B, and C.",
  ].join("\n\n");
}

export function refinementPrompt(input: RefinementRequest): string {
  return [
    context(input),
    `Selected candidate:\n${JSON.stringify(input.candidate, null, 2)}`,
    `Single refinement request: ${input.instruction}`,
    ...(input.rejected === undefined
      ? []
      : [
          `Rejected refinement:\n${JSON.stringify(input.rejected.refinement, null, 2)}\nIssues:\n${input.rejected.issues.join("\n")}`,
        ]),
    "Return one complete refinement whose exact replacements apply to the selected candidate source.",
  ].join("\n\n");
}
