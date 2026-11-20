import { z } from "zod";
import { IdiomError } from "../errors.js";
import {
  defaultExec,
  type Exec,
  harvestEnvironment,
} from "../learn/harvest-sources.js";
import { executableOnPath } from "../wiring/detect.js";

/** An open autobuild escalation, as `ab build status <slug> --json` prints it. */
export type OpenEscalation = {
  id: string;
  phase: string;
  round?: number | undefined;
  source: string;
  question: string;
  refs?: string[] | undefined;
};

export type BuildEscalations = {
  slug: string;
  /** The build's status in the same read as its escalations. */
  status: string;
  escalations: OpenEscalation[];
};

export type OpenEscalationsResult =
  | { status: "read"; builds: BuildEscalations[]; skipped: string[] }
  | { status: "unavailable"; reason: string };

type AbOptions = {
  root: string;
  environment: NodeJS.ProcessEnv;
  exec?: Exec | undefined;
};

/** The first stderr line of a failed command, else its message. */
function reason(error: unknown): string {
  const failed = error as { code?: unknown; stderr?: unknown };
  if (failed.code === "ENOENT") return "ab is not installed";
  const stderr = typeof failed.stderr === "string" ? failed.stderr : "";
  const line = stderr
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line ?? (error instanceof Error ? error.message : String(error));
}

/**
 * Run `ab` without the ambient build identity: inside a phase `ab builds` is
 * denied and `ab answer` refuses to answer the phase's own build.
 */
function ab(options: AbOptions) {
  const exec = options.exec ?? defaultExec;
  const env = harvestEnvironment(options.environment);
  return async (args: string[]): Promise<string> =>
    (await exec("ab", args, { cwd: options.root, env })).stdout;
}

function json(args: string[], stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`ab ${args.slice(0, 2).join(" ")} printed non-JSON output`);
  }
}

const buildListSchema = z.array(
  z.looseObject({ slug: z.string().min(1), status: z.string().min(1) }),
);
const escalationSchema = z.looseObject({
  id: z.string().min(1),
  phase: z.string().min(1),
  round: z.number().int().optional(),
  source: z.string().min(1),
  question: z.string(),
  refs: z.array(z.string()).optional(),
});
const statusSchema = z.looseObject({
  status: z.string().min(1),
  openEscalations: z.array(escalationSchema).default([]),
});

/** Builds that can hold an open escalation. */
const WAITING = new Set(["blocked", "paused"]);

/**
 * Every open escalation on the repository's active builds, read offline
 * through the local `ab` CLI. Read-only.
 */
export async function readOpenEscalations(
  options: AbOptions,
): Promise<OpenEscalationsResult> {
  if (!(await executableOnPath("ab", { environment: options.environment })))
    return { status: "unavailable", reason: "ab is not installed" };
  const run = ab(options);
  let list: z.infer<typeof buildListSchema>;
  try {
    const args = ["builds", "--json"];
    const parsed = buildListSchema.safeParse(json(args, await run(args)));
    if (!parsed.success)
      return {
        status: "unavailable",
        reason: "ab builds --json printed an unknown shape",
      };
    list = parsed.data;
  } catch (error) {
    return { status: "unavailable", reason: reason(error) };
  }
  const builds: BuildEscalations[] = [];
  const skipped: string[] = [];
  for (const build of list) {
    if (!WAITING.has(build.status)) continue;
    const args = ["build", "status", build.slug, "--json"];
    try {
      const parsed = statusSchema.safeParse(json(args, await run(args)));
      if (!parsed.success) throw new Error("unknown status shape");
      builds.push({
        slug: build.slug,
        status: parsed.data.status,
        escalations: parsed.data.openEscalations.map((escalation) => ({
          id: escalation.id,
          phase: escalation.phase,
          ...(escalation.round === undefined
            ? {}
            : { round: escalation.round }),
          source: escalation.source,
          question: escalation.question,
          ...(escalation.refs === undefined ? {} : { refs: escalation.refs }),
        })),
      });
    } catch (error) {
      // One unreadable build does not hide the rest.
      skipped.push(`${build.slug}: ${reason(error)}`);
    }
  }
  return { status: "read", builds, skipped };
}

/**
 * Answer a blocked build with guidance: `ab answer <slug> <text>`. Never a
 * bare retry, a dismissal, a spec revision or an abort.
 */
export async function answerBuild(
  options: AbOptions & { slug: string; text: string },
): Promise<void> {
  if (options.text.trim() === "")
    throw new IdiomError("refusing to answer an escalation with blank text");
  try {
    await ab(options)(["answer", options.slug, options.text]);
  } catch (error) {
    throw new IdiomError(`ab answer ${options.slug} failed: ${reason(error)}`);
  }
}
