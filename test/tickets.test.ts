import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { initProject } from "../src/commands/init.js";
import { ticketsCommand } from "../src/commands/tickets.js";
import { appendDecision } from "../src/decisions/log.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { renderTicket, ticketId } from "../src/tickets/render.js";

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
  viewport: string,
  fingerprint = "shared-fingerprint",
  overrides: Partial<
    Pick<
      import("../src/schemas/finding.js").FindingInput,
      "flow" | "state" | "acceptance" | "colorScheme"
    >
  > = {},
) {
  return findingSchema.parse({
    id,
    fingerprint,
    createdAt: "2026-08-14T12:00:00.000Z",
    commit: "abc123",
    flow: overrides.flow ?? "booking",
    state: overrides.state ?? "ready",
    viewport,
    colorScheme: overrides.colorScheme,
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    rule: "idiom:target-size",
    evidence: { screenshots: [`ready/${viewport}/screenshot.png`] },
    explanation: `The ${viewport} action is hard to activate.`,
    suggestedArea: "apps/web/src/button.tsx",
    acceptance: overrides.acceptance ?? [
      `The [data-route="/book/example"] action is at least 44 by 44 CSS pixels at ${viewport}.`,
    ],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: "open",
  });
}

async function fixture(findings: Finding[]) {
  const directory = await mkdtemp(join(tmpdir(), "idiom-tickets-"));
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  const run = join(directory, ".idiom", "reports", "2026-08-14T12-00-00-000Z");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "findings.json"), `${JSON.stringify(findings)}\n`);
  for (const item of findings) {
    for (const screenshot of item.evidence.screenshots) {
      const path = join(run, screenshot);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "png");
    }
  }
  return { directory, run };
}

async function acceptAll(directory: string, findings: Finding[]) {
  for (const item of findings) {
    await appendDecision({
      projectDirectory: directory,
      finding: item,
      decision: "accept",
      scope: "instance",
      now: () => new Date("2026-08-15T10:00:00.000Z"),
    });
  }
}

function findingBlock(item: Finding): string {
  return `\`\`\`idiom:finding\n${JSON.stringify(item, null, 2)}\n\`\`\``;
}

test("ticket rendering retains the complete legacy/default tuple format", () => {
  const item = finding("finding-1", "phone", "golden-fingerprint");
  item.idAliases = ["IDM-golden-0001"];
  const record = {
    finding: item,
    runId: "2026-08-14T12-00-00-000Z",
    runDirectory: "/project/.idiom/reports/2026-08-14T12-00-00-000Z",
    findingsPath:
      "/project/.idiom/reports/2026-08-14T12-00-00-000Z/findings.json",
  };

  const rendered = renderTicket({
    record,
    sourceFindings: [record],
    ticketDirectory: "/project/.autobuild/tickets/triage",
    presentation: { target: record, siblings: [] },
  });

  expect(rendered.body).toBe(
    [
      "+++",
      'id = "idiom-97a274bb0ed1ac43f191a009972f576156f33ee190b43cca4548991ceb2a6652"',
      'title = "Resolve target-size in ready at phone"',
      'labels = ["design", "idiom"]',
      "+++",
      "",
      "## What and why",
      "",
      "The phone action is hard to activate.",
      "",
      "## Acceptance criteria",
      "",
      '- [ ] The [data-route="/book/example"] action is at least 44 by 44 CSS pixels at phone.',
      "",
      "## Out of scope",
      "",
      "- Other findings from this review: none.",
      "- The default scope is flow booking, state ready, and viewport phone. An acceptance criterion that explicitly requires additional coverage extends the corresponding flow, state, or viewport scope; every flow, state, and viewport not required by that default tuple or an acceptance criterion remains out of scope.",
      "- Verification, ticket promotion, dispatch, and implementation of adjacent findings.",
      "",
      "## Evidence",
      "",
      "Source review: 2026-08-14T12-00-00-000Z; captured commit: `abc123`; finding: `finding-1`.",
      "",
      "- [Screenshot 1](../../../.idiom/reports/2026-08-14T12-00-00-000Z/ready/phone/screenshot.png)",
      "",
      "```idiom:finding",
      ...JSON.stringify(item, null, 2).split("\n"),
      "```",
      "",
      "",
    ].join("\n"),
  );
});

test("ticket rendering retains sibling and colour-scheme presentation", () => {
  const item = finding("finding-2", "desktop", "scheme-fingerprint", {
    acceptance: [
      "The action remains usable in ready and confirmed states on desktop.",
    ],
    colorScheme: "dark",
  });
  item.idAliases = ["IDM-golden-0002"];
  const sibling = finding("finding-3", "phone", "sibling-fingerprint", {
    colorScheme: "light",
  });
  const record = {
    finding: item,
    runId: "2026-08-14T12-00-00-000Z",
    runDirectory: "/project/.idiom/reports/2026-08-14T12-00-00-000Z",
    findingsPath:
      "/project/.idiom/reports/2026-08-14T12-00-00-000Z/findings.json",
  };
  const siblingRecord = { ...record, finding: sibling };

  const rendered = renderTicket({
    record,
    sourceFindings: [record, siblingRecord],
    ticketDirectory: "/project/.autobuild/tickets/triage",
    presentation: { target: record, siblings: [siblingRecord] },
  });

  expect(rendered.body).toBe(
    [
      "+++",
      'id = "idiom-9d96d1c292d632d613dca5f237a8b7c3937d407ec8d19782376280997cb83868"',
      'title = "Resolve target-size in ready at desktop (dark)"',
      'labels = ["design", "idiom"]',
      "+++",
      "",
      "## What and why",
      "",
      "The desktop action is hard to activate.",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] The action remains usable in ready and confirmed states on desktop.",
      "",
      "## Out of scope",
      "",
      "- Other findings from this review are separate work:",
      "  - finding-3: target-size on ready/phone/light",
      "- The default scope is flow booking, state ready, viewport desktop, and color scheme dark. An acceptance criterion that explicitly requires additional coverage extends the corresponding flow, state, viewport, or color-scheme scope; every coordinate not required by that default tuple or an acceptance criterion remains out of scope.",
      "- Verification, ticket promotion, dispatch, and implementation of adjacent findings.",
      "",
      "## Evidence",
      "",
      "Source review: 2026-08-14T12-00-00-000Z; captured commit: `abc123`; finding: `finding-2`.",
      "",
      "- [Screenshot 1](../../../.idiom/reports/2026-08-14T12-00-00-000Z/ready/desktop/screenshot.png)",
      "",
      "```idiom:finding",
      ...JSON.stringify(item, null, 2).split("\n"),
      "```",
      "",
      "",
    ].join("\n"),
  );
});

test("accepted findings emit distinct complete spec-standard canonical tickets", async () => {
  const findings = [
    finding("IDM-run-0001", "phone", "phone-fingerprint"),
    finding("IDM-run-0002", "desktop", "desktop-fingerprint"),
  ];
  const { directory } = await fixture(findings);
  await acceptAll(directory, findings);
  const result = await ticketsCommand({ project: directory });
  expect(result.outcomes.map((outcome) => outcome.kind)).toEqual([
    "created",
    "created",
  ]);
  const paths = result.outcomes.flatMap((outcome) =>
    outcome.kind === "created" ? [outcome.path] : [],
  );
  expect(new Set(paths.map((path) => path.split("/").at(-1))).size).toBe(2);
  for (const [index, path] of paths.entries()) {
    const source = await readFile(path, "utf8");
    const frontMatter = source.split("+++\n")[1]?.trim().split("\n") ?? [];
    expect(frontMatter.map((line) => line.split(" = ")[0])).toEqual([
      "id",
      "title",
      "labels",
    ]);
    for (const heading of [
      "## What and why",
      "## Acceptance criteria",
      "## Out of scope",
      "## Evidence",
    ])
      expect(source).toContain(heading);
    expect(source).toContain(
      `- [ ] ${findings[index]?.acceptance.doneWhen[0]}`,
    );
    const criteria = source
      .split("## Acceptance criteria\n\n")[1]
      ?.split("\n## Out of scope")[0];
    expect(criteria).not.toContain("apps/web/src/button.tsx");
    const outOfScope =
      source.split("## Out of scope\n\n")[1]?.split("\n## Evidence")[0] ?? "";
    expect(outOfScope).toContain(`finding-${index === 0 ? 2 : 1}`);
    expect(outOfScope).not.toContain(`  - finding-${index + 1}:`);
    const block = source.match(/(`{3,})idiom:finding\n([\s\S]*?)\n\1/);
    expect(block).not.toBeNull();
    expect(findingSchema.parse(JSON.parse(block?.[2] ?? ""))).toEqual({
      ...findings[index],
      id: `finding-${index + 1}`,
      idAliases: [findings[index]?.id],
    });
    const screenshot = source.match(/\[Screenshot 1\]\(([^)]+)\)/)?.[1];
    expect(screenshot).toBeDefined();
    await expect(
      access(resolve(dirname(path), decodeURIComponent(screenshot ?? ""))),
    ).resolves.toBeUndefined();
  }
});

test("emitted scope follows explicit acceptance coverage beyond the finding tuple", async () => {
  const multiViewportCriterion =
    "The standing-confirm slot time is distinguishable on both desktop and mobile.";
  const singleViewportCriterion =
    "The standing-confirm slot time is distinguishable on desktop.";
  const multiStateCriterion =
    "The booking summary remains distinguishable in both ready and confirmed states.";
  const multiFlowCriterion =
    "The slot time remains distinguishable in both booking and rescheduling flows.";
  const findings = [
    finding("IDM-scope-0001", "desktop", "multi-viewport", {
      acceptance: [multiViewportCriterion],
    }),
    finding("IDM-scope-0002", "desktop", "single-viewport", {
      acceptance: [singleViewportCriterion],
    }),
    finding("IDM-scope-0003", "desktop", "multi-state", {
      acceptance: [multiStateCriterion],
    }),
    finding("IDM-scope-0004", "desktop", "multi-flow", {
      acceptance: [multiFlowCriterion],
    }),
  ];
  const { directory } = await fixture(findings);
  await acceptAll(directory, findings);

  const result = await ticketsCommand({ project: directory });
  const sources = new Map<string, string>();
  for (const outcome of result.outcomes) {
    if (outcome.kind === "created")
      sources.set(outcome.findingId, await readFile(outcome.path, "utf8"));
  }
  expect(sources.size).toBe(findings.length);

  for (const [index, item] of findings.entries()) {
    const source = sources.get(`finding-${index + 1}`) ?? "";
    const outOfScope =
      source.split("## Out of scope\n\n")[1]?.split("\n## Evidence")[0] ?? "";
    expect(source).toContain(`- [ ] ${item.acceptance.doneWhen[0]}`);
    expect(outOfScope).toContain(
      `The default scope is flow ${item.flow}, state ${item.state}, and viewport ${item.viewport}.`,
    );
    expect(outOfScope).toContain(
      "An acceptance criterion that explicitly requires additional coverage extends the corresponding flow, state, or viewport scope",
    );
    expect(outOfScope).toContain(
      "every flow, state, and viewport not required by that default tuple or an acceptance criterion remains out of scope",
    );
  }

  expect(sources.get("finding-1") ?? "").not.toContain(
    "Every viewport other than desktop",
  );
  expect(sources.get("finding-3") ?? "").not.toContain(
    "Every state other than ready",
  );
  expect(sources.get("finding-4") ?? "").not.toContain(
    "Every flow other than booking",
  );
});

test("tracker-wide retries preserve promotion and human edits while isolating conflicts", async () => {
  const findings = [
    finding("IDM-run-0001", "phone", "one"),
    finding("IDM-run-0002", "desktop", "two"),
  ];
  const { directory, run } = await fixture(findings);
  await acceptAll(directory, findings);
  const first = await ticketsCommand({ project: directory });
  const created = first.outcomes.filter(
    (outcome) => outcome.kind === "created",
  );
  const firstPath = created[0]?.kind === "created" ? created[0].path : "";
  const secondPath = created[1]?.kind === "created" ? created[1].path : "";
  const tracker = join(directory, ".autobuild", "tickets");

  for (const state of ["ready", "doing", "done"] as const) {
    const destination = join(tracker, state, firstPath.split("/").at(-1) ?? "");
    await mkdir(dirname(destination), { recursive: true });
    await rename(
      state === "ready"
        ? firstPath
        : join(
            tracker,
            state === "doing" ? "ready" : "doing",
            firstPath.split("/").at(-1) ?? "",
          ),
      destination,
    );
    const retry = await ticketsCommand({ project: directory });
    expect(retry.outcomes[0]).toMatchObject({
      kind: "already-emitted",
      state,
      path: destination,
    });
    await expect(access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
  }

  const humanEdit = `${await readFile(secondPath, "utf8")}\nHuman note.\n`;
  await writeFile(secondPath, humanEdit);
  const edited = await ticketsCommand({ project: directory });
  expect(edited.outcomes[1]).toMatchObject({
    kind: "already-emitted",
    unchanged: false,
  });
  expect(await readFile(secondPath, "utf8")).toBe(humanEdit);

  await mkdir(dirname(firstPath), { recursive: true });
  await writeFile(firstPath, "pre-existing duplicate");
  const unrelated = finding("IDM-run-0003", "tablet", "three");
  findings.push(unrelated);
  await writeFile(join(run, "findings.json"), `${JSON.stringify(findings)}\n`);
  const unrelatedScreenshot = join(
    run,
    unrelated.evidence.screenshots[0] ?? "",
  );
  await mkdir(dirname(unrelatedScreenshot), { recursive: true });
  await writeFile(unrelatedScreenshot, "png");
  await acceptAll(directory, [unrelated]);
  const conflicted = await ticketsCommand({ project: directory });
  expect(conflicted.outcomes[0]).toMatchObject({ kind: "conflict" });
  expect(
    conflicted.outcomes[0]?.kind === "conflict"
      ? conflicted.outcomes[0].paths
      : [],
  ).toHaveLength(2);
  expect(conflicted.outcomes[2]).toMatchObject({
    kind: "created",
    findingId: "finding-3",
  });
});

test("custom drafts are no-overwrite without suppressing canonical tracker emission", async () => {
  const accepted = finding("IDM-run-0001", "phone", "accepted");
  const rejected = finding("IDM-run-0002", "desktop", "rejected");
  const undecided = finding("IDM-run-0003", "tablet", "undecided");
  const { directory, run } = await fixture([accepted, rejected, undecided]);
  await appendDecision({
    projectDirectory: directory,
    finding: accepted,
    decision: "accept",
    scope: "instance",
  });
  await appendDecision({
    projectDirectory: directory,
    finding: rejected,
    decision: "reject",
    scope: "instance",
  });
  const out = join(directory, "ticket-drafts");
  const first = await ticketsCommand({ project: directory, out });
  expect(first.outcomes).toHaveLength(1);
  expect(first.ineligible).toEqual(["finding-2", "finding-3"]);
  const path =
    first.outcomes[0]?.kind === "created" ? first.outcomes[0].path : "";
  expect(
    (
      JSON.parse(
        await readFile(join(run, "findings.json"), "utf8"),
      ) as Finding[]
    )[0]?.status,
  ).toBe("open");
  await writeFile(path, "human custom draft");
  const retry = await ticketsCommand({
    project: directory,
    out,
    findingIds: [accepted.id, rejected.id],
  });
  expect(retry.outcomes[0]).toMatchObject({
    kind: "already-emitted",
    unchanged: false,
  });
  expect(retry.ineligible).toEqual(["finding-2"]);
  expect(await readFile(path, "utf8")).toBe("human custom draft");
  expect(await readdir(out)).toHaveLength(1);
  expect(
    (
      JSON.parse(
        await readFile(join(run, "findings.json"), "utf8"),
      ) as Finding[]
    )[0]?.status,
  ).toBe("open");

  const canonical = await ticketsCommand({
    project: directory,
    findingIds: [accepted.id],
  });
  expect(canonical.outcomes[0]).toMatchObject({
    kind: "created",
    findingId: "finding-1",
    path: expect.stringContaining("/.autobuild/tickets/triage/"),
  });
  expect(
    (
      JSON.parse(
        await readFile(join(run, "findings.json"), "utf8"),
      ) as Finding[]
    )[0]?.status,
  ).toBe("ticketed");
});

test("a canonical lifecycle checkpoint suppresses a later custom draft", async () => {
  const accepted = finding("IDM-run-0001", "phone", "accepted");
  const { directory, run } = await fixture([accepted]);
  await appendDecision({
    projectDirectory: directory,
    finding: accepted,
    decision: "accept",
    scope: "instance",
  });
  const lifecycleStatus = async () =>
    (
      JSON.parse(
        await readFile(join(run, "findings.json"), "utf8"),
      ) as Finding[]
    )[0]?.status;

  const canonical = await ticketsCommand({ project: directory });
  expect(canonical.outcomes[0]).toMatchObject({
    kind: "created",
    findingId: "finding-1",
    path: expect.stringContaining("/.autobuild/tickets/triage/"),
  });
  const canonicalPath =
    canonical.outcomes[0]?.kind === "created" ? canonical.outcomes[0].path : "";
  expect(await lifecycleStatus()).toBe("ticketed");

  // With the canonical tracker ticket present, the draft resolves to it.
  const out = join(directory, "ticket-drafts");
  const withTicket = await ticketsCommand({ project: directory, out });
  expect(withTicket.outcomes).toHaveLength(1);
  expect(withTicket.outcomes[0]).toMatchObject({
    kind: "already-resolved",
    findingId: "finding-1",
    status: "ticketed",
    path: canonicalPath,
    state: "triage",
  });
  expect(withTicket.ineligible).toEqual([]);
  await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });

  // Without any tracker ticket, the persisted checkpoint alone suppresses it.
  await rm(canonicalPath);
  for (const selection of [undefined, ["finding-1"]]) {
    const result = await ticketsCommand({
      project: directory,
      out,
      ...(selection ? { findingIds: selection } : {}),
    });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      kind: "already-resolved",
      findingId: "finding-1",
      status: "ticketed",
    });
    const outcome = result.outcomes[0] as { path?: string; state?: string };
    expect(outcome.path).toBeUndefined();
    expect(outcome.state).toBeUndefined();
    await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lifecycleStatus()).toBe("ticketed");
  }

  // The checkpoint also keeps canonical output from recreating the ticket.
  const again = await ticketsCommand({ project: directory });
  expect(again.outcomes[0]).toMatchObject({
    kind: "already-resolved",
    findingId: "finding-1",
    status: "ticketed",
  });
});

test("a schema-valid hand-authored rule acceptance remains actionable", async () => {
  const item = finding("IDM-run-0001", "phone", "defensive-accept");
  const { directory } = await fixture([item]);
  await appendDecision({
    projectDirectory: directory,
    finding: item,
    decision: "accept",
    scope: "rule",
  });
  const result = await ticketsCommand({ project: directory });
  expect(result.outcomes[0]).toMatchObject({
    kind: "created",
    findingId: "finding-1",
  });
});

test("a migrated lineage discovers its legacy ticket without creating a replacement", async () => {
  const legacy = finding("IDM-run-0001", "phone", "legacy-fingerprint");
  const { directory } = await fixture([legacy]);
  const canonical = finding(legacy.id, "phone", "canonical-fingerprint");
  const secondRun = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-15T12-00-00-000Z",
  );
  await mkdir(join(secondRun, "ready", "phone"), { recursive: true });
  await writeFile(
    join(secondRun, "findings.json"),
    `${JSON.stringify([canonical])}\n`,
  );
  await writeFile(join(secondRun, "ready", "phone", "screenshot.png"), "png");
  await appendDecision({
    projectDirectory: directory,
    finding: canonical,
    decision: "accept",
    scope: "instance",
  });

  const legacyId = ticketId(legacy.fingerprint, legacy.id);
  const legacyPath = join(
    directory,
    ".autobuild",
    "tickets",
    "ready",
    `${legacyId}.md`,
  );
  await mkdir(dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, "legacy ticket");

  const result = await ticketsCommand({ project: directory });
  expect(result.outcomes).toEqual([
    expect.objectContaining({
      kind: "already-emitted",
      findingId: "finding-1",
      ticketId: legacyId,
      path: legacyPath,
      state: "ready",
    }),
  ]);
  const canonicalId = ticketId(canonical.fingerprint, canonical.id);
  await expect(
    access(
      join(directory, ".autobuild", "tickets", "triage", `${canonicalId}.md`),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(dirname(legacyPath))).toEqual([`${legacyId}.md`]);
});

test("an untouched multi-finding legacy ticket remains byte-equivalent", async () => {
  const target = finding("IDM-run-0001", "phone", "target-fingerprint");
  const sibling = finding("IDM-run-0002", "desktop", "sibling-fingerprint");
  const { directory, run } = await fixture([target, sibling]);
  await acceptAll(directory, [target]);
  const triage = join(directory, ".autobuild", "tickets", "triage");
  const ready = join(directory, ".autobuild", "tickets", "ready");
  const record = {
    finding: target,
    runId: "2026-08-14T12-00-00-000Z",
    runDirectory: run,
    findingsPath: join(run, "findings.json"),
  };
  const sourceFindings = [
    record,
    {
      ...record,
      finding: sibling,
    },
  ];
  const legacy = renderTicket({
    record,
    sourceFindings,
    ticketDirectory: triage,
  });
  await mkdir(ready, { recursive: true });
  const path = join(ready, `${legacy.id}.md`);
  await writeFile(path, legacy.body);

  const result = await ticketsCommand({ project: directory });
  expect(result.outcomes).toEqual([
    expect.objectContaining({
      kind: "already-emitted",
      findingId: "finding-1",
      path,
      unchanged: true,
    }),
  ]);
  expect(await readFile(path, "utf8")).toBe(legacy.body);
});

test("an untouched legacy ticket remains byte-equivalent after fingerprint drift", async () => {
  const first = finding("IDM-run-0001", "phone", "print-first");
  const { directory } = await fixture([first]);
  const latest = finding("IDM-run-0001", "desktop", "print-drifted");
  latest.createdAt = "2026-08-15T12:00:00.000Z";
  const latestRunId = "2026-08-15T12-00-00-000Z";
  const latestRun = join(directory, ".idiom", "reports", latestRunId);
  await mkdir(join(latestRun, dirname(latest.evidence.screenshots[0] ?? "")), {
    recursive: true,
  });
  await writeFile(
    join(latestRun, "findings.json"),
    `${JSON.stringify([latest])}\n`,
  );
  await writeFile(
    join(latestRun, latest.evidence.screenshots[0] ?? "screenshot.png"),
    "png",
  );
  await acceptAll(directory, [latest]);

  const triage = join(directory, ".autobuild", "tickets", "triage");
  const ready = join(directory, ".autobuild", "tickets", "ready");
  const latestRecord = {
    finding: latest,
    runId: latestRunId,
    runDirectory: latestRun,
    findingsPath: join(latestRun, "findings.json"),
  };
  const legacy = renderTicket({
    record: latestRecord,
    sourceFindings: [latestRecord],
    ticketDirectory: triage,
    identity: {
      fingerprint: first.fingerprint,
      findingId: first.id,
    },
  });
  await mkdir(ready, { recursive: true });
  const path = join(ready, `${legacy.id}.md`);
  await writeFile(path, legacy.body);

  const result = await ticketsCommand({ project: directory });
  expect(result.outcomes).toEqual([
    expect.objectContaining({
      kind: "already-emitted",
      findingId: "finding-1",
      path,
      unchanged: true,
    }),
  ]);
  expect(await readFile(path, "utf8")).toBe(legacy.body);
});

test("terminal lifecycle checkpoints suppress missing generated tickets", async () => {
  const ticketed = finding("IDM-run-0001", "phone", "ticketed-fingerprint");
  ticketed.status = "ticketed";
  const verified = finding("IDM-run-0002", "desktop", "verified-fingerprint");
  verified.status = "verified-fixed";
  const { directory, run } = await fixture([ticketed, verified]);
  await acceptAll(directory, [ticketed, verified]);
  const triage = join(directory, ".autobuild", "tickets", "triage");
  await mkdir(triage, { recursive: true });

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    {
      kind: "already-resolved",
      findingId: "finding-1",
      status: "ticketed",
    },
    {
      kind: "already-resolved",
      findingId: "finding-2",
      status: "verified-fixed",
    },
  ]);
  expect(result.ineligible).toEqual([]);
  expect(await readdir(triage)).toEqual([]);
  const persisted = JSON.parse(
    await readFile(join(run, "findings.json"), "utf8"),
  ) as Finding[];
  expect(persisted.map((item) => item.status)).toEqual([
    "ticketed",
    "verified-fixed",
  ]);
});

test("consolidated tracker records resolve exact historical identities without blocking unrelated creation", async () => {
  const legacy = finding("IDM-run-0001", "phone", "legacy-fingerprint");
  const consolidated = finding(
    "IDM-run-0002",
    "desktop",
    "consolidated-fingerprint",
  );
  const unrelated = finding("IDM-run-0003", "tablet", "unrelated-fingerprint");
  const { directory, run } = await fixture([legacy, consolidated, unrelated]);
  const canonical = finding(legacy.id, "phone", "canonical-fingerprint");
  canonical.commit = "def456";
  canonical.createdAt = "2026-08-15T12:00:00.000Z";
  const secondRun = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-15T12-00-00-000Z",
  );
  await mkdir(join(secondRun, "ready", "phone"), { recursive: true });
  await writeFile(
    join(secondRun, "findings.json"),
    `${JSON.stringify([canonical])}\n`,
  );
  await writeFile(join(secondRun, "ready", "phone", "screenshot.png"), "png");
  await acceptAll(directory, [canonical, consolidated, unrelated]);

  const mismatchedPair = finding(
    unrelated.id,
    "tablet",
    "not-the-catalog-fingerprint",
  );
  const consolidatedPath = join(
    directory,
    ".autobuild",
    "tickets",
    "done",
    "combined-human-ticket.md",
  );
  await mkdir(dirname(consolidatedPath), { recursive: true });
  await writeFile(
    consolidatedPath,
    [
      "# Combined repair",
      findingBlock(legacy),
      findingBlock(consolidated),
      findingBlock(mismatchedPair),
      "",
    ].join("\n\n"),
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    {
      kind: "already-resolved",
      findingId: "finding-1",
      status: "ticketed",
      path: consolidatedPath,
      state: "done",
    },
    {
      kind: "already-resolved",
      findingId: "finding-2",
      status: "ticketed",
      path: consolidatedPath,
      state: "done",
    },
    expect.objectContaining({
      kind: "created",
      findingId: "finding-3",
    }),
  ]);
  const triage = join(directory, ".autobuild", "tickets", "triage");
  expect(await readdir(triage)).toHaveLength(1);
  for (const item of [legacy, consolidated]) {
    await expect(
      access(join(triage, `${ticketId(item.fingerprint, item.id)}.md`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
  const firstPersisted = JSON.parse(
    await readFile(join(run, "findings.json"), "utf8"),
  ) as Finding[];
  expect(
    firstPersisted.find((item) => item.id === consolidated.id)?.status,
  ).toBe("ticketed");
  expect(firstPersisted.find((item) => item.id === unrelated.id)?.status).toBe(
    "ticketed",
  );
  const secondPersisted = JSON.parse(
    await readFile(join(secondRun, "findings.json"), "utf8"),
  ) as Finding[];
  expect(secondPersisted[0]?.status).toBe("ticketed");
});

async function writeTracker(
  directory: string,
  state: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(directory, ".autobuild", "tickets", state, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  return path;
}

async function persistedStatuses(run: string): Promise<string[]> {
  return (
    JSON.parse(await readFile(join(run, "findings.json"), "utf8")) as Finding[]
  ).map((item) => item.status);
}

test.each([
  ["schema-invalid", "```idiom:finding\n{}\n```\n", "invalid idiom:finding"],
  [
    "malformed JSON",
    "```idiom:finding\n{\n```\n",
    "malformed idiom:finding JSON",
  ],
  [
    "unterminated",
    "```idiom:finding\n{}\n",
    "unterminated idiom:finding block",
  ],
])(
  "a %s unrelated tracker ticket is reported while a valid accepted finding still emits",
  async (_label, body, reason) => {
    const item = finding("IDM-run-0001", "phone", "malformed-tracker");
    const { directory, run } = await fixture([item]);
    await acceptAll(directory, [item]);
    const malformedPath = await writeTracker(
      directory,
      "done",
      "malformed.md",
      body,
    );

    const result = await ticketsCommand({ project: directory });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: "created", findingId: "finding-1" }),
    ]);
    expect(result.malformed).toEqual([
      {
        path: malformedPath,
        state: "done",
        error: expect.stringContaining(
          `cannot parse tracker ticket ${malformedPath}: ${reason}`,
        ),
      },
    ]);
    expect(await persistedStatuses(run)).toEqual(["ticketed"]);
  },
);

test("a duplicate embedded identity in an unrelated ticket is reported without blocking emission", async () => {
  const item = finding("IDM-run-0001", "phone", "valid-fingerprint");
  const { directory, run } = await fixture([item]);
  await acceptAll(directory, [item]);
  const other = finding("IDM-other-0001", "desktop", "other-fingerprint");
  const changed = { ...other, explanation: "A different body." };
  const duplicatePath = await writeTracker(
    directory,
    "doing",
    "duplicate.md",
    `${findingBlock(other)}\n\n${findingBlock(changed)}\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    expect.objectContaining({ kind: "created", findingId: "finding-1" }),
  ]);
  expect(result.malformed).toHaveLength(1);
  expect(result.malformed[0]?.path).toBe(duplicatePath);
  expect(result.malformed[0]?.state).toBe("doing");
  expect(result.malformed[0]?.error).toMatch(
    new RegExp(
      `^cannot parse tracker ticket ${duplicatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*(incompatible|ambiguous)`,
    ),
  );
  expect(await persistedStatuses(run)).toEqual(["ticketed"]);
});

test("a malformed ticket naming a lineage blocks only that lineage", async () => {
  const named = finding("IDM-run-0001", "phone", "named-fingerprint");
  const unrelated = finding("IDM-run-0002", "desktop", "unrelated-fingerprint");
  const { directory, run } = await fixture([named, unrelated]);
  await acceptAll(directory, [named, unrelated]);
  const malformedPath = await writeTracker(
    directory,
    "done",
    "hand-edited.md",
    `\`\`\`idiom:finding\n${JSON.stringify({ id: named.id, fingerprint: named.fingerprint, bogus: true })}\n\`\`\`\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    { kind: "blocked", findingId: "finding-1", paths: [malformedPath] },
    expect.objectContaining({ kind: "created", findingId: "finding-2" }),
  ]);
  expect(result.malformed.map((ticket) => ticket.path)).toEqual([
    malformedPath,
  ]);
  const triage = join(directory, ".autobuild", "tickets", "triage");
  expect(await readdir(triage)).toHaveLength(1);
  expect(await persistedStatuses(run)).toEqual(["open", "ticketed"]);
  // The name minted for the blocked lineage is provisional: not persisted.
  const registry = JSON.parse(
    await readFile(join(directory, ".idiom", "finding-names.json"), "utf8"),
  ) as { next: number; entries: Array<{ name: string }> };
  expect(registry.entries.map((entry) => entry.name)).toEqual(["finding-2"]);
  expect(registry.next).toBe(3);
});

test("a malformed ticket at the lineage's generated filename blocks it", async () => {
  const item = finding("IDM-run-0001", "phone", "owned-fingerprint");
  const { directory, run } = await fixture([item]);
  await acceptAll(directory, [item]);
  const ownedPath = await writeTracker(
    directory,
    "triage",
    `${ticketId(item.fingerprint, item.id)}.md`,
    "# Hand edited\n\n```idiom:finding\n{}\n```\n",
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    { kind: "blocked", findingId: "finding-1", paths: [ownedPath] },
  ]);
  expect(await persistedStatuses(run)).toEqual(["open"]);
});

test("embedded reconciliation proceeds beside a malformed unrelated ticket", async () => {
  const item = finding("IDM-run-0001", "phone", "consolidated-fingerprint");
  const { directory, run } = await fixture([item]);
  await acceptAll(directory, [item]);
  const consolidatedPath = await writeTracker(
    directory,
    "done",
    "combined.md",
    `# Combined\n\n${findingBlock(item)}\n`,
  );
  await writeTracker(
    directory,
    "done",
    "broken.md",
    "```idiom:finding\n{}\n```\n",
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    {
      kind: "already-resolved",
      findingId: "finding-1",
      status: "ticketed",
      path: consolidatedPath,
      state: "done",
    },
  ]);
  expect(result.malformed).toHaveLength(1);
  expect(await persistedStatuses(run)).toEqual(["ticketed"]);
});

test("an embedded identity in two tracker tickets is a conflict, not the first ticket", async () => {
  const item = finding("IDM-run-0001", "phone", "duplicated-fingerprint");
  const unrelated = finding("IDM-run-0002", "desktop", "unrelated-fingerprint");
  const { directory, run } = await fixture([item, unrelated]);
  await acceptAll(directory, [item, unrelated]);
  const readyPath = await writeTracker(
    directory,
    "ready",
    "combined-a.md",
    `# Combined A\n\n${findingBlock(item)}\n`,
  );
  const donePath = await writeTracker(
    directory,
    "done",
    "combined-b.md",
    `# Combined B\n\n${findingBlock(item)}\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    {
      kind: "conflict",
      findingId: "finding-1",
      ticketId: expect.any(String),
      paths: [readyPath, donePath],
    },
    expect.objectContaining({ kind: "created", findingId: "finding-2" }),
  ]);
  const triage = join(directory, ".autobuild", "tickets", "triage");
  const createdOutcome = result.outcomes[1];
  expect(await readdir(triage)).toEqual([
    createdOutcome?.kind === "created" ? `${createdOutcome.ticketId}.md` : "",
  ]);
  expect(await persistedStatuses(run)).toEqual(["open", "ticketed"]);
});

test("an unaccepted lineage embedded twice in one state is a conflict", async () => {
  const item = finding("IDM-run-0001", "phone", "unaccepted-duplicate");
  const { directory, run } = await fixture([item]);
  const firstPath = await writeTracker(
    directory,
    "done",
    "first.md",
    `${findingBlock(item)}\n`,
  );
  const secondPath = await writeTracker(
    directory,
    "done",
    "second.md",
    `${findingBlock(item)}\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    {
      kind: "conflict",
      findingId: "finding-1",
      ticketId: expect.any(String),
      paths: [firstPath, secondPath],
    },
  ]);
  expect(result.ineligible).toEqual([]);
  expect(await persistedStatuses(run)).toEqual(["open"]);
});

test("a ticketed lineage embedded in two tickets is a conflict, not already-resolved", async () => {
  const item = finding("IDM-run-0001", "phone", "ticketed-duplicate");
  item.status = "ticketed";
  const { directory } = await fixture([item]);
  await acceptAll(directory, [item]);
  const firstPath = await writeTracker(
    directory,
    "doing",
    "first.md",
    `${findingBlock(item)}\n`,
  );
  const secondPath = await writeTracker(
    directory,
    "done",
    "second.md",
    `${findingBlock(item)}\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    {
      kind: "conflict",
      findingId: "finding-1",
      ticketId: expect.any(String),
      paths: [firstPath, secondPath],
    },
  ]);
});

test("one ticket repeating an embedded block resolves to that ticket, not a conflict", async () => {
  const item = finding("IDM-run-0001", "phone", "repeated-block-fingerprint");
  const { directory, run } = await fixture([item]);
  await acceptAll(directory, [item]);
  const path = await writeTracker(
    directory,
    "done",
    "combined.md",
    `${findingBlock(item)}\n\n${findingBlock(item)}\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.malformed).toEqual([]);
  expect(result.outcomes).toEqual([
    {
      kind: "already-resolved",
      findingId: "finding-1",
      status: "ticketed",
      path,
      state: "done",
    },
  ]);
  expect(await persistedStatuses(run)).toEqual(["ticketed"]);
});

test("a malformed ticket mentioning finding-12 does not block finding-1", async () => {
  const item = finding("finding-1", "phone", "boundary-fingerprint");
  const { directory } = await fixture([item]);
  await acceptAll(directory, [item]);
  await writeTracker(
    directory,
    "done",
    "other.md",
    'Relates to finding-12 and finding-1x.\n\n```idiom:finding\n{"id":"finding-12"}\n```\n',
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    expect.objectContaining({ kind: "created", findingId: "finding-1" }),
  ]);
  expect(result.malformed).toHaveLength(1);
});

test("an instance acceptance does not authorize ticketing a later commit", async () => {
  const first = finding("IDM-run-0001", "phone", "stable-fingerprint");
  const { directory } = await fixture([first]);
  await appendDecision({
    projectDirectory: directory,
    finding: first,
    decision: "accept",
    scope: "instance",
  });
  const second = finding("IDM-run-0001", "phone", "stable-fingerprint");
  second.commit = "def456";
  second.createdAt = "2026-08-15T12:00:00.000Z";
  const secondRun = join(
    directory,
    ".idiom",
    "reports",
    "2026-08-15T12-00-00-000Z",
  );
  await mkdir(secondRun, { recursive: true });
  await writeFile(
    join(secondRun, "findings.json"),
    `${JSON.stringify([second])}\n`,
  );

  const result = await ticketsCommand({ project: directory });
  expect(result.outcomes).toEqual([]);
  expect(result.ineligible).toEqual(["finding-1"]);
});

test("legacy publication follows severity then score and retries retain ticket identities", async () => {
  const low = finding("finding-1", "phone", "low");
  low.severity = "minor";
  const high = finding("finding-2", "desktop", "high");
  high.category = "dead-control";
  high.severity = "minor";
  const major = finding("finding-3", "phone", "major");
  const blocker = finding("finding-4", "desktop", "blocker");
  blocker.severity = "blocker";
  const { directory } = await fixture([low, high, major, blocker]);
  for (const item of [low, high, major, blocker])
    await appendDecision({
      projectDirectory: directory,
      finding: item,
      decision: "accept",
      reason: "Repair",
      scope: "instance",
    });
  const first = await ticketsCommand({ project: directory });
  expect(first.outcomes.map((o) => o.findingId)).toEqual([
    "finding-4",
    "finding-3",
    "finding-2",
    "finding-1",
  ]);
  const retry = await ticketsCommand({ project: directory });
  expect(retry.outcomes.map((o) => o.kind)).toEqual(
    Array(4).fill("already-emitted"),
  );
  expect(
    retry.outcomes.map((o) => ("ticketId" in o ? o.ticketId : "")),
  ).toEqual(first.outcomes.map((o) => ("ticketId" in o ? o.ticketId : "")));
});

async function linkTracker(
  directory: string,
  state: string,
  name: string,
  body: string,
): Promise<{ link: string; target: string }> {
  const target = join(directory, "elsewhere", name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
  const link = join(directory, ".autobuild", "tickets", state, name);
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  return { link, target };
}

test.each(["regular", "symlink"] as const)(
  "a %s ticket at the generated filename prevents a duplicate",
  async (form) => {
    const item = finding("IDM-run-0001", "phone", "linked-fingerprint");
    const { directory, run } = await fixture([item]);
    await acceptAll(directory, [item]);
    const first = await ticketsCommand({ project: directory });
    const createdPath =
      first.outcomes[0]?.kind === "created" ? first.outcomes[0].path : "";
    const name = createdPath.split("/").at(-1) ?? "";
    const tracker = join(directory, ".autobuild", "tickets");
    const destination = join(tracker, "ready", name);
    await mkdir(dirname(destination), { recursive: true });
    const target = join(directory, "elsewhere", name);
    const bytes = await readFile(createdPath, "utf8");
    if (form === "regular") {
      await rename(createdPath, destination);
    } else {
      await mkdir(dirname(target), { recursive: true });
      await rename(createdPath, target);
      await symlink(target, destination);
    }

    const retry = await ticketsCommand({ project: directory });

    expect(retry.outcomes[0]).toMatchObject({
      kind: "already-emitted",
      state: "ready",
      path: destination,
      unchanged: true,
    });
    expect(await readdir(join(tracker, "triage"))).toEqual([]);
    expect(await persistedStatuses(run)).toEqual(["ticketed"]);
    if (form === "symlink") {
      expect((await lstat(destination)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe(bytes);
    }
  },
);

test("a symlinked ticket's embedded identity resolves the lineage", async () => {
  const item = finding("IDM-run-0001", "phone", "linked-embedded-fingerprint");
  const { directory, run } = await fixture([item]);
  await acceptAll(directory, [item]);
  const { link } = await linkTracker(
    directory,
    "done",
    "combined.md",
    `# Combined\n\n${findingBlock(item)}\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    {
      kind: "already-resolved",
      findingId: "finding-1",
      status: "ticketed",
      path: link,
      state: "done",
    },
  ]);
  await expect(
    access(join(directory, ".autobuild", "tickets", "triage")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await persistedStatuses(run)).toEqual(["ticketed"]);
});

test("a malformed symlinked ticket naming a lineage blocks it", async () => {
  const item = finding("IDM-run-0001", "phone", "linked-malformed-fingerprint");
  const { directory, run } = await fixture([item]);
  await acceptAll(directory, [item]);
  const { link } = await linkTracker(
    directory,
    "done",
    "hand-edited.md",
    `\`\`\`idiom:finding\n${JSON.stringify({ id: item.id, fingerprint: item.fingerprint, bogus: true })}\n\`\`\`\n`,
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    { kind: "blocked", findingId: "finding-1", paths: [link] },
  ]);
  expect(result.malformed.map((ticket) => ticket.path)).toEqual([link]);
  expect(await persistedStatuses(run)).toEqual(["open"]);
});

test("dangling and directory symlinks in the tracker are not tickets", async () => {
  const item = finding("IDM-run-0001", "phone", "unrelated-link-fingerprint");
  const { directory } = await fixture([item]);
  await acceptAll(directory, [item]);
  const ready = join(directory, ".autobuild", "tickets", "ready");
  await mkdir(join(directory, "elsewhere", "folder.md"), { recursive: true });
  await mkdir(ready, { recursive: true });
  await symlink(
    join(directory, "elsewhere", "missing.md"),
    join(ready, "dangling.md"),
  );
  await symlink(
    join(directory, "elsewhere", "folder.md"),
    join(ready, "folder.md"),
  );

  const result = await ticketsCommand({ project: directory });

  expect(result.outcomes).toEqual([
    expect.objectContaining({ kind: "created", findingId: "finding-1" }),
  ]);
  expect(result.malformed).toEqual([]);
});
