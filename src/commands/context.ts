import { type ContextDependencies, designBrief } from "../context/brief.js";

export type { ContextDependencies };

/**
 * Read-only projection of committed guidance and recorded judgment into one
 * bounded Markdown brief. It writes nothing, reads no credential, makes no
 * network call, and runs no child process other than the local Git topology
 * query reused from verify — whose failure degrades rather than fails.
 */
export async function contextCommand(options: {
  project?: string | undefined;
  cwd?: string | undefined;
  flow?: string | undefined;
  dependencies?: ContextDependencies | undefined;
}): Promise<string> {
  return await designBrief(options);
}
