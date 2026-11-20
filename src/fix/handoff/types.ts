import type { Finding } from "../../schemas/finding.js";

/** Where the director's words for a finding came from, always labelled. */
export type WordsSource =
  | "learned"
  | "ruling"
  | "rules"
  | "design"
  | "rule-reference";

/** One finding the verify step hands its agent to fix, in rank order. */
export type HandoffFinding = {
  rank: number;
  id: string;
  /** Stable occurrence identity, compared across rounds (never the bare id). */
  fingerprint?: string | undefined;
  /** state/viewport[/scheme] — the coordinate key rounds are compared on. */
  key: string;
  flow: string;
  state: string;
  viewport: string;
  colorScheme?: string | undefined;
  severity: Finding["severity"];
  rule: string;
  category: string;
  selector: string;
  measured: { summary: string; value?: string | undefined };
  words: { text: string; source: WordsSource; ref: string };
  suggestedFix: string;
  doneWhen: string[];
  suggestedArea?: string | undefined;
  /** Crop images, relative to the handoff directory. */
  crops: string[];
};

export type HandoffNext = "pass" | "repair" | "stop" | "skip";

/**
 * What the fix step does with the edits a re-verify round judged: keep them
 * (commit) when they fixed a target and introduced nothing, otherwise revert.
 */
export type HandoffOutcome = "commit" | "revert";

export type HandoffProgress = {
  fixed: string[];
  persisting: string[];
  introduced: string[];
};

/** `<dir>/round-N/handoff.json`: one gate run of the fix step. */
export type HandoffRound = {
  version: 1;
  round: number;
  base: string;
  head: string;
  next: HandoffNext;
  /** The top three blocking new findings this round asks the agent to fix. */
  targets: HandoffFinding[];
  /** Blocking new findings beyond the top three. */
  remaining: HandoffFinding[];
  progress?: HandoffProgress | undefined;
  /** Re-verify rounds only: what happens to the edits this round judged. */
  outcome?: HandoffOutcome | undefined;
  /**
   * The round whose findings describe HEAD once this round's outcome is
   * applied, and so the round the next repair works from: this round, or
   * after a revert the last kept round.
   */
  repairFrom?: number | undefined;
  /** The gate's skip line, when it skipped. */
  line?: string | undefined;
  timing: { totalMs: number };
};

/** The most repair rounds the step runs; round 0 is the initial check. */
export const MAX_REPAIR_ROUNDS = 3;
/** The most findings one repair round takes on. */
export const TARGETS_PER_ROUND = 3;
