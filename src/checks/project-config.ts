import { readDecisionLog } from "../decisions/log.js";
import { designChoicesFrom } from "../design/decide.js";
import type { Project } from "../schemas/project.js";
import { checksConfigFrom } from "./registry.js";
import type { ChecksConfig } from "./types.js";

/**
 * Checks configuration for a validated project, including recorded design
 * reference choices, so review, check, fix, baseline and verify all emit the
 * same candidates for the same decisions.
 */
export async function projectChecksConfig(validated: {
  projectDirectory: string;
  project: Pick<Project, "checks">;
}): Promise<ChecksConfig> {
  const designChoices = designChoicesFrom(
    await readDecisionLog(validated.projectDirectory),
  );
  return {
    ...checksConfigFrom(validated.project.checks),
    ...(designChoices.length ? { designChoices } : {}),
  };
}
