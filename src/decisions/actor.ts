import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const actorSchema = z.enum(["human", "agent"]);
export type Actor = z.infer<typeof actorSchema>;
export type ActorMetadata = { actor: Actor; agent?: string | undefined };
export type ActorDependencies = {
  env?: NodeJS.ProcessEnv | undefined;
  isDirectory?: ((path: string) => Promise<boolean>) | undefined;
  exists?: ((path: string) => Promise<boolean>) | undefined;
  read?: ((path: string) => Promise<string>) | undefined;
};
const nonblank = (value: string | undefined) => value?.trim() || undefined;
const exists = async (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const isDirectory = async (path: string) =>
  stat(path).then(
    (value) => value.isDirectory(),
    () => false,
  );

/** Runtime hints, not authenticated identity. Never infer identity from credentials. */
export async function resolveActor(
  options: {
    source?: "cli" | "mcp" | undefined;
    actor?: Actor | undefined;
    cwd?: string | undefined;
    projectDirectory?: string | undefined;
    dependencies?: ActorDependencies | undefined;
  } = {},
): Promise<ActorMetadata> {
  if (options.source === "mcp") return { actor: "agent", agent: "mcp" };
  if (options.actor !== undefined) actorSchema.parse(options.actor);
  if (options.actor === "human") return { actor: "human" };
  const deps = options.dependencies;
  const env = deps?.env ?? process.env;
  const build = nonblank(env.AB_BUILD);
  if (build) return { actor: "agent", agent: `autobuild:${build}` };
  const autobuild = !!(nonblank(env.AB_PHASE) || nonblank(env.AB_SESSION));
  const project = options.projectDirectory && resolve(options.projectDirectory);
  const start = resolve(options.cwd ?? process.cwd());
  // Check explicit projects too, including projects outside the invoking checkout.
  const paths = new Set<string>();
  let directory = start;
  while (true) {
    paths.add(directory);
    if (
      directory === project ||
      (await (deps?.exists ?? exists)(join(directory, ".git")))
    )
      break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (project) paths.add(project);
  // Only a context naming a build counts: harvest runs leave build-less `.ab/`
  // directories in real checkouts, and a person typing there is still human.
  for (const path of paths) {
    if (!(await (deps?.isDirectory ?? isDirectory)(join(path, ".ab"))))
      continue;
    try {
      const context = JSON.parse(
        await (deps?.read ?? ((file) => readFile(file, "utf8")))(
          join(path, ".ab", "context.json"),
        ),
      );
      const slug =
        typeof context?.build === "string"
          ? nonblank(context.build)
          : undefined;
      if (slug) return { actor: "agent", agent: `autobuild:${slug}` };
    } catch {
      /* Missing or broken context is not a build; live sessions set AB_* instead. */
    }
  }
  if (autobuild) return { actor: "agent", agent: "autobuild" };
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_CHILD_SESSION === "1")
    return { actor: "agent", agent: "claude-code" };
  if (
    nonblank(env.CODEX_THREAD_ID) ||
    nonblank(env.CODEX_SESSION_ID) ||
    env.CODEX_CI === "1"
  )
    return { actor: "agent", agent: "codex" };
  return { actor: options.actor ?? "human" };
}

/** New writes are narrower than the historically accepted string actor input. */
export function newActor(metadata: ActorMetadata): ActorMetadata {
  const actor = actorSchema.parse(metadata.actor);
  return actor === "human"
    ? { actor }
    : { actor, ...(metadata.agent ? { agent: metadata.agent } : {}) };
}
