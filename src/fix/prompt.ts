import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { tupleCoordinateKey } from "../baseline/coordinate.js";
import { renderInstruction } from "../instructions/render.js";
import { repairPresentation } from "../repair/presentation.js";
import type { CatalogFinding } from "../review/catalog.js";
import type { FixSnapshot } from "./check.js";

export async function repairPrompt(
  snapshot: FixSnapshot,
  selected: CatalogFinding[],
  eligible: CatalogFinding[],
): Promise<string> {
  if (selected.length === 0) return "";
  const instructionPaths: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = resolve(snapshot.projectDirectory, name);
    try {
      await access(path);
      instructionPaths.push(path);
    } catch {
      /* Optional repository instructions. */
    }
  }
  const assignments = selected.map(({ finding }) => finding.id);
  const sections = selected.map((record) => {
    const presentation = repairPresentation(snapshot.catalog, record);
    // Filter using source identities before presentation canonicalizes aliases.
    presentation.siblings = eligible.filter(
      (sibling) => !assignments.includes(sibling.finding.id),
    );
    const finding = record.finding;
    const screenshots = finding.evidence.screenshots;
    const crops = screenshots.filter((path) => /(^|\/)crops\//.test(path));
    return [
      `# Finding ${finding.id}`,
      renderInstruction(presentation),
      "## Measured evidence (source record)",
      JSON.stringify(
        {
          id: finding.id,
          selector: finding.verification.params?.selector,
          measurement: finding.explanation,
          verification: finding.verification,
          rule: finding.rule,
          category: finding.category,
          acceptance: finding.acceptance,
          coordinate: tupleCoordinateKey(finding),
          cropPaths: (crops.length ? crops : screenshots).map((path) =>
            resolve(record.runDirectory, path),
          ),
        },
        null,
        2,
      ),
    ].join("\n\n");
  });
  return [
    "Repair these Idiom findings in the application source.",
    `Selected assignments: ${assignments.join(", ")}.`,
    `Repository: ${snapshot.projectDirectory}`,
    `Read repository instructions: ${instructionPaths.length ? instructionPaths.join(", ") : "none at repository root; respect any instructions in the source directories you edit"}.`,
    `Read the design rules in context: ${snapshot.designFile}.`,
    "Preserve unrelated user edits. Leave all edits uncommitted. Never stage, commit, push, open a PR, reset, stash, or clean.",
    "Change application source only. Do not change Idiom configuration, flows, decisions, rules, design documents, reports, or evidence to hide failures.",
    "Idiom owns rechecking and calibrated verification. Do not run idiom fix recursively. Do not attempt unassigned adjacent work.",
    ...sections,
    "",
  ].join("\n\n");
}
