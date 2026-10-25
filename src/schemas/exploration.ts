import { z } from "zod";

const nonblank = z.string().trim().min(1);

export const explorationEditPathSchema = nonblank.refine(
  (path) =>
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") &&
    !path.startsWith(".idiom-explore-evidence/"),
  "must be a safe project-relative existing-file path",
);

export const explorationEditSchema = z
  .object({
    path: explorationEditPathSchema,
    oldText: z.string().min(1),
    newText: z.string(),
  })
  .strict()
  .refine((edit) => edit.oldText !== edit.newText, {
    message: "oldText and newText must differ",
  });

export const explorationCandidateSchema = z
  .object({
    label: nonblank,
    direction: nonblank,
    choiceKey: nonblank,
    rule: nonblank,
    reason: nonblank,
    category: z.enum([
      "hierarchy",
      "density",
      "brand-alignment",
      "generic-pattern",
      "reference-mismatch",
    ]),
    repair: nonblank,
    references: z.array(nonblank),
    edits: z.array(explorationEditSchema).min(1),
  })
  .strict()
  .superRefine((candidate, context) => {
    const paths = new Set<string>();
    for (const [index, edit] of candidate.edits.entries()) {
      if (paths.has(edit.path))
        context.addIssue({
          code: "custom",
          path: ["edits", index, "path"],
          message: "duplicate edit path",
        });
      paths.add(edit.path);
    }
  });

export const explorationCandidatesSchema = z
  .array(explorationCandidateSchema)
  .length(3)
  .superRefine((candidates, context) => {
    const normalizedLabels = candidates
      .map((candidate) => normalizeExplorationKey(candidate.label))
      .sort();
    if (JSON.stringify(normalizedLabels) !== JSON.stringify(["a", "b", "c"]))
      context.addIssue({
        code: "custom",
        message: `labels must be exactly the unique set A, B, and C; received ${JSON.stringify(candidates.map((candidate) => candidate.label))}`,
      });

    const directions = new Set<string>();
    for (const [index, candidate] of candidates.entries()) {
      const direction = normalizeExplorationKey(candidate.direction);
      if (directions.has(direction))
        context.addIssue({
          code: "custom",
          path: [index, "direction"],
          message: "must be unique",
        });
      directions.add(direction);
    }
  });

export const explorationRefinementSchema = z
  .object({
    direction: nonblank,
    choiceKey: nonblank,
    rule: nonblank,
    reason: nonblank,
    category: explorationCandidateSchema.shape.category,
    repair: nonblank,
    references: z.array(nonblank),
    edits: z.array(explorationEditSchema).min(1),
  })
  .strict();

export const explorationSteeringSchema = z
  .object({
    question: nonblank.optional(),
    decision: z
      .string()
      .regex(/^ruling-[1-9]\d*$/)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.question === undefined) !== (value.decision === undefined),
    {
      message: "provide exactly one of question or decision",
    },
  );

const persistedExplorationLabelSchema = nonblank
  .transform((value) => normalizeExplorationKey(value).toUpperCase())
  .pipe(z.enum(["A", "B", "C"]));

export const persistedExplorationCandidateSchema = z
  .object({
    label: persistedExplorationLabelSchema,
    direction: nonblank,
    choiceKey: nonblank,
    rule: nonblank,
    reason: nonblank,
    category: explorationCandidateSchema.shape.category,
    repair: nonblank,
    references: z.array(nonblank),
    capture: nonblank.refine(
      (path) =>
        !path.startsWith("/") &&
        !/^[A-Za-z]:/.test(path) &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        !path
          .split("/")
          .some((part) => part === "" || part === "." || part === ".."),
      "must be a safe run-relative capture path",
    ),
    refined: z.boolean(),
  })
  .strict();

export const persistedExplorationSteeringSchema = z
  .object({
    decision: z.string().regex(/^ruling-[1-9]\d*$/),
    fingerprint: nonblank,
    choiceKey: nonblank,
  })
  .strict();

export const explorationRunResolutionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("none"),
      reason: nonblank,
      recordedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("rule"),
      reason: nonblank,
      recordedAt: z.string().datetime({ offset: true }),
      selected: persistedExplorationLabelSchema,
      ruling: z
        .object({
          id: z.string().regex(/^ruling-[1-9]\d*$/),
          fingerprint: nonblank,
          choiceKey: nonblank,
        })
        .strict(),
      repairs: z.boolean(),
    })
    .strict(),
]);

export const explorationRunSchema = z
  .object({
    version: z.literal(1),
    flow: nonblank,
    state: nonblank,
    question: nonblank,
    candidates: z.array(persistedExplorationCandidateSchema).min(3).max(4),
    selected: persistedExplorationLabelSchema.optional(),
    refined: nonblank.optional(),
    steering: persistedExplorationSteeringSchema.optional(),
    resolution: explorationRunResolutionSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const base = run.candidates.filter((candidate) => !candidate.refined);
    const refined = run.candidates.filter((candidate) => candidate.refined);
    if (
      base.length !== 3 ||
      [...base.map((candidate) => candidate.label)].sort().join("") !== "ABC"
    )
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "must contain exactly one base candidate for A, B, and C",
      });
    if (refined.length > 1)
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "may contain only one refined candidate",
      });
    if (refined.length === 1 && refined[0]?.label !== run.selected)
      context.addIssue({
        code: "custom",
        path: ["selected"],
        message: "must name the refined candidate label",
      });
    if ((run.refined === undefined) !== (refined.length === 0))
      context.addIssue({
        code: "custom",
        path: ["refined"],
        message: "must be present exactly when a refined candidate exists",
      });
    if (refined.length === 1 && run.refined !== refined[0]?.direction)
      context.addIssue({
        code: "custom",
        path: ["refined"],
        message: "must match the refined candidate direction",
      });
    const captures = new Set<string>();
    for (const [index, candidate] of run.candidates.entries()) {
      if (captures.has(candidate.capture))
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "capture"],
          message: "must be unique",
        });
      captures.add(candidate.capture);
    }
  });

export function normalizeExplorationKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export type ExplorationEdit = z.infer<typeof explorationEditSchema>;
export type ExplorationCandidate = z.infer<typeof explorationCandidateSchema>;
export type ExplorationRefinement = z.infer<typeof explorationRefinementSchema>;
export type PersistedExplorationCandidate = z.infer<
  typeof persistedExplorationCandidateSchema
>;
export type ExplorationRunResolution = z.infer<
  typeof explorationRunResolutionSchema
>;
export type ExplorationRun = z.infer<typeof explorationRunSchema>;
