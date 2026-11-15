import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/learn/harvest-sources.js";

/** One canned reply per command line (`ab builds --all --json`, …). */
export type Responses = Record<
  string,
  { stdout?: string; stderr?: string; code?: number }
>;

/** The real answer from an Idiom build: build-process talk, not UI. */
export const PROCESS_ANSWER =
  "The implementation is complete and committed: 2efe1d23 (fix), 5d701102 (docs/rules boundary), 37d71cb3 (CHANGELOG), c383f540 (measurement: site 36 -> 0, field test 0 -> 0, no accepted finding lost). Do not re-run the site check or field-test measurements; they are recorded. Confirm the four fixture cases from the spec exist and pass with a focused test run (only the error-text test files), then end implement. The inline-child word-order gap in obs_0d702923 is a follow-up, not this build's scope.";

export const UI_ANSWER =
  "The time picker chips feel cramped; add more space between them. Then rerun the tests.";
export const UI_SENTENCE =
  "The time picker chips feel cramped; add more space between them.";
export const PR_COMMENT =
  "The confirmation toast overlaps the header; move it below.";
export const NEW_ANSWER = 'The button should say "Reserve", not "Book".';

const human = { kind: "human", user: "director" };
const lines = (items: unknown[]) =>
  items.map((item) => JSON.stringify(item)).join("\n");

function status(slug: string, events: unknown[], pr?: number) {
  return JSON.stringify({
    slug,
    status: "merged",
    ...(pr === undefined ? {} : { pr: { number: pr, state: "merged" } }),
    events: events.map((event, index) => ({
      build: slug,
      seq: index + 1,
      ...(event as object),
    })),
  });
}

/** A local autobuild store and a GitHub repository, as `ab` and `gh` print them. */
export function harvestFixture(options: { newAnswer?: boolean } = {}) {
  const bookingUpdated = options.newAnswer
    ? "2026-11-11T10:00:00.000Z"
    : "2026-11-09T10:00:00.000Z";
  const responses: Responses = {
    "ab builds --all --json": {
      stdout: JSON.stringify([
        {
          slug: "booking-times",
          ticket: { id: "file-1", title: "Times" },
          status: "merged",
          updatedAt: bookingUpdated,
        },
        {
          slug: "error-text-tells",
          ticket: { id: "file-2", title: "Errors" },
          status: "merged",
          updatedAt: "2026-11-09T00:20:00.000Z",
        },
        {
          slug: "retry-only",
          ticket: { id: "file-3", title: "Retry" },
          status: "merged",
          updatedAt: "2026-11-08T00:00:00.000Z",
        },
      ]),
    },
    "ab build status booking-times --events 100000 --json": {
      stdout: status(
        "booking-times",
        [
          {
            ts: "2026-11-09T08:00:00.000Z",
            actor: { kind: "kernel" },
            type: "escalation.raised",
            payload: {
              id: "esc_a1",
              phase: "implement",
              source: "agent",
              question: "Which spacing token should the time chips use?",
            },
          },
          {
            ts: "2026-11-09T09:00:00.000Z",
            actor: human,
            type: "escalation.answered",
            payload: { id: "esc_a1", answer: UI_ANSWER, resolution: "resume" },
          },
          ...(options.newAnswer
            ? [
                {
                  ts: "2026-11-11T09:00:00.000Z",
                  actor: human,
                  type: "escalation.answered",
                  payload: {
                    id: "esc_a2",
                    answer: NEW_ANSWER,
                    resolution: "resume",
                  },
                },
              ]
            : []),
        ],
        41,
      ),
    },
    "ab build status error-text-tells --events 100000 --json": {
      stdout: status("error-text-tells", [
        {
          ts: "2026-11-09T00:18:33.852Z",
          actor: { kind: "kernel" },
          type: "escalation.raised",
          payload: { id: "esc_b37e9430", phase: "implement", source: "policy" },
        },
        {
          ts: "2026-11-09T00:19:09.891Z",
          actor: human,
          type: "escalation.answered",
          payload: {
            id: "esc_b37e9430",
            answer: PROCESS_ANSWER,
            resolution: "resume",
          },
        },
      ]),
    },
    "ab build status retry-only --events 100000 --json": {
      stdout: status("retry-only", [
        {
          ts: "2026-11-07T23:00:00.000Z",
          actor: { kind: "kernel" },
          type: "escalation.answered",
          payload: { id: "esc_k1", answer: "The button should be bigger." },
        },
        {
          ts: "2026-11-07T23:30:00.000Z",
          actor: human,
          type: "escalation.answered",
          payload: { id: "esc_r1", answer: "   ", resolution: "retry" },
        },
        { ts: "not a date", actor: human, type: "escalation.answered" },
      ]),
    },
    "gh repo view --json nameWithOwner": {
      stdout: JSON.stringify({ nameWithOwner: "acme/shop" }),
    },
    "gh pr list --state all --limit 100 --json number,title,url,updatedAt": {
      stdout: JSON.stringify([
        {
          number: 41,
          title: "Times",
          url: "https://github.com/acme/shop/pull/41",
          updatedAt: "2026-11-10T12:00:00.000Z",
        },
      ]),
    },
    "gh api --paginate --jq .[] repos/acme/shop/pulls/41/comments": {
      stdout: lines([
        {
          id: 501,
          body: PR_COMMENT,
          user: { login: "director", type: "User" },
          created_at: "2026-11-10T08:00:00Z",
          html_url: "https://github.com/acme/shop/pull/41#discussion_r501",
          path: "src/Toast.tsx",
        },
        {
          id: 502,
          body: "The button looks too small.",
          user: { login: "helper[bot]", type: "Bot" },
          created_at: "2026-11-10T08:05:00Z",
          html_url: "https://github.com/acme/shop/pull/41#discussion_r502",
          path: "src/Button.tsx",
        },
      ]),
    },
    "gh api --paginate --jq .[] repos/acme/shop/pulls/41/reviews": {
      stdout: lines([
        {
          id: 601,
          body: "Looks good, merge after CI passes.",
          user: { login: "director", type: "User" },
          submitted_at: "2026-11-10T09:00:00Z",
          html_url:
            "https://github.com/acme/shop/pull/41#pullrequestreview-601",
          state: "APPROVED",
        },
        {
          id: 602,
          body: "The header should be darker.",
          user: { login: "director", type: "User" },
          submitted_at: null,
          state: "PENDING",
        },
      ]),
    },
    "gh api --paginate --jq .[] repos/acme/shop/issues/41/comments": {
      stdout: lines([
        {
          id: 701,
          body: "<!-- idiom:evidence -->\nThe card spacing is too tight.",
          user: { login: "director", type: "User" },
          created_at: "2026-11-10T10:00:00Z",
          html_url: "https://github.com/acme/shop/pull/41#issuecomment-701",
        },
        {
          id: 702,
          body: "Make the badge bigger.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
          user: { login: "director", type: "User" },
          created_at: "2026-11-10T10:30:00Z",
        },
      ]),
    },
  };
  return responses;
}

/** gh fails the way it does when nobody has logged in. */
export function unauthenticated(responses: Responses): Responses {
  return {
    ...responses,
    "gh repo view --json nameWithOwner": {
      code: 1,
      stderr:
        "\nTo get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable.\n",
    },
  };
}

/** An in-process `exec` serving the canned replies, logging every call. */
export function fakeExec(responses: () => Responses) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> =
    [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const reply = responses()[[file, ...args].join(" ")];
    if (reply === undefined)
      throw Object.assign(new Error(`unexpected ${file} ${args.join(" ")}`), {
        code: 2,
        stderr: `unsupported: ${file} ${args.join(" ")}`,
      });
    if ((reply.code ?? 0) !== 0)
      throw Object.assign(new Error("Command failed"), {
        code: reply.code,
        stderr: reply.stderr ?? "",
      });
    return { stdout: reply.stdout ?? "" };
  };
  return { exec, calls };
}

/**
 * A `bin` directory holding fake `ab` and `gh` executables that serve the
 * replies in `<bin>/responses.json`.
 */
export async function fakeBin(
  directories: string[],
  tools: Array<"ab" | "gh"> = ["ab", "gh"],
) {
  const bin = await mkdtemp(join(tmpdir(), "idiom-harvest-bin-"));
  directories.push(bin);
  const responsesPath = join(bin, "responses.json");
  for (const tool of tools) {
    await writeFile(
      join(bin, tool),
      `#!${process.execPath}
const fs = require("node:fs");
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responsesPath)}, "utf8"));
const reply = responses[[${JSON.stringify(tool)}, ...process.argv.slice(2)].join(" ")];
if (!reply) { process.stderr.write("unsupported: " + process.argv.slice(2).join(" ")); process.exit(2); }
if (reply.stdout) process.stdout.write(reply.stdout);
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.code ?? 0);
`,
    );
    await chmod(join(bin, tool), 0o755);
  }
  return {
    bin,
    serve: (responses: Responses) =>
      writeFile(responsesPath, JSON.stringify(responses)),
  };
}

/** An executable named like each tool, so PATH lookups find them. */
export async function pathWith(
  directories: string[],
  tools: Array<"ab" | "gh">,
): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "idiom-harvest-path-"));
  directories.push(bin);
  for (const tool of tools) {
    await writeFile(join(bin, tool), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, tool), 0o755);
  }
  return bin;
}
