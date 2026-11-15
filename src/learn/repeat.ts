import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LearnedEntry } from "../schemas/learned.js";
import { readLearnedLog } from "./misses.js";

const normalize = (words: string) => words.trim().replace(/\s+/g, " ");

async function digest(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * The learned record an observation already became: the same words
 * (whitespace collapsed) and the same screenshot bytes, or no screenshot on
 * either side. A named flow or state must match too; the selector does not
 * count. The newest match wins. A stored screenshot copy that is gone or
 * unreadable never matches, so the catch can be recorded again.
 */
export async function findRepeatedLearning(options: {
  projectDirectory: string;
  observation: string;
  /** Absolute path of the incoming screenshot. */
  screenshot?: string | undefined;
  flow?: string | undefined;
  state?: string | undefined;
}): Promise<LearnedEntry | undefined> {
  const words = normalize(options.observation);
  const candidates = (await readLearnedLog(options.projectDirectory)).filter(
    (entry) =>
      normalize(entry.observation) === words &&
      (options.flow === undefined || entry.flow === options.flow) &&
      (options.state === undefined || entry.state === options.state) &&
      (entry.screenshot === undefined) === (options.screenshot === undefined),
  );
  if (candidates.length === 0) return undefined;
  if (options.screenshot === undefined) return candidates.at(-1);
  const incoming = await digest(options.screenshot);
  if (incoming === undefined) return undefined;
  for (const entry of candidates.reverse()) {
    if (entry.screenshot === undefined) continue;
    const stored = await digest(
      join(options.projectDirectory, entry.screenshot),
    );
    if (stored === incoming) return entry;
  }
  return undefined;
}
