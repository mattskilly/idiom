import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  idiomSkillFileNames,
  readAutobuildVerifierSkillTemplate,
  readIdiomSkillFile,
  templatesDirectory,
} from "../templates.js";
import { IDIOM_VERSION } from "../version.js";
import type { Distribution, SkillName } from "./types.js";
export const skillNames: SkillName[] = ["idiom", "ab-verify-idiom"];
export const canonicalPath = (skill: SkillName) => `.agents/skills/${skill}`;
export const discoveryPath = (skill: SkillName) => `.claude/skills/${skill}`;
export const discoveryTarget = (skill: SkillName) =>
  `../../.agents/skills/${skill}`;
export async function readDistribution(): Promise<Distribution> {
  const idiom: Distribution["skills"]["idiom"] = {};
  for (const name of idiomSkillFileNames)
    idiom[name] = {
      content: await readIdiomSkillFile(name),
      incomingPath: join(templatesDirectory(), "idiom", name),
    };
  return {
    version: IDIOM_VERSION,
    skills: {
      idiom,
      "ab-verify-idiom": {
        "SKILL.md": {
          content: await readAutobuildVerifierSkillTemplate(),
          incomingPath: join(templatesDirectory(), "ab-verify-idiom/SKILL.md"),
        },
      },
    },
  };
}
export type History = {
  schema: 1;
  releases: {
    version: string;
    tag: string;
    tagObject: string;
    commit: string;
    files: Record<string, string>;
  }[];
};
export async function readHistory(): Promise<History> {
  return JSON.parse(
    await readFile(
      join(templatesDirectory(), "skill-history/catalog.json"),
      "utf8",
    ),
  );
}
