import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
export type InitConfirmationRequest =
  | { kind: "apply-wiring"; prompt: string; path: string; diff: string }
  | { kind: "offer-system-learning"; prompt: string; path: string }
  | {
      kind: "apply-system-learning";
      prompt: string;
      path: string;
      diff: string;
    }
  | { kind: "offer-flow-generation"; prompt: string; path: string }
  | {
      kind: "replace-scaffold-file";
      prompt: string;
      path: string;
    }
  | {
      kind: "offer-autobuild-wiring";
      prompt: string;
      path: string;
    }
  | {
      kind: "apply-autobuild-config";
      prompt: string;
      path: string;
      diff: string;
    }
  | { kind: "offer-brief-instruction"; prompt: string; path: string }
  | {
      kind: "offer-idiom-tickets" | "select-verifier-flow";
      prompt: string;
      path: string;
    }
  | { kind: "offer-agent-setup"; prompt: string; path: string };

export type Confirmation = (
  request: InitConfirmationRequest,
) => Promise<boolean>;

export async function defaultConfirmation(
  request: InitConfirmationRequest,
): Promise<boolean> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(request.prompt);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
