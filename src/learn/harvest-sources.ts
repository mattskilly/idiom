import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { HarvestSource } from "../schemas/learned.js";
import { executableOnPath } from "../wiring/detect.js";

/** One piece of the director's writing, before classification. */
export type HarvestItem = {
  key: string;
  source: HarvestSource;
  at: string;
  author?: string | undefined;
  text: string;
  build?: string | undefined;
  escalation?: string | undefined;
  pr?: number | undefined;
  url?: string | undefined;
  path?: string | undefined;
};

export type SourceResult =
  | {
      status: "read";
      items: HarvestItem[];
      /** The newest timestamp examined; the next run starts here. */
      through?: string | undefined;
      /** The repository the items came from (pull requests only). */
      repo?: string | undefined;
      /** Parts that could not be read and will be read again next run. */
      skipped?: string[] | undefined;
    }
  | { status: "unavailable"; reason: string };

export type Exec = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

export const defaultExec: Exec = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout };
};

/** A tool that cannot be run, as a reason a person can act on. */
class Unavailable extends Error {}

function failure(file: string, error: unknown): Unavailable {
  if (error instanceof Unavailable) return error;
  const failed = error as { code?: unknown; stderr?: unknown };
  if (failed.code === "ENOENT")
    return new Unavailable(`${file} is not installed`);
  const stderr = typeof failed.stderr === "string" ? failed.stderr : "";
  const line = stderr
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return new Unavailable(
    line ?? (error instanceof Error ? error.message : String(error)),
  );
}

/**
 * The ambient identity an autobuild phase sets. `ab` denies
 * repository-wide reads while it is set, so a harvest that runs inside a
 * build step drops it and keeps the store (`AB_STORE`) and `PATH`.
 */
export const AMBIENT_AB_IDENTITY = [
  "AB_BUILD",
  "AB_PHASE",
  "AB_SESSION",
  "AB_BUILD_RUNNER_OPTIONS",
  "AB_DISPATCH_CHILD_OPTIONS",
  "AB_DISPATCH_LAUNCH_CONTEXT",
] as const;

export function harvestEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of AMBIENT_AB_IDENTITY) delete result[name];
  return result;
}

type ReaderOptions = {
  root: string;
  environment: NodeJS.ProcessEnv;
  /** Only items at or after this instant. */
  since?: string | undefined;
  exec?: Exec | undefined;
};

function tool(options: ReaderOptions) {
  const exec = options.exec ?? defaultExec;
  const env = harvestEnvironment(options.environment);
  return async (file: string, args: string[]): Promise<string> => {
    try {
      return (await exec(file, args, { cwd: options.root, env })).stdout;
    } catch (error) {
      throw failure(file, error);
    }
  };
}

function parseJson(file: string, args: string[], stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Unavailable(
      `${file} ${args.slice(0, 2).join(" ")} printed output that is not JSON`,
    );
  }
}

const atOrAfter = (at: string, since: string | undefined) =>
  since === undefined || Date.parse(at) >= Date.parse(since);

/** The latest of some timestamps, as an ISO string. */
function newest(values: string[]): string | undefined {
  const times = values.map((value) => Date.parse(value));
  return times.length === 0
    ? undefined
    : new Date(Math.max(...times)).toISOString();
}

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)));

const buildListSchema = z.array(
  z.looseObject({ slug: z.string().min(1), updatedAt: timestamp.optional() }),
);
const eventSchema = z.looseObject({
  ts: timestamp,
  actor: z.looseObject({ kind: z.string(), user: z.string().optional() }),
  type: z.string(),
  payload: z.unknown(),
});
const statusSchema = z.looseObject({
  pr: z.looseObject({ number: z.number().int().positive() }).optional(),
  events: z.array(z.unknown()).default([]),
});
const answeredSchema = z.looseObject({
  id: z.string().min(1),
  answer: z.string().optional(),
});

/**
 * Human answers to autobuild escalations, read through the local `ab` CLI.
 * Both commands are read-only and offline against the local store.
 */
export async function readEscalationAnswers(
  options: ReaderOptions,
): Promise<SourceResult> {
  if (!(await executableOnPath("ab", { environment: options.environment })))
    return { status: "unavailable", reason: "ab is not installed" };
  const run = tool(options);
  try {
    const listArgs = ["builds", "--all", "--json"];
    const builds = buildListSchema.safeParse(
      parseJson("ab", listArgs, await run("ab", listArgs)),
    );
    if (!builds.success)
      throw new Unavailable("ab builds --all --json printed an unknown shape");
    const items: HarvestItem[] = [];
    const examined: string[] = [];
    const skipped: string[] = [];
    for (const build of builds.data) {
      if (
        build.updatedAt !== undefined &&
        !atOrAfter(build.updatedAt, options.since)
      )
        continue;
      const args = [
        "build",
        "status",
        build.slug,
        "--events",
        "100000",
        "--json",
      ];
      let status: z.infer<typeof statusSchema>;
      try {
        const parsed = statusSchema.safeParse(
          parseJson("ab", args, await run("ab", args)),
        );
        if (!parsed.success) throw new Unavailable("unknown status shape");
        status = parsed.data;
      } catch (error) {
        // One unreadable build does not hide the rest. It is read again
        // next run because the cursor does not move this run (below).
        skipped.push(
          `${build.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      // The answer is the director's words; the question stays out of the
      // record, and an answer whose raised event is missing still counts.
      for (const value of status.events) {
        const event = eventSchema.safeParse(value);
        if (!event.success) continue;
        if (event.data.type !== "escalation.answered") continue;
        if (event.data.actor.kind !== "human") continue;
        const payload = answeredSchema.safeParse(event.data.payload);
        if (!payload.success) continue;
        const answer = payload.data.answer?.trim();
        if (!answer) continue;
        if (!atOrAfter(event.data.ts, options.since)) continue;
        examined.push(event.data.ts);
        items.push({
          key: `autobuild:${build.slug}:${payload.data.id}`,
          source: "escalation",
          at: new Date(event.data.ts).toISOString(),
          ...(event.data.actor.user === undefined
            ? {}
            : { author: event.data.actor.user }),
          text: payload.data.answer ?? answer,
          build: build.slug,
          escalation: payload.data.id,
          ...(status.pr === undefined ? {} : { pr: status.pr.number }),
        });
      }
    }
    // A skipped build's answers may be older than anything read this run,
    // so the cursor stays where this run started; keys absorb the re-read.
    const through = skipped.length === 0 ? newest(examined) : undefined;
    return {
      status: "read",
      items,
      ...(through === undefined ? {} : { through }),
      ...(skipped.length === 0 ? {} : { skipped }),
    };
  } catch (error) {
    return { status: "unavailable", reason: failure("ab", error).message };
  }
}

const userSchema = z
  .looseObject({ login: z.string().optional(), type: z.string().optional() })
  .nullable()
  .optional();
const commentSchema = z.looseObject({
  id: z.number(),
  body: z.string().nullable().optional(),
  user: userSchema,
  created_at: timestamp.optional(),
  submitted_at: timestamp.nullable().optional(),
  html_url: z.string().optional(),
  path: z.string().optional(),
  state: z.string().optional(),
});
type Comment = z.infer<typeof commentSchema>;
const pullListSchema = z.array(
  z.looseObject({
    number: z.number().int().positive(),
    updatedAt: timestamp,
  }),
);

/** Comments a bot or a tool wrote rather than the director. */
function machineWritten(comment: Comment, body: string): boolean {
  const login = comment.user?.login ?? "";
  return (
    comment.user?.type === "Bot" ||
    login.endsWith("[bot]") ||
    body.includes("<!--") ||
    body.includes("Generated with [Claude Code]")
  );
}

/** `gh api --paginate --jq '.[]'` prints one object per line across pages. */
function ndjson(stdout: string, what: string): Comment[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Unavailable(`gh api ${what} printed a line that is not JSON`);
      }
      const parsed = commentSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
}

/**
 * Review comments, review bodies and conversation comments on the
 * repository's recent pull requests, read through the `gh` CLI.
 */
export async function readPullRequestComments(
  options: ReaderOptions & {
    /** Pull requests examined on a first run with no cursor. */
    recent?: number | undefined;
    /** The repository `since` was recorded for; another repo starts fresh. */
    sinceRepo?: string | undefined;
  },
): Promise<SourceResult> {
  if (!(await executableOnPath("gh", { environment: options.environment })))
    return { status: "unavailable", reason: "gh is not installed" };
  const run = tool(options);
  try {
    const viewArgs = ["repo", "view", "--json", "nameWithOwner"];
    const view = z
      .looseObject({ nameWithOwner: z.string().min(1) })
      .safeParse(parseJson("gh", viewArgs, await run("gh", viewArgs)));
    if (!view.success)
      throw new Unavailable("gh repo view printed no repository name");
    const repo = view.data.nameWithOwner;
    const since =
      options.sinceRepo === undefined || options.sinceRepo === repo
        ? options.since
        : undefined;
    const listArgs = [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,title,url,updatedAt",
    ];
    const pulls = pullListSchema.safeParse(
      parseJson("gh", listArgs, await run("gh", listArgs)),
    );
    if (!pulls.success)
      throw new Unavailable("gh pr list printed an unknown shape");
    const chosen =
      since === undefined
        ? [...pulls.data]
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, options.recent ?? 20)
        : pulls.data.filter((pull) => atOrAfter(pull.updatedAt, since));
    const items: HarvestItem[] = [];
    const examined: string[] = [];
    const kinds = [
      {
        endpoint: "pulls/{n}/comments",
        source: "pr-review-comment",
        key: "review-comment",
      },
      { endpoint: "pulls/{n}/reviews", source: "pr-review", key: "review" },
      {
        endpoint: "issues/{n}/comments",
        source: "pr-comment",
        key: "issue-comment",
      },
    ] as const;
    for (const pull of [...chosen].sort((a, b) => a.number - b.number))
      for (const kind of kinds) {
        const endpoint = `repos/${repo}/${kind.endpoint.replace("{n}", String(pull.number))}`;
        const comments = ndjson(
          await run("gh", ["api", "--paginate", "--jq", ".[]", endpoint]),
          endpoint,
        );
        for (const comment of comments) {
          const at = comment.submitted_at ?? comment.created_at;
          if (at === undefined || at === null) continue;
          if (kind.source === "pr-review" && comment.state === "PENDING")
            continue;
          examined.push(at);
          const body = comment.body?.trim() ?? "";
          if (body === "" || machineWritten(comment, body)) continue;
          if (!atOrAfter(at, since)) continue;
          items.push({
            key: `github:${repo}#${pull.number}:${kind.key}:${comment.id}`,
            source: kind.source,
            at: new Date(at).toISOString(),
            ...(comment.user?.login ? { author: comment.user.login } : {}),
            text: comment.body ?? body,
            pr: pull.number,
            ...(comment.html_url ? { url: comment.html_url } : {}),
            ...(comment.path ? { path: comment.path } : {}),
          });
        }
      }
    const through = newest(examined);
    return {
      status: "read",
      items,
      repo,
      ...(through === undefined ? {} : { through }),
    };
  } catch (error) {
    return { status: "unavailable", reason: failure("gh", error).message };
  }
}
