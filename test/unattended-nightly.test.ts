import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../src/cli.js";
import { baselineRecordCommand } from "../src/commands/baseline.js";
import { checkWithReview } from "../src/commands/check.js";
import { RunFailure } from "../src/errors.js";
import { conditionStorePath, openConditions } from "../src/unattended/store.js";
import {
  baselineProject,
  commit,
  missing,
  storedBaselineRun,
} from "./baseline-support.js";
import { fakeAbBin } from "./unattended-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function idiom(
  project: string,
  args: string[],
  nightly?: NonNullable<Parameters<typeof run>[1]>["nightly"],
) {
  let out = "";
  let err = "";
  const code = await run(["node", "idiom", "--project", project, ...args], {
    cwd: project,
    stdout: (message) => {
      out += `${message}\n`;
    },
    stderr: (message) => {
      err += `${message}\n`;
    },
    ...(nightly === undefined ? {} : { nightly }),
  });
  return { code, out, err, errLines: err.trim().split("\n").filter(Boolean) };
}

const EXPECTATION =
  /^idiom nightly: expectation: studio\/editor: expect no longer matches at desktop\/light: selector-present "#required" — fix: fix the app, or update the state's steps\/expect in \.idiom\/flows\/studio\.json; confirm with idiom capture studio --states editor$/;

test("nightly never fails quietly: a broken expectation, an expired baseline and an app that cannot start each exit 2 with one line and one ticket", async () => {
  const { project, configPath } = await baselineProject();
  directories.push(project);
  await writeFile(join(project, "autobuild.toml"), "[commands]\n");
  const sha = await commit(project, "autobuild");
  // The silent case: the baseline was recorded while the state's expect
  // already failed, so the mismatch is pre-existing and nothing is new.
  await storedBaselineRun(project, "initial", sha, [
    { mismatches: [missing()] },
  ]);
  await baselineRecordCommand({ project, flow: "studio", from: "initial" });
  await commit(project, "baseline");
  await storedBaselineRun(project, "later", sha, [{ mismatches: [missing()] }]);
  const bin = await mkdtemp(join(tmpdir(), "idiom-unattended-ab-"));
  directories.push(bin);
  const ab = await fakeAbBin(bin);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...ab.environment,
    PATH: `${bin}:${process.env.PATH}`,
  };
  delete environment.IDIOM_UNATTENDED_TRACKER;
  const fromLater = {
    environment,
    check: (options: Parameters<typeof checkWithReview>[0]) =>
      checkWithReview({ ...options, from: "later" }),
  };

  // The check itself shows the state as broken coverage, not reviewed.
  const checked = await idiom(project, [
    "check",
    "studio",
    "--from",
    "later",
    "--since-baseline",
  ]);
  expect(checked.out).toContain(
    "broken coverage: editor (desktop/light) — expect no longer matches; not counted as reviewed",
  );
  const checkedJson = await idiom(project, [
    "check",
    "studio",
    "--from",
    "later",
    "--since-baseline",
    "--json",
  ]);
  const summary = JSON.parse(checkedJson.out);
  expect(summary.findings).toEqual([]);
  expect(summary.brokenCoverage).toEqual([
    {
      state: "editor",
      viewport: "desktop",
      colorScheme: "light",
      mismatches: [missing()],
    },
  ]);

  // Three nightly runs: exit 2 each time, one line, one ticket.
  const runs = [];
  for (let index = 0; index < 3; index += 1)
    runs.push(await idiom(project, ["nightly", "--json"], fromLater));
  for (const result of runs) {
    expect(result.code, result.err).toBe(2);
    expect(result.errLines).toHaveLength(1);
    expect(result.errLines[0]).toMatch(EXPECTATION);
  }
  const first = JSON.parse(runs[0]?.out ?? "{}");
  expect(first.flows).toEqual([
    expect.objectContaining({ flow: "studio", newFindings: 0 }),
  ]);
  expect(first.conditionOutcomes).toEqual([
    { key: "expectation:studio/editor", ticket: "file-1", kind: "created" },
  ]);
  expect(JSON.parse(runs[2]?.out ?? "{}").conditionOutcomes).toEqual([
    expect.objectContaining({ ticket: "file-1", kind: "updated" }),
  ]);
  let tickets = (await ab.store()).tickets;
  expect(tickets.map((ticket) => ticket.ref.id)).toEqual(["file-1"]);
  expect(tickets[0]).toMatchObject({
    state: "Inbox",
    labels: ["idiom", "idiom-condition"],
    title: expect.stringMatching(/^Idiom cannot review studio\/editor: /),
  });
  expect(tickets[0]?.body).toContain("- Runs: 3");
  expect((await ab.store()).verbs).not.toContain("move");

  // An expired baseline: the checks configuration changed since it was
  // recorded. Its own line, its own ticket.
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    JSON.stringify({ ...config, checks: { minGap: 12 } }),
  );
  for (let index = 0; index < 2; index += 1) {
    const stale = await idiom(project, ["nightly"], fromLater);
    expect(stale.code).toBe(2);
    expect(stale.errLines).toHaveLength(2);
    expect(stale.errLines).toContainEqual(
      expect.stringMatching(
        /^idiom nightly: baseline: studio: baseline is stale: checks configuration changed since the baseline was recorded .* — fix: idiom baseline advance studio \(or baseline record\) on main and commit it$/,
      ),
    );
  }
  await writeFile(configPath, JSON.stringify(config));

  // The app cannot start.
  const cannotStart = {
    environment,
    check: async () => {
      throw new RunFailure({
        stage: "server",
        cause: "server-timeout",
        headline:
          "server failed to start: http://127.0.0.1:3107/ did not answer within 30s",
        hint: "raise server.startupTimeoutMs, or check server.readyUrl",
        detail: "tail:\nlistening on 3108",
      });
    },
  };
  for (let index = 0; index < 3; index += 1) {
    const down = await idiom(project, ["nightly"], cannotStart);
    expect(down.code).toBe(2);
    expect(down.errLines).toEqual([
      "idiom nightly: app-start: studio: server failed to start: http://127.0.0.1:3107/ did not answer within 30s — fix: raise server.startupTimeoutMs, or check server.readyUrl; diagnose with idiom doctor studio",
    ]);
    expect(down.out).toContain("studio: not checked");
  }
  tickets = (await ab.store()).tickets;
  expect(tickets.map((ticket) => ticket.title)).toEqual([
    expect.stringMatching(/^Idiom cannot review studio\/editor/),
    expect.stringMatching(/^Idiom cannot compare studio: baseline is stale/),
    expect.stringMatching(/^Idiom cannot run studio: server failed to start/),
  ]);

  // doctor's list: every open condition, newest first.
  const open = await openConditions(
    await conditionStorePath({ projectDirectory: project }),
  );
  expect(open.map((entry) => [entry.key, entry.runs, entry.ticket])).toEqual([
    ["app-start", 3, "file-3"],
    expect.arrayContaining(["baseline:studio"]),
    expect.arrayContaining(["expectation:studio/editor"]),
  ]);

  // The app starts again and the baseline is fresh: those two clear, and
  // their tickets get one Cleared: line; the broken state stays open.
  const back = await idiom(project, ["nightly", "--json"], fromLater);
  expect(back.code).toBe(2);
  expect(JSON.parse(back.out).conditionOutcomes).toEqual(
    expect.arrayContaining([
      { key: "app-start", ticket: "file-3", kind: "cleared" },
      { key: "baseline:studio", ticket: "file-2", kind: "cleared" },
    ]),
  );
  expect(
    (
      await openConditions(
        await conditionStorePath({ projectDirectory: project }),
      )
    ).map((entry) => entry.key),
  ).toEqual(["expectation:studio/editor"]);
  tickets = (await ab.store()).tickets;
  expect(tickets[2]?.body).toMatch(
    /Cleared: \d{4}-\d{2}-\d{2} by idiom nightly/,
  );
  expect(tickets[2]?.state).toBe("Inbox");
}, 120_000);
