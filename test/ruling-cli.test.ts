import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { projectChecksConfig } from "../src/checks/project-config.js";
import { run } from "../src/cli.js";
import { initProject } from "../src/commands/init.js";
import { rulingCommand } from "../src/commands/ruling.js";
import { writeUnruledDecisions } from "../src/rulings/artifacts.js";
import { parseRulingBlocks } from "../src/rulings/law.js";
import { loadProjectContext } from "../src/validation.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "idiom-ruling-cli-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  const run = join(directory, ".idiom", "reports", "2026-08-20-review");
  await mkdir(run, { recursive: true });
  await writeUnruledDecisions(run, [
    {
      id: "ruling-1",
      fingerprint: "chip-print",
      choiceKey: "chip-selection",
      question: "How should selection be shown?",
      nearestLawExcerpt: "Describe only observable UI behavior.",
      occurrences: [
        {
          state: "ready",
          viewport: "mobile",
          screenshot: "ready/mobile",
        },
        {
          state: "confirmed",
          viewport: "mobile",
          screenshot: "confirmed/mobile",
        },
      ],
      candidates: [
        {
          wording: "Selected chips use a filled treatment.",
          precedent: {
            kind: "law",
            excerpt: "Describe only observable UI behavior.",
          },
        },
      ],
    },
    {
      id: "ruling-2",
      fingerprint: "scale-print",
      choiceKey:
        "scale-cluster:v1 spacing:padding 17px component=role:.row-control landmark=main viewport=desktop",
      question:
        "17px padding appears 12 times on .row-control in main at desktop, between your 16px and 24px steps. Add a step for this context, or keep reporting it as drift?",
      nearestLawExcerpt: "checks.scales.spacing: [4px, 8px, 16px, 24px]",
      occurrences: [
        { state: "orders", viewport: "desktop", screenshot: "orders/desktop" },
      ],
      candidates: [],
      scaleCluster: {
        property: "spacing:padding",
        value: "17px",
        count: 12,
        distinctStates: 1,
        distinctElements: 6,
        context: {
          landmark: "main",
          component: "role:.row-control",
          viewport: "desktop",
        },
        componentLabel: ".row-control",
        nearestSteps: {
          below: "16px",
          above: "24px",
          steps: ["4px", "8px", "16px", "24px"],
        },
        suggestedToken: "space-row-control-main",
        examples: [
          {
            state: "orders",
            viewport: "desktop",
            screenshot: "orders/desktop",
            selector: ".row-control",
          },
        ],
      },
    },
  ]);
  return directory;
}

test("candidate resolution previews a diff before atomically appending", async () => {
  const directory = await project();
  const design = join(directory, "DESIGN.md");
  const before = await readFile(design, "utf8");
  const events: string[] = [];
  const result = await rulingCommand({
    project: directory,
    decision: "ruling-1",
    candidate: 1,
    write: (diff) => events.push(`write:${diff}`),
    dependencies: {
      clock: () => new Date("2026-08-20T12:00:00.000Z"),
      confirm: async (diff) => {
        events.push(`confirm:${diff}`);
        return true;
      },
    },
  });
  expect(result.recorded).toBe(true);
  expect(events[0]).toContain("--- a/DESIGN.md");
  expect(events[1]).toContain("confirm:--- a/DESIGN.md");
  const after = await readFile(design, "utf8");
  expect(after.startsWith(before)).toBe(true);
  expect(parseRulingBlocks(after).resolutions[0]).toMatchObject({
    id: "ruling-1",
    wording: "Selected chips use a filled treatment.",
  });
  await expect(
    rulingCommand({
      project: directory,
      decision: "ruling-1",
      noRule: true,
      dependencies: { confirm: async () => true },
    }),
  ).rejects.toThrow("already been recorded");
});

test("custom, no-rule, cancellation, and conflicting modes are explicit", async () => {
  const directory = await project();
  const design = join(directory, "DESIGN.md");
  const before = await readFile(design, "utf8");
  const confirm = vi.fn(async () => false);
  const cancelled = await rulingCommand({
    project: directory,
    decision: "ruling-1",
    wording: "Use a visible selected state.",
    dependencies: { confirm },
  });
  expect(cancelled.recorded).toBe(false);
  expect(await readFile(design, "utf8")).toBe(before);
  await expect(
    rulingCommand({
      project: directory,
      decision: "ruling-1",
      wording: "Custom",
      noRule: true,
    }),
  ).rejects.toThrow("exactly one");
  await expect(
    rulingCommand({
      project: directory,
      decision: "ruling-1",
      wording: "   ",
    }),
  ).rejects.toThrow("must not be blank");

  const custom = await rulingCommand({
    project: directory,
    decision: "ruling-1",
    wording: "Use a visible selected state.",
    dependencies: { confirm: async () => true },
  });
  expect(custom.resolution).toMatchObject({
    outcome: "rule",
    wording: "Use a visible selected state.",
  });

  const noRuleProject = await project();
  const noRule = await rulingCommand({
    project: noRuleProject,
    decision: "ruling-1",
    noRule: true,
    dependencies: { confirm: async () => true },
  });
  expect(noRule.resolution).toMatchObject({ outcome: "no-rule" });
  expect(noRule.resolution).not.toHaveProperty("wording");
});

test("the parsed --no-rule CLI flag records an explicit no-rule outcome", async () => {
  const directory = await project();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "--project",
      directory,
      "ruling",
      "--decision",
      "ruling-1",
      "--no-rule",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      ruling: { confirm: async () => true },
    },
  );

  expect(code).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.at(-1)).toContain("Recorded ruling-1");
  expect(
    parseRulingBlocks(await readFile(join(directory, "DESIGN.md"), "utf8"))
      .resolutions[0],
  ).toMatchObject({ id: "ruling-1", outcome: "no-rule" });
});

test("stray files in the reports directory do not interrupt decision lookup", async () => {
  const directory = await project();
  await writeFile(
    join(directory, ".idiom", "reports", "zz-stray.txt"),
    "not a report directory",
  );

  await expect(
    rulingCommand({
      project: directory,
      decision: "ruling-1",
      candidate: 1,
      dependencies: { confirm: async () => false },
    }),
  ).resolves.toMatchObject({ recorded: false });
  await expect(
    rulingCommand({
      project: directory,
      decision: "ruling-999",
      noRule: true,
    }),
  ).rejects.toThrow('unknown unruled decision "ruling-999"');
});

test("--add-step records the suggested or edited token and the next run's config carries the step", async () => {
  for (const token of [undefined, "space-dense-row"]) {
    const directory = await project();
    const design = join(directory, "DESIGN.md");
    const before = await readFile(design, "utf8");
    const result = await rulingCommand({
      project: directory,
      decision: "ruling-2",
      addStep: true,
      ...(token === undefined ? {} : { token }),
      dependencies: {
        clock: () => new Date("2026-10-27T12:00:00.000Z"),
        confirm: async () => true,
      },
    });
    const expected = token ?? "space-row-control-main";
    expect(result.recorded).toBe(true);
    const after = await readFile(design, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain(
      `Add the \`${expected}\` step: 17px padding for role:.row-control in main at desktop.`,
    );
    expect(parseRulingBlocks(after).resolutions).toMatchObject([
      {
        id: "ruling-2",
        outcome: "rule",
        scale: { answer: "add-step", token: expected, value: "17px" },
      },
    ]);
    const config = await projectChecksConfig(
      await loadProjectContext({ project: directory }),
    );
    expect(config.scaleQuestions?.rulings).toEqual([
      {
        id: "ruling-2",
        fingerprint: "scale-print",
        answer: "add-step",
        property: "spacing:padding",
        value: "17px",
        context: {
          landmark: "main",
          component: "role:.row-control",
          viewport: "desktop",
        },
        token: expected,
      },
    ]);
  }
});

test("--drift records a no-rule answer through the parsed CLI", async () => {
  const directory = await project();
  const stdout: string[] = [];
  const code = await run(
    [
      "node",
      "idiom",
      "--project",
      directory,
      "ruling",
      "--decision",
      "ruling-2",
      "--drift",
    ],
    {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
      ruling: { confirm: async () => true },
    },
  );
  expect(code).toBe(0);
  const after = await readFile(join(directory, "DESIGN.md"), "utf8");
  expect(after).toContain(
    "Keep reporting 17px padding on role:.row-control in main at desktop as drift.",
  );
  expect(parseRulingBlocks(after).resolutions[0]).toMatchObject({
    outcome: "no-rule",
    scale: { answer: "drift" },
  });
  expect(parseRulingBlocks(after).resolutions[0]?.scale).not.toHaveProperty(
    "token",
  );
});

test("scale and generic decisions reject each other's modes; a cancelled answer changes nothing", async () => {
  const directory = await project();
  const design = join(directory, "DESIGN.md");
  const before = await readFile(design, "utf8");
  for (const options of [
    { candidate: 1 },
    { noRule: true },
    { wording: "Use 17px" },
    {},
    { addStep: true, drift: true },
  ])
    await expect(
      rulingCommand({ project: directory, decision: "ruling-2", ...options }),
    ).rejects.toThrow("scale question ruling-2 takes --add-step or --drift");
  await expect(
    rulingCommand({ project: directory, decision: "ruling-1", drift: true }),
  ).rejects.toThrow("ruling-1 is not one");
  await expect(
    rulingCommand({
      project: directory,
      decision: "ruling-2",
      drift: true,
      token: "x",
    }),
  ).rejects.toThrow("--token is only used with --add-step");
  await expect(
    rulingCommand({
      project: directory,
      decision: "ruling-2",
      addStep: true,
      token: "has spaces",
    }),
  ).rejects.toThrow("must start with a letter or digit");
  const cancelled = await rulingCommand({
    project: directory,
    decision: "ruling-2",
    addStep: true,
    dependencies: { confirm: async () => false },
  });
  expect(cancelled.recorded).toBe(false);
  expect(await readFile(design, "utf8")).toBe(before);
});
