import type { BriefReference } from "../schemas/project.js";

export const BRIEF_PLAN_DEFAULT_MINUTES = 10;
export const BRIEF_PLAN_SEARCHES = { min: 3, max: 6 } as const;

/** What to check, per open question, in each reference product. */
export const BRIEF_PLAN_CHECKS = [
  {
    id: "hover",
    check:
      "Mouse: what appears on hover, and is anything only reachable by hovering?",
  },
  {
    id: "touch",
    check:
      "Touch: with no hover, is the control visible and large enough to tap?",
  },
  {
    id: "keyboard",
    check:
      "Keyboard: focus order, a visible focus indicator, and the control's accessible name.",
  },
  {
    id: "small-screen",
    check:
      "Small screen (390px wide or less): does it fit, wrap, move or disappear?",
  },
  {
    id: "empty-state",
    check: "Empty state: what shows before there is anything to show?",
  },
  {
    id: "error-state",
    check: "Error state: what happens when the action fails or is not allowed?",
  },
] as const;

/** The research rules, stated to the calling agent verbatim. */
export const BRIEF_PLAN_RULES = [
  "Cite every claim with a source URL.",
  "Label each finding hands-on (you used the product) or read (you read about it).",
  'Say "nothing found" rather than guess.',
  'Treat "a competitor has it" as a signal to investigate, not a reason to build.',
] as const;

/** Mirrors the validation `idiom brief record` applies. */
export const BRIEF_RECORD_RULES = [
  "request is the original request, verbatim.",
  'research has one entry per open question; findings is a list of { claim, source, verified } or the string "nothing found", never an empty list.',
  'options has 2 to 4 entries; exactly one is kind "dont-build"; exactly one is kind "requester" when requestNamedIdea is true, none when it is false.',
  "Every option except the recommendation has rejectedBecause; the recommendation does not.",
  "label (one line, at most 40 characters) and sketch (low-fidelity ASCII, at most 16 lines of 72 characters, only where layout is the question) are optional.",
  'stakes is "low" or "high" (default high); reversible defaults to false. The agent may proceed without asking only when the decision is low-stakes and reversible.',
  "geometry criteria state a measurement with a unit, contrast criteria a ratio such as 3:1, input-states criteria name an input.",
  "A criterion may add assertions so idiom check judges the built UI: each names a declared flow, state and CSS selector, plus one of width/height (px or {min,max}), sameSizeAs (a selector), within (a selector), visibleWithoutHover: true, stableOnHover: true, or minContrast (a ratio); tolerance defaults to 1px.",
] as const;

type Standard = {
  topic: string;
  look_for: string;
  url: string;
  when?: RegExp;
};

const STANDARDS: Standard[] = [
  {
    topic: "Target size",
    look_for:
      "WCAG 2.2 SC 2.5.8 Target Size (Minimum): 24 by 24 CSS pixels, or enough spacing.",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html",
    when: /\b(?:size|sizes|large|larger|small|smaller|button|buttons|icon|icons|control|controls|tap|taps)\b/i,
  },
  {
    topic: "Content on hover or focus",
    look_for:
      "WCAG 2.2 SC 1.4.13: hover or focus content is dismissible, hoverable and persistent.",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html",
    when: /\b(?:hover|hovering|tooltip|tooltips|reveal|reveals)\b/i,
  },
  {
    topic: "Keyboard",
    look_for:
      "WCAG 2.2 SC 2.1.1 Keyboard: every function works from a keyboard.",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html",
    when: /\b(?:keyboard|focus|shortcut|shortcuts)\b/i,
  },
  {
    topic: "Focus visible",
    look_for:
      "WCAG 2.2 SC 2.4.7 Focus Visible: the keyboard focus indicator is visible.",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html",
    when: /\b(?:keyboard|focus|shortcut|shortcuts)\b/i,
  },
  {
    topic: "Non-text contrast",
    look_for:
      "WCAG 2.2 SC 1.4.11: icons and control boundaries meet 3:1 against adjacent colours.",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html",
    when: /\b(?:icon|icons|contrast|outline|outlined|colou?r|colou?rs|control|controls|button|buttons)\b/i,
  },
  {
    topic: "Reflow",
    look_for:
      "WCAG 2.2 SC 1.4.10 Reflow: content works at 320 CSS pixels wide without two-way scrolling.",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html",
    when: /\b(?:mobile|small screens?|narrow|responsive|drawer|drawers|sidebar|sidebars)\b/i,
  },
  {
    topic: "ARIA patterns",
    look_for:
      "The WAI-ARIA Authoring Practices pattern closest to the control: expected keyboard behaviour and roles.",
    url: "https://www.w3.org/WAI/ARIA/apg/patterns/",
  },
];

export type BriefPlanTriage = {
  id: string;
  verdict: "design decision" | "no design decision";
  reason: string;
};

export type BriefPlan = {
  request: string;
  triageId?: string | undefined;
  noDecision?: true | undefined;
  inventoryInstructions: string[];
  stateChecklist: string[];
  questions: Array<{ question: string; check: string[] }>;
  references: Record<string, Array<{ name: string; note: string }>>;
  referencesNote?: string | undefined;
  checks: Array<{ id: string; check: string }>;
  standards: Array<{ topic: string; look_for: string; url: string }>;
  budget: { minutes: number; searches: { min: number; max: number } };
  rules: string[];
  recordShape: Record<string, unknown>;
  recordRules: string[];
  next: string[];
};

const TIER_ORDER = ["bar", "always", "floor"];

function groupReferences(
  references: BriefReference[],
): BriefPlan["references"] {
  const tiers = [...new Set(references.map((reference) => reference.tier))]
    .sort((left, right) => {
      const rank = (tier: string) => {
        const index = TIER_ORDER.indexOf(tier);
        return index === -1 ? TIER_ORDER.length : index;
      };
      return rank(left) - rank(right) || left.localeCompare(right);
    })
    .map((tier) => [
      tier,
      references
        .filter((reference) => reference.tier === tier)
        .map((reference) => ({ name: reference.name, note: reference.note })),
    ]);
  return Object.fromEntries(tiers);
}

const PLACEHOLDER_COST = {
  space: "<how much room it takes>",
  steps: "<steps for the user>",
  concepts: "<new concepts the user must learn, or none>",
  code: "<small | medium | large>",
};

/** The exact input `idiom brief record` accepts, with placeholders to replace. */
export function briefRecordShape(options: {
  request: string;
  questions: string[];
  triage?: BriefPlanTriage | undefined;
}): Record<string, unknown> {
  return {
    slug: "<optional lowercase-slug; derived from title when omitted>",
    title: "<short title, at most 120 characters>",
    request: options.request,
    decision: "<the design question being decided>",
    screenQuestion:
      "<optional: the one question the screen answers, in one line>",
    inventory: [
      "<optional: real objects and realistic counts, ranges, units or sizes>",
    ],
    requestNamedIdea: "<true if the request proposed its own solution>",
    ...(options.triage === undefined
      ? {}
      : {
          triage: {
            verdict: options.triage.verdict,
            reason: options.triage.reason,
            questions: options.questions,
          },
        }),
    research: (options.questions.length === 0
      ? ["<open question>"]
      : options.questions
    ).map((question) => ({
      question,
      findings: [
        {
          claim: "<what you found>",
          source: "<https URL>",
          verified: "<hands-on | read>",
        },
      ],
    })),
    options: [
      {
        id: "<requester-idea>",
        title: "<the requester's idea>",
        summary: "<one line>",
        kind: "requester",
        cost: PLACEHOLDER_COST,
        rejectedBecause: "<omit on the recommended option>",
        label: "<optional: short answer label>",
        sketch: "<optional: low-fidelity ASCII, only where layout matters>",
      },
      {
        id: "<alternative>",
        title: "<an established alternative>",
        summary: "<one line>",
        kind: "alternative",
        cost: PLACEHOLDER_COST,
      },
      {
        id: "dont-build",
        title: "<what staying as-is means>",
        summary: "<one line>",
        kind: "dont-build",
        cost: PLACEHOLDER_COST,
        rejectedBecause: "<why not>",
      },
    ],
    recommendation: {
      option: "<an option id>",
      reason: "<why, citing the research>",
    },
    acceptanceCriteria: [
      { kind: "geometry", statement: "<a measurement with a unit>" },
      { kind: "input-states", statement: "<mouse, touch and keyboard>" },
      { kind: "contrast", statement: "<a ratio such as 3:1>" },
      { kind: "behaviour", statement: "<what happens>" },
    ],
    outOfScope: ["<optional>"],
    status: "proposed",
    decidedBy: "<omit until decided; idiom brief decide sets it>",
    supersededBy: "<omit unless another brief replaces this one>",
    stakes: "<low | high; default high>",
    reversible: "<true | false; default false>",
    chosenOption: "<omit; idiom brief decide sets it>",
  };
}

export function buildBriefPlan(options: {
  request: string;
  questions: string[];
  triage?: BriefPlanTriage | undefined;
  references: BriefReference[];
  minutes?: number | undefined;
}): BriefPlan {
  const noDecision = options.triage?.verdict === "no design decision";
  const questions = noDecision ? [] : options.questions;
  const haystack = [options.request, ...questions].join("\n");
  const checks = BRIEF_PLAN_CHECKS.map(({ id, check }) => ({ id, check }));
  return {
    request: options.request,
    ...(options.triage === undefined ? {} : { triageId: options.triage.id }),
    ...(noDecision ? { noDecision: true as const } : {}),
    inventoryInstructions: [
      "Before considering options, state the one question the screen answers in one line (optional screenQuestion in the record).",
      "Inventory the real objects and magnitudes the screen shows: counts, ranges, units and sizes (optional inventory in the record). Gather facts; when unknown, say so rather than fabricate numbers.",
    ],
    stateChecklist: [
      "Build every block's empty, zero, loading and error states. Empty and zero are distinct; loading does not replace error.",
      "Build every row or item's hover, selected, focus and disabled states.",
      "Declare important cases as named flow states so Idiom captures them, including opened drawers, dialogs and menus. The editor base state must also be declared for this opened-state example:",
      JSON.stringify({
        id: "editor+menu",
        description: "Page menu open",
        from: "editor",
        steps: [{ action: "click", selector: "[data-testid=open-menu]" }],
        expect: { selectorPresent: ["[data-testid=page-menu]"] },
      }),
    ],
    questions: questions.map((question) => ({
      question,
      check: checks.map((check) => check.check),
    })),
    references: groupReferences(options.references),
    ...(options.references.length === 0
      ? {
          referencesNote:
            "None configured: name 2–3 established products in this category, say which, and treat them as read, not hands-on, unless you used them.",
        }
      : {}),
    checks,
    standards: STANDARDS.filter(
      (standard) => standard.when === undefined || standard.when.test(haystack),
    ).map(({ topic, look_for, url }) => ({ topic, look_for, url })),
    budget: {
      minutes: options.minutes ?? BRIEF_PLAN_DEFAULT_MINUTES,
      searches: { ...BRIEF_PLAN_SEARCHES },
    },
    rules: [...BRIEF_PLAN_RULES],
    recordShape: briefRecordShape({
      request: options.request,
      questions,
      triage: options.triage,
    }),
    recordRules: [...BRIEF_RECORD_RULES],
    next: noDecision
      ? ["No design decision: write the ticket as usual."]
      : [
          "Research each question within the budget, following the rules.",
          "Fill the record shape and run idiom brief record (MCP: idiom_brief_record).",
          "Ask the requester with the returned question, or proceed on the recommendation only when it says you may.",
          "Record their choice with idiom brief decide <slug> --option <id> (MCP: idiom_brief_decide), then use .idiom/briefs/<slug>.md as the ticket.",
        ],
  };
}

export function renderBriefPlan(plan: BriefPlan): string {
  if (plan.noDecision === true)
    return "No design decision: write the ticket as usual.";
  const referenceTiers = Object.entries(plan.references);
  return [
    "# Research plan",
    `Request: ${plan.request}`,
    ...(plan.triageId === undefined ? [] : [`Triage id: ${plan.triageId}`]),
    `Budget: about ${plan.budget.minutes} minutes and ${plan.budget.searches.min}–${plan.budget.searches.max} searches. Stop when it runs out and record what you have.`,
    "## Inventory before options",
    plan.inventoryInstructions
      .map((instruction) => `- ${instruction}`)
      .join("\n"),
    "## Build every state",
    plan.stateChecklist.map((instruction) => `- ${instruction}`).join("\n"),
    "## Rules",
    plan.rules.map((rule) => `- ${rule}`).join("\n"),
    "## Open questions",
    plan.questions
      .map((question, index) => `${index + 1}. ${question.question}`)
      .join("\n"),
    "For each question, check in each reference product:",
    plan.checks.map((check) => `- ${check.check}`).join("\n"),
    "## Reference products",
    referenceTiers.length === 0
      ? (plan.referencesNote ?? "None configured.")
      : referenceTiers
          .map(
            ([tier, products]) =>
              `**${tier}**\n\n${products.map((product) => `- ${product.name}: ${product.note}`).join("\n")}`,
          )
          .join("\n\n"),
    "## Standards and research to look for",
    plan.standards
      .map(
        (standard) =>
          `- ${standard.topic}: ${standard.look_for} ${standard.url}`,
      )
      .join("\n"),
    "## Record",
    "Fill this shape and pass it to idiom brief record (stdin or a file) or the idiom_brief_record MCP tool. Omit the optional fields you do not use.",
    plan.recordRules.map((rule) => `- ${rule}`).join("\n"),
    `\`\`\`json\n${JSON.stringify(plan.recordShape, null, 2)}\n\`\`\``,
    "## Next",
    plan.next.map((step, index) => `${index + 1}. ${step}`).join("\n"),
  ].join("\n\n");
}
