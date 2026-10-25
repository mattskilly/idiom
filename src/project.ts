import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { IdiomError } from "./errors.js";

const PROJECT_FILE = join(".idiom", "project.json");

export function resolveProjectArgument(
  project: string | undefined,
  cwd = process.cwd(),
): string {
  if (project === undefined) return resolve(cwd);
  return isAbsolute(project) ? resolve(project) : resolve(cwd, project);
}

export async function findProjectDirectory(start: string): Promise<string> {
  let current = resolve(start);
  while (true) {
    try {
      await access(join(current, PROJECT_FILE));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new IdiomError(
          `no .idiom/project.json found from ${resolve(start)} or any parent directory`,
        );
      }
      current = parent;
    }
  }
}

export async function findOptionalProjectDirectory(
  start: string,
): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    try {
      await access(join(current, PROJECT_FILE));
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}
