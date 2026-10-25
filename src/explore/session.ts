import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { IdiomError } from "../errors.js";
import type { ExplorationCandidate } from "../schemas/exploration.js";

export type ExplorationPrompts = {
  choose(candidates: ExplorationCandidate[]): Promise<string | undefined>;
  refinement(candidate: ExplorationCandidate): Promise<string | undefined>;
  reason(inferred: string): Promise<string>;
  repairs(): Promise<boolean>;
};

async function ask(question: string): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

export const defaultExplorationPrompts: ExplorationPrompts = {
  async choose(candidates) {
    const answer = (
      await ask(
        `Choose ${candidates.map((candidate) => candidate.label).join(", ")}, or none: `,
      )
    ).trim();
    if (answer === "" || /^none$/i.test(answer)) return undefined;
    return answer;
  },
  async refinement() {
    const answer = (
      await ask("Optional one-time refinement (blank to continue): ")
    ).trim();
    return answer === "" ? undefined : answer;
  },
  async reason(inferred) {
    const answer = (
      await ask(`Why did this direction win? [${inferred}] `)
    ).trim();
    return answer === "" ? inferred : answer;
  },
  async repairs() {
    return /^(?:y|yes)$/i.test(
      (await ask("Create bounded repair tickets? [y/N] ")).trim(),
    );
  },
};

export class ExplorationSession {
  private refinementUsed = false;
  readonly candidates: ExplorationCandidate[];

  constructor(candidates: ExplorationCandidate[]) {
    this.candidates = candidates;
  }

  select(label: string | undefined): ExplorationCandidate | undefined {
    if (label === undefined) return undefined;
    const normalized = label.trim().toLowerCase();
    const match = this.candidates.find(
      (candidate) =>
        candidate.label.trim().toLowerCase() === normalized ||
        candidate.direction.trim().toLowerCase() === normalized,
    );
    if (match === undefined)
      throw new IdiomError(
        `unknown exploration candidate ${JSON.stringify(label)}`,
      );
    return match;
  }

  useRefinement(instruction: string): string {
    if (this.refinementUsed)
      throw new IdiomError(
        "This exploration has already used its one refinement.",
      );
    const trimmed = instruction.trim();
    if (trimmed === "") throw new IdiomError("refinement must not be blank");
    this.refinementUsed = true;
    return trimmed;
  }
}
