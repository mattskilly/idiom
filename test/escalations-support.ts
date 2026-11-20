import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/learn/harvest-sources.js";
import { renderRulingBlock } from "../src/rulings/law.js";
import { decisionLogEntrySchema } from "../src/schemas/decision.js";
import { learnedEntrySchema } from "../src/schemas/learned.js";

/** The five fixture escalations, one per build, as the spec lists them. */
export const QUESTIONS = {
  filter:
    "The status filter has four options; should it be a dropdown or a segmented control?",
  footer:
    "Should the confirmation footer get a second primary button for Add to calendar?",
  errors:
    "Should form error messages show inline under the field or in a toast?",
  empty: "Should the empty calendar state show an illustration or plain text?",
  lockfile:
    "verify fails because bun.lock is stale; should I regenerate the lockfile?",
} as const;

export const FILTER_RULING =
  "Filters with five or fewer options use a segmented control, never a dropdown.";
export const ERROR_RULING = "Error messages sit inline under the field.";
export const FOOTER_REJECTION =
  "One primary button per footer; a second primary action in the confirmation footer competes with Confirm.";
export const TOAST_ACCEPT =
  "Show form error messages in a toast at the top of the form.";

export type AbBuild = {
  slug: string;
  status: string;
  escalations: Array<{
    id: string;
    phase?: string;
    source?: string;
    question: string;
  }>;
};

/** The fixture store: five blocked builds, one escalation each, plus a merged build. */
export function fixtureBuilds(): AbBuild[] {
  const one = (slug: string, id: string, question: string): AbBuild => ({
    slug,
    status: "blocked",
    escalations: [{ id, question }],
  });
  return [
    one("booking-filter", "esc_filter1", QUESTIONS.filter),
    one("confirm-footer", "esc_footer1", QUESTIONS.footer),
    one("form-errors", "esc_errors1", QUESTIONS.errors),
    one("calendar-empty", "esc_empty1", QUESTIONS.empty),
    one("lockfile", "esc_lock1", QUESTIONS.lockfile),
    { slug: "shipped", status: "merged", escalations: [] },
  ];
}

function statusJson(build: AbBuild): string {
  return JSON.stringify({
    slug: build.slug,
    status: build.status,
    openEscalations: build.escalations.map((escalation, index) => ({
      id: escalation.id,
      phase: escalation.phase ?? "implement",
      round: 1,
      source: escalation.source ?? "agent",
      question: escalation.question,
      seq: index + 10,
    })),
  });
}

/**
 * An in-process `ab` serving a mutable store. `ab answer` is recorded and,
 * unless `keepOpen` is set, closes the build's escalations as autobuild does.
 */
export function fakeAb(builds: AbBuild[]) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const state = {
    builds,
    keepOpen: false,
    failAnswer: undefined as string | undefined,
  };
  const exec: Exec = async (file, args, options) => {
    calls.push({ args, env: options.env });
    if (file !== "ab") throw new Error(`unexpected ${file}`);
    if (args.join(" ") === "builds --json")
      return {
        stdout: JSON.stringify(
          state.builds.map((build) => ({
            slug: build.slug,
            status: build.status,
            updatedAt: "2026-11-15T10:00:00.000Z",
          })),
        ),
      };
    if (args[0] === "build" && args[1] === "status" && args[3] === "--json") {
      const build = state.builds.find((item) => item.slug === args[2]);
      if (build === undefined)
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stderr: `no build ${args[2]}`,
        });
      return { stdout: statusJson(build) };
    }
    if (args[0] === "answer") {
      if (state.failAnswer !== undefined)
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stderr: state.failAnswer,
        });
      const build = state.builds.find((item) => item.slug === args[1]);
      if (build !== undefined && !state.keepOpen) {
        build.escalations = [];
        build.status = "ready";
      }
      return { stdout: "" };
    }
    throw Object.assign(new Error("Command failed"), {
      code: 2,
      stderr: `unsupported: ab ${args.join(" ")}`,
    });
  };
  const answers = () => calls.filter((call) => call.args[0] === "answer");
  return { exec, calls, answers, state };
}

const NOW = "2026-11-10T12:00:00.000Z";

/** A project with two recorded rulings, three decisions and a learned law. */
export async function precedentProject(directories: string[]) {
  const project = await mkdtemp(join(tmpdir(), "idiom-escalations-"));
  directories.push(project);
  const idiom = join(project, ".idiom");
  await mkdir(join(idiom, "flows"), { recursive: true });
  await writeFile(
    join(idiom, "project.json"),
    JSON.stringify({
      version: 1,
      app: { name: "fixture", framework: "other" },
      server: {
        build: "build",
        start: "start",
        readyUrl: "http://127.0.0.1:1",
        port: 1,
        env: {},
      },
      capture: {},
      design: {},
      model: { provider: "anthropic", model: "unused" },
    }),
  );
  const ruling = (id: string, wording: string) =>
    renderRulingBlock({
      id,
      fingerprint: `fp-${id}`,
      choiceKey: `choice-${id}`,
      outcome: "rule",
      wording,
      recordedAt: NOW,
    });
  await writeFile(
    join(project, "DESIGN.md"),
    [
      "# Design",
      "",
      "Calm, plain booking screens.",
      "",
      ruling("ruling-1", FILTER_RULING),
      "",
      ruling("ruling-2", ERROR_RULING),
      "",
    ].join("\n"),
  );
  const decision = (overrides: Record<string, unknown>) =>
    JSON.stringify(
      decisionLogEntrySchema.parse({
        at: NOW,
        commit: "abc1234",
        fingerprint: `fp-${String(overrides.findingId)}`,
        actor: "human",
        ...overrides,
      }),
    );
  await writeFile(
    join(idiom, "decisions.jsonl"),
    `${[
      // Superseded: the later accept of the same finding wins.
      decision({
        findingId: "IDM-footer-primary",
        decision: "accept",
        reason: "Add a second primary button to the confirmation footer.",
        at: "2026-11-01T12:00:00.000Z",
      }),
      decision({
        findingId: "IDM-footer-primary",
        decision: "reject",
        scope: "rule",
        reason: FOOTER_REJECTION,
      }),
      decision({
        findingId: "IDM-form-toast",
        decision: "accept",
        reason: TOAST_ACCEPT,
      }),
      decision({
        findingId: "IDM-contrast",
        decision: "reject",
        reason: "False positive, Idiom bug in the contrast check.",
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    join(idiom, "learned.jsonl"),
    `${JSON.stringify(
      learnedEntrySchema.parse({
        version: 1,
        id: "learned-1",
        recordedAt: NOW,
        flow: "booking",
        state: "times",
        observation: "The time picker chips are cramped.",
        kind: "law",
        target: { file: ".idiom/project.json", check: "control-gap" },
        entry: { minGapPx: 8 },
        candidate: {
          rule: "Time picker chips keep at least an 8px gap between them.",
          kind: "law",
          checkable: "deterministic",
        },
      }),
    )}\n`,
  );
  return project;
}

/** A PATH directory with an `ab` the presence check finds (in-process exec serves it). */
export async function abOnPath(directories: string[]): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "idiom-escalations-path-"));
  directories.push(bin);
  await writeFile(join(bin, "ab"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "ab"), 0o755);
  return bin;
}

/**
 * A real `ab` executable serving `<bin>/store.json` and appending each
 * `ab answer` argv (and the identity it saw) to `<bin>/answers.jsonl`.
 */
export async function stubAbBin(directories: string[], builds: AbBuild[]) {
  const bin = await mkdtemp(join(tmpdir(), "idiom-escalations-bin-"));
  directories.push(bin);
  const store = join(bin, "store.json");
  const answers = join(bin, "answers.jsonl");
  await writeFile(store, JSON.stringify(builds));
  await writeFile(
    join(bin, "ab"),
    `#!${process.execPath}
const fs = require("node:fs");
const builds = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, "utf8"));
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
if (args.join(" ") === "builds --json") {
  out(builds.map((build) => ({ slug: build.slug, status: build.status, updatedAt: "2026-11-15T10:00:00.000Z" })));
} else if (args[0] === "build" && args[1] === "status") {
  const build = builds.find((item) => item.slug === args[2]);
  out({ slug: build.slug, status: build.status, openEscalations: build.escalations.map((e, i) => ({ id: e.id, phase: e.phase || "implement", source: e.source || "agent", question: e.question, seq: i + 10 })) });
} else if (args[0] === "answer") {
  fs.appendFileSync(${JSON.stringify(answers)}, JSON.stringify({ args, build: process.env.AB_BUILD || null }) + "\\n");
  const build = builds.find((item) => item.slug === args[1]);
  build.escalations = [];
  build.status = "ready";
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(builds));
} else {
  process.stderr.write("unsupported: " + args.join(" "));
  process.exit(2);
}
`,
  );
  await chmod(join(bin, "ab"), 0o755);
  return { bin, answers };
}
