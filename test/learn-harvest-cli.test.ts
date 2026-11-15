import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { learnedEntrySchema } from "../src/schemas/learned.js";
import {
  fakeBin,
  harvestFixture,
  type Responses,
  UI_SENTENCE,
  unauthenticated,
} from "./harvest-support.js";
import { studioProject } from "./stored-run-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const SIZE_COMMENT = "The export menu item should be 32px.";

/** The shared fixture plus a measurable comment no declared state matches. */
function cliFixture(): Responses {
  const responses = harvestFixture();
  const key = "gh api --paginate --jq .[] repos/acme/shop/pulls/41/comments";
  responses[key] = {
    stdout: `${responses[key]?.stdout ?? ""}\n${JSON.stringify({
      id: 503,
      body: SIZE_COMMENT,
      user: { login: "director", type: "User" },
      created_at: "2026-11-10T08:10:00Z",
      html_url: "https://github.com/acme/shop/pull/41#discussion_r503",
      path: "src/Menu.tsx",
    })}`,
  };
  return responses;
}

async function setup() {
  const { project } = await studioProject(directories, [
    "editor",
    "time-picker",
  ]);
  const tools = await fakeBin(directories);
  await tools.serve(cliFixture());
  const learn = {
    clock: () => new Date("2026-11-12T12:00:00.000Z"),
    gitTopology: async () => undefined,
    harvest: {
      environment: {
        PATH: `${tools.bin}:/usr/bin:/bin`,
        AB_BUILD: "idiom-harvest-ui",
        AB_PHASE: "finalize@1",
      },
    },
  };
  const idiom = async (...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["node", "idiom", ...args, "--project", project], {
      stdout: (message) => out.push(message),
      stderr: (message) => err.push(message),
      learn,
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  return { project, tools, idiom };
}

async function records(project: string) {
  return (await readFile(join(project, ".idiom", "learned.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => learnedEntrySchema.parse(JSON.parse(line)));
}

test("learn --harvest records UI corrections once, lists candidates, and --confirm applies them", async () => {
  const { project, tools, idiom } = await setup();

  const first = await idiom("learn", "--harvest");
  expect(first.code).toBe(0);
  expect(first.out).toContain(
    "Harvested 3 UI corrections (1 escalation answer, 2 PR comments); ignored 2 non-UI, 0 already harvested.",
  );
  expect(first.out).toContain(
    "learned-1  open  studio-lab/time-picker (state matched, words)  from booking-times esc_a1 (2026-11-09, director)",
  );
  expect(first.out).toContain(`  ${JSON.stringify(UI_SENTENCE)}`);
  expect(first.out).toContain(
    "learned-2  open  studio-lab/confirmation-toast-overlap-header (state proposed: .idiom/proposals/states/learned-2.json)  from PR #41 review comment on src/Toast.tsx (2026-11-10, director)",
  );
  expect(first.out).toContain("Rule candidates (3):");
  expect(first.out).toContain(`  learned-1  ruling (judged)  ${UI_SENTENCE}`);
  expect(first.out).toContain(
    "  learned-3  component (deterministic)  Every export menu item is 32×32px.",
  );
  expect(first.out).toContain(
    "Confirm them in one pass: idiom learn --confirm learned-1 learned-2 learned-3",
  );

  const second = await idiom("learn", "--harvest");
  expect(second.code).toBe(0);
  expect(second.out).toBe(
    "Harvested 0 UI corrections (0 escalation answers, 0 PR comments); ignored 0 non-UI, 1 already harvested.\nNothing new since 2026-11-10T10:30:00.000Z.\n",
  );

  const json = await idiom("learn", "--harvest", "--json");
  expect(JSON.parse(json.out)).toMatchObject({
    interfaceVersion: 1,
    dryRun: false,
    recorded: [],
    ignored: 0,
    duplicates: 1,
    sources: {
      autobuild: { status: "read", examined: 1, duplicates: 1 },
      pullRequests: { status: "read", repo: "acme/shop", examined: 0 },
    },
    cursor: { version: 1 },
  });

  await tools.serve(unauthenticated(cliFixture()));
  const offline = await idiom("learn", "--harvest");
  expect(offline.code).toBe(0);
  expect(offline.out).toContain(
    "PR review comments: not read — To get started with GitHub CLI, please run:  gh auth login.",
  );

  const designBefore = await readFile(join(project, "DESIGN.md"), "utf8");
  expect(designBefore).not.toContain(UI_SENTENCE);
  const confirmed = await idiom("learn", "--confirm", "learned-1", "--yes");
  expect(confirmed.code).toBe(0);
  expect(confirmed.out).toContain(
    "learned-1  applied as learned-4 (ruling) — DESIGN.md, .idiom/learned.jsonl",
  );
  expect(await readFile(join(project, "DESIGN.md"), "utf8")).toContain(
    UI_SENTENCE,
  );
  const afterConfirm = await records(project);
  expect(afterConfirm.find((entry) => entry.id === "learned-1")).toMatchObject({
    covered: { by: "learned-4" },
  });
  expect(afterConfirm.find((entry) => entry.id === "learned-4")).toMatchObject({
    kind: "ruling",
    state: "time-picker",
  });

  const files = async () =>
    Promise.all(
      ["DESIGN.md", ".idiom/project.json", ".idiom/learned.jsonl"].map((file) =>
        readFile(join(project, file), "utf8"),
      ),
    );
  const before = await files();
  const refused = await idiom("learn", "--confirm", "learned-3", "--yes");
  expect(refused.code).toBe(0);
  expect(refused.out).toContain(
    "learned-3  not applied — add the draft state in .idiom/proposals/states/learned-3.json first",
  );
  expect(refused.out).toContain("Nothing applied.");
  expect(await files()).toEqual(before);

  const listed = await idiom("learn", "--list");
  expect(listed.out).toContain("from booking-times esc_a1");
  expect(listed.out).toContain("from PR #41");
}, 120_000);

test("learn mode flags are exclusive and --since/--dry-run need --harvest", async () => {
  const { idiom } = await setup();
  const both = await idiom("learn", "--harvest", "--list");
  expect(both.code).not.toBe(0);
  expect(both.err).toContain(
    "choose exactly one learn mode: an observation, --list, --covered <id>, --fixture <id>, --harvest, --confirm [ids...], --import <file.md>, or --replay <import>",
  );
  expect(
    (await idiom("learn", "--list", "--since", "2026-01-01")).err,
  ).toContain("--since requires --harvest");
  expect((await idiom("learn", "--list", "--dry-run")).err).toContain(
    "--dry-run requires --harvest",
  );
  const dry = await idiom("learn", "--harvest", "--dry-run");
  expect(dry.out).toContain("Would record 3 UI corrections");
  expect(dry.out).toContain("Dry run: no files changed.");
}, 120_000);
