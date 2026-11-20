import { z } from "zod";

/** Where an answer's precedent came from. */
export const precedentKinds = ["ruling", "decision", "law"] as const;
export type PrecedentKind = (typeof precedentKinds)[number];

/**
 * One line of `.idiom/escalation-answers.jsonl`: an autobuild escalation
 * Idiom answered from precedent, so the director can audit and overrule it.
 */
export const escalationAnswerSchema = z
  .object({
    version: z.literal(1),
    at: z.string().datetime({ offset: true }),
    build: z.string().trim().min(1),
    escalation: z.string().trim().min(1),
    phase: z.string().trim().min(1),
    question: z.string().trim().min(1),
    guidance: z.string().trim().min(1),
    precedent: z
      .object({
        kind: z.enum(precedentKinds),
        id: z.string().trim().min(1),
        where: z.string().trim().min(1),
        text: z.string().trim().min(1),
        stance: z.enum(["accepted", "rejected"]).optional(),
        score: z.number().min(0).max(1),
        sharedTerms: z.array(z.string().min(1)),
      })
      .strict(),
    actor: z.literal("idiom"),
  })
  .strict();

export type EscalationAnswer = z.infer<typeof escalationAnswerSchema>;
