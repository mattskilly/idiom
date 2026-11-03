import { z } from "zod";
import { invariantDimensionSchema } from "./invariant.js";
import { critiqueProviderSchema } from "./project.js";

/** What `idiom brief triage` answers, and what `record` may carry over. */
export const briefTriageVerdicts = [
  "design decision",
  "no design decision",
] as const;

export const BRIEF_TRIAGE_MAX_QUESTIONS = 8;

export const briefTriageResultSchema = z
  .object({
    verdict: z.enum(briefTriageVerdicts),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((reason) => !/[\r\n]/.test(reason), "must be one line"),
    questions: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.verdict === "design decision") {
      if (result.questions.length === 0)
        context.addIssue({
          code: "custom",
          path: ["questions"],
          message: "a design decision needs at least one open question",
        });
      if (result.questions.length > BRIEF_TRIAGE_MAX_QUESTIONS)
        context.addIssue({
          code: "custom",
          path: ["questions"],
          message: `at most ${BRIEF_TRIAGE_MAX_QUESTIONS} questions`,
        });
    } else if (result.questions.length > 0)
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "no design decision means questions must be []",
      });
  });
export type BriefTriageResult = z.infer<typeof briefTriageResultSchema>;

/**
 * Written by hand, like the skill resolver's, so every provider transport
 * accepts it; local validation enforces the rest.
 */
export const briefTriageJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: [...briefTriageVerdicts] },
    reason: { type: "string" },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "reason", "questions"],
};

export const briefSlugSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "must be a lowercase slug such as pinned-group",
  );

const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), {
    message: "must be an http or https URL",
  });

const nonEmpty = z.string().trim().min(1);

export const researchFindingSchema = z
  .object({
    claim: nonEmpty,
    source: httpUrl,
    verified: z.enum(["hands-on", "read"]),
  })
  .strict();

export const researchQuestionSchema = z
  .object({
    question: nonEmpty,
    // The list branch first: on a tie its issues are the useful ones.
    findings: z.union([
      z.array(researchFindingSchema, {
        error: 'must be a list of findings or "nothing found"',
      }),
      z.literal("nothing found"),
    ]),
  })
  .strict()
  .superRefine((research, context) => {
    if (Array.isArray(research.findings) && research.findings.length === 0)
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: 'use "nothing found", not an empty list',
      });
  });

export type ResearchQuestion = z.infer<typeof researchQuestionSchema>;

export const BRIEF_SKETCH_MAX_LINES = 16;
export const BRIEF_SKETCH_MAX_COLUMNS = 72;

export const briefOptionKinds = [
  "requester",
  "alternative",
  "dont-build",
] as const;

export const briefOptionSchema = z
  .object({
    id: briefSlugSchema,
    title: nonEmpty,
    summary: nonEmpty,
    kind: z.enum(briefOptionKinds),
    cost: z
      .object({
        space: nonEmpty,
        steps: nonEmpty,
        concepts: nonEmpty,
        code: nonEmpty,
      })
      .strict(),
    rejectedBecause: nonEmpty.optional(),
    /** A short answer label for the ready-to-ask question; the title otherwise. */
    label: nonEmpty
      .max(40)
      .refine((label) => !/[\r\n]/.test(label), "must be one line")
      .optional(),
    /** A low-fidelity ASCII sketch, shown as the answer's preview. */
    sketch: z
      .string()
      .refine((sketch) => sketch.trim() !== "", "must not be empty")
      .refine(
        (sketch) => sketch.split(/\r?\n/).length <= BRIEF_SKETCH_MAX_LINES,
        `at most ${BRIEF_SKETCH_MAX_LINES} lines`,
      )
      .refine(
        (sketch) =>
          sketch
            .split(/\r?\n/)
            .every((row) => row.length <= BRIEF_SKETCH_MAX_COLUMNS),
        `each line at most ${BRIEF_SKETCH_MAX_COLUMNS} characters`,
      )
      .optional(),
  })
  .strict();
export type BriefOption = z.infer<typeof briefOptionSchema>;

export const briefCriterionKinds = [
  "geometry",
  "input-states",
  "contrast",
  "behaviour",
] as const;

const criterionPatterns: Partial<
  Record<(typeof briefCriterionKinds)[number], [RegExp, string]>
> = {
  geometry: [
    /\d+(?:\.\d+)?\s*(?:px|rem|em|%|pt|vh|vw)\b/,
    'must state a measurement with a unit, e.g. "the pin icon is at most 20px square"',
  ],
  contrast: [
    /\d+(?:\.\d+)?\s*:\s*1\b/,
    'must state a ratio, e.g. "the icon meets 3:1 against the tile"',
  ],
  "input-states": [
    /\b(?:mouse|hover|pointer|touch|tap|keyboard|focus)\b/i,
    'must name an input, e.g. "on touch the pin is visible without hover"',
  ],
};

const assertionPixels = z.number().finite().nonnegative();

/** Where an assertion is measured, and the element it is about. */
const assertionSubject = {
  flow: nonEmpty,
  /** A declared state id; it also covers that state's combinations (`S.<combination>`). */
  state: nonEmpty,
  selector: nonEmpty,
  name: nonEmpty.optional(),
  /** CSS pixels. */
  tolerance: assertionPixels.default(1),
};

/**
 * A machine-checkable form of an acceptance criterion, judged by the
 * `brief-mismatch` check on the named flow state. The size form is the flow
 * invariant vocabulary verbatim.
 */
export const briefAssertionSchema = z.union([
  z
    .object({
      ...assertionSubject,
      width: invariantDimensionSchema.optional(),
      height: invariantDimensionSchema.optional(),
    })
    .strict()
    .refine(
      (value) => value.width !== undefined || value.height !== undefined,
      "must declare width or height",
    ),
  z
    .object({
      ...assertionSubject,
      sameSizeAs: nonEmpty,
      axis: z.enum(["width", "height", "both"]).default("both"),
    })
    .strict(),
  z.object({ ...assertionSubject, within: nonEmpty }).strict(),
  z
    .object({ ...assertionSubject, visibleWithoutHover: z.literal(true) })
    .strict(),
  z.object({ ...assertionSubject, stableOnHover: z.literal(true) }).strict(),
  z
    .object({
      ...assertionSubject,
      minContrast: z.number().finite().min(1).max(21),
    })
    .strict(),
]);
export type BriefAssertion = z.infer<typeof briefAssertionSchema>;

export type BriefAssertionForm =
  | "size"
  | "sameSizeAs"
  | "within"
  | "visibleWithoutHover"
  | "stableOnHover"
  | "minContrast";

export function briefAssertionForm(
  assertion: BriefAssertion,
): BriefAssertionForm {
  if ("sameSizeAs" in assertion) return "sameSizeAs";
  if ("within" in assertion) return "within";
  if ("visibleWithoutHover" in assertion) return "visibleWithoutHover";
  if ("stableOnHover" in assertion) return "stableOnHover";
  if ("minContrast" in assertion) return "minContrast";
  return "size";
}

/** The subject, then any reference or container selector. */
export function briefAssertionSelectors(assertion: BriefAssertion): string[] {
  return [
    ...new Set([
      assertion.selector,
      ...("sameSizeAs" in assertion ? [assertion.sameSizeAs] : []),
      ...("within" in assertion ? [assertion.within] : []),
    ]),
  ];
}

export const briefCriterionSchema = z
  .object({
    kind: z.enum(briefCriterionKinds),
    statement: nonEmpty,
    /** Optional: how Idiom checks the criterion on the built UI. */
    assertions: z.array(briefAssertionSchema).min(1).optional(),
  })
  .strict()
  .superRefine((criterion, context) => {
    const rule = criterionPatterns[criterion.kind];
    if (rule !== undefined && !rule[0].test(criterion.statement))
      context.addIssue({
        code: "custom",
        path: ["statement"],
        message: `${/^[aeiou]/.test(criterion.kind) ? "an" : "a"} ${criterion.kind} criterion ${rule[1]}`,
      });
  });
export type BriefCriterion = z.infer<typeof briefCriterionSchema>;

export const briefStatuses = ["proposed", "decided", "superseded"] as const;
export type BriefStatus = (typeof briefStatuses)[number];

const briefFields = {
  slug: briefSlugSchema.optional(),
  title: nonEmpty.max(120),
  /** The request, verbatim. */
  request: nonEmpty.max(20_000),
  /** The design question being decided. */
  decision: nonEmpty,
  /** Did the requester propose a solution of their own? */
  requestNamedIdea: z.boolean(),
  triage: briefTriageResultSchema.optional(),
  research: z.array(researchQuestionSchema).min(1),
  options: z.array(briefOptionSchema).min(2).max(4),
  recommendation: z
    .object({ option: briefSlugSchema, reason: nonEmpty })
    .strict(),
  acceptanceCriteria: z.array(briefCriterionSchema).min(1),
  outOfScope: z.array(nonEmpty).default([]),
  status: z.enum(briefStatuses).default("proposed"),
  decidedBy: nonEmpty.optional(),
  supersededBy: briefSlugSchema.optional(),
  /** Readers treat a missing value as "high": ask before proceeding. */
  stakes: z.enum(["low", "high"]).optional(),
  /** Readers treat a missing value as false. */
  reversible: z.boolean().optional(),
  /** The option the human chose; the recommendation when absent on a decided brief. */
  chosenOption: briefSlugSchema.optional(),
};

/** Every field `idiom brief record` accepts, for the research plan's skeleton. */
export const briefInputFieldNames = Object.keys(briefFields);

type StatusShape = {
  slug?: string | undefined;
  chosenOption?: string | undefined;
  status: BriefStatus;
  decidedBy?: string | undefined;
  supersededBy?: string | undefined;
};

type OptionsShape = {
  chosenOption?: string | undefined;
  requestNamedIdea: boolean;
  options: BriefOption[];
  recommendation: { option: string };
};

function optionRules(brief: OptionsShape, context: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  const seen = new Map<string, number>();
  for (const [index, option] of brief.options.entries()) {
    const prior = seen.get(option.id);
    if (prior !== undefined)
      issue(["options", index, "id"], `duplicates options[${prior}].id`);
    else seen.set(option.id, index);
  }
  const dontBuild = brief.options.filter((o) => o.kind === "dont-build");
  if (dontBuild.length !== 1)
    issue(
      ["options"],
      `exactly one option must be kind "dont-build"; found ${dontBuild.length}`,
    );
  const requester = brief.options.filter((o) => o.kind === "requester");
  if (brief.requestNamedIdea && requester.length !== 1)
    issue(
      ["options"],
      `the request named an idea, so exactly one option must be kind "requester"; found ${requester.length}`,
    );
  if (!brief.requestNamedIdea && requester.length > 0)
    issue(
      ["options"],
      'requestNamedIdea is false, so no option may be kind "requester"',
    );
  const recommended = brief.recommendation.option;
  if (!seen.has(recommended))
    issue(
      ["recommendation", "option"],
      `names no option; choose one of ${[...seen.keys()].join(", ")}`,
    );
  for (const [index, option] of brief.options.entries()) {
    if (option.id === recommended && option.rejectedBecause !== undefined)
      issue(
        ["options", index, "rejectedBecause"],
        "the recommended option is not rejected",
      );
    if (
      option.id !== recommended &&
      seen.has(recommended) &&
      option.rejectedBecause === undefined
    )
      issue(
        ["options", index, "rejectedBecause"],
        "every option except the recommendation needs a reason it was rejected",
      );
  }
  if (brief.chosenOption !== undefined && !seen.has(brief.chosenOption))
    issue(
      ["chosenOption"],
      `names no option; choose one of ${[...seen.keys()].join(", ")}`,
    );
}

function statusRules(brief: StatusShape, context: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: "custom", path, message });
  if (brief.status === "decided" && brief.decidedBy === undefined)
    issue(["decidedBy"], 'a "decided" brief names who decided');
  if (brief.status === "superseded" && brief.supersededBy === undefined)
    issue(
      ["supersededBy"],
      'a "superseded" brief names the brief replacing it',
    );
  if (brief.status !== "decided" && brief.chosenOption !== undefined)
    issue(["chosenOption"], 'only a "decided" brief names a chosen option');
  if (brief.status !== "decided" && brief.decidedBy !== undefined)
    issue(["decidedBy"], 'only a "decided" brief names who decided');
  if (brief.status !== "superseded" && brief.supersededBy !== undefined)
    issue(["supersededBy"], 'only a "superseded" brief names a replacement');
  if (
    brief.supersededBy !== undefined &&
    brief.slug !== undefined &&
    brief.supersededBy === brief.slug
  )
    issue(["supersededBy"], "a brief cannot supersede itself");
}

function briefRules(
  brief: StatusShape & OptionsShape,
  context: z.RefinementCtx,
): void {
  optionRules(brief, context);
  statusRules(brief, context);
}

/** What the calling agent sends to `idiom brief record`. */
export const briefInputSchema = z
  .object(briefFields)
  .strict()
  .superRefine(briefRules);
export type BriefInput = z.infer<typeof briefInputSchema>;

const count = z.number().int().min(0);

/**
 * Idiom-owned: what an `idiom brief "<request>" --research` run cost, and
 * whether it stopped before finishing. `record` input never carries it.
 */
export const researchRunSchema = z
  .object({
    provider: critiqueProviderSchema,
    model: nonEmpty,
    budgetMs: count,
    durationMs: count,
    calls: count,
    turns: count.optional(),
    searches: count.optional(),
    tokens: z.object({ input: count, output: count }).strict().optional(),
    incomplete: z
      .object({
        stage: z.enum(["research", "options"]),
        note: nonEmpty,
        unresearched: z.array(nonEmpty),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ResearchRun = z.infer<typeof researchRunSchema>;

/** The fields only the options stage of research produces. */
const optionStageFields = [
  "decision",
  "requestNamedIdea",
  "options",
  "recommendation",
  "acceptanceCriteria",
] as const;

export const storedBriefSchema = z
  .object({
    version: z.literal(1),
    ...briefFields,
    // An incomplete research run may stop before research or options.
    research: z.array(researchQuestionSchema),
    decision: briefFields.decision.optional(),
    requestNamedIdea: briefFields.requestNamedIdea.optional(),
    options: briefFields.options.optional(),
    recommendation: briefFields.recommendation.optional(),
    acceptanceCriteria: briefFields.acceptanceCriteria.optional(),
    slug: briefSlugSchema,
    rubricVersion: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    researchRun: researchRunSchema.optional(),
  })
  .strict()
  .superRefine((brief, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const present = optionStageFields.filter(
      (field) => brief[field] !== undefined,
    );
    if (brief.researchRun?.incomplete === undefined) {
      for (const field of optionStageFields)
        if (brief[field] === undefined) issue([field], "required");
      if (brief.research.length === 0)
        issue(["research"], "needs at least 1 researched question");
    } else {
      if (brief.status !== "proposed")
        issue(
          ["status"],
          'a brief with incomplete research stays "proposed"; record a complete brief to decide it',
        );
      if (present.length > 0 && present.length < optionStageFields.length)
        issue(
          ["options"],
          `incomplete research stores every options-stage field or none; missing ${optionStageFields.filter((field) => brief[field] === undefined).join(", ")}`,
        );
    }
    statusRules(brief, context);
    if (
      brief.requestNamedIdea !== undefined &&
      brief.options !== undefined &&
      brief.recommendation !== undefined
    )
      optionRules(
        {
          chosenOption: brief.chosenOption,
          requestNamedIdea: brief.requestNamedIdea,
          options: brief.options,
          recommendation: brief.recommendation,
        },
        context,
      );
  });
export type StoredBrief = z.infer<typeof storedBriefSchema>;

export const BRIEF_TRIAGE_ID_PATTERN = /^triage-[0-9a-f]{10}$/;

export const briefTriageIdSchema = z
  .string()
  .regex(
    BRIEF_TRIAGE_ID_PATTERN,
    "must be a triage id such as triage-0123abcdef",
  );

/** `.idiom/briefs/triage/<id>.json`: a model triage, so `brief plan <id>` can find it. */
export const storedTriageSchema = z
  .object({
    version: z.literal(1),
    id: briefTriageIdSchema,
    request: z.string().min(1),
    rubricVersion: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    verdict: z.enum(briefTriageVerdicts),
    reason: z.string(),
    questions: z.array(z.string()),
  })
  .strict();
export type StoredTriage = z.infer<typeof storedTriageSchema>;

export type CompleteStoredBrief = StoredBrief & {
  [Field in (typeof optionStageFields)[number]]-?: NonNullable<
    StoredBrief[Field]
  >;
};

/** Every options-stage field is present: true of every brief `record` stores. */
export function isCompleteBrief(
  brief: StoredBrief,
): brief is CompleteStoredBrief {
  return optionStageFields.every((field) => brief[field] !== undefined);
}

/** What one research call answers; Idiom fills in the question itself. */
export const briefResearchAnswerSchema = z
  .object({ findings: researchQuestionSchema.shape.findings })
  .strict();

const findingJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    claim: { type: "string" },
    source: { type: "string" },
    verified: { type: "string", enum: ["hands-on", "read"] },
  },
  required: ["claim", "source", "verified"],
};

export const briefResearchAnswerJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      anyOf: [
        { type: "array", items: findingJsonSchema },
        { type: "string", enum: ["nothing found"] },
      ],
    },
  },
  required: ["findings"],
};

/** The options call answers every remaining brief-input field. */
export const briefOptionsAnswerSchema = z
  .object({
    title: briefFields.title,
    decision: briefFields.decision,
    requestNamedIdea: briefFields.requestNamedIdea,
    options: briefFields.options,
    recommendation: briefFields.recommendation,
    acceptanceCriteria: briefFields.acceptanceCriteria,
    outOfScope: z.array(nonEmpty),
  })
  .strict();
export type BriefOptionsAnswer = z.infer<typeof briefOptionsAnswerSchema>;

const stringSchema = { type: "string" };

export const briefOptionsAnswerJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: stringSchema,
    decision: stringSchema,
    requestNamedIdea: { type: "boolean" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: stringSchema,
          title: stringSchema,
          summary: stringSchema,
          kind: { type: "string", enum: [...briefOptionKinds] },
          cost: {
            type: "object",
            additionalProperties: false,
            properties: {
              space: stringSchema,
              steps: stringSchema,
              concepts: stringSchema,
              code: stringSchema,
            },
            required: ["space", "steps", "concepts", "code"],
          },
          rejectedBecause: stringSchema,
        },
        required: ["id", "title", "summary", "kind", "cost"],
      },
    },
    recommendation: {
      type: "object",
      additionalProperties: false,
      properties: { option: stringSchema, reason: stringSchema },
      required: ["option", "reason"],
    },
    acceptanceCriteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: [...briefCriterionKinds] },
          statement: stringSchema,
        },
        required: ["kind", "statement"],
      },
    },
    outOfScope: { type: "array", items: stringSchema },
  },
  required: [
    "title",
    "decision",
    "requestNamedIdea",
    "options",
    "recommendation",
    "acceptanceCriteria",
    "outOfScope",
  ],
};

function issuePath(path: readonly PropertyKey[]): string {
  let rendered = "";
  for (const segment of path) {
    if (typeof segment === "number") rendered += `[${segment}]`;
    else rendered += rendered === "" ? String(segment) : `.${String(segment)}`;
  }
  return rendered || "<root>";
}

/** One `path: message` line per issue, so an agent can fix them in one round. */
export function formatBriefIssues(error: z.ZodError): string[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "invalid_union") {
      // Report the closest branch rather than "Invalid input".
      const branches = issue.errors
        .filter((branch) => branch.length > 0)
        .sort((left, right) => left.length - right.length);
      const best = branches[0];
      if (best !== undefined)
        return best.map(
          (inner) =>
            `${issuePath([...issue.path, ...inner.path])}: ${inner.message}`,
        );
    }
    return [`${issuePath(issue.path)}: ${issue.message}`];
  });
}
