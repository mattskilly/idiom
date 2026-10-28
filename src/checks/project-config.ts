import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDecisionLog } from "../decisions/log.js";
import { designChoicesFrom } from "../design/decide.js";
import { parseRulingBlocks } from "../rulings/law.js";
import type { Project } from "../schemas/project.js";
import { checksConfigFrom } from "./registry.js";
import type { ChecksConfig, ScaleRulingRecord } from "./types.js";

/**
 * Recorded design-system answers in the project's design law. A missing
 * design file has none; a malformed ruling block fails as `idiom ruling`
 * does.
 */
async function scaleRulings(
  projectDirectory: string,
  designFile: string,
): Promise<ScaleRulingRecord[]> {
  let source: string;
  try {
    source = await readFile(join(projectDirectory, designFile), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseRulingBlocks(source).resolutions.flatMap((resolution) =>
    resolution.scale === undefined
      ? []
      : [
          {
            id: resolution.id,
            fingerprint: resolution.fingerprint,
            answer: resolution.scale.answer,
            property: resolution.scale.property,
            value: resolution.scale.value,
            context: resolution.scale.context,
            ...(resolution.scale.token === undefined
              ? {}
              : { token: resolution.scale.token }),
          },
        ],
  );
}

/**
 * Checks configuration for a validated project, including recorded design
 * reference choices and design-system answers, so review, check, fix,
 * baseline and verify all emit the same candidates for the same decisions.
 * A recorded add-step extends the effective scale for its context only.
 */
export async function projectChecksConfig(validated: {
  projectDirectory: string;
  project: Pick<Project, "checks"> & {
    design?: Pick<Project["design"], "designFile"> | undefined;
  };
}): Promise<ChecksConfig> {
  const designChoices = designChoicesFrom(
    await readDecisionLog(validated.projectDirectory),
  );
  return {
    ...checksConfigFrom(validated.project.checks),
    ...(designChoices.length ? { designChoices } : {}),
    scaleQuestions: {
      rulings:
        validated.project.design === undefined
          ? []
          : await scaleRulings(
              validated.projectDirectory,
              validated.project.design.designFile,
            ),
    },
  };
}
