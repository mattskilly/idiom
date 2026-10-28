import { acceptanceText } from "../findings/presentation.js";
import {
  type RepairPresentation,
  repairScopeBoundary,
  repairSiblingLines,
} from "../repair/presentation.js";

export function renderInstruction(presentation: RepairPresentation): string {
  const finding = presentation.target.finding;
  const surface = [
    `- Flow: ${finding.flow}`,
    `- State: ${finding.state}`,
    `- Viewport: ${finding.viewport}`,
    ...(finding.colorScheme === undefined
      ? []
      : [`- Color scheme: ${finding.colorScheme}`]),
    ...(finding.suggestedArea === undefined
      ? []
      : [
          `- Suggested starting area: ${finding.suggestedArea} (a starting point only; it does not expand the scope below)`,
        ]),
  ];
  const motivation = finding.rule ?? finding.category;
  return [
    "## Change",
    "",
    finding.explanation,
    "",
    "## Surface",
    "",
    ...surface,
    "",
    "## Why",
    "",
    `This change is motivated by ${finding.rule === undefined ? "the finding category" : "the recorded rule"} ${motivation}. The observed issue was: ${finding.explanation}`,
    "",
    "## Done when",
    "",
    ...acceptanceText(finding).map((criterion) => `- ${criterion}`),
    "",
    "## Out of scope",
    "",
    ...repairSiblingLines(presentation.siblings),
    repairScopeBoundary(finding),
    "- Do not implement adjacent findings or make changes outside the bounded surface and acceptance criteria above.",
    "",
  ].join("\n");
}
