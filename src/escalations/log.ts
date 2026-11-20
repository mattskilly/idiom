import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IdiomError } from "../errors.js";
import {
  type EscalationAnswer,
  escalationAnswerSchema,
} from "../schemas/escalation-answer.js";

export const escalationAnswerLogPath = (stateProjectDirectory: string) =>
  join(stateProjectDirectory, ".idiom", "escalation-answers.jsonl");

/** The harvest key of an answered escalation, as `learn --harvest` keys it. */
export const answerKey = (build: string, escalation: string) =>
  `autobuild:${build}:${escalation}`;

/** Every answer Idiom gave, oldest first. A bad line names `file:line`. */
export async function readEscalationAnswers(
  stateProjectDirectory: string,
): Promise<EscalationAnswer[]> {
  const path = escalationAnswerLogPath(stateProjectDirectory);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").flatMap((line, index) => {
    if (line.trim() === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new IdiomError(
        `.idiom/escalation-answers.jsonl:${index + 1} is not valid JSON`,
      );
    }
    const parsed = escalationAnswerSchema.safeParse(value);
    if (!parsed.success)
      throw new IdiomError(
        `.idiom/escalation-answers.jsonl:${index + 1} is not an escalation answer this Idiom reads: ${parsed.error.issues
          .map(
            (issue) =>
              `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
          )
          .join("; ")}`,
      );
    return [parsed.data];
  });
}

/** Append one answer as a JSON line, creating `.idiom/` when needed. */
export async function appendEscalationAnswer(
  stateProjectDirectory: string,
  record: EscalationAnswer,
): Promise<void> {
  const path = escalationAnswerLogPath(stateProjectDirectory);
  const parsed = escalationAnswerSchema.parse(record);
  await mkdir(dirname(path), { recursive: true });
  let before = "";
  try {
    before = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const separator = before === "" || before.endsWith("\n") ? "" : "\n";
  await appendFile(path, `${separator}${JSON.stringify(parsed)}\n`);
}
