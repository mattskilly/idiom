import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { contextCommand } from "../src/commands/context.js";
import { initProject } from "../src/commands/init.js";
import {
  BRIEF_BYTE_CEILING,
  REVIEW_EVIDENCE_UNAVAILABLE,
  TOKENS_NOT_CONFIGURED,
  TRACKER_STATE_UNAVAILABLE,
} from "../src/context/brief.js";
import { appendRuling } from "../src/rulings/law.js";
import type { Decision } from "../src/schemas/decision.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import { ticketId } from "../src/tickets/render.js";
import type { GitTopology } from "../src/verify/baseline.js";

const SECTIONS = [
  "Recorded rulings",
  "Design law",
  "Standing prohibitions",
  "Craft checks",
  "Design tokens",
  "Project rules",
  "Accepted work not yet built",
  "Product intent",
] as const;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function project(): Promise<string> {
  const directory = await temporary("idiom-context-");
  await initProject({ project: directory, yes: true });
  await writeFile(
    join(directory, "DESIGN.md"),
    "# Law\n\nWe do not underline.\n",
  );
  await writeFile(join(directory, "PRODUCT.md"), "# Intent\n\nBook fast.\n");
  return directory;
}

function finding(options: {
  id: string;
  fingerprint: string;
  createdAt?: string | undefined;
  commit?: string | undefined;
  flow?: string | undefined;
  state?: string | undefined;
  viewport?: string | undefined;
  colorScheme?: Finding["colorScheme"] | undefined;
  category?: Finding["category"] | undefined;
  severity?: Finding["severity"] | undefined;
  rule?: string | undefined;
  explanation?: string | undefined;
  acceptance?: string[] | undefined;
  status?: Finding["status"] | undefined;
}): Finding {
  return findingSchema.parse({
    id: options.id,
    fingerprint: options.fingerprint,
    createdAt: options.createdAt ?? "2026-08-14T12:00:00.000Z",
    commit: options.commit ?? "abc123",
    flow: options.flow ?? "booking",
    state: options.state ?? "ready",
    viewport: options.viewport ?? "desktop",
    ...(options.colorScheme === undefined
      ? {}
      : { colorScheme: options.colorScheme }),
    layer: "deterministic",
    category: options.category ?? "target-size",
    severity: options.severity ?? "major",
    confidence: 1,
    ...(options.rule === undefined ? {} : { rule: options.rule }),
    evidence: { screenshots: [] },
    explanation: options.explanation ?? "The action is too small.",
    acceptance: options.acceptance ?? ["The target is at least 44px."],
    verification: { kind: "deterministic-check", check: "target-size" },
    status: options.status ?? "open",
  });
}

async function reportRun(
  root: string,
  runId: string,
  findings: Finding[],
): Promise<void> {
  const path = join(root, ".idiom", "reports", runId);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "findings.json"),
    `${JSON.stringify(findings, null, 2)}\n`,
  );
}

function decision(options: {
  findingId: string;
  fingerprint: string;
  decision: "accept" | "reject";
  scope?: "instance" | "rule" | undefined;
  reason?: string | undefined;
  at?: string | undefined;
  commit?: string | undefined;
}): Decision {
  return {
    at: options.at ?? "2026-08-15T12:00:00.000Z",
    commit: options.commit ?? "abc123",
    findingId: options.findingId,
    fingerprint: options.fingerprint,
    decision: options.decision,
    scope: options.scope ?? "instance",
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    actor: "human",
  };
}

async function writeDecisions(
  directory: string,
  decisions: Decision[],
): Promise<void> {
  await appendFile(
    join(directory, ".idiom", "decisions.jsonl"),
    decisions.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
}

function flowManifest(id: string): unknown {
  return {
    id,
    title: id,
    intent: [],
    setup: [],
    states: [{ id: "ready", description: "Ready", url: "/", expect: {} }],
  };
}

async function writeFlow(
  directory: string,
  file: string,
  body?: unknown,
): Promise<void> {
  await writeFile(
    join(directory, ".idiom", "flows", `${file}.json`),
    typeof body === "string"
      ? body
      : JSON.stringify(body ?? flowManifest(file)),
  );
}

async function setDesign(
  directory: string,
  design: Record<string, string>,
): Promise<void> {
  const path = join(directory, ".idiom", "project.json");
  const value = JSON.parse(await readFile(path, "utf8")) as {
    design: Record<string, string>;
  };
  value.design = { ...value.design, ...design };
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function ticketAt(
  root: string,
  state: string,
  id: string,
): Promise<void> {
  const directory = join(root, ".autobuild", "tickets", state);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.md`), "# ticket\n");
}

function topology(primary: string | undefined): GitTopology {
  return async () => primary;
}

const throwingTopology: GitTopology = async () => {
  throw new Error("git is unavailable");
};

async function tree(root: string): Promise<string> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        files.push(`${relative(root, path)}->${await readlink(path)}`);
      else if (entry.isDirectory()) await walk(path);
      else
        files.push(
          `${relative(root, path)}:${createHash("sha256")
            .update(await readFile(path))
            .digest("hex")}`,
        );
    }
  };
  await walk(root);
  return files.join("\n");
}

function headingIndexes(brief: string): number[] {
  return SECTIONS.map((title) => brief.indexOf(`\n## ${title}\n`));
}

function section(brief: string, title: (typeof SECTIONS)[number]): string {
  const marker = `\n## ${title}\n`;
  const start = brief.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = brief.slice(start + marker.length);
  const next = SECTIONS.map((candidate) => body.indexOf(`\n## ${candidate}\n`))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return next === undefined ? body : body.slice(0, next + 1);
}

test("the brief renders the fixed sections in order from committed guidance", async () => {
  const directory = await project();
  await mkdir(join(directory, "packages", "design"), { recursive: true });
  await writeFile(
    join(directory, "packages", "design", "theme.css"),
    ":root {\n  --color-fg: #111111;\n}\n@media (min-width: 40em) {\n  :root { --color-accent: rgb(1, 2, 3); }\n}\n",
  );
  await setDesign(directory, { tokensFile: "packages/design/theme.css" });

  const brief = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });

  const indexes = headingIndexes(brief);
  expect(indexes.every((index) => index >= 0)).toBe(true);
  expect([...indexes].sort((left, right) => left - right)).toEqual(indexes);
  expect(brief.startsWith("# Design brief\n\nScope: project-wide\n")).toBe(
    true,
  );
  expect(section(brief, "Design law")).toContain("We do not underline.");
  expect(section(brief, "Product intent")).toContain("Book fast.");
  // Nested declarations resolve exactly as the token-drift capture layer sees
  // them, and names are emitted in a stable sorted order with authored values.
  expect(section(brief, "Design tokens").trim()).toBe(
    "--color-accent: rgb(1, 2, 3)\n--color-fg: #111111",
  );
  expect(brief).not.toContain(directory);
});

test("recorded rule and no-rule outcomes are promoted ahead of a long design law", async () => {
  const directory = await project();
  const design = join(directory, "DESIGN.md");
  const longLaw = `# Law\n\n${"early design prose\n".repeat(900)}`;
  const ruled = appendRuling(longLaw, {
    id: "ruling-1",
    fingerprint: "chip-print",
    choiceKey: "chip-selection",
    outcome: "rule",
    wording: "Selected chips use a filled treatment.",
    recordedAt: "2026-08-20T12:00:00.000Z",
  });
  await writeFile(
    design,
    appendRuling(ruled, {
      id: "ruling-2",
      fingerprint: "date-print",
      choiceKey: "date-input-strategy",
      outcome: "no-rule",
      recordedAt: "2026-08-20T12:01:00.000Z",
    }),
  );
  const brief = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });
  expect(section(brief, "Recorded rulings")).toContain(
    "Selected chips use a filled treatment.",
  );
  expect(section(brief, "Recorded rulings")).toContain(
    "No rule needed (deliberately left unruled)",
  );
  expect(section(brief, "Design law")).not.toContain(
    "<!-- idiom:ruling:start -->",
  );
  expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(BRIEF_BYTE_CEILING);
});

test("an unconfigured token file is reported explicitly rather than as no tokens", async () => {
  const directory = await project();
  const brief = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });
  expect(section(brief, "Design tokens").trim()).toBe(TOKENS_NOT_CONFIGURED);
});

test("configured token failures propagate the existing capture diagnostics", async () => {
  const directory = await project();
  await setDesign(directory, { tokensFile: "missing/theme.css" });
  await expect(
    contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).rejects.toThrow('cannot read design.tokensFile "missing/theme.css"');

  await setDesign(directory, { tokensFile: "../escape.css" });
  await expect(
    contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).rejects.toThrow("design.tokensFile must remain inside the project");

  await writeFile(join(directory, "empty.css"), "a { color: red; }\n");
  await setDesign(directory, { tokensFile: "empty.css" });
  await expect(
    contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).rejects.toThrow("contains no custom-property declarations");
});

test("rules are complete without a flow and global-plus-exact with one", async () => {
  const directory = await project();
  await writeFlow(directory, "alpha");
  await writeFlow(directory, "beta");
  await writeFile(
    join(directory, ".idiom", "rules.json"),
    JSON.stringify({
      version: 1,
      overrides: [
        {
          id: "global-suppress",
          match: { category: "contrast" },
          action: "suppress",
          reason: "Brand palette is intentional",
        },
        {
          id: "alpha-severity",
          match: { flow: "alpha", state: "ready" },
          action: "severity",
          severity: "minor",
          reason: "Alpha is low traffic",
        },
        {
          id: "beta-suppress",
          match: { fingerprint: "beta-print", flow: "beta" },
          action: "suppress",
          reason: "Beta ships an intentional treatment",
        },
      ],
    }),
  );

  const all = section(
    await contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Project rules",
  );
  expect(all.trim().split("\n")).toEqual([
    "- global-suppress: suppress when category=contrast — Brand palette is intentional",
    "- alpha-severity: severity minor when flow=alpha, state=ready — Alpha is low traffic",
    "- beta-suppress: suppress when fingerprint=beta-print, flow=beta — Beta ships an intentional treatment",
  ]);

  const beta = section(
    await contextCommand({
      project: directory,
      flow: "beta",
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Project rules",
  );
  expect(beta).toContain("- global-suppress:");
  expect(beta).toContain("- beta-suppress:");
  expect(beta).not.toContain("alpha-severity");
});

test("standing rule rejections are project-wide, actionable, and alias-aware", async () => {
  const directory = await project();
  await writeFlow(directory, "alpha");
  await writeFlow(directory, "beta");
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-alpha-0001",
      fingerprint: "legacy-print",
      flow: "alpha",
      state: "entry",
      viewport: "mobile",
      rule: "DESIGN.md: we do not underline",
      explanation: "The link is underlined.",
    }),
    finding({
      id: "IDM-alpha-0002",
      fingerprint: "cancelled-print",
      flow: "alpha",
      explanation: "The heading is quiet.",
    }),
  ]);
  await reportRun(directory, "2026-08-15T12-00-00-000Z", [
    finding({
      id: "IDM-alpha-0001",
      fingerprint: "canonical-print",
      createdAt: "2026-08-15T12:00:00.000Z",
      flow: "alpha",
      state: "entry",
      viewport: "mobile",
      rule: "DESIGN.md: we do not underline",
      explanation: "The link is underlined in the newest observation.",
    }),
  ]);
  await writeDecisions(directory, [
    decision({
      findingId: "IDM-alpha-0001",
      fingerprint: "legacy-print",
      decision: "reject",
      scope: "rule",
      reason: "Underlines are never used here",
      at: "2026-08-15T13:00:00.000Z",
    }),
    decision({
      findingId: "IDM-alpha-0001",
      fingerprint: "canonical-print",
      decision: "reject",
      scope: "rule",
      reason: "Underlines are never used here",
      at: "2026-08-15T14:00:00.000Z",
    }),
    decision({
      findingId: "IDM-alpha-0002",
      fingerprint: "cancelled-print",
      decision: "reject",
      scope: "rule",
      at: "2026-08-15T15:00:00.000Z",
    }),
    decision({
      findingId: "IDM-alpha-0002",
      fingerprint: "cancelled-print",
      decision: "accept",
      scope: "rule",
      at: "2026-08-15T16:00:00.000Z",
    }),
    decision({
      findingId: "IDM-gone-0001",
      fingerprint: "orphan-print",
      decision: "reject",
      scope: "rule",
      at: "2026-08-15T17:00:00.000Z",
    }),
  ]);

  // A rejection observed only in alpha is standing project-wide policy, so a
  // beta-scoped brief must still carry it in full.
  const brief = await contextCommand({
    project: directory,
    flow: "beta",
    dependencies: { gitTopology: topology(undefined) },
  });
  const prohibitions = section(brief, "Standing prohibitions");
  expect(prohibitions.trim().split("\n\n")).toEqual([
    [
      "- Do not repeat this rejected pattern: The link is underlined in the newest observation.",
      "  Rule: DESIGN.md: we do not underline",
      "  Reason: Underlines are never used here",
      "  Rejections: 2",
      "  Applies: project-wide, in every flow and state",
      "  First observed: alpha/entry/mobile",
    ].join("\n"),
    [
      "- Do not reintroduce the standing rejected pattern identified by fingerprint orphan-print; descriptive finding evidence is unavailable.",
      "  Reason: No reason recorded",
      "  Rejections: 1",
      "  Applies: project-wide, in every flow and state",
    ].join("\n"),
  ]);
  // The later alias acceptance removed its prohibition entirely.
  expect(prohibitions).not.toContain("The heading is quiet.");
  expect(prohibitions).not.toContain(REVIEW_EVIDENCE_UNAVAILABLE);
});

test("a prohibition without finding artifacts falls back to its category label", async () => {
  const directory = await project();
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-run-0001",
      fingerprint: "print",
      explanation: "The control is generic.",
    }),
  ]);
  await writeDecisions(directory, [
    decision({
      findingId: "IDM-run-0001",
      fingerprint: "print",
      decision: "reject",
      scope: "rule",
    }),
  ]);
  const brief = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });
  expect(section(brief, "Standing prohibitions")).toContain(
    "  Rule: target-size",
  );
});

test("standing prohibitions identify the color scheme where they were first observed", async () => {
  const directory = await project();
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-light-0001",
      fingerprint: "light-print",
      colorScheme: "light",
      explanation: "The light surface is incorrect.",
    }),
    finding({
      id: "IDM-dark-0001",
      fingerprint: "dark-print",
      colorScheme: "dark",
      explanation: "The dark surface is incorrect.",
    }),
  ]);
  await writeDecisions(directory, [
    decision({
      findingId: "IDM-light-0001",
      fingerprint: "light-print",
      decision: "reject",
      scope: "rule",
    }),
    decision({
      findingId: "IDM-dark-0001",
      fingerprint: "dark-print",
      decision: "reject",
      scope: "rule",
    }),
  ]);

  const prohibitions = section(
    await contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Standing prohibitions",
  );
  expect(prohibitions).toContain("First observed: booking/ready/desktop/light");
  expect(prohibitions).toContain("First observed: booking/ready/desktop/dark");
});

test("recorded free text spanning lines stays on one entry line", async () => {
  const directory = await project();
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-run-0001",
      fingerprint: "print",
      rule: "DESIGN.md:\n  we do not underline",
      explanation:
        "The link is underlined.\r\n\r\nIt competes with the action.",
    }),
  ]);
  await writeDecisions(directory, [
    decision({
      findingId: "IDM-run-0001",
      fingerprint: "print",
      decision: "reject",
      scope: "rule",
      reason: "Never.\nNot once.",
    }),
  ]);

  const prohibitions = section(
    await contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Standing prohibitions",
  );
  expect(prohibitions.trim().split("\n")).toEqual([
    "- Do not repeat this rejected pattern: The link is underlined. It competes with the action.",
    "  Rule: DESIGN.md: we do not underline",
    "  Reason: Never. Not once.",
    "  Rejections: 1",
    "  Applies: project-wide, in every flow and state",
    "  First observed: booking/ready/desktop",
  ]);
});

test("accepted work excludes completed lineages and honors flow scope", async () => {
  const directory = await project();
  await writeFlow(directory, "alpha");
  await writeFlow(directory, "beta");
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-open-0001",
      fingerprint: "open-print",
      flow: "alpha",
      explanation: "The action is too small.",
      acceptance: ["The target is at least 44px.", "Spacing is preserved."],
    }),
    finding({
      id: "IDM-other-0001",
      fingerprint: "other-print",
      flow: "beta",
      explanation: "The label is missing.",
    }),
    finding({
      id: "IDM-fixed-0001",
      fingerprint: "fixed-print",
      flow: "alpha",
      status: "verified-fixed",
      explanation: "The contrast was raised.",
    }),
    finding({
      id: "IDM-failed-0001",
      fingerprint: "failed-print",
      flow: "alpha",
      status: "verify-failed",
      explanation: "The retry still overflows.",
    }),
    finding({
      id: "IDM-rejected-0001",
      fingerprint: "rejected-print",
      flow: "alpha",
      explanation: "The density is intentional.",
    }),
  ]);
  await writeDecisions(directory, [
    ...["open", "other", "fixed", "failed"].map((name) =>
      decision({
        findingId: `IDM-${name}-0001`,
        fingerprint: `${name}-print`,
        decision: "accept",
      }),
    ),
    decision({
      findingId: "IDM-rejected-0001",
      fingerprint: "rejected-print",
      decision: "reject",
    }),
  ]);

  const all = section(
    await contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Accepted work not yet built",
  );
  expect(all).toContain(
    "- finding-1 — major target-size in alpha/ready/desktop",
  );
  expect(all).toContain(
    "  Acceptance:\n  - The target is at least 44px.\n  - Spacing is preserved.",
  );
  expect(all).toContain("  Tracker: custom checkpoint");
  expect(all).toContain("- finding-2");
  expect(all).toContain("- finding-4");
  expect(all).toContain("  Verification: verify-failed");
  expect(all).not.toContain("IDM-fixed-0001");
  expect(all).not.toContain("IDM-rejected-0001");

  const alpha = section(
    await contextCommand({
      project: directory,
      flow: "alpha",
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Accepted work not yet built",
  );
  expect(alpha).toContain("- finding-1");
  expect(alpha).not.toContain("finding-2");
});

test("a named flow is validated exactly and unrelated manifests stay unread", async () => {
  const directory = await project();
  await writeFlow(directory, "booking");
  await writeFlow(directory, "broken", "{ not json");
  await writeFlow(directory, "mismatch", flowManifest("elsewhere"));

  await expect(
    contextCommand({
      project: directory,
      flow: "booking",
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).resolves.toContain("Scope: flow booking");
  await expect(
    contextCommand({
      project: directory,
      flow: "typo",
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).rejects.toThrow(".idiom/flows/typo.json: file not found");
  await expect(
    contextCommand({
      project: directory,
      flow: "broken",
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).rejects.toThrow(".idiom/flows/broken.json: malformed JSON");
  await expect(
    contextCommand({
      project: directory,
      flow: "mismatch",
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).rejects.toThrow(
    'requested flow "mismatch" does not match the manifest id "elsewhere"',
  );
});

test("a project-wide brief succeeds when no flow manifest exists at all", async () => {
  const directory = await project();
  await rm(join(directory, ".idiom", "flows"), {
    recursive: true,
    force: true,
  });
  await expect(
    contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
  ).resolves.toContain("Scope: project-wide");
});

test("finding evidence resolves through the primary checkout of a linked worktree", async () => {
  const worktree = await project();
  // The report store is gitignored, so a linked worktree carries none of its
  // own. `initProject` creates the directory, so remove it to match reality.
  await rm(join(worktree, ".idiom", "reports"), {
    recursive: true,
    force: true,
  });
  const primary = await temporary("idiom-primary-");
  await reportRun(primary, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-run-0001",
      fingerprint: "print",
      rule: "DESIGN.md: we do not underline",
      explanation: "The link is underlined.",
    }),
    finding({
      id: "IDM-open-0001",
      fingerprint: "open-print",
      explanation: "The action is too small.",
    }),
  ]);
  await writeDecisions(worktree, [
    decision({
      findingId: "IDM-run-0001",
      fingerprint: "print",
      decision: "reject",
      scope: "rule",
      reason: "Underlines are never used here",
    }),
    decision({
      findingId: "IDM-open-0001",
      fingerprint: "open-print",
      decision: "accept",
    }),
  ]);

  const resolved = await contextCommand({
    project: worktree,
    dependencies: { gitTopology: topology(primary) },
  });
  expect(resolved).toContain(
    "- Do not repeat this rejected pattern: The link is underlined.",
  );
  expect(resolved).toContain("  Rule: DESIGN.md: we do not underline");
  expect(resolved).toContain("- finding-2 — major target-size");
  expect(resolved).not.toContain(REVIEW_EVIDENCE_UNAVAILABLE);

  const degraded = await contextCommand({
    project: worktree,
    dependencies: { gitTopology: topology(undefined) },
  });
  expect(degraded).toContain(
    "- Do not reintroduce the standing rejected pattern identified by fingerprint print; descriptive finding evidence is unavailable.",
  );
  expect(degraded).not.toContain("The link is underlined.");
  expect(section(degraded, "Standing prohibitions")).toContain(
    REVIEW_EVIDENCE_UNAVAILABLE,
  );
  expect(section(degraded, "Accepted work not yet built")).toContain(
    REVIEW_EVIDENCE_UNAVAILABLE,
  );
  expect(section(degraded, "Accepted work not yet built")).not.toContain(
    "IDM-open-0001",
  );

  // A throwing topology resolver is indistinguishable from no primary at all.
  await expect(
    contextCommand({
      project: worktree,
      dependencies: { gitTopology: throwingTopology },
    }),
  ).resolves.toBe(degraded);
});

test("a present but empty report store is distinct from a missing one", async () => {
  const directory = await project();
  const brief = async (): Promise<string> =>
    await contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    });

  // Straight out of `initProject`: the store exists and holds no run at all.
  // Nothing about that read is degraded — the project has simply never been
  // reviewed — so the marker must stay off.
  const neverReviewed = await brief();
  expect(neverReviewed).not.toContain(REVIEW_EVIDENCE_UNAVAILABLE);
  expect(section(neverReviewed, "Standing prohibitions")).toContain(
    "No standing rule-scope rejections recorded.",
  );

  await reportRun(directory, "2026-08-14T12-00-00-000Z", []);
  expect(await brief()).not.toContain(REVIEW_EVIDENCE_UNAVAILABLE);

  await rm(join(directory, ".idiom", "reports"), {
    recursive: true,
    force: true,
  });
  const missing = await brief();
  expect(section(missing, "Standing prohibitions")).toContain(
    REVIEW_EVIDENCE_UNAVAILABLE,
  );
  expect(section(missing, "Accepted work not yet built")).toContain(
    REVIEW_EVIDENCE_UNAVAILABLE,
  );
});

test("a self-resolving or duplicate primary leaves the brief byte-identical", async () => {
  const directory = await project();
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [
    finding({ id: "IDM-run-0001", fingerprint: "print" }),
  ]);
  await writeDecisions(directory, [
    decision({
      findingId: "IDM-run-0001",
      fingerprint: "print",
      decision: "accept",
    }),
  ]);
  const baseline = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });

  await expect(
    contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(directory) },
    }),
  ).resolves.toBe(baseline);

  // A primary whose run ID collides with a local one must not double-count the
  // lineage or reorder first/latest chronology.
  const primary = await temporary("idiom-primary-");
  await reportRun(primary, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-run-0001",
      fingerprint: "print",
      explanation: "A stale copy that must never win.",
    }),
  ]);
  await expect(
    contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(primary) },
    }),
  ).resolves.toBe(baseline);
});

test("tracker state resolves through the primary checkout and marks a missing store", async () => {
  const worktree = await project();
  const primary = await temporary("idiom-primary-");
  const built = finding({
    id: "IDM-built-0001",
    fingerprint: "built-print",
    status: "ticketed",
    explanation: "The built repair.",
  });
  const queued = finding({
    id: "IDM-queued-0001",
    fingerprint: "queued-print",
    status: "ticketed",
    explanation: "The queued repair.",
  });
  await reportRun(worktree, "2026-08-14T12-00-00-000Z", [built, queued]);
  await writeDecisions(worktree, [
    decision({
      findingId: built.id,
      fingerprint: built.fingerprint,
      decision: "accept",
    }),
    decision({
      findingId: queued.id,
      fingerprint: queued.fingerprint,
      decision: "accept",
    }),
  ]);
  await ticketAt(primary, "done", ticketId(built.fingerprint, built.id));
  await ticketAt(primary, "ready", ticketId(queued.fingerprint, queued.id));

  const resolved = section(
    await contextCommand({
      project: worktree,
      dependencies: { gitTopology: topology(primary) },
    }),
    "Accepted work not yet built",
  );
  expect(resolved).not.toContain("IDM-built-0001");
  expect(resolved).toContain("- finding-2");
  expect(resolved).toContain("  Tracker: ready");
  expect(resolved).not.toContain(TRACKER_STATE_UNAVAILABLE);

  // Without the primary, `ticketed` status alone cannot distinguish built work
  // from open work, so both are listed and the store is marked missing.
  const unresolved = section(
    await contextCommand({
      project: worktree,
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Accepted work not yet built",
  );
  expect(unresolved).toContain("- finding-1");
  expect(unresolved).toContain("- finding-2");
  expect(unresolved).toContain("  Tracker: custom checkpoint");
  expect(unresolved).toContain(TRACKER_STATE_UNAVAILABLE);
});

test.each(["triage", "ready", "doing"])(
  "a primary-only %s ticket keeps its finding listed",
  async (state) => {
    const worktree = await project();
    const primary = await temporary("idiom-primary-");
    const record = finding({
      id: "IDM-run-0001",
      fingerprint: "print",
      status: "ticketed",
    });
    await reportRun(worktree, "2026-08-14T12-00-00-000Z", [record]);
    await writeDecisions(worktree, [
      decision({
        findingId: record.id,
        fingerprint: record.fingerprint,
        decision: "accept",
      }),
    ]);
    await ticketAt(primary, state, ticketId(record.fingerprint, record.id));

    const accepted = section(
      await contextCommand({
        project: worktree,
        dependencies: { gitTopology: topology(primary) },
      }),
      "Accepted work not yet built",
    );
    expect(accepted).toContain("- finding-1");
    expect(accepted).toContain(`  Tracker: ${state}`);
    expect(accepted).not.toContain(TRACKER_STATE_UNAVAILABLE);
  },
);

test("a present tracker root holding no matching ticket is a genuine answer", async () => {
  const directory = await project();
  const record = finding({ id: "IDM-run-0001", fingerprint: "print" });
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [record]);
  await writeDecisions(directory, [
    decision({
      findingId: record.id,
      fingerprint: record.fingerprint,
      decision: "accept",
    }),
  ]);
  await mkdir(join(directory, ".autobuild", "tickets", "triage"), {
    recursive: true,
  });

  const accepted = section(
    await contextCommand({
      project: directory,
      dependencies: { gitTopology: topology(undefined) },
    }),
    "Accepted work not yet built",
  );
  expect(accepted).toContain("- finding-1");
  expect(accepted).toContain("  Tracker: none");
  expect(accepted).not.toContain(TRACKER_STATE_UNAVAILABLE);
});

test("the two unavailable-evidence markers are independent", async () => {
  const worktree = await project();
  // Review evidence must reach the brief through the primary alone, so that
  // this asserts resolution across checkouts and not the local store.
  await rm(join(worktree, ".idiom", "reports"), {
    recursive: true,
    force: true,
  });
  const primary = await temporary("idiom-primary-");
  await reportRun(primary, "2026-08-14T12-00-00-000Z", [
    finding({ id: "IDM-run-0001", fingerprint: "print" }),
  ]);

  const brief = await contextCommand({
    project: worktree,
    dependencies: { gitTopology: topology(primary) },
  });
  expect(brief).not.toContain(REVIEW_EVIDENCE_UNAVAILABLE);
  expect(brief).toContain(TRACKER_STATE_UNAVAILABLE);
});

test("the command writes nothing to either checkout and repeats byte-identically", async () => {
  const worktree = await project();
  const primary = await temporary("idiom-primary-");
  const record = finding({
    id: "IDM-run-0001",
    fingerprint: "print",
    status: "ticketed",
  });
  await reportRun(primary, "2026-08-14T12-00-00-000Z", [record]);
  await ticketAt(primary, "ready", ticketId(record.fingerprint, record.id));
  await writeDecisions(worktree, [
    decision({
      findingId: record.id,
      fingerprint: record.fingerprint,
      decision: "accept",
    }),
  ]);
  const before = [await tree(worktree), await tree(primary)];

  const first = await contextCommand({
    project: worktree,
    dependencies: { gitTopology: topology(primary) },
  });
  const second = await contextCommand({
    project: worktree,
    dependencies: { gitTopology: topology(primary) },
  });

  expect(second).toBe(first);
  expect([await tree(worktree), await tree(primary)]).toEqual(before);
});

test("oversized sources stay under the byte ceiling with prohibitions intact", async () => {
  const directory = await project();
  const paragraph = `Ünïcödé design law — ${"ヒラギノ角ゴシック ".repeat(20)}`;
  await writeFile(
    join(directory, "DESIGN.md"),
    `${Array.from({ length: 400 }, (_, index) => `${index}. ${paragraph}`).join("\n")}\n`,
  );
  await writeFile(
    join(directory, "PRODUCT.md"),
    `${Array.from({ length: 400 }, (_, index) => `${index}. ${paragraph}`).join("\n")}\n`,
  );
  await reportRun(directory, "2026-08-14T12-00-00-000Z", [
    finding({
      id: "IDM-run-0001",
      fingerprint: "print",
      rule: "DESIGN.md: we do not underline",
      explanation: "The link is underlined — 下線は使いません。",
    }),
  ]);
  await writeDecisions(directory, [
    decision({
      findingId: "IDM-run-0001",
      fingerprint: "print",
      decision: "reject",
      scope: "rule",
      reason: "Underlines are never used here — 決定済み",
    }),
  ]);

  const brief = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });

  expect(Buffer.byteLength(brief, "utf8")).toBeLessThanOrEqual(
    BRIEF_BYTE_CEILING,
  );
  expect(brief).toContain(
    "- Do not repeat this rejected pattern: The link is underlined — 下線は使いません。",
  );
  expect(brief).toContain(
    "  Reason: Underlines are never used here — 決定済み",
  );
  // Every fixed section survives, and the prose that could not fit says so.
  expect(headingIndexes(brief).every((index) => index >= 0)).toBe(true);
  expect(brief).toMatch(
    new RegExp(
      `\\(\\d+ further lines omitted to stay within the ${BRIEF_BYTE_CEILING}-byte ceiling\\)`,
    ),
  );
  expect(brief.normalize("NFC")).toBe(brief);
  expect(brief.includes("�")).toBe(false);
});

test("the brief tells builders what idiom check will reject, with the project's own values", async () => {
  const { craftCheckEntries } = await import("../src/context/brief.js");
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  const entries = craftCheckEntries(
    checksConfigSchema.parse({
      minGap: 6,
      components: [
        {
          name: "override dot",
          selector: ".bp-override-dot",
          width: 8,
          height: 8,
        },
      ],
      copy: {
        locale: "en-US",
        glossary: [
          { term: "Patterns-built", preferred: "Built from patterns" },
        ],
      },
    }),
  ).map((entry) => entry.join("\n"));
  expect(entries.join("\n")).toContain("at least 6px between them");
  expect(entries).toContain(
    '- "override dot" (.bp-override-dot) renders at 8×8px (±the smaller of 15% and 1px per dimension).',
  );
  expect(entries).toContain(
    '- Say "Built from patterns", not "Patterns-built".',
  );
  expect(entries).toContain("- Spell in en-US.");
  expect(entries.at(-1)).toContain("run `idiom check <flow>`");
});

test("configured mirrored pairs appear in the craft brief (#24)", async () => {
  const { craftCheckEntries } = await import("../src/context/brief.js");
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  const entries = craftCheckEntries(
    checksConfigSchema.parse({
      mirrored: [
        {
          name: "panel collapse",
          a: "#drawer-collapse",
          b: "#inspector-collapse",
        },
      ],
    }),
  ).flat();
  expect(entries).toContain(
    '- "panel collapse": #drawer-collapse and #inspector-collapse mirror each other — same size, same kind of element (icon or text), same type, each the same distance from the canvas-facing edge of its own panel.',
  );
  expect(
    craftCheckEntries(checksConfigSchema.parse({}))
      .flat()
      .some((line) => line.includes("mirror each other")),
  ).toBe(false);
});

test("the craft brief states scheme parity and the configured frame (#9, #32)", async () => {
  const { craftCheckEntries } = await import("../src/context/brief.js");
  const { checksConfigSchema } = await import("../src/schemas/project.js");
  const defaults = craftCheckEntries(checksConfigSchema.parse({})).flat();
  expect(defaults.join("\n")).toContain("4.5:1 contrast in every scheme");
  expect(defaults.some((line) => line.includes("page frame"))).toBe(false);
  expect(
    craftCheckEntries(
      checksConfigSchema.parse({
        frame: { selector: "#page-frame", minLuminanceDelta: 0.08 },
      }),
    ).flat(),
  ).toContain(
    "- The page frame (#page-frame) stands apart from what surrounds it: a fill at least 0.08 luminance away, a visible border, or a shadow.",
  );
});

test.each([
  { tolerance: {}, policy: "larger", ratio: 25, px: 4 },
  { tolerance: { ratio: 0.1, px: 2 }, policy: "larger", ratio: 10, px: 2 },
  { tolerance: { mode: "tighter" }, policy: "smaller", ratio: 25, px: 4 },
  {
    tolerance: { ratio: 0.15, px: 1, mode: "tighter" },
    policy: "smaller",
    ratio: 15,
    px: 1,
  },
])(
  "the brief explains explicit component tolerance $tolerance",
  async ({ tolerance, policy, ratio, px }) => {
    const { craftCheckEntries } = await import("../src/context/brief.js");
    const { checksConfigSchema } = await import("../src/schemas/project.js");
    const entries = craftCheckEntries(
      checksConfigSchema.parse({
        components: [
          { name: "dot", selector: ".dot", width: 8, height: 8, tolerance },
        ],
      }),
    ).flat();
    expect(entries).toContain(
      `- "dot" (.dot) renders at 8×8px (±the ${policy} of ${ratio}% and ${px}px per dimension).`,
    );
  },
);

test("component sizes stated in DESIGN.md appear in the craft checks, and explicit config wins", async () => {
  const directory = await project();
  await writeFile(
    join(directory, "DESIGN.md"),
    "# Law\n\nOverride dots are about 8px.\nChips 24px high.\n",
  );
  const brief = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });
  expect(brief).toContain(
    '- "override dot" renders at 8×8px (inferred from DESIGN.md:3; selector resolved at capture from class or aria-label words "override dot"; set checks.components to override).',
  );
  expect(brief).toContain(
    '- "chip" renders 24px high (inferred from DESIGN.md:4;',
  );
  const path = join(directory, ".idiom", "project.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  value.checks = {
    ...value.checks,
    components: [{ name: "Chips", selector: ".chip", width: 60, height: 24 }],
  };
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  const explicit = await contextCommand({
    project: directory,
    dependencies: { gitTopology: topology(undefined) },
  });
  expect(explicit).toContain('- "Chips" (.chip) renders at 60×24px');
  expect(explicit).not.toContain('"chip" renders 24px high');
  expect(explicit).toContain("inferred from DESIGN.md:3");
});
