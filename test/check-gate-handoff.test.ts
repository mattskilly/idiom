import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createFixFixture,
  type FixFixture,
  scriptedFix,
} from "../scripts/idiom-fix-fixture.mjs";
import { run } from "../src/cli.js";
import type { HandoffRound } from "../src/fix/handoff/types.js";
import { checkGateJsonContract } from "../src/interface/surfaces.js";
import { changedFixture } from "./changed-support.js";
import { fixtureCommand } from "./support/fixture-server.js";

const gate = ["--gate", "--fail-on", "major", "--deferred", "warn", "--json"];

async function idiom(directory: string, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const status = await run(["node", "idiom", "--project", directory, ...args], {
    cwd: directory,
    stdout: (value) => out.push(value),
    stderr: (value) => err.push(value),
  });
  return { status, out: out.join("\n"), err: err.join("\n") };
}

let fixture: FixFixture;

beforeAll(async () => {
  fixture = await createFixFixture({
    idiom,
    start: fixtureCommand(join("server.mjs")),
  });
}, 120_000);
afterAll(async () => {
  await fixture?.cleanup();
});

const readRound = async (dir: string, round: number) =>
  JSON.parse(
    await readFile(join(dir, `round-${round}`, "handoff.json"), "utf8"),
  ) as HandoffRound;

test("a non-UI diff writes a skip round in under a second", async () => {
  const f = await changedFixture({});
  try {
    await f.write("README.md", "# changed\n");
    const dir = join(f.directory, ".ab", "idiom-fix");
    const started = performance.now();
    const response = await idiom(f.directory, [
      "check",
      ...gate,
      "--handoff",
      dir,
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(response.status, response.err).toBe(0);
    const output = JSON.parse(response.out);
    checkGateJsonContract.options[0].parse(output);
    expect(output.handoff).toMatchObject({
      round: 0,
      next: "skip",
      targets: 0,
    });
    const round = await readRound(dir, 0);
    expect(round).toMatchObject({ next: "skip", targets: [] });
    expect(round.line).toMatch(/^no UI changes since [0-9a-f]{12}; skipped$/);
    expect(await readFile(join(dir, "summary.md"), "utf8")).toContain(
      "no UI changes",
    );
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("--handoff is rejected without --gate, with --plan-only and with --fail-on never", async () => {
  const f = await changedFixture({});
  try {
    const cases: Array<[string[], string]> = [
      [["orders", "--handoff", "x"], "--handoff requires --gate"],
      [
        ["--gate", "--plan-only", "--handoff", "x"],
        "--handoff cannot be combined with --plan-only",
      ],
      [
        ["--gate", "--fail-on", "never", "--handoff", "x"],
        "--handoff needs a severity gate",
      ],
    ];
    for (const [flags, message] of cases) {
      const response = await idiom(f.directory, ["check", ...flags]);
      expect(response.status).not.toBe(0);
      expect(response.err).toContain(message);
    }
  } finally {
    await f.cleanup();
  }
}, 30_000);

test("a planted spacing regression hands off one structured round, and the fix re-verifies to pass", async () => {
  const { directory, git } = fixture;
  const dir = join(directory, ".ab", "fix-pass");
  const first = await idiom(directory, ["check", ...gate, "--handoff", dir]);
  expect(first.status, first.err).toBe(1);
  const output = JSON.parse(first.out);
  checkGateJsonContract.options[2].parse(output);
  expect(output.handoff).toEqual({
    dir,
    round: 0,
    next: "repair",
    targets: 2,
    summaryPath: join(dir, "summary.md"),
  });
  const round0 = await readRound(dir, 0);
  expect(round0.next).toBe("repair");
  expect(round0.remaining).toEqual([]);
  const [target] = round0.targets;
  expect(target).toMatchObject({
    rank: 1,
    flow: "orders",
    state: "list",
    viewport: "desktop",
    severity: "major",
    rule: "idiom:adjacent-elements-touch",
    category: "adjacent-gap",
    selector: expect.stringMatching(/button/),
    measured: { value: "2px" },
    words: {
      text: "Buttons in a toolbar keep at least 8px apart.",
      source: "learned",
      ref: "learned-1",
    },
    suggestedFix:
      'Change gap on `div[aria-label="Order actions"]` from 2px to at least 3px.',
  });
  expect(target?.doneWhen.length).toBeGreaterThan(0);
  expect(target?.crops).toHaveLength(1);
  await expect(
    readFile(join(dir, target?.crops[0] ?? "missing")),
  ).resolves.toBeInstanceOf(Buffer);
  expect(await readFile(join(dir, "round-0", "handoff.md"), "utf8")).toContain(
    '- Rule broken (learned catch, learned-1): "Buttons in a toolbar keep at least 8px apart."',
  );
  expect(await scriptedFix(directory)).toEqual([
    "components/Toolbar.module.css",
  ]);
  try {
    const second = await idiom(directory, ["check", ...gate, "--handoff", dir]);
    expect(second.status, second.err).toBe(0);
    expect(JSON.parse(second.out).handoff).toMatchObject({
      round: 1,
      next: "pass",
      targets: 0,
      outcome: "commit",
      repairFrom: 1,
    });
    const round1 = await readRound(dir, 1);
    expect(round1.progress).toEqual({
      fixed: round0.targets.map((item) => item.id),
      persisting: [],
      introduced: [],
    });
    const transcript = await readFile(join(dir, "transcript.md"), "utf8");
    expect(transcript.indexOf("## Round 0")).toBeLessThan(
      transcript.indexOf("## Round 1"),
    );
    expect(transcript).toContain("Result: no new blocking findings. Pass.");
  } finally {
    await git("checkout", "--", ".");
  }
}, 180_000);

test("a regression left unfixed for three rounds stops with a short summary", async () => {
  const { directory, git } = fixture;
  const dir = join(directory, ".ab", "fix-stop");
  try {
    for (let round = 0; round <= 3; round += 1) {
      const response = await idiom(directory, [
        "check",
        ...gate,
        "--handoff",
        dir,
      ]);
      expect(response.status, response.err).toBe(1);
      expect(JSON.parse(response.out).handoff).toMatchObject({
        round,
        next: round < 3 ? "repair" : "stop",
      });
      // A non-fix edit each round: the comment moves, the gap does not.
      await mkdir(join(directory, "components"), { recursive: true });
      const css = join(directory, "components", "Toolbar.module.css");
      await writeFile(css, `${await readFile(css, "utf8")}/* ${round} */\n`);
    }
    const last = await readRound(dir, 3);
    expect(last.progress).toMatchObject({ fixed: [], introduced: [] });
    // Nothing fixed: every repair round is judged revert and works from round 0.
    expect(last).toMatchObject({ outcome: "revert", repairFrom: 0 });
    const summary = await readFile(join(dir, "summary.md"), "utf8");
    const lines = summary.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(15);
    expect(lines[0]).toBe(
      "Idiom fix: fixed 0 of 2 new blocking finding(s) in 3 round(s) (3 reverted).",
    );
    expect(summary).toContain("Rounds tried: 3.");
    expect(summary).toContain("(list, desktop): measured 2px;");
    expect(summary).toContain(
      '"Buttons in a toolbar keep at least 8px apart." (learned-1)',
    );
    expect(summary).not.toMatch(/[{}]/);
  } finally {
    await git("checkout", "--", ".");
  }
}, 300_000);
