import { MalformedCritiqueError, parseModelResponse } from "./schema.js";
import type { CritiqueInput, CritiqueResult } from "./types.js";

function parse(output: unknown, input: CritiqueInput): CritiqueResult {
  return parseModelResponse(
    JSON.stringify(output),
    input.screenshots,
    input.references,
    input.screenshots,
    input.designMd,
    input.spec !== undefined,
    input.page,
    input.designImages,
  );
}

/**
 * The CLI providers' shared contract: validate the structured output locally
 * and, when it is malformed, ask once for a complete replacement.
 */
export async function critiqueWithRepair(options: {
  input: CritiqueInput;
  prompt: string;
  invoke: (prompt: string) => Promise<unknown>;
}): Promise<CritiqueResult> {
  const first = await options.invoke(options.prompt);
  try {
    return parse(first, options.input);
  } catch (error) {
    if (!(error instanceof MalformedCritiqueError)) throw error;
    const repairPrompt = [
      options.prompt,
      "## Rejected structured output",
      JSON.stringify(first, null, 2),
      "## Local validation issues",
      error.issues.join("\n"),
      "Return a complete replacement batch that fixes every issue. Re-read the same evidence; do not return a patch or explanation.",
    ].join("\n\n");
    return parse(await options.invoke(repairPrompt), options.input);
  }
}
