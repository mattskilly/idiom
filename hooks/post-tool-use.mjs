import { resolve } from "node:path";
import {
  createBudget,
  flowReminder,
  matchesUI,
  normalizePath,
  readInput,
  recordEdit,
  resolveContext,
} from "./lib.mjs";

const budget = createBudget();
try {
  const input = await readInput(budget);
  if (input && ["Edit", "Write", "MultiEdit"].includes(input.tool_name)) {
    const context = await resolveContext(input.cwd, budget);
    if (context) {
      const file = input.tool_input?.file_path;
      const path = await normalizePath(
        context,
        typeof file === "string"
          ? resolve(input.cwd, file.replaceAll("\\", "/"))
          : undefined,
        budget,
      );
      if (path && matchesUI(path, context.globs)) {
        await recordEdit(context, path, budget);
        const reminder = await flowReminder(context, budget);
        budget.check();
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: `UI changed: ${path.replace(/[\r\n\t]/g, " ").slice(0, 240)}. ${reminder}`,
            },
          }),
        );
      }
    }
  }
} catch {
  /* Hooks fail open, including malformed input and deadline expiry. */
} finally {
  budget.close();
}
