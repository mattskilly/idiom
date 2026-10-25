import { z } from "zod";
import {
  type ExplorationCandidate,
  type ExplorationRefinement,
  explorationCandidatesSchema,
  explorationRefinementSchema,
  normalizeExplorationKey,
} from "../schemas/exploration.js";

const category = {
  type: "string",
  enum: [
    "hierarchy",
    "density",
    "brand-alignment",
    "generic-pattern",
    "reference-mismatch",
  ],
};
const edit = {
  type: "object",
  additionalProperties: false,
  required: ["path", "oldText", "newText"],
  properties: {
    path: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
  },
};
function references(permittedLabels: readonly string[]) {
  if (permittedLabels.length > 0)
    return {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: [...permittedLabels] },
    };

  // Anthropic structured outputs do not support maxItems, so the empty-catalog
  // contract cannot be represented completely on the wire. The local parser
  // below compensates by requiring this array to be exactly empty.
  return { type: "array", items: { type: "string" } };
}

function candidate(permittedLabels: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "label",
      "direction",
      "choiceKey",
      "rule",
      "reason",
      "category",
      "repair",
      "references",
      "edits",
    ],
    properties: {
      // Anthropic structured outputs support scalar enums. Local parsing still
      // validates labels case-insensitively because enum casing can vary in
      // structured output and non-transport adapters must obey the same contract.
      label: { type: "string", enum: ["A", "B", "C"] },
      direction: { type: "string" },
      choiceKey: { type: "string" },
      rule: { type: "string" },
      reason: { type: "string" },
      category,
      repair: { type: "string" },
      references: references(permittedLabels),
      edits: { type: "array", minItems: 1, items: edit },
    },
  };
}

export function explorationCandidatesJsonSchema(
  permittedLabels: readonly string[],
) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      // Anthropic structured outputs do not support maxItems and only accept
      // minItems values 0 or 1. Exact cardinality remains enforced by the
      // prompt and explorationCandidatesSchema.length(3) after transport.
      candidates: { type: "array", items: candidate(permittedLabels) },
    },
  };
}

export function explorationRefinementJsonSchema(
  permittedLabels: readonly string[],
) {
  const refinement = candidate(permittedLabels);
  return {
    type: "object",
    additionalProperties: false,
    required: ["refinement"],
    properties: {
      refinement: {
        ...refinement,
        required: [
          "direction",
          "choiceKey",
          "rule",
          "reason",
          "category",
          "repair",
          "references",
          "edits",
        ],
        properties: Object.fromEntries(
          Object.entries(refinement.properties).filter(
            ([key]) => key !== "label",
          ),
        ),
      },
    },
  };
}

export class MalformedExplorationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid exploration output: ${issues.join("; ")}`);
    this.name = "MalformedExplorationError";
    this.issues = issues;
  }
}

function issues(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
  );
}

function canonicalizeReferences<T extends { references: string[] }>(
  values: T[],
  permittedLabels: readonly string[],
  locations: string[],
): T[] {
  const normalized = new Map<string, string[]>();
  for (const label of permittedLabels) {
    const key = normalizeExplorationKey(label);
    normalized.set(key, [...(normalized.get(key) ?? []), label]);
  }
  const exact = new Set(permittedLabels);
  const permitted = JSON.stringify(permittedLabels);
  const citationIssues: string[] = [];
  const output = values.map((value, valueIndex) => {
    if (permittedLabels.length > 0 && value.references.length === 0)
      citationIssues.push(
        `${locations[valueIndex]}.references: must cite at least one permitted label; permitted labels: ${permitted}`,
      );
    const canonical = value.references.map((reference, referenceIndex) => {
      if (exact.has(reference)) return reference;
      const matches = normalized.get(normalizeExplorationKey(reference)) ?? [];
      if (matches.length === 1) return matches[0] as string;
      citationIssues.push(
        `${locations[valueIndex]}.references.${referenceIndex}: citation ${JSON.stringify(reference)} does not unambiguously match a managed reference; permitted labels: ${permitted}`,
      );
      return reference;
    });
    return { ...value, references: canonical };
  });
  if (citationIssues.length > 0)
    throw new MalformedExplorationError(citationIssues);
  return output;
}

export function parseCandidateOutput(
  value: unknown,
  permittedLabels: readonly string[],
): ExplorationCandidate[] {
  const envelope = z
    .object({ candidates: z.unknown() })
    .strict()
    .safeParse(value);
  if (!envelope.success)
    throw new MalformedExplorationError(issues(envelope.error));
  const parsed = explorationCandidatesSchema.safeParse(
    envelope.data.candidates,
  );
  if (!parsed.success)
    throw new MalformedExplorationError(issues(parsed.error));
  return canonicalizeReferences(
    parsed.data,
    permittedLabels,
    parsed.data.map((_, index) => `candidates.${index}`),
  );
}

export function parseRefinementOutput(
  value: unknown,
  permittedLabels: readonly string[],
): ExplorationRefinement {
  const envelope = z
    .object({ refinement: z.unknown() })
    .strict()
    .safeParse(value);
  if (!envelope.success)
    throw new MalformedExplorationError(issues(envelope.error));
  const parsed = explorationRefinementSchema.safeParse(
    envelope.data.refinement,
  );
  if (!parsed.success)
    throw new MalformedExplorationError(issues(parsed.error));
  return canonicalizeReferences([parsed.data], permittedLabels, [
    "refinement",
  ])[0] as ExplorationRefinement;
}
