import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const templateNames = [
  "PRODUCT.md",
  "DESIGN.md",
  "project.json",
  "rules.json",
  "decisions.jsonl",
  "finding-names.json",
  "ruling-names.json",
] as const;

export type TemplateName = (typeof templateNames)[number];

export const idiomSkillFileNames = ["SKILL.md", "init.md"] as const;

export type IdiomSkillFileName = (typeof idiomSkillFileNames)[number];

export function idiomSkillTemplatePath(name: IdiomSkillFileName): string {
  return join("idiom", name);
}

export function templatesDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

export async function readTemplate(name: TemplateName): Promise<string> {
  return readFile(join(templatesDirectory(), name), "utf8");
}

export async function readIdiomSkillFile(
  name: IdiomSkillFileName,
): Promise<string> {
  return readFile(
    join(templatesDirectory(), idiomSkillTemplatePath(name)),
    "utf8",
  );
}

export async function readIdiomSkillTemplate(): Promise<string> {
  return readIdiomSkillFile("SKILL.md");
}

export function autobuildTemplatePath(): string {
  return join(templatesDirectory(), "autobuild.idiom.toml");
}

export function autobuildVerifierSkillTemplatePath(): string {
  return join(templatesDirectory(), "ab-verify-idiom", "SKILL.md");
}

export async function readAutobuildTemplate(): Promise<string> {
  return readFile(autobuildTemplatePath(), "utf8");
}

export async function readAutobuildVerifierSkillTemplate(): Promise<string> {
  return readFile(autobuildVerifierSkillTemplatePath(), "utf8");
}
