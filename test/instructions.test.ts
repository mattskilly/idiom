import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { instructionCommand } from "../src/commands/instruction.js";
import { ticketsCommand } from "../src/commands/tickets.js";
import { appendDecision } from "../src/decisions/log.js";
import {
  repairScopeBoundary,
  repairSiblingLines,
} from "../src/repair/presentation.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function finding(
  id: string,
  fingerprint: string,
  options: {
    viewport?: string;
    colorScheme?: "light" | "dark";
    rule?: string | null;
    suggestedArea?: string | null;
    screenshots?: string[];
    status?: Finding["status"];
  } = {},
): Finding {
  const viewport = options.viewport ?? "desktop";
  return findingSchema.parse({
    id,
    fingerprint,
    createdAt: "2026-08-14T12:00:00.000Z",
    commit: "abc123",
    flow: "booking",
    state: "ready",
    viewport,
    ...(options.colorScheme === undefined
      ? {}
      : { colorScheme: options.colorScheme }),
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    ...(options.rule === null
      ? {}
      : { rule: options.rule ?? "design:minimum-target" }),
    evidence: {
      screenshots: options.screenshots ?? [
        `ready/${viewport}/internal-evidence.png`,
      ],
    },
    explanation: "The primary action is too small to activate reliably.",
    ...(options.suggestedArea === null
      ? {}
      : { suggestedArea: options.suggestedArea ?? "booking action styles" }),
    acceptance: [
      "The primary action is at least 44 by 44 CSS pixels.",
      "The surrounding layout remains unchanged.",
    ],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: options.status ?? "open",
  });
}

async function fixture(
  findings: Finding[],
  runId = "2026-08-14T12-00-00-000Z",
) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-instructions-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  const runDirectory = join(directory, ".idiom", "reports", runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    `${JSON.stringify(findings)}\n`,
  );
  for (const item of findings) {
    for (const screenshot of item.evidence.screenshots) {
      const path = join(runDirectory, screenshot);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "private screenshot bytes");
    }
  }
  return { directory, runDirectory };
}

async function accept(directory: string, item: Finding): Promise<void> {
  await appendDecision({
    projectDirectory: directory,
    finding: item,
    decision: "accept",
    scope: "instance",
    now: () => new Date("2026-08-15T10:00:00.000Z"),
  });
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files[relative(root, path)] = (await readFile(path)).toString("base64");
    }
  };
  await walk(root);
  return files;
}

test("renders one deterministic human-facing instruction through canonical and legacy ids", async () => {
  const target = finding("IDM-run-0001", "target-fingerprint", {
    colorScheme: "dark",
    screenshots: [
      "ready/desktop/internal-evidence.png",
      "ready/desktop/second-private.png",
    ],
  });
  const sibling = finding("IDM-run-0002", "sibling-fingerprint", {
    viewport: "phone",
    colorScheme: "light",
  });
  const { directory } = await fixture([target, sibling]);
  await accept(directory, target);

  const canonical = await instructionCommand({
    project: directory,
    findingId: "finding-1",
  });
  const legacy = await instructionCommand({
    project: directory,
    findingId: target.id,
  });

  expect(legacy).toBe(canonical);
  expect(canonical.endsWith("\n")).toBe(true);
  expect(canonical.endsWith("\n\n")).toBe(false);
  const headings = ["Change", "Surface", "Why", "Done when", "Out of scope"];
  let previous = -1;
  for (const heading of headings) {
    const index = canonical.indexOf(`## ${heading}\n`);
    expect(index, heading).toBeGreaterThan(previous);
    previous = index;
  }
  expect(canonical).toContain(target.explanation);
  expect(canonical).toContain("- Flow: booking");
  expect(canonical).toContain("- State: ready");
  expect(canonical).toContain("- Viewport: desktop");
  expect(canonical).toContain("- Color scheme: dark");
  expect(canonical).toContain(
    "- Suggested starting area: booking action styles (a starting point only; it does not expand the scope below)",
  );
  expect(canonical).toContain("the recorded rule design:minimum-target");
  for (const criterion of target.acceptance)
    expect(canonical).toContain(`- ${criterion}`);
  expect(canonical).toContain(
    "  - finding-2: target-size on ready/phone/light",
  );
  expect(canonical).toContain(repairScopeBoundary(target));
  expect(canonical).toContain(
    "Do not implement adjacent findings or make changes outside",
  );
  for (const forbidden of [
    "+++",
    "idiom:finding",
    "2026-08-14T12-00-00-000Z",
    "abc123",
    "target-fingerprint",
    ".idiom/reports",
    "internal-evidence.png",
    "second-private.png",
    "ticket promotion",
    "Autobuild",
    '"status"',
  ])
    expect(canonical).not.toContain(forbidden);
});

test("omits absent optional surface fields and falls back from rule to category", async () => {
  const item = finding("IDM-run-0001", "fallback-fingerprint", {
    rule: null,
    suggestedArea: null,
    screenshots: [],
  });
  const { directory } = await fixture([item]);
  await accept(directory, item);

  const output = await instructionCommand({
    project: directory,
    findingId: item.id,
  });

  expect(output).toContain("the finding category target-size");
  expect(output).not.toContain("Color scheme:");
  expect(output).not.toContain("Suggested starting area:");
  expect(output).toContain(repairSiblingLines([])[0]);
  expect(output).toContain(repairScopeBoundary(item));
});

test.each(["ticketed", "verify-failed", "verified-fixed"] as const)(
  "an accepted %s finding remains renderable",
  async (status) => {
    const item = finding(`IDM-${status}`, `${status}-fingerprint`, { status });
    const { directory } = await fixture([item]);
    await accept(directory, item);

    await expect(
      instructionCommand({ project: directory, findingId: item.id }),
    ).resolves.toContain("Change\n");
  },
);

test("rejected, undecided, and stale instance-accepted findings fail clearly", async () => {
  const acceptedThenStale = finding("IDM-stale", "stale-fingerprint");
  const rejected = finding("IDM-rejected", "rejected-fingerprint");
  const undecided = finding("IDM-undecided", "undecided-fingerprint");
  const { directory } = await fixture([acceptedThenStale, rejected, undecided]);
  await accept(directory, acceptedThenStale);
  await appendDecision({
    projectDirectory: directory,
    finding: rejected,
    decision: "reject",
    scope: "instance",
  });
  const later = finding("IDM-stale", "stale-fingerprint");
  later.commit = "later-commit";
  later.createdAt = "2026-08-16T12:00:00.000Z";
  const laterRun = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-16T12-00-00-000Z",
  );
  await mkdir(laterRun, { recursive: true });
  await writeFile(
    join(laterRun, "findings.json"),
    `${JSON.stringify([later])}\n`,
  );

  await expect(
    instructionCommand({ project: directory, findingId: rejected.id }),
  ).rejects.toThrow("is rejected; accept the latest occurrence");
  await expect(
    instructionCommand({ project: directory, findingId: undecided.id }),
  ).rejects.toThrow("has no acceptance for its latest occurrence");
  await expect(
    instructionCommand({ project: directory, findingId: acceptedThenStale.id }),
  ).rejects.toThrow("has no acceptance for its latest occurrence");
});

test("instruction emission is read-only and independent of ticket emission order", async () => {
  const beforeTicket = finding("IDM-before", "before-fingerprint");
  const firstFixture = await fixture([beforeTicket]);
  await accept(firstFixture.directory, beforeTicket);
  const beforeInstruction = await snapshot(firstFixture.directory);
  const firstOutput = await instructionCommand({
    project: firstFixture.directory,
    findingId: beforeTicket.id,
  });
  expect(await snapshot(firstFixture.directory)).toEqual(beforeInstruction);
  const ticketsAfter = await ticketsCommand({
    project: firstFixture.directory,
    findingIds: [beforeTicket.id],
  });
  expect(ticketsAfter.outcomes[0]?.kind).toBe("created");

  const afterTicket = finding("IDM-after", "after-fingerprint");
  const secondFixture = await fixture([afterTicket]);
  await accept(secondFixture.directory, afterTicket);
  const ticketsBefore = await ticketsCommand({
    project: secondFixture.directory,
    findingIds: [afterTicket.id],
  });
  expect(ticketsBefore.outcomes[0]?.kind).toBe("created");
  const afterTicketsSnapshot = await snapshot(secondFixture.directory);
  const secondOutput = await instructionCommand({
    project: secondFixture.directory,
    findingId: afterTicket.id,
  });
  expect(await snapshot(secondFixture.directory)).toEqual(afterTicketsSnapshot);
  expect(secondOutput).toBe(firstOutput);
});
