import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serverAnswers } from "../capture/process.js";
import type { Project } from "../schemas/project.js";
import type { GateServer } from "./types.js";

/** A Next.js build id from a served page (`__NEXT_DATA__` or a static path). */
export function servedBuildId(html: string): string | undefined {
  return (
    /"buildId"\s*:\s*"([^"]+)"/.exec(html)?.[1] ??
    /\/_next\/static\/([^/"']+)\/_(?:buildManifest|ssgManifest)/.exec(html)?.[1]
  );
}

/**
 * Whether a server already answering at `readyUrl` serves this working tree.
 * Verifiable only with a build id on disk; otherwise reuse is unverified.
 */
export async function planServerReuse(options: {
  projectDirectory: string;
  project: Project;
  reuse: boolean;
  production: boolean;
  /** Absolute paths of the changed UI files, for build staleness. */
  changedFiles: string[];
  fetch?: typeof globalThis.fetch | undefined;
}): Promise<GateServer> {
  if (options.production)
    return {
      mode: "production-reuse",
      reason: "production build keyed on working-tree content",
    };
  if (!options.reuse)
    return {
      mode: "fresh",
      reason: "server.reuse is off (pass --reuse-server)",
    };
  const { readyUrl } = options.project.server;
  if (!(await serverAnswers(readyUrl, { fetch: options.fetch })))
    return { mode: "fresh", reason: `nothing answers at ${readyUrl}` };
  const distDir = options.project.server.production?.distDir;
  const buildIdPath =
    distDir === undefined
      ? undefined
      : join(resolve(options.projectDirectory, distDir), "BUILD_ID");
  if (buildIdPath === undefined || !existsSync(buildIdPath))
    return {
      mode: "reused",
      verified: false,
      reason: "no build id on disk to compare",
    };
  const onDisk = (await readFile(buildIdPath, "utf8")).trim();
  let served: string | undefined;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(readyUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    served = servedBuildId(await response.text());
  } catch {
    served = undefined;
  }
  if (served === undefined)
    return {
      mode: "reused",
      verified: false,
      reason: "the served page names no build id",
    };
  if (served !== onDisk)
    return {
      mode: "fresh",
      reason: `served build ${served} is not ${distDir} build ${onDisk}`,
    };
  const built = (await stat(buildIdPath)).mtimeMs;
  for (const file of options.changedFiles) {
    try {
      if ((await stat(file)).mtimeMs > built)
        return {
          mode: "fresh",
          reason: `stale build: ${file} changed after ${distDir}/BUILD_ID`,
        };
    } catch {
      // A deleted file cannot be newer than the build.
    }
  }
  return { mode: "reused", verified: true, reason: `build ${onDisk}` };
}
