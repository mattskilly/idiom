import { basename } from "node:path";
import { selectColorSchemes } from "../capture/resolve.js";
import { validateProject } from "../validation.js";

export async function validateCommand(options: {
  project?: string | undefined;
  flow?: string | undefined;
  cwd?: string | undefined;
}): Promise<string> {
  const result = await validateProject(options);
  const flowNames = result.flows
    .map(
      ({ flow }) =>
        `${flow.id} (color schemes: ${selectColorSchemes(result.project, flow).join(", ")})`,
    )
    .join(", ");
  return `Validated ${basename(result.projectDirectory)}: ${flowNames}`;
}
