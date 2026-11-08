import { readFile } from "node:fs/promises";
import { readDecisionLogEntries } from "../decisions/log.js";
import { IdiomError } from "../errors.js";
import type { RulingResolution } from "../schemas/ruling.js";
import { parseRulingBlocks, renderRulingBlock } from "./law.js";

/** Source design prose and state-checkout memory form one effective law. */
export async function effectiveLaw(
  source: string,
  stateProjectDirectory: string,
) {
  const law = parseRulingBlocks(source);
  const resolutions = [...law.resolutions];
  const added: RulingResolution[] = [];
  for (const entry of await readDecisionLogEntries(stateProjectDirectory)) {
    if (entry.decision !== "ruling") continue;
    const next = entry.resolution;
    const existing = resolutions.find(
      (item) => item.fingerprint === next.fingerprint,
    );
    if (existing) {
      const answer = (item: RulingResolution) =>
        JSON.stringify({
          outcome: item.outcome,
          wording: item.wording,
          scale: item.scale,
        });
      if (answer(existing) !== answer(next))
        throw new IdiomError(
          `conflicting ruling resolutions for ${next.fingerprint}`,
        );
      continue;
    }
    resolutions.push(next);
    added.push(next);
  }
  return {
    ...law,
    resolutions,
    designMd: [source, ...added.map((item) => renderRulingBlock(item))].join(
      "\n\n",
    ),
  };
}

export async function readEffectiveLaw(
  designPath: string,
  stateProjectDirectory: string,
) {
  let source = "";
  try {
    source = await readFile(designPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return effectiveLaw(source, stateProjectDirectory);
}
