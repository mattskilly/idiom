import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { tupleCoordinateKey } from "../src/baseline/coordinate.js";
import { run } from "../src/cli.js";
import type { ClusterInputs } from "../src/commands/check.js";
import { initProject } from "../src/commands/init.js";
import { nightlyCommand } from "../src/commands/nightly.js";
import { appendDecision } from "../src/decisions/log.js";
import { RunFailure } from "../src/errors.js";
import { autobuildTracker } from "../src/nightly/autobuild.js";
import { fileNightly, type NightlySink } from "../src/nightly/file.js";
import { ledgerPath, readLedger } from "../src/nightly/ledger.js";
import { nightlySchedule } from "../src/nightly/schedule.js";
import { type Finding, findingSchema } from "../src/schemas/finding.js";
import type { ClusterCause } from "../src/tickets/cluster.js";
import { parseFindingBlocks } from "../src/verify/spec.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary(prefix: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

async function nightlyProject(flows = ["studio"]) {
  const project = await temporary("idiom-nightly-");
  await initProject({ project, yes: true });
  for (const id of flows)
    await writeFile(
      join(project, `.idiom/flows/${id}.json`),
      JSON.stringify({
        id,
        title: id,
        intent: [],
        setup: [],
        states: [
          {
            id: "ready",
            description: "Ready",
            url: "/",
            expect: { selectorPresent: ["main"] },
          },
        ],
      }),
    );
  return project;
}

function finding(
  index: number,
  overrides: Partial<Record<keyof Finding, unknown>> = {},
): Finding {
  return findingSchema.parse({
    id: `finding-${index}`,
    fingerprint: `fingerprint-${index}`,
    createdAt: "2026-11-07T03:17:00.000Z",
    commit: "def5678def5678",
    flow: "studio",
    state: "ready",
    viewport: "phone",
    layer: "deterministic",
    category: "target-size",
    severity: "major",
    confidence: 1,
    evidence: {
      screenshots: [`ready/phone/crops/${index}.png`],
      artifacts: [],
    },
    explanation: `Action ${index} is too small.`,
    acceptance: ["Actions are at least 44 by 44 CSS pixels."],
    verification: {
      kind: "deterministic-check",
      check: "target-size",
      params: { selector: `#action-${index}` },
    },
    status: "open",
    ...overrides,
  });
}

/** A stored run with its findings and crops; returns the run directory. */
async function storeRun(project: string, runId: string, findings: Finding[]) {
  const runDirectory = join(project, ".idiom/reports", runId);
  for (const item of findings)
    for (const screenshot of item.evidence.screenshots) {
      const path = join(runDirectory, screenshot);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "png");
    }
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "findings.json"),
    JSON.stringify(findings),
  );
  return runDirectory;
}

async function writeAttribution(runDirectory: string, findings: Finding[]) {
  await writeFile(
    join(runDirectory, "attribution.json"),
    JSON.stringify({
      version: 1,
      flow: "studio",
      runId: runDirectory.split("/").at(-1),
      commit: "def5678def5678",
      dirty: false,
      previous: {
        runId: "earlier",
        commit: "abc1234abc1234",
        dirty: false,
        completedAt: "2026-11-06T03:17:00.000Z",
      },
      configChanged: false,
      introductions: findings.map((item) => ({
        id: item.id,
        fingerprint: item.fingerprint,
        where: tupleCoordinateKey(item),
        state: item.state,
        range: {
          from: "abc1234abc1234",
          to: "def5678def5678",
          commits: 3,
          linear: true,
          fromDirty: false,
          toDirty: false,
        },
        likely: {
          commit: "bbb2222bbb2222",
          subject: "Tighten toolbar",
          tickets: ["file-12"],
        },
      })),
    }),
  );
}

const cause = (id: string): ClusterCause => ({
  id,
  kind: "component",
  key: `cause-${id}`,
  cause: "Toolbar buttons share a 32px height",
  confidence: 0.9,
  evidence: ["Every symptom is a toolbar button."],
  symptoms: 2,
});

function inputsFor(
  runDirectory: string,
  findings: Finding[],
  causes: Record<string, ClusterCause> = {},
): ClusterInputs {
  return {
    records: findings.map((item) => ({
      finding: item,
      runId: runDirectory.split("/").at(-1) as string,
      runDirectory,
      findingsPath: join(runDirectory, "findings.json"),
    })),
    rootCauses: new Map(Object.entries(causes)),
    issueScores: new Map(),
  };
}

type FakeTicket = {
  kind: "work";
  revision: string;
  ref: { source: "file"; id: string; title: string };
  title: string;
  body: string;
  state: string;
  resolved: boolean;
  labels: string[];
};
type FakeStore = {
  states: Array<{ name: string; roles: string[] }>;
  tickets: FakeTicket[];
  next: number;
  creates: number;
  failCreate?: number;
};

/** An `ab` that answers ticket verbs from a JSON store and logs every call. */
async function fakeAb(
  states: FakeStore["states"] = [
    { name: "Inbox", roles: ["create", "triage", "proposal"] },
    { name: "ready", roles: ["ready"] },
    { name: "doing", roles: ["claimed"] },
    { name: "done", roles: ["done"] },
  ],
) {
  const bin = await temporary("idiom-fake-ab-");
  const log = join(bin, "log.jsonl");
  const store = join(bin, "store.json");
  await writeFile(log, "");
  await writeFile(
    store,
    JSON.stringify({ states, tickets: [], next: 100, creates: 0 }),
  );
  await writeFile(
    join(bin, "ab"),
    `#!${process.execPath}
const fs = require("node:fs");
const [, , group, verb, ...rest] = process.argv;
fs.appendFileSync(process.env.AB_LOG, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + "\\n");
const store = JSON.parse(fs.readFileSync(process.env.AB_STORE, "utf8"));
const save = () => fs.writeFileSync(process.env.AB_STORE, JSON.stringify(store));
const flag = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
const print = (value) => process.stdout.write(JSON.stringify(value));
if (group !== "ticket") { process.stderr.write("unknown"); process.exit(2); }
if (verb === "states") print(store.states.map((s) => ({ ...s, tickets: 0 })));
else if (verb === "list") print(store.tickets.filter((t) => t.labels.includes(flag("--labels"))));
else if (verb === "show" || verb === "update") {
  const ticket = store.tickets.find((t) => t.ref.id === rest[0]);
  if (!ticket) { process.stderr.write('no ticket "' + rest[0] + '" in the configured file ticket source'); process.exit(1); }
  if (verb === "update") {
    ticket.body = fs.readFileSync(flag("--body"), "utf8");
    ticket.labels = flag("--labels").split(",").filter(Boolean);
    ticket.revision = String(Number(ticket.revision) + 1);
    save();
  }
  print(ticket);
} else if (verb === "create") {
  store.creates += 1;
  if (store.failCreate === store.creates) { save(); process.stderr.write("label not found"); process.exit(1); }
  const id = "file-" + store.next++;
  const ticket = { kind: "work", revision: "1", ref: { source: "file", id, title: rest[0] }, title: rest[0], body: fs.readFileSync(flag("--body"), "utf8"), state: flag("--state"), resolved: false, labels: flag("--labels").split(",").filter(Boolean) };
  store.tickets.push(ticket);
  save();
  print(ticket);
} else { process.stderr.write("unsupported verb " + verb); process.exit(2); }
`,
  );
  await chmod(join(bin, "ab"), 0o755);
  const environment = {
    PATH: `${bin}:/usr/bin:/bin`,
    AB_LOG: log,
    AB_STORE: store,
  };
  return {
    environment,
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { cwd: string; argv: string[] }),
    store: async () => JSON.parse(await readFile(store, "utf8")) as FakeStore,
    edit: async (change: (value: FakeStore) => void) => {
      const value = JSON.parse(await readFile(store, "utf8")) as FakeStore;
      change(value);
      await writeFile(store, JSON.stringify(value));
    },
  };
}

async function trackerSink(
  project: string,
  environment: NodeJS.ProcessEnv,
): Promise<NightlySink> {
  const tracker = autobuildTracker({ root: project, environment });
  const triageStates = await tracker.triageStates();
  return {
    kind: "autobuild",
    tracker,
    triageState: triageStates[0] as string,
    triageStates,
  };
}

const verbs = (calls: Array<{ argv: string[] }>) =>
  calls.map((call) => call.argv[1]);

test("first run files one triage ticket per cluster with labels, evidence, range and done-when; a rerun updates only on change", async () => {
  const project = await nightlyProject();
  const ab = await fakeAb();
  const first = [finding(1), finding(2), finding(3, { category: "contrast" })];
  const runDirectory = await storeRun(project, "run-1", first);
  await writeAttribution(runDirectory, first);
  const sink = await trackerSink(project, ab.environment);
  const options = {
    project,
    ledgerPath: ledgerPath(project),
    severity: "major" as const,
    labels: ["idiom"],
    sink,
  };
  const filed = await fileNightly({
    ...options,
    inputs: [
      inputsFor(runDirectory, first, {
        "finding-1": cause("c1"),
        "finding-2": cause("c1"),
      }),
    ],
  });
  const created = filed.outcomes.filter(
    (outcome) => outcome.kind === "created",
  );
  expect(created).toHaveLength(2);
  expect(created.map((outcome) => outcome.findingIds)).toEqual(
    expect.arrayContaining([["finding-1", "finding-2"], ["finding-3"]]),
  );
  const calls = await ab.calls();
  const creates = calls.filter((call) => call.argv[1] === "create");
  expect(creates).toHaveLength(2);
  for (const call of creates) {
    expect(call.cwd).toBe(project);
    expect(call.argv[call.argv.indexOf("--state") + 1]).toBe("Inbox");
  }
  const store = await ab.store();
  const toolbar = store.tickets.find((ticket) =>
    ticket.body.includes("finding-1"),
  ) as FakeTicket;
  expect(toolbar.labels).toEqual(["idiom", "target-size"]);
  expect(
    store.tickets.find((ticket) => ticket.body.includes("finding-3"))?.labels,
  ).toEqual(["idiom", "contrast"]);
  expect(toolbar.state).toBe("Inbox");
  expect(toolbar.body).not.toContain("+++");
  expect(toolbar.body).toContain("finding-1");
  expect(toolbar.body).toContain("finding-2");
  expect(toolbar.body).toContain(
    "- Crop 1: `.idiom/reports/run-1/ready/phone/crops/1.png`",
  );
  expect(toolbar.body).toContain(
    "Introduced: appeared between abc1234 and def5678 (3 commits)",
  );
  expect(toolbar.body).toContain(
    'likely introduced by bbb2222 "Tighten toolbar" (file-12)',
  );
  expect(toolbar.body).toContain(
    "- [ ] Done when `idiom check studio --since-baseline` no longer reports `finding-1`, `finding-2`, and `idiom verify studio --spec <this ticket>` passes for every embedded finding.",
  );
  expect(parseFindingBlocks(toolbar.body).map((item) => item.id)).toEqual([
    "finding-1",
    "finding-2",
  ]);
  const ledger = await readLedger(ledgerPath(project));
  expect(ledger.entries.map((entry) => entry.ticket).sort()).toEqual([
    "file-100",
    "file-101",
  ]);

  // Same findings in a later run: nothing created, nothing updated.
  const later = await storeRun(project, "run-2", first);
  const again = await fileNightly({
    ...options,
    inputs: [
      inputsFor(later, first, {
        "finding-1": cause("c1"),
        "finding-2": cause("c1"),
      }),
    ],
  });
  expect(again.outcomes.map((outcome) => outcome.kind)).toEqual([
    "unchanged",
    "unchanged",
  ]);
  expect(
    verbs(await ab.calls()).filter((verb) => verb === "create"),
  ).toHaveLength(2);
  expect(verbs(await ab.calls())).not.toContain("update");

  // The cluster gains a member: a new cluster id, but the same ticket is updated.
  const grown = [...first, finding(4)];
  const third = await storeRun(project, "run-3", grown);
  const updated = await fileNightly({
    ...options,
    inputs: [
      inputsFor(third, grown, {
        "finding-1": cause("c1"),
        "finding-2": cause("c1"),
        "finding-4": cause("c1"),
      }),
    ],
  });
  expect(updated.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "updated",
        ticket: toolbar.ref.id,
        findingIds: ["finding-1", "finding-2", "finding-4"],
      }),
      expect.objectContaining({ kind: "unchanged", findingIds: ["finding-3"] }),
    ]),
  );
  const after = await ab.calls();
  expect(verbs(after).filter((verb) => verb === "create")).toHaveLength(2);
  expect(verbs(after).filter((verb) => verb === "update")).toHaveLength(1);
  expect(
    (await ab.store()).tickets.find(
      (ticket) => ticket.ref.id === toolbar.ref.id,
    )?.body,
  ).toContain("finding-4");
  // Only sessionless read/create/update verbs; never a move.
  expect(new Set(verbs(after))).toEqual(
    new Set(["states", "list", "create", "show", "update"]),
  );
});

test("in-progress tickets are left alone, resolved ones are refiled as regressions, and missing ones are refiled", async () => {
  const project = await nightlyProject();
  const ab = await fakeAb();
  const findings = [finding(1)];
  const runDirectory = await storeRun(project, "run-1", findings);
  const sink = await trackerSink(project, ab.environment);
  const file = async (dryRun = false) =>
    fileNightly({
      project,
      ledgerPath: ledgerPath(project),
      severity: "major",
      labels: ["idiom"],
      sink,
      dryRun,
      inputs: [inputsFor(runDirectory, findings)],
    });
  await file();
  await ab.edit((store) => {
    (store.tickets[0] as FakeTicket).state = "doing";
  });
  expect((await file()).outcomes).toEqual([
    expect.objectContaining({
      kind: "in-progress",
      ticket: "file-100",
      ticketState: "doing",
    }),
  ]);
  expect(verbs(await ab.calls())).not.toContain("update");

  await ab.edit((store) => {
    const ticket = store.tickets[0] as FakeTicket;
    ticket.state = "done";
    ticket.resolved = true;
  });
  expect((await file()).outcomes).toEqual([
    expect.objectContaining({
      kind: "reopened-as-new",
      ticket: "file-101",
      replaced: "file-100",
      state: "Inbox",
    }),
  ]);
  const reopened = (await ab.store()).tickets[1] as FakeTicket;
  expect(reopened.body).toContain("Reappeared after `file-100` was resolved");
  expect(reopened.state).toBe("Inbox");
  const ledger = await readLedger(ledgerPath(project));
  expect(ledger.entries).toEqual([
    expect.objectContaining({ ticket: "file-101", replaced: "file-100" }),
  ]);

  await ab.edit((store) => {
    store.tickets = store.tickets.filter(
      (ticket) => ticket.ref.id !== "file-101",
    );
  });
  expect((await file()).outcomes).toEqual([
    expect.objectContaining({
      kind: "refiled-missing",
      ticket: "file-102",
      replaced: "file-101",
    }),
  ]);
  for (const call of (await ab.calls()).filter((c) => c.argv[1] === "create"))
    expect(call.argv).toContain("--state");
  expect(verbs(await ab.calls())).not.toContain("move");
});

test("a deleted ledger recovers identities from the tracker; a malformed one is refused", async () => {
  const project = await nightlyProject();
  const ab = await fakeAb();
  const findings = [finding(1)];
  const runDirectory = await storeRun(project, "run-1", findings);
  const sink = await trackerSink(project, ab.environment);
  const file = () =>
    fileNightly({
      project,
      ledgerPath: ledgerPath(project),
      severity: "major",
      labels: ["idiom"],
      sink,
      inputs: [inputsFor(runDirectory, findings)],
    });
  await file();
  await rm(ledgerPath(project));
  const recovered = await file();
  expect(recovered.outcomes).toEqual([
    expect.objectContaining({ kind: "updated", ticket: "file-100" }),
  ]);
  const calls = await ab.calls();
  expect(verbs(calls).filter((verb) => verb === "create")).toHaveLength(1);
  expect(calls.find((call) => call.argv[1] === "list")?.argv).toEqual([
    "ticket",
    "list",
    "--labels",
    "idiom",
    "--json",
  ]);
  expect((await readLedger(ledgerPath(project))).entries).toEqual([
    expect.objectContaining({ ticket: "file-100" }),
  ]);
  await writeFile(ledgerPath(project), "{not json");
  await expect(file()).rejects.toThrow(/malformed .*filed-tickets\.json/);
});

test("rejected, acknowledged and below-severity findings are never filed", async () => {
  const project = await nightlyProject();
  const ab = await fakeAb();
  const findings = [
    finding(1),
    finding(2),
    finding(3, {
      acknowledgement: { reference: "file-7", at: "2026-11-01T00:00:00.000Z" },
    }),
    finding(4, { severity: "minor" }),
  ];
  const runDirectory = await storeRun(project, "run-1", findings);
  await appendDecision({
    projectDirectory: project,
    finding: findings[1] as Finding,
    decision: "reject",
    scope: "instance",
  });
  const sink = await trackerSink(project, ab.environment);
  const file = (severity: "major" | "minor") =>
    fileNightly({
      project,
      ledgerPath: ledgerPath(project),
      severity,
      labels: ["idiom"],
      sink,
      inputs: [inputsFor(runDirectory, findings)],
    });
  const filed = await file("major");
  expect(filed.belowSeverity).toBe(1);
  expect(filed.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "created", findingIds: ["finding-1"] }),
      expect.objectContaining({
        kind: "skipped",
        findingIds: ["finding-2"],
        reason: "rejected",
      }),
      expect.objectContaining({
        kind: "skipped",
        findingIds: ["finding-3"],
        reason: "acknowledged",
      }),
    ]),
  );
  expect(filed.outcomes).toHaveLength(3);
  const minor = await file("minor");
  expect(minor.outcomes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "created", findingIds: ["finding-4"] }),
    ]),
  );
  const bodies = (await ab.store()).tickets.map((ticket) => ticket.body);
  expect(bodies.some((body) => body.includes("finding-2"))).toBe(false);
  expect(bodies.some((body) => body.includes("finding-3"))).toBe(false);
});

test("a failed create keeps what already filed in the ledger and is reported", async () => {
  const project = await nightlyProject();
  const ab = await fakeAb();
  await ab.edit((store) => {
    store.failCreate = 2;
  });
  const findings = [finding(1), finding(2)];
  const runDirectory = await storeRun(project, "run-1", findings);
  const filed = await fileNightly({
    project,
    ledgerPath: ledgerPath(project),
    severity: "major",
    labels: ["idiom"],
    sink: await trackerSink(project, ab.environment),
    inputs: [inputsFor(runDirectory, findings)],
  });
  expect(filed.outcomes.map((outcome) => outcome.kind)).toEqual([
    "created",
    "error",
  ]);
  expect(filed.outcomes[1]?.message).toContain(
    "ab ticket create failed (exit 1): label not found",
  );
  expect((await readLedger(ledgerPath(project))).entries).toHaveLength(1);
});

async function injectedCheck(
  project: string,
  byFlow: Record<string, Finding[] | "baseline-missing">,
) {
  let runs = 0;
  return (async (options: { flow: string }) => {
    const value = byFlow[options.flow];
    if (value === "baseline-missing" || value === undefined)
      throw new RunFailure({
        stage: "preflight",
        cause: "baseline-missing",
        headline: `no recorded baseline for "${options.flow}"`,
        hint: `run idiom baseline record ${options.flow}`,
      });
    runs += 1;
    const runDirectory = await storeRun(
      project,
      `${options.flow}-${runs}`,
      value,
    );
    return {
      summary: {
        flow: options.flow,
        runDirectory,
        reportPath: join(runDirectory, "report.md"),
        findings: value.map((item) => ({ id: item.id })),
        blocking: 0,
      },
      review: {
        runDirectory,
        findingsPath: join(runDirectory, "findings.json"),
      },
    };
  }) as unknown as typeof import("../src/commands/check.js").checkWithReview;
}

test("nightly with autobuild: config labels, --label, triage resolution, no triage state, and a failing flow", async () => {
  const project = await nightlyProject(["booking", "studio"]);
  await writeFile(join(project, "autobuild.toml"), "[commands]\n");
  const config = JSON.parse(
    await readFile(join(project, ".idiom/project.json"), "utf8"),
  );
  config.nightly = { labels: ["design-qa"] };
  await writeFile(join(project, ".idiom/project.json"), JSON.stringify(config));
  const ab = await fakeAb();
  const check = await injectedCheck(project, {
    studio: [finding(1)],
    booking: "baseline-missing",
  });
  const result = await nightlyCommand({
    project,
    cwd: project,
    dependencies: { check, environment: ab.environment },
  });
  expect(result).toMatchObject({
    sink: "autobuild",
    triageState: "Inbox",
    labels: ["design-qa"],
    flows: [
      {
        flow: "booking",
        status: "failed",
        error: { cause: "baseline-missing" },
      },
      { flow: "studio", status: "checked", newFindings: 1 },
    ],
  });
  expect((await ab.store()).tickets[0]?.labels).toEqual([
    "design-qa",
    "target-size",
  ]);
  // --label overrides the configured labels; recovery lists by the first.
  await rm(ledgerPath(project));
  const relabelled = await nightlyCommand({
    project,
    cwd: project,
    flows: ["studio"],
    labels: ["nightly", "ux"],
    dependencies: { check, environment: ab.environment },
  });
  expect(relabelled.outcomes).toEqual([
    expect.objectContaining({
      kind: "created",
      labels: ["nightly", "ux", "target-size"],
    }),
  ]);

  // The CLI exits 2 when a flow could not run, after filing the others.
  let out = "";
  let err = "";
  const code = await run(["node", "idiom", "--project", project, "nightly"], {
    cwd: project,
    stdout: (message) => {
      out += message;
    },
    stderr: (message) => {
      err += message;
    },
    nightly: { check, environment: ab.environment },
  });
  expect(code).toBe(2);
  expect(out).toContain("booking: not checked");
  expect(out).toContain(
    "Filing at major and above to autobuild triage (Inbox)",
  );
  expect(err).toContain(
    "nightly: 1 flow(s) not checked: booking (baseline-missing)",
  );

  // No triage-role state: refused before any check or create.
  const bare = await fakeAb([{ name: "ready", roles: ["create", "ready"] }]);
  let checked = false;
  await expect(
    nightlyCommand({
      project,
      cwd: project,
      dependencies: {
        check: (async () => {
          checked = true;
          throw new Error("unreachable");
        }) as unknown as typeof check,
        environment: bare.environment,
      },
    }),
  ).rejects.toThrow(/no autobuild ticket state has the triage role/);
  expect(checked).toBe(false);
  expect(verbs(await bare.calls())).toEqual(["states"]);
});

test("without autobuild, proposals go to a directory and dedupe; --tracker autobuild refuses; --dry-run writes nothing", async () => {
  const project = await nightlyProject();
  const ab = await fakeAb();
  const check = await injectedCheck(project, {
    studio: [finding(1), finding(2, { category: "contrast" })],
  });
  const dependencies = { check, environment: ab.environment };
  const dry = await nightlyCommand({
    project,
    cwd: project,
    dryRun: true,
    dependencies,
  });
  expect(dry.outcomes.map((outcome) => outcome.kind)).toEqual([
    "created",
    "created",
  ]);
  const out = join(project, ".idiom/reports/nightly");
  await expect(readdir(out)).rejects.toThrow();
  await expect(readFile(ledgerPath(project))).rejects.toThrow();

  const first = await nightlyCommand({ project, cwd: project, dependencies });
  expect(first).toMatchObject({ sink: "directory", outDirectory: out });
  const files = (await readdir(out)).sort();
  expect(files).toHaveLength(2);
  const body = await readFile(join(out, files[0] as string), "utf8");
  expect(body).toMatch(/^\+\+\+\nid = "idiom-cluster-/);
  expect(body).toMatch(/labels = \["idiom", "(contrast|target-size)"\]/);
  expect(body).toContain("Done when `idiom check studio --since-baseline`");
  expect(body).toContain(
    "Introduced: commit range unavailable: no earlier complete run.",
  );

  const second = await nightlyCommand({ project, cwd: project, dependencies });
  expect(second.outcomes.map((outcome) => outcome.kind)).toEqual([
    "unchanged",
    "unchanged",
  ]);
  // A fresh checkout without the ledger dedupes against the proposals.
  await rm(ledgerPath(project));
  const recovered = await nightlyCommand({
    project,
    cwd: project,
    dependencies,
  });
  expect(recovered.outcomes.map((outcome) => outcome.kind)).not.toContain(
    "created",
  );
  expect(await readdir(out)).toHaveLength(2);
  expect(await ab.calls()).toEqual([]);

  await expect(
    nightlyCommand({
      project,
      cwd: project,
      tracker: "autobuild",
      dependencies,
    }),
  ).rejects.toThrow(/needs an autobuild project.*--tracker directory/);
  await writeFile(join(project, "autobuild.toml"), "[commands]\n");
  await expect(
    nightlyCommand({
      project,
      cwd: project,
      tracker: "autobuild",
      dependencies: { check, environment: { PATH: "/usr/bin:/bin" } },
    }),
  ).rejects.toThrow(/needs the autobuild CLI \(ab\) on PATH/);
});

test.each([false, true])(
  "directory proposals recover from a retained ledger when reports are wiped (cluster grows: %s)",
  async (grows) => {
    const project = await nightlyProject();
    const out = join(project, ".idiom/reports/nightly");
    const options = {
      project,
      ledgerPath: ledgerPath(project),
      severity: "major" as const,
      labels: ["idiom"],
      sink: { kind: "directory" as const, out },
      now: () => new Date("2026-11-07T03:17:00.000Z"),
    };
    const firstFindings = [finding(1)];
    const firstRun = await storeRun(project, "run-1", firstFindings);
    const first = await fileNightly({
      ...options,
      inputs: [
        inputsFor(firstRun, firstFindings, { "finding-1": cause("c1") }),
      ],
    });
    expect(first.outcomes[0]?.kind).toBe("created");
    const before = await readFile(ledgerPath(project), "utf8");
    const original = (await readLedger(ledgerPath(project))).entries[0];
    const filename = (await readdir(out))[0] as string;

    // A new CI runner restores only the ledger, without yesterday's reports.
    await rm(out, { recursive: true });
    const findings = grows ? [...firstFindings, finding(2)] : firstFindings;
    const runDirectory = await storeRun(project, "run-2", findings);
    const later = {
      ...options,
      now: () => new Date("2026-11-08T03:17:00.000Z"),
      inputs: [
        inputsFor(runDirectory, findings, {
          "finding-1": cause("c1"),
          "finding-2": cause("c1"),
        }),
      ],
    };
    const expected = expect.objectContaining({
      kind: grows ? "updated" : "unchanged",
      ticket: first.outcomes[0]?.ticket,
      findingIds: findings.map((item) => item.id),
    });
    const dry = await fileNightly({ ...later, dryRun: true });
    expect(dry.outcomes).toEqual([expected]);
    await expect(readdir(out)).rejects.toThrow();
    expect(await readFile(ledgerPath(project), "utf8")).toBe(before);

    const second = await fileNightly(later);
    expect(second.outcomes).toEqual([expected]);
    expect(await readdir(out)).toEqual([filename]);
    const body = await readFile(join(out, filename), "utf8");
    expect(body).toContain(`id = "${filename.slice(0, -3)}"`);
    expect(parseFindingBlocks(body).map((item) => item.id)).toEqual(
      findings.map((item) => item.id),
    );
    const ledger = await readLedger(ledgerPath(project));
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      ticket: original?.ticket,
      filedAt: original?.filedAt,
      updatedAt: grows ? later.now().toISOString() : original?.updatedAt,
    });
    expect(ledger.entries[0]?.replaced).toBeUndefined();
    expect((await fileNightly(later)).outcomes[0]?.kind).toBe("unchanged");
  },
);

test("--print-schedule prints a quoted cron line and a launchd agent", async () => {
  const project = await nightlyProject();
  const bin = await temporary("idiom bin-");
  await writeFile(join(bin, "idiom"), "#!/bin/sh\n");
  await chmod(join(bin, "idiom"), 0o755);
  const environment = { PATH: `${bin}:/usr/bin:/bin`, HOME: "/home/someone" };
  const cron = await nightlySchedule({ kind: "cron", project, environment });
  expect(cron.text).toBe(
    `17 3 * * * cd '${project}' && PATH='${bin}:/usr/bin:/bin' '${bin}/idiom' nightly >> .idiom/reports/nightly.log 2>&1`,
  );
  const launchd = await nightlySchedule({
    kind: "launchd",
    project,
    environment,
  });
  const label = `build.idiom.nightly.${project
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")}`;
  expect(launchd.path).toBe(
    `/home/someone/Library/LaunchAgents/${label}.plist`,
  );
  expect(launchd.install).toBe(
    `launchctl bootstrap gui/$(id -u) '/home/someone/Library/LaunchAgents/${label}.plist'`,
  );
  expect(launchd.text).toContain(`<string>${label}</string>`);
  expect(launchd.text).toContain(
    `<key>WorkingDirectory</key>\n  <string>${project}</string>`,
  );
  expect(launchd.text).toContain(
    `<array>\n    <string>${bin}/idiom</string>\n    <string>nightly</string>\n  </array>`,
  );
  expect(launchd.text).toContain(
    "<key>Hour</key>\n    <integer>3</integer>\n    <key>Minute</key>\n    <integer>17</integer>",
  );
  let out = "";
  expect(
    await run(
      [
        "node",
        "idiom",
        "--project",
        project,
        "nightly",
        "--print-schedule",
        "cron",
      ],
      {
        stdout: (message) => {
          out += message;
        },
        nightly: { environment },
      },
    ),
  ).toBe(0);
  expect(out.trim()).toBe(cron.text);
});
