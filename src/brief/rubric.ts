import { readFile } from "node:fs/promises";
import { IdiomError } from "../errors.js";
import { briefRubricPath } from "../templates.js";

export type BriefRubric = {
  version: number;
  text: string;
  triggers: string[];
  nonTriggers: string[];
};

function sectionIds(text: string, heading: string): string[] {
  const section = text.split(`\n## ${heading}\n`)[1]?.split(/\n## /)[0];
  if (section === undefined)
    throw new IdiomError(`brief rubric has no ## ${heading} section`);
  const ids = [...section.matchAll(/^- `([a-z][a-z0-9-]*)`: /gm)].map(
    (match) => match[1] as string,
  );
  if (ids.length === 0)
    throw new IdiomError(`brief rubric lists no ${heading.toLowerCase()}`);
  return ids;
}

export function parseBriefRubric(text: string): BriefRubric {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const version = Number(/^version:\s*(\d+)\s*$/m.exec(front?.[1] ?? "")?.[1]);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new IdiomError("brief rubric has no positive integer version");
  return {
    version,
    text,
    triggers: sectionIds(text, "Triggers"),
    nonTriggers: sectionIds(text, "Non-triggers"),
  };
}

export async function readBriefRubric(): Promise<BriefRubric> {
  return parseBriefRubric(await readFile(briefRubricPath(), "utf8"));
}
