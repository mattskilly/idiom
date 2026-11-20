import type { GitRead } from "../changed/git.js";
import { findProjectDirectory, resolveProjectArgument } from "../project.js";
import { buildScorecard, type Scorecard } from "../scorecard/build.js";
import { loadScorecardInputs } from "../scorecard/load.js";
import { renderScorecard } from "../scorecard/render.js";
import { weekWindow } from "../scorecard/weeks.js";

/**
 * `idiom scorecard`: per ISO week, who found each UI problem first and how
 * many findings the director accepted. Offline; reads `.idiom/` and stored
 * runs only.
 */
export async function scorecardCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  since?: string | undefined;
  weeks?: string | undefined;
  verbose?: boolean | undefined;
  now?: Date | undefined;
  git?: GitRead | undefined;
}): Promise<{ card: Scorecard; text: string; warnings: string[] }> {
  // The window is checked before anything is read.
  const window = weekWindow({
    now: options.now ?? new Date(),
    weeks: options.weeks,
    since: options.since,
  });
  const projectDirectory = await findProjectDirectory(
    resolveProjectArgument(options.project, options.cwd),
  );
  const inputs = await loadScorecardInputs({
    projectDirectory,
    git: options.git,
  });
  const card = buildScorecard({
    ...inputs,
    window,
    verbose: options.verbose,
  });
  return {
    card,
    text: renderScorecard(card).join("\n"),
    warnings: inputs.warnings,
  };
}
