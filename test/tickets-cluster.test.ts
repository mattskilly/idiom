import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { afterEach, expect, test, vi } from "vitest";
import { observationArtifactSchema } from "../src/checks/artifact-schema.js";
import type {
  ObservationArtifact,
  ObservationArtifactV2,
  ObservedElementV2,
} from "../src/checks/types.js";
import { initProject } from "../src/commands/init.js";
import {
  clusterTicketsCommand,
  ticketsCommand,
} from "../src/commands/tickets.js";
import { appendDecision } from "../src/decisions/log.js";
import type { CatalogFinding } from "../src/review/catalog.js";
import { loadReviewCatalog } from "../src/review/catalog.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import {
  clusterTicketId,
  componentFor,
  groupFindings,
  observationLoader,
} from "../src/tickets/cluster.js";
import { emitClusterTickets } from "../src/tickets/emit.js";
import { resolveTicketTarget } from "../src/tickets/target.js";
import { parseFindingBlocks } from "../src/verify/spec.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function clusterFixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-clusters-")),
  );
  directories.push(directory);
  await initProject({ project: directory, yes: true });
  const run = join(directory, ".idiom/reports/2026-08-14T12-00-00-000Z");
  const input = JSON.parse(
    await readFile(
      new URL("./fixtures/cluster-findings/before.json", import.meta.url),
      "utf8",
    ),
  );
  const findings: Finding[] = [];
  const elements = [];
  const styles = Object.fromEntries(
    [
      "color",
      "backgroundColor",
      "borderTopColor",
      "borderRightColor",
      "borderBottomColor",
      "borderLeftColor",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "outlineColor",
      "outlineWidth",
      "fill",
      "stroke",
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomRightRadius",
      "borderBottomLeftRadius",
      "overflowX",
      "overflowY",
      "position",
    ].map((key) => [key, ""]),
  );
  const element = (
    selector: string,
    tag: string,
    ancestorSelectors: string[],
  ) => ({
    selector,
    tag,
    ancestorSelectors,
    text: "",
    visible: true,
    interactive: false,
    enabled: true,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    scrollWidth: 10,
    scrollHeight: 10,
    clientWidth: 10,
    clientHeight: 10,
    outOfFlow: false,
    styles,
    hitTestWith: [],
  });
  elements.push(element("body", "body", []));
  for (let component = 0; component < input.components; component++) {
    elements.push(element(`#component-${component}`, "section", ["body"]));
    for (let member = 0; member < input.membersPerComponent; member++) {
      const index = component * input.membersPerComponent + member + 1;
      const selector = `[data-action="${index} unrelated"]`;
      elements.push(
        element(selector, "button", [`#component-${component}`, "body"]),
      );
      findings.push(
        findingSchema.parse({
          id: `finding-${index}`,
          fingerprint: `fingerprint-${index}`,
          createdAt: "2026-08-14T12:00:00.000Z",
          commit: "abc123",
          flow: "booking",
          state: input.state,
          viewport: input.viewport,
          layer: "deterministic",
          category: input.category,
          severity: "major",
          confidence: 1,
          evidence: {
            screenshots: [
              `ready/phone/crops/${index}.png`,
              "ready/phone/screenshot.png",
            ],
            artifacts: ["ready/phone/observations.json"],
          },
          explanation: `Action ${index} is too small.`,
          acceptance: [
            "Actions are at least 44 by 44 CSS pixels.",
            `Action ${index} remains usable.`,
          ],
          verification: {
            kind: "deterministic-check",
            check: "target-size",
            params: { selector },
          },
          status: "open",
        }),
      );
    }
  }
  for (const finding of findings)
    for (const screenshot of finding.evidence.screenshots) {
      const path = join(run, screenshot);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, screenshot);
    }
  await writeFile(
    join(run, "ready/phone/observations.json"),
    JSON.stringify({
      version: 1,
      viewport: { width: 400, height: 800 },
      document: {
        scrollWidth: 400,
        scrollHeight: 800,
        clientWidth: 400,
        clientHeight: 800,
      },
      elements,
      headings: [],
      tokens: { status: "not-configured" },
    }),
  );
  await writeFile(join(run, "findings.json"), JSON.stringify(findings));
  return { directory, run, findings };
}
async function accept(directory: string, findings: Finding[]) {
  for (const finding of findings)
    await appendDecision({
      projectDirectory: directory,
      finding,
      decision: "accept",
      scope: "instance",
    });
}

test("twelve findings emit three complete triage specs and retry preserves all bytes", async () => {
  const { directory, findings, run } = await clusterFixture();
  await accept(directory, findings);
  const result = await clusterTicketsCommand({ project: directory });
  const expected = JSON.parse(
    await readFile(
      new URL("./fixtures/cluster-findings/after.json", import.meta.url),
      "utf8",
    ),
  );
  const created = result.outcomes.filter(
    (outcome) => outcome.kind === "created",
  );
  expect(created).toHaveLength(expected.created);
  const bytes = new Map<string, string>();
  const embedded: Finding[] = [];
  for (const outcome of created) {
    const body = await readFile(outcome.path, "utf8");
    bytes.set(outcome.path, body);
    const metadata = parse(body.split("+++")[1] ?? "");
    expect(metadata.id).toBe(outcome.ticketId);
    expect(body.match(/- \[ \] Actions are at least/g)).toHaveLength(1);
    expect(body).toContain("## Out of scope");
    const members = parseFindingBlocks(body);
    embedded.push(...members);
    expect(members).toHaveLength(4);
    expect(outcome.findingIds).toHaveLength(4);
    for (const match of body.matchAll(/\]\(([^)]+\.png)\)/g)) {
      const path = resolve(
        dirname(outcome.path),
        decodeURIComponent(match[1] ?? ""),
      );
      expect(await readFile(path, "utf8")).toBe(path.slice(run.length + 1));
    }
  }
  expect(new Set(embedded.map((f) => f.id)).size).toBe(
    expected.embeddedFindings,
  );
  expect(new Set(embedded.map((f) => f.fingerprint)).size).toBe(12);
  const retry = await clusterTicketsCommand({ project: directory });
  expect(retry.outcomes.filter((o) => o.kind === "created")).toHaveLength(
    expected.retryCreated,
  );
  for (const [path, body] of bytes)
    expect(await readFile(path, "utf8")).toBe(body);
  expect(
    (await ticketsCommand({ project: directory })).outcomes.some(
      (o) => o.kind === "created",
    ),
  ).toBe(false);
  expect(await readdir(result.outputDirectory)).toHaveLength(3);
});

async function recordsFixture() {
  const fixture = await clusterFixture();
  const records = fixture.findings.map((finding) => ({
    finding,
    runId: "2026-08-14T12-00-00-000Z",
    runDirectory: fixture.run,
    findingsPath: join(fixture.run, "findings.json"),
  }));
  const observations = observationArtifactSchema.parse(
    JSON.parse(
      await readFile(
        join(fixture.run, "ready/phone/observations.json"),
        "utf8",
      ),
    ),
  );
  if (observations.version !== 1) throw new Error("expected v1 fixture");
  return { ...fixture, records, observations };
}
function block(finding: Finding): string {
  return `\n\`\`\`idiom:finding\n${JSON.stringify(finding)}\n\`\`\`\n`;
}

// Pure grouping tests intentionally bypass disk/schema setup after the baseline artifact is validated.
function withNodes(observations: ObservationArtifact): ObservationArtifactV2 {
  return {
    ...observations,
    version: 2,
    maskMembership: [],
    elements: observations.elements.map(
      (element) =>
        ({ ...element, signals: { nodeId: undefined } }) as ObservedElementV2,
    ),
  };
}
function groups(records: CatalogFinding[], observations?: ObservationArtifact) {
  return groupFindings(
    records.map((record) => ({
      id: record.finding.id,
      record,
      component: componentFor(record, record.finding.id, observations),
    })),
  );
}

test("grouping is deterministic and follows actual ancestry rather than selector prefixes", async () => {
  const { records, observations } = await recordsFixture();
  const first = groups(records, observations);
  expect(first).toHaveLength(3);
  expect(
    groups([...records].reverse(), observations).map(clusterTicketId),
  ).toEqual(first.map(clusterTicketId));
  expect(first.every((cluster) => cluster.members.length === 4)).toBe(true);
});

test("opaque node IDs unite surface selectors but different IDs, categories and flows stay separate", async () => {
  const { records, observations } = await recordsFixture();
  const nodes = withNodes(observations);
  for (const element of nodes.elements)
    if (element.selector.startsWith("#component"))
      element.signals = {
        ...element.signals,
        nodeId: "001:Case",
      } as ObservedElementV2["signals"];
  expect(groups(records, nodes)).toHaveLength(1);
  const second = nodes.elements.find((e) => e.selector === "#component-1");
  if (second?.signals) second.signals.nodeId = "001:case";
  expect(groups(records, nodes)).toHaveLength(2);
  const changed = structuredClone(records);
  if (changed[0]) changed[0].finding.category = "contrast";
  if (changed[1]) changed[1].finding.flow = "other-flow";
  expect(groups(changed, nodes)).toHaveLength(4);
});

test("document shells, missing and ambiguous targets never combine unrelated findings", async () => {
  const { records, observations } = await recordsFixture();
  const noComponents = structuredClone(observations);
  for (const element of noComponents.elements)
    if (element.tag === "button") element.ancestorSelectors = ["body"];
  expect(groups(records, noComponents)).toHaveLength(12);
  expect(groups(records)).toHaveLength(12);
  const ambiguous = structuredClone(observations);
  const target = ambiguous.elements.find((e) => e.tag === "button");
  if (target) ambiguous.elements.push(target);
  expect(
    groups(records, ambiguous).filter((g) =>
      g.component.startsWith("finding:"),
    ),
  ).toHaveLength(1);
  const missing = structuredClone(records);
  if (missing[0]) missing[0].finding.verification.params = { selector: "body" };
  if (missing[1])
    missing[1].finding.verification.params = { selector: "#missing" };
  expect(
    groups(missing, observations).filter((g) =>
      g.component.startsWith("finding:"),
    ),
  ).toHaveLength(2);
});

test("nearest nested boundaries win and locus selectors are supported", async () => {
  const { records, observations } = await recordsFixture();
  const target = observations.elements.find(
    (e) => e.selector === records[0]?.finding.verification.params?.selector,
  );
  const parent = observations.elements.find(
    (e) => e.selector === "#component-0",
  );
  if (!target || !parent || !records[0]) throw new Error("fixture missing");
  const nested = {
    ...parent,
    selector: '[data-testid="nested component"]',
    ancestorSelectors: [parent.selector, "body"],
  };
  observations.elements.push(nested);
  target.ancestorSelectors.unshift(nested.selector);
  records[0].finding.verification = {
    kind: "manual",
    locus: {
      version: 1,
      target: { selector: target.selector, signature: "t" },
      region: { selector: parent.selector, signature: "r" },
      relativePath: "button",
    },
  };
  expect(groups(records, observations)).toHaveLength(4);
  expect(componentFor(records[0], "finding-1", observations)).toBe(
    `selector:${nested.selector}`,
  );
});

test("node-based integration emits three tickets from twelve cross-surface findings", async () => {
  const { directory, run, records, observations } = await recordsFixture();
  const nodes = withNodes(observations);
  // Supply complete v2 fields for strict observation loading.
  const expanded = [
    "display",
    "visibility",
    "opacity",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "textDecorationLine",
    "textTransform",
    "whiteSpace",
    "wordBreak",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "gap",
    "flexDirection",
    "justifyContent",
    "alignItems",
    "gridTemplateColumns",
    "boxShadow",
    "transform",
    "zIndex",
  ];
  for (const element of nodes.elements) {
    Object.assign(element, {
      structuralPath: element.selector,
      directText: "",
      attributes: {},
      temporal: false,
      stableIslandPath: element.selector,
      relativeRect: element.rect,
    });
    Object.assign(
      element.styles,
      Object.fromEntries(expanded.map((key) => [key, ""])),
    );
    const member = records.find(
      (r) => r.finding.verification.params?.selector === element.selector,
    );
    element.signals = {
      role: "",
      name: "",
      described: false,
      appearance: "",
      cursor: "",
      hasGraphic: false,
      lineCount: 0,
      contentBox: element.rect,
      transition: "",
      animation: "",
      focused: false,
      repeatedItem: false,
      ...(member
        ? {
            nodeId: `opaque:${Math.floor((Number(member.finding.id.split("-")[1]) - 1) / 4)}`,
          }
        : {}),
    };
    element.ancestorSelectors = [];
  }
  await writeFile(
    join(run, "ready/phone/observations.json"),
    JSON.stringify(nodes),
  );
  const result = await emitClusterTickets({
    project: directory,
    out: join(directory, "drafts"),
    selection: { policy: "current-run", records },
  });
  expect(result.createdPaths).toHaveLength(3);
  expect(
    result.outcomes
      .filter((o) => o.kind === "created")
      .every((o) => o.findingIds.length === 4),
  ).toBe(true);
});

test("custom proposals do not accept or checkpoint findings; canonical publication checkpoints every accepted member", async () => {
  const { directory, run, records, findings } = await recordsFixture();
  const result = await emitClusterTickets({
    project: directory,
    out: join(directory, "drafts"),
    selection: { policy: "current-run", records },
  });
  expect(result.createdPaths).toHaveLength(3);
  expect(
    JSON.parse(await readFile(join(run, "findings.json"), "utf8")).every(
      (f: Finding) => f.status === "open",
    ),
  ).toBe(true);
  expect(
    (await clusterTicketsCommand({ project: directory })).ineligible,
  ).toHaveLength(12);
  await accept(directory, findings);
  expect(
    (await clusterTicketsCommand({ project: directory })).createdPaths,
  ).toHaveLength(3);
  expect(
    JSON.parse(await readFile(join(run, "findings.json"), "utf8")).every(
      (f: Finding) => f.status === "ticketed",
    ),
  ).toBe(true);
});

test("empty current-run selection never expands to all catalog findings", async () => {
  const { directory, findings } = await clusterFixture();
  await accept(directory, findings);
  const result = await emitClusterTickets({
    project: directory,
    selection: { policy: "current-run", records: [] },
  });
  expect(result.outcomes).toEqual([]);
  await expect(readdir(result.outputDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each(["root", "ready", "icebox", "done"])(
  "arbitrary %s filenames and partial overlap suppress only covered members",
  async (state) => {
    const { directory, findings } = await clusterFixture();
    const tracker = join(directory, "proposals");
    const ownerDirectory = state === "root" ? tracker : join(tracker, state);
    await mkdir(ownerDirectory, { recursive: true });
    const first = findings[0];
    if (!first) throw new Error("fixture missing");
    const owner = join(ownerDirectory, "human-renamed.md");
    const body = `Human changes\n${block(first)}`;
    await writeFile(owner, body);
    await accept(directory, findings);
    const result = await clusterTicketsCommand({
      project: directory,
      out: tracker,
    });
    const created = result.outcomes.filter((o) => o.kind === "created");
    expect(created).toHaveLength(3);
    expect(created.flatMap((o) => o.findingIds)).toHaveLength(11);
    expect(created.flatMap((o) => o.findingIds)).not.toContain(first.id);
    expect(await readFile(owner, "utf8")).toBe(body);
    expect(
      (await clusterTicketsCommand({ project: directory, out: tracker }))
        .createdPaths,
    ).toHaveLength(0);
  },
);

test.each(["alias", "fingerprint", "legacy filename"])(
  "%s deduplication survives identity drift",
  async (identity) => {
    const { directory, findings } = await clusterFixture();
    const first = findings[0];
    if (!first) throw new Error("fixture missing");
    first.idAliases = ["historical-id"];
    const run = join(
      directory,
      ".idiom/reports/2026-08-14T12-00-00-000Z/findings.json",
    );
    await writeFile(run, JSON.stringify(findings));
    const root = join(directory, ".autobuild/tickets/ready");
    await mkdir(root, { recursive: true });
    const embedded = {
      ...first,
      id: identity === "alias" ? "historical-id" : "old-owner",
      idAliases: undefined,
      fingerprint: identity === "alias" ? "old-fingerprint" : first.fingerprint,
    };
    const { ticketId } = await import("../src/tickets/render.js");
    await writeFile(
      join(
        root,
        identity === "legacy filename"
          ? `${ticketId(first.fingerprint, first.id)}.md`
          : "renamed.md",
      ),
      identity === "legacy filename" ? "Legacy human ticket" : block(embedded),
    );
    await accept(directory, findings);
    const result = await clusterTicketsCommand({ project: directory });
    expect(
      result.outcomes
        .filter((o) => o.kind === "created")
        .flatMap((o) => o.findingIds),
    ).toHaveLength(11);
  },
);

test("multiple owners conflict per member while unrelated members still publish", async () => {
  const { directory, findings } = await clusterFixture();
  const first = findings[0];
  if (!first) throw new Error("fixture missing");
  const root = join(directory, ".autobuild/tickets/triage");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "one.md"), block(first));
  await writeFile(join(root, "two.md"), block(first));
  await accept(directory, findings);
  const result = await clusterTicketsCommand({ project: directory });
  expect(result.outcomes.filter((o) => o.kind === "conflict")).toHaveLength(1);
  expect(
    result.outcomes
      .filter((o) => o.kind === "created")
      .flatMap((o) => o.findingIds),
  ).toHaveLength(11);
});

test("malformed embedded records fail closed with a path before mutation", async () => {
  const { directory } = await clusterFixture();
  const root = join(directory, "target/custom-state");
  await mkdir(root, { recursive: true });
  const namesBefore = await readFile(
    join(directory, ".idiom/finding-names.json"),
    "utf8",
  );
  const path = join(root, "broken.md");
  await writeFile(path, "```idiom:finding\n{}");
  await expect(
    clusterTicketsCommand({
      project: directory,
      out: join(directory, "target"),
    }),
  ).rejects.toThrow(path);
  expect(
    await readFile(join(directory, ".idiom/finding-names.json"), "utf8"),
  ).toBe(namesBefore);
});

test("malformed declared observations name their artifact; legacy absence stays singleton", async () => {
  const { directory, run, records } = await recordsFixture();
  await writeFile(join(run, "ready/phone/observations.json"), "{}");
  await expect(
    emitClusterTickets({
      project: directory,
      selection: { policy: "current-run", records },
    }),
  ).rejects.toThrow("observations.json");
  for (const record of records) record.finding.evidence.artifacts = [];
  expect(
    (
      await emitClusterTickets({
        project: directory,
        selection: { policy: "current-run", records },
      })
    ).createdPaths,
  ).toHaveLength(12);
});

test("cross-tuple observation artifacts cannot supply a component", async () => {
  const { records } = await recordsFixture();
  const record = records[0];
  if (!record) throw new Error("fixture missing");
  record.finding.viewport = "desktop";
  expect(await observationLoader()(record)).toBeUndefined();
});

test("missing crops are explicit and retained full screenshots still resolve", async () => {
  const { directory, run, records } = await recordsFixture();
  await rm(join(run, "ready/phone/crops"), { recursive: true });
  const result = await emitClusterTickets({
    project: directory,
    selection: { policy: "current-run", records },
  });
  const body = await readFile(result.createdPaths[0] ?? "", "utf8");
  expect(body).toContain("Crop unavailable");
  expect(body).toContain("[Screenshot 1]");
  expect(body).not.toContain("[Crop ");
});

test("a new member in an emitted component gets its own proposal without rewriting the original", async () => {
  const { directory, run, records } = await recordsFixture();
  const first = await emitClusterTickets({
    project: directory,
    selection: { policy: "current-run", records: records.slice(0, 3) },
  });
  const path = first.createdPaths[0] ?? "";
  const bytes = await readFile(path, "utf8");
  const second = await emitClusterTickets({
    project: directory,
    selection: { policy: "current-run", records: records.slice(0, 4) },
  });
  expect(
    second.outcomes
      .filter((o) => o.kind === "created")
      .flatMap((o) => o.findingIds),
  ).toEqual(["finding-4"]);
  expect(await readFile(path, "utf8")).toBe(bytes);
  expect(
    JSON.parse(await readFile(join(run, "findings.json"), "utf8")).every(
      (f: Finding) => f.status === "open",
    ),
  ).toBe(true);
});

test("configured file tracker resolves from repository and canonical dedupe recovers checkpointing", async () => {
  const { directory, records, findings, run } = await recordsFixture();
  await writeFile(
    join(directory, "autobuild.toml"),
    '[tickets]\nsource = "file"\ndir = "tasks"\nreadyState = "shipping"\nproposalState = "shipping"\n',
  );
  const draft = await emitClusterTickets({
    project: directory,
    out: join(directory, "tasks/triage"),
    selection: { policy: "current-run", records },
  });
  expect(draft.outputDirectory).toBe(join(directory, "tasks/triage"));
  expect(draft.createdPaths).toHaveLength(3);
  await accept(directory, findings);
  const recovered = await clusterTicketsCommand({ project: directory });
  expect(recovered.createdPaths).toHaveLength(0);
  expect(
    JSON.parse(await readFile(join(run, "findings.json"), "utf8")).every(
      (f: Finding) => f.status === "ticketed",
    ),
  ).toBe(true);
});

test.each([
  "ready",
  "doing",
  "done",
  "shipping",
  "shipping/nested",
  "SHIPPING/nested",
])(
  "unsafe %s targets fail before names or directories are written",
  async (state) => {
    const { directory, findings } = await clusterFixture();
    await accept(directory, findings);
    await writeFile(
      join(directory, "autobuild.toml"),
      '[tickets]\nsource = "file"\ndir = "tasks"\nreadyState = "shipping"\n',
    );
    const names = await loadReviewCatalog({ project: directory });
    const before = JSON.stringify(names.names);
    await expect(
      clusterTicketsCommand({
        project: directory,
        out: join(directory, "tasks", state),
      }),
    ).rejects.toThrow(/triage|state/);
    expect(
      JSON.stringify((await loadReviewCatalog({ project: directory })).names),
    ).toBe(before);
    await expect(readdir(join(directory, "tasks"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

test("symlink prefixes and triage aliases cannot bypass configured ready state", async () => {
  const { directory } = await clusterFixture();
  await writeFile(
    join(directory, "autobuild.toml"),
    '[tickets]\nsource = "file"\ndir = "tasks"\nreadyState = "shipping"\n',
  );
  await mkdir(join(directory, "tasks/shipping"), { recursive: true });
  await symlink(join(directory, "tasks/shipping"), join(directory, "alias"));
  await expect(
    resolveTicketTarget({
      projectDirectory: directory,
      out: join(directory, "alias/new"),
    }),
  ).rejects.toThrow(/state/);
  await symlink(
    join(directory, "tasks/shipping"),
    join(directory, "tasks/triage"),
  );
  await expect(
    resolveTicketTarget({ projectDirectory: directory }),
  ).rejects.toThrow(/state/);
});

test("triage-as-ready and non-file defaults are refused but explicit file targets work", async () => {
  const { directory } = await clusterFixture();
  await writeFile(
    join(directory, "autobuild.toml"),
    '[tickets]\nsource = "file"\nreadyState = "TRIAGE"\n',
  );
  await expect(
    resolveTicketTarget({ projectDirectory: directory }),
  ).rejects.toThrow(/triage/);
  await writeFile(
    join(directory, "autobuild.toml"),
    '[tickets]\nsource = "linear"\nreadyState = "Ready"\n',
  );
  await expect(
    resolveTicketTarget({ projectDirectory: directory }),
  ).rejects.toThrow(/explicit file/);
  expect(
    (
      await resolveTicketTarget({
        projectDirectory: directory,
        out: join(directory, "drafts"),
      })
    ).outputDirectory,
  ).toBe(join(directory, "drafts/triage"));
});

test("promoted human-edited cluster tickets stay unchanged and suppress retries", async () => {
  const { directory, records } = await recordsFixture();
  const first = await emitClusterTickets({
    project: directory,
    selection: { policy: "current-run", records },
  });
  const path = first.createdPaths[0] ?? "";
  const destination = join(
    directory,
    ".autobuild/tickets/ready/human-title.md",
  );
  await mkdir(dirname(destination), { recursive: true });
  const modified =
    (await readFile(path, "utf8")) +
    "\nHuman additional acceptance criterion.\n";
  await writeFile(path, modified);
  await rename(path, destination);
  expect(
    (
      await emitClusterTickets({
        project: directory,
        selection: { policy: "current-run", records },
      })
    ).createdPaths,
  ).toHaveLength(0);
  expect(await readFile(destination, "utf8")).toBe(modified);
});

test.each(["matching", "unrelated"])(
  "exclusive-create %s races confirm member coverage before checkpointing",
  async (race) => {
    const { directory, findings } = await clusterFixture();
    await accept(directory, findings);
    const originalWrite = fs.writeFile;
    let raced = false;
    vi.spyOn(fs, "writeFile").mockImplementation(
      async (path, data, options) => {
        if (
          !raced &&
          String(path).includes("idiom-cluster-") &&
          String(path).endsWith(".md")
        ) {
          raced = true;
          await originalWrite(
            path,
            race === "matching" ? data : "Unrelated human ticket",
            options,
          );
          throw Object.assign(new Error("racing file"), { code: "EEXIST" });
        }
        return originalWrite(path, data, options);
      },
    );
    const result = await clusterTicketsCommand({ project: directory });
    expect(result.createdPaths).toHaveLength(2);
    expect(
      result.outcomes.filter(
        (o) =>
          o.kind === (race === "matching" ? "already-emitted" : "conflict"),
      ),
    ).toHaveLength(4);
    const persisted = JSON.parse(
      await readFile(
        join(
          directory,
          ".idiom/reports/2026-08-14T12-00-00-000Z/findings.json",
        ),
        "utf8",
      ),
    ) as Finding[];
    expect(persisted.filter((f) => f.status === "ticketed")).toHaveLength(
      race === "matching" ? 12 : 8,
    );
  },
);

test("source terminal work cannot be resurrected in custom drafts and verification status is preserved", async () => {
  const { directory, findings, run } = await clusterFixture();
  const first = findings[0];
  const second = findings[1];
  if (!first || !second) throw new Error("fixture missing");
  first.status = "verified-fixed";
  second.status = "verify-failed";
  await writeFile(join(run, "findings.json"), JSON.stringify(findings));
  await accept(directory, findings);
  const result = await clusterTicketsCommand({
    project: directory,
    out: join(directory, "drafts"),
  });
  expect(
    result.outcomes.filter((o) => o.kind === "already-resolved"),
  ).toHaveLength(2);
  expect(
    result.outcomes
      .filter((o) => o.kind === "created")
      .flatMap((o) => o.findingIds),
  ).toHaveLength(10);
  const statuses = JSON.parse(
    await readFile(join(run, "findings.json"), "utf8"),
  ) as Finding[];
  expect(statuses[0]?.status).toBe("verified-fixed");
  expect(statuses[1]?.status).toBe("verify-failed");
});

test("conventional state descendants without a target config cannot become tracker roots", async () => {
  const { directory } = await clusterFixture();
  for (const state of ["ready", "doing", "done"])
    await expect(
      resolveTicketTarget({
        projectDirectory: directory,
        out: join(directory, "other", state, "nested"),
      }),
    ).rejects.toThrow(/state/);
});

test("source directory aliases do not turn one canonical owner into duplicate owners", async () => {
  const { directory, findings } = await clusterFixture();
  await accept(directory, findings);
  await clusterTicketsCommand({ project: directory });
  const alias = join(directory, "project-alias");
  await symlink(directory, alias);
  const retry = await clusterTicketsCommand({ project: alias });
  expect(retry.createdPaths).toHaveLength(0);
  expect(retry.outcomes.filter((o) => o.kind === "conflict")).toHaveLength(0);
});

test("safe triage directory aliases retain member dedupe when cluster membership grows", async () => {
  const { directory, records } = await recordsFixture();
  const root = join(directory, "proposals");
  const intake = join(directory, "intake");
  await mkdir(root);
  await mkdir(intake);
  await symlink(intake, join(root, "triage"));
  await emitClusterTickets({
    project: directory,
    out: root,
    selection: { policy: "current-run", records: records.slice(0, 3) },
  });
  const result = await emitClusterTickets({
    project: directory,
    out: root,
    selection: { policy: "current-run", records: records.slice(0, 4) },
  });
  expect(
    result.outcomes
      .filter((o) => o.kind === "created")
      .flatMap((o) => o.findingIds),
  ).toEqual(["finding-4"]);
});

test("external target repositories supply their own directory and ready-state safety rules", async () => {
  const { directory, findings } = await clusterFixture();
  await accept(directory, findings);
  const repository = await realpath(
    await mkdtemp(join(tmpdir(), "idiom-target-")),
  );
  directories.push(repository);
  await writeFile(
    join(repository, "autobuild.toml"),
    '[tickets]\nsource="file"\ndir="queue"\nreadyState="shipping"\n',
  );
  await expect(
    clusterTicketsCommand({
      project: directory,
      out: join(repository, "queue/SHIPPING/new"),
    }),
  ).rejects.toThrow(/state/);
  const result = await clusterTicketsCommand({
    project: directory,
    out: join(repository, "queue"),
  });
  expect(result.outputDirectory).toBe(join(repository, "queue/triage"));
  expect(result.createdPaths).toHaveLength(3);
});

test("tuple metadata prevents combination and scheme evidence from crossing component boundaries", async () => {
  const { records, run } = await recordsFixture();
  const record = records[0];
  if (!record) throw new Error("fixture missing");
  record.finding.combination = "expanded";
  const metadata = {
    state: { id: record.finding.state },
    viewport: { name: record.finding.viewport },
    flow: { id: record.finding.flow },
    combination: { label: "expanded" },
  };
  await writeFile(
    join(run, "ready/phone/metadata.json"),
    JSON.stringify(metadata),
  );
  expect(await observationLoader()(record)).toBeDefined();
  record.finding.combination = "collapsed";
  expect(await observationLoader()(record)).toBeUndefined();
  record.finding.combination = undefined;
  record.finding.colorScheme = "dark";
  expect(await observationLoader()(record)).toBeUndefined();
});

test("members sharing a root cause form one cluster across categories, rendered as one cause ticket", async () => {
  const { records, observations } = await recordsFixture();
  const [first, second, third] = records;
  if (!first || !second || !third) throw new Error("three records required");
  const other = {
    ...second,
    finding: { ...second.finding, category: "scale-conformance" as const },
  };
  const cause = {
    id: "cause-0123456789ab",
    kind: "token" as const,
    key: "--control-scale",
    cause:
      "`--control-scale` is not applied: 2 controls render 4px against 8px",
    confidence: 0.9,
    evidence: ["2 of 2 measured values come from `var(--control-scale)`"],
    fix: "Define `--control-scale` where these elements inherit it (or fix the reference)",
    symptoms: 2,
  };
  const clusters = groupFindings(
    [first, other, third].map((record, index) => ({
      id: record.finding.id,
      record,
      component: componentFor(record, record.finding.id, observations),
      ...(index < 2 ? { cause } : {}),
    })),
  );
  const caused = clusters.filter((cluster) => cluster.cause !== undefined);
  expect(caused).toHaveLength(1);
  expect(caused[0]?.members.map((member) => member.id).sort()).toEqual(
    [first.finding.id, other.finding.id].sort(),
  );
  // Members without a cause keep component clustering.
  expect(
    clusters.find((cluster) => cluster.cause === undefined)?.members,
  ).toHaveLength(1);
  const { renderClusterTicket } = await import("../src/tickets/render.js");
  const cluster = caused[0];
  if (cluster === undefined) throw new Error("cause cluster required");
  const rendered = renderClusterTicket({
    cluster,
    id: clusterTicketId(cluster),
    ticketDirectory: tmpdir(),
    availableImages: new Map(),
  });
  expect(rendered.title).toBe(`Resolve root cause: ${cause.cause}`);
  expect(rendered.body).toContain(`${cause.cause}.`);
  expect(rendered.body).toContain(
    "- [ ] All 2 symptoms below clear on recheck (one fix for the shared cause)",
  );
  expect(rendered.body).toContain(
    'Root cause key: "token:--control-scale" (cause-0123456789ab)',
  );
  expect(parseFindingBlocks(rendered.body)).toHaveLength(2);
  expect(() => parse(rendered.body.split("+++")[1] ?? "")).not.toThrow();
});
