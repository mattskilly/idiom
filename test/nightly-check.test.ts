import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { baselineRecordCommand } from "../src/commands/baseline.js";
import { checkWithReview } from "../src/commands/check.js";
import { nightlyCommand } from "../src/commands/nightly.js";
import { parseFindingBlocks } from "../src/verify/spec.js";
import {
  baselineProject,
  commit,
  missing,
  storedBaselineRun,
} from "./baseline-support.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("nightly runs the real since-baseline check, files its new finding through ab, and still files when another flow has no baseline", async () => {
  const { project } = await baselineProject();
  directories.push(project);
  await writeFile(join(project, "autobuild.toml"), "[commands]\n");
  await writeFile(
    join(project, ".idiom/flows/booking.json"),
    JSON.stringify({
      id: "booking",
      title: "Booking",
      intent: [],
      setup: [],
      states: [
        {
          id: "editor",
          description: "Editor",
          url: "/",
          expect: { selectorPresent: ["#required"] },
        },
      ],
    }),
  );
  const sha = await commit(project, "flows");
  await storedBaselineRun(project, "initial", sha);
  await baselineRecordCommand({ project, flow: "studio", from: "initial" });
  await commit(project, "baseline");
  await storedBaselineRun(project, "later", sha, [{ mismatches: [missing()] }]);

  const bin = await mkdtemp(join(tmpdir(), "idiom-nightly-ab-"));
  directories.push(bin);
  const log = join(bin, "log.txt");
  await writeFile(log, "");
  await writeFile(
    join(bin, "ab"),
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.AB_LOG, JSON.stringify(argv) + "\\n");
const flag = (name) => argv[argv.indexOf(name) + 1];
if (argv[1] === "states") process.stdout.write(JSON.stringify([{ name: "triage", roles: ["create", "triage"], tickets: 0 }]));
else if (argv[1] === "list") process.stdout.write("[]");
else if (argv[1] === "create") {
  fs.writeFileSync(process.env.AB_LOG + ".body", fs.readFileSync(flag("--body"), "utf8"));
  process.stdout.write(JSON.stringify({ revision: "1", ref: { source: "file", id: "file-1", title: argv[2] }, title: argv[2], body: "", state: flag("--state"), resolved: false, labels: flag("--labels").split(",") }));
} else process.exit(2);
`,
  );
  await chmod(join(bin, "ab"), 0o755);
  const result = await nightlyCommand({
    project,
    cwd: project,
    dependencies: {
      environment: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AB_LOG: log,
      },
      check: (options) => checkWithReview({ ...options, from: "later" }),
    },
  });
  expect(result.flows).toEqual([
    expect.objectContaining({
      flow: "booking",
      status: "failed",
      error: expect.objectContaining({ cause: "baseline-missing" }),
    }),
    expect.objectContaining({
      flow: "studio",
      status: "checked",
      newFindings: 1,
    }),
  ]);
  expect(result.outcomes).toEqual([
    expect.objectContaining({
      kind: "created",
      ticket: "file-1",
      state: "triage",
    }),
  ]);
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(calls.map((argv) => argv[1])).toEqual(["states", "list", "create"]);
  const body = await readFile(`${log}.body`, "utf8");
  const embedded = parseFindingBlocks(body);
  expect(embedded).toHaveLength(1);
  expect(embedded[0]?.flow).toBe("studio");
  expect(body).toContain("Done when `idiom check studio --since-baseline`");
  // A stored --from run carries no run record, so it digests as partial.
  expect(result.digest).toEqual([]);
}, 60_000);
