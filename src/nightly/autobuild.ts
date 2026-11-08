import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { IdiomError } from "../errors.js";

const execFileAsync = promisify(execFile);

/** The `Ticket` fields `ab ticket … --json` prints that filing reads. */
const ticketSchema = z.looseObject({
  ref: z.looseObject({ id: z.string().min(1) }),
  state: z.string().optional(),
  resolved: z.boolean(),
  labels: z.array(z.string()).default([]),
  body: z.string().default(""),
});
export type TrackerTicket = z.infer<typeof ticketSchema>;
const statesSchema = z.array(
  z.looseObject({ name: z.string().min(1), roles: z.array(z.string()) }),
);

/**
 * The sessionless `ab ticket` verbs `idiom nightly` runs. It never runs
 * `move`: tickets are filed in triage and humans promote them.
 */
export type AutobuildTracker = {
  /** Every state whose roles include triage, in `ab ticket states` order. */
  triageStates(): Promise<string[]>;
  listLabelled(label: string): Promise<TrackerTicket[]>;
  /** undefined when the source has no such ticket. */
  show(id: string): Promise<TrackerTicket | undefined>;
  create(options: {
    title: string;
    body: string;
    state: string;
    labels: readonly string[];
  }): Promise<TrackerTicket>;
  update(options: {
    id: string;
    body: string;
    labels: readonly string[];
  }): Promise<TrackerTicket>;
};

class AbFailure extends IdiomError {
  constructor(
    verb: string,
    readonly code: unknown,
    readonly stderr: string,
  ) {
    super(
      `ab ticket ${verb} failed (exit ${typeof code === "number" ? code : "unknown"}): ${stderr}`,
    );
  }
}

export function autobuildTracker(options: {
  root: string;
  environment: NodeJS.ProcessEnv;
}): AutobuildTracker {
  const ab = async (verb: string, args: string[]): Promise<unknown> => {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("ab", ["ticket", verb, ...args], {
        cwd: options.root,
        env: options.environment,
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      const stderr =
        typeof failure.stderr === "string" ? failure.stderr.trim() : "";
      throw new AbFailure(verb, failure.code, stderr || String(error));
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new IdiomError(
        `ab ticket ${verb} printed no JSON: ${stdout.trim().slice(0, 200)}`,
      );
    }
  };
  const parse = <T>(verb: string, schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new IdiomError(
        `ab ticket ${verb} printed unexpected JSON: ${parsed.error.message}`,
      );
    return parsed.data;
  };
  const withBody = async <T>(
    body: string,
    use: (path: string) => Promise<T>,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "idiom-nightly-"));
    try {
      const path = join(directory, "body.md");
      await writeFile(path, body);
      return await use(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  return {
    async triageStates() {
      const states = parse(
        "states",
        statesSchema,
        await ab("states", ["--json"]),
      );
      return states
        .filter((state) => state.roles.includes("triage"))
        .map((state) => state.name);
    },
    async listLabelled(label) {
      return parse(
        "list",
        z.array(ticketSchema),
        await ab("list", ["--labels", label, "--json"]),
      );
    },
    async show(id) {
      try {
        return parse("show", ticketSchema, await ab("show", [id, "--json"]));
      } catch (error) {
        if (
          error instanceof AbFailure &&
          /\bno ticket\b|not found/i.test(error.stderr)
        )
          return undefined;
        throw error;
      }
    },
    create({ title, body, state, labels }) {
      return withBody(body, async (path) =>
        parse(
          "create",
          ticketSchema,
          await ab("create", [
            title,
            "--body",
            path,
            "--state",
            state,
            "--labels",
            labels.join(","),
            "--json",
          ]),
        ),
      );
    },
    update({ id, body, labels }) {
      return withBody(body, async (path) =>
        parse(
          "update",
          ticketSchema,
          await ab("update", [
            id,
            "--body",
            path,
            "--labels",
            labels.join(","),
            "--json",
          ]),
        ),
      );
    },
  };
}
