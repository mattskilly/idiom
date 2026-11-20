import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { baseCachePath, readBaseCache } from "../src/baseline/base-cache.js";
import { learnImportCommand } from "../src/commands/learn-import.js";
import { readLearnedLog } from "../src/learn/misses.js";
import { parseFindingBlocks } from "../src/verify/spec.js";
import { runWatch, type WatchEvent } from "../src/watch/loop.js";
import { baseFixture, page } from "./support/base-gate-fixture.js";

const exec = promisify(execFile);

/** Spec latency target: a covered miss is in triage within ten minutes. */
const TARGET_MS = 10 * 60 * 1000;

/**
 * The spec's evidence: a watcher over a real repository sees three merges,
 * one of which reintroduces a miss a learned record covers. That merge is
 * filed into autobuild triage with no human step; the clean ones advance
 * the baseline; a restart redoes nothing.
 */
test("idiom watch gates three merges, files the reintroduced covered miss into triage, and advances the clean ones", async () => {
  const f = await baseFixture();
  const bin = await mkdtemp(join(tmpdir(), "idiom-watch-ab-"));
  const controller = new AbortController();
  let watcher: Promise<unknown> | undefined;
  try {
    await f.write("autobuild.toml", "[commands]\n");
    await f.write(
      "misses.md",
      [
        "| ID | Observation | General rule | How it could be checked | State that would show it |",
        "| --- | --- | --- | --- | --- |",
        "| W-1 | The detail page lost its second paragraph | Declared content stays on the page | `missing-state` | s1 |",
        "",
      ].join("\n"),
    );
    await learnImportCommand({
      project: f.directory,
      cwd: f.directory,
      file: "misses.md",
    });
    const learned = await readLearnedLog(f.directory);
    const covered = learned.find((entry) =>
      entry.import?.checks.includes("missing-state"),
    );
    expect(covered, JSON.stringify(learned)).toBeDefined();
    await f.commit("import the misses table");

    const log = join(bin, "log.txt");
    await writeFile(log, "");
    await writeFile(
      join(bin, "ab"),
      `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.AB_LOG, JSON.stringify(argv) + "\\n");
const flag = (name) => argv[argv.indexOf(name) + 1];
if (argv[0] !== "ticket") process.exit(2);
if (argv[1] === "states") process.stdout.write(JSON.stringify([{ name: "triage", roles: ["create", "triage"], tickets: 0 }]));
else if (argv[1] === "list") process.stdout.write("[]");
else if (argv[1] === "create") {
  fs.writeFileSync(process.env.AB_LOG + ".body", fs.readFileSync(flag("--body"), "utf8"));
  process.stdout.write(JSON.stringify({ revision: "1", ref: { source: "file", id: "file-1", title: argv[2] }, title: argv[2], body: "", state: flag("--state"), resolved: false, labels: flag("--labels").split(",") }));
} else process.exit(2);
`,
    );
    // No network in a test: the PR source reports itself unavailable.
    await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, "ab"), 0o755);
    await chmod(join(bin, "gh"), 0o755);

    const events: WatchEvent[] = [];
    const seen = new Map<string, number>();
    watcher = runWatch({
      project: f.directory,
      cwd: f.directory,
      tracker: "autobuild",
      pollMs: 250,
      signal: controller.signal,
      log: (event) => {
        events.push(event);
        if (event.event === "merge") seen.set(event.commit, Date.now());
      },
      dependencies: {
        environment: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AB_LOG: log,
        },
      },
    });
    const waitFor = async (commit: string) => {
      const deadline = Date.now() + TARGET_MS;
      while (!seen.has(commit)) {
        if (Date.now() > deadline)
          throw new Error(`no merge event for ${commit} within ten minutes`);
        await new Promise((done) => setTimeout(done, 100));
      }
    };
    // The watcher records its starting cursor before any merge lands.
    while (!events.some((event) => event.event === "start"))
      await new Promise((done) => setTimeout(done, 50));

    const merges: Array<{
      index: number;
      commit: string;
      at: number;
      what: string;
    }> = [];
    const changes: Record<number, [string, string, string]> = {
      1: ["app/r0/page.tsx", page("<h1>Home 1</h1>"), "home copy"],
      2: [
        "app/r1/page.tsx",
        page('<h1>Detail</h1><p id="a">A</p>'),
        "drops #b (the covered miss)",
      ],
      // A broken expectation fails every gate until it is fixed, so the
      // next clean merge is the one that puts #b back.
      3: [
        "app/r1/page.tsx",
        page('<h1>Detail</h1><p id="a">A</p><p id="b">B</p>'),
        "restores #b",
      ],
    };
    for (const index of [1, 2, 3]) {
      const [path, content, what] = changes[index] as [string, string, string];
      await f.git("checkout", "--quiet", "-b", `feature-${index}`);
      await f.write(path, content);
      await f.commit(`feature ${index}: ${what}`);
      await f.git("checkout", "--quiet", "main");
      await f.git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        `Merge feature-${index}`,
        `feature-${index}`,
      );
      const commit = await f.git("rev-parse", "HEAD");
      const at = Date.now();
      merges.push({ index, commit, at, what });
      await waitFor(commit);
    }

    const outcomes = events.filter(
      (event): event is Extract<WatchEvent, { event: "merge" }> =>
        event.event === "merge",
    );
    expect(outcomes.map((outcome) => outcome.commit)).toEqual(
      merges.map((merge) => merge.commit),
    );
    const [first, regression, third] = outcomes;
    expect(first, JSON.stringify(first)).toMatchObject({
      gate: { status: "clean" },
      baseline: { status: "advanced" },
      tickets: [],
    });
    expect(regression, JSON.stringify(regression)).toMatchObject({
      gate: { status: "findings" },
      baseline: { status: "not-advanced" },
      tickets: [expect.objectContaining({ kind: "created", ticket: "file-1" })],
    });
    expect(regression?.error).toBeUndefined();
    expect(third, JSON.stringify(third)).toMatchObject({
      gate: { status: "clean" },
      baseline: { status: "advanced" },
      tickets: [],
    });

    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter((argv) => argv[0] === "ticket");
    expect(calls.map((argv) => argv[1])).toEqual(["states", "list", "create"]);
    const create = calls.find((argv) => argv[1] === "create") ?? [];
    expect(create[create.indexOf("--state") + 1]).toBe("triage");
    const body = await readFile(`${log}.body`, "utf8");
    const embedded = parseFindingBlocks(body);
    expect(embedded.length).toBeGreaterThan(0);
    expect(
      embedded.some((finding) =>
        covered?.import?.checks.includes(finding.category),
      ),
      body,
    ).toBe(true);

    const cached = (
      await readBaseCache(await baseCachePath(f.directory, "site"), "site")
    ).map((record) => record.commit);
    expect(cached).toContain(merges[0]?.commit);
    expect(cached).toContain(merges[2]?.commit);
    // Merge 2 was never advanced to; it is cached only because merge 3's
    // gate captured its first parent as the base. Merge 3 restores #b, so
    // nothing new is filed and the broken expectation clears.
    expect(third?.tickets).toEqual([]);

    const rows = merges.map((merge) => {
      const outcome = outcomes[merge.index - 1];
      const latency = (seen.get(merge.commit) ?? 0) - merge.at;
      expect(latency).toBeLessThan(TARGET_MS);
      return `merge ${merge.index} ${merge.commit.slice(0, 12)} (${merge.what}): gate ${outcome?.gate.status}, tickets ${outcome?.tickets.map((ticket) => `${ticket.ticket} ${ticket.kind}`).join(", ") || "none"}, baseline ${outcome?.baseline.status}; merge-to-event ${(latency / 1000).toFixed(1)}s (steps ${((outcome?.ms ?? 0) / 1000).toFixed(1)}s)`;
    });
    console.log(
      ["idiom watch fixture run (target < 600s per merge):", ...rows].join(
        "\n",
      ),
    );

    controller.abort();
    await watcher;
    watcher = undefined;
    // The primary checkout's tracked files are untouched outside .idiom/.
    const dirty = (
      await exec("git", ["status", "--porcelain"], { cwd: f.directory })
    ).stdout
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.slice(3).startsWith(".idiom/"));
    expect(dirty).toEqual([]);

    // A restart redoes nothing.
    const again: WatchEvent[] = [];
    const rerun = await runWatch({
      project: f.directory,
      cwd: f.directory,
      tracker: "autobuild",
      once: true,
      log: (event) => again.push(event),
      dependencies: {
        environment: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AB_LOG: log,
        },
      },
    });
    expect(rerun.processed).toEqual([]);
    expect(again.filter((event) => event.event === "merge")).toEqual([]);
  } finally {
    controller.abort();
    await watcher?.catch(() => undefined);
    await rm(bin, { recursive: true, force: true });
    await f.cleanup();
  }
}, 600_000);
