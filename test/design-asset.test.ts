import { readFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compareToBaseline } from "../src/baseline/compare.js";
import {
  type BriefCheck,
  briefAssertionIdentity,
} from "../src/brief/assertions.js";
import {
  DESIGN_ASSET_FORMAT,
  designAssetSchema,
  readDesignAssets,
} from "../src/brief/design-asset.js";
import { renderBrief } from "../src/brief/render.js";
import { loadBriefChecks, readBrief } from "../src/brief/store.js";
import type { CaptureDependencies } from "../src/capture/run.js";
import { briefMismatchCheck } from "../src/checks/brief-mismatch.js";
import { checksConfigFrom } from "../src/checks/registry.js";
import type { CheckTuple, ObservedElementV2 } from "../src/checks/types.js";
import { run } from "../src/cli.js";
import {
  briefAttachCommand,
  briefDecideCommand,
  briefExportCommand,
  recordBriefInput,
} from "../src/commands/brief.js";
import {
  briefCoverageLines,
  computeBriefCoverage,
} from "../src/coverage/briefs.js";
import { planGate } from "../src/gate/plan.js";
import {
  briefAssertionSchema,
  storedBriefSchema,
} from "../src/schemas/brief.js";
import type { Finding } from "../src/schemas/finding.js";
import { briefSettings } from "../src/schemas/project.js";
import { runVerify } from "../src/verify/run.js";
import { changedFixture } from "./changed-support.js";
import { invariantObservations, invariantTuple } from "./invariant-support.js";
import { mcpClient, toolData } from "./mcp-support.js";
import { studioProject } from "./stored-run-support.js";
import { fixtureCommand } from "./support/fixture-server.js";
import { artifactV2, freePort, png } from "./verify-support.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/brief/pinned-group-brief.json", import.meta.url),
    "utf8",
  ),
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const tileHeight = {
  flow: "studio-lab",
  state: "editor",
  selector: ".drawer-item",
  height: 56,
};

function withAssertions(assertions: unknown[], extra: object = {}) {
  return {
    ...fixture,
    slug: "pinned-group",
    acceptanceCriteria: fixture.acceptanceCriteria.map(
      (criterion: { kind: string }, index: number) =>
        index === 0 ? { ...criterion, assertions } : criterion,
    ),
    ...extra,
  };
}

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function decidedProject(
  assertions: unknown[] = [tileHeight],
  option = "corner-pin",
) {
  const { project } = await studioProject(directories, ["editor", "empty"]);
  await recordBriefInput({ project, input: withAssertions(assertions) });
  await briefDecideCommand({ project, slug: "pinned-group", option });
  return project;
}

/** A stored capture of studio-lab, laid out the way capture writes it. */
async function storedCapture(
  project: string,
  states: string[],
  runId = "2026-11-01T10-00-00-000Z",
): Promise<string> {
  const run = join(project, ".idiom", "reports", runId);
  for (const [index, state] of states.entries()) {
    const tuple = join(run, state, "desktop");
    await mkdir(tuple, { recursive: true });
    await Promise.all([
      writeFile(join(tuple, "screenshot.png"), png(2, 2, 10 + index)),
      writeFile(join(tuple, "dom.html"), "<html></html>"),
      writeFile(join(tuple, "console.jsonl"), ""),
      writeFile(join(tuple, "axe.json"), JSON.stringify({ violations: [] })),
      writeFile(
        join(tuple, "observations.json"),
        JSON.stringify(artifactV2(state)),
      ),
      writeFile(
        join(tuple, "metadata.json"),
        JSON.stringify({
          source: { commit: "0123456789abcdef0123", dirty: false },
          flow: { id: "studio-lab", title: "Studio" },
          state: { id: state, description: state },
          viewport: {
            name: "desktop",
            width: 1440,
            height: 900,
            deviceScaleFactor: 2,
          },
          url: {
            kind: "literal",
            origin: "http://127.0.0.1:3100",
            url: `http://127.0.0.1:3100/lab/${state}`,
          },
          timestamps: {
            startedAt: "2026-11-01T10:00:00.000Z",
            endedAt: "2026-11-01T10:00:01.000Z",
          },
          status: 200,
          expectations: { passed: true, mismatches: [] },
          failure: null,
        }),
      ),
    ]);
  }
  await writeFile(
    join(run, "baseline.md"),
    `# Capture\n\nFlow \`studio-lab\`: ${states.length} passed, 0 failed, ${states.length} total.\n`,
  );
  return run;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

describe("export", () => {
  test("writes README, criteria.json and one screenshot per asserted state, with no absolute path", async () => {
    const project = await decidedProject();
    const run = await storedCapture(project, ["editor", "empty"]);
    const out = join(project, "design", "pinned-group");
    const exported = await briefExportCommand({
      project,
      cwd: project,
      slug: "pinned-group",
      out: "design/pinned-group",
    });
    expect(exported).toEqual({
      out,
      slug: "pinned-group",
      files: [
        "README.md",
        "criteria.json",
        "screenshots/studio-lab--editor--desktop--light.png",
      ],
      screenshots: 1,
      states: 1,
    });
    expect(
      await readFile(
        join(out, "screenshots/studio-lab--editor--desktop--light.png"),
      ),
    ).toEqual(await readFile(join(run, "editor", "desktop", "screenshot.png")));

    const asset = designAssetSchema.parse(
      JSON.parse(await readFile(join(out, "criteria.json"), "utf8")),
    );
    const assertion = briefAssertionSchema.parse(tileHeight);
    expect(asset).toMatchObject({
      format: DESIGN_ASSET_FORMAT,
      version: 1,
      brief: {
        slug: "pinned-group",
        chosenOption: "corner-pin",
        decidedBy: "requester",
      },
      screenshots: [
        {
          flow: "studio-lab",
          state: "editor",
          viewport: "desktop",
          colorScheme: "light",
          path: "screenshots/studio-lab--editor--desktop--light.png",
        },
      ],
      capture: {
        runId: "2026-11-01T10-00-00-000Z",
        commit: "0123456789abcdef0123",
      },
    });
    // The same id brief-mismatch emits for the stored brief.
    expect(asset.criteria[0]?.rules).toEqual([
      `idiom:brief-mismatch:pinned-group:c0:a0:size:${briefAssertionIdentity(assertion)}`,
    ]);
    expect(asset.criteria[1]?.rules).toEqual([]);

    const readme = await readFile(join(out, "README.md"), "utf8");
    for (const fragment of [
      "# Pinned group in the Add drawer",
      "Idiom design asset · decided by requester · brief pinned-group",
      "## Decision",
      "### Rejected options",
      "## Acceptance criteria",
      "- [ ] The pin icon is at most 20px square and tile height is unchanged.",
      "  - Verified by Idiom: brief-mismatch — studio-lab/editor — `.drawer-item` height 56px ±1, on studio-lab/editor",
      "  - Not machine-checked by Idiom: judge it against the reference screenshots.",
      "## Out of scope",
      "## Reference screenshots",
      "(screenshots/studio-lab--editor--desktop--light.png)",
      "show the UI **before** the build",
      "## How this is verified",
    ])
      expect(readme).toContain(fragment);

    for (const file of await walk(out)) {
      if (file.endsWith(".png")) continue;
      const text = await readFile(file, "utf8");
      for (const local of [
        project,
        await realpath(project),
        homedir(),
        tmpdir(),
      ])
        expect(text).not.toContain(local);
    }
  });

  test("refuses a missing screenshot, naming it and suggesting --capture", async () => {
    const project = await decidedProject();
    await storedCapture(project, ["empty"]);
    await expect(
      briefExportCommand({
        project,
        cwd: project,
        slug: "pinned-group",
        out: "design/x",
      }),
    ).rejects.toThrow(
      "no captured screenshot for studio-lab/editor at desktop/light; capture it (idiom capture studio-lab) or pass --capture",
    );
    await expect(access(join(project, "design", "x"))).rejects.toThrow();
  });

  test("refuses a non-empty output directory", async () => {
    const project = await decidedProject();
    await storedCapture(project, ["editor"]);
    await mkdir(join(project, "design"), { recursive: true });
    await writeFile(join(project, "design", "keep.txt"), "mine");
    await expect(
      briefExportCommand({
        project,
        cwd: project,
        slug: "pinned-group",
        out: "design",
      }),
    ).rejects.toThrow("design is not empty");
    expect(await readFile(join(project, "design", "keep.txt"), "utf8")).toBe(
      "mine",
    );
  });

  test("refuses briefs that are not a buildable contract", async () => {
    const { project } = await studioProject(directories, ["editor"]);
    await recordBriefInput({ project, input: withAssertions([tileHeight]) });
    const exportIt = () =>
      briefExportCommand({
        project,
        cwd: project,
        slug: "pinned-group",
        out: "out",
      });
    await expect(exportIt()).rejects.toThrow(
      "brief pinned-group is proposed; decide it first (idiom brief decide)",
    );
    await briefDecideCommand({
      project,
      slug: "pinned-group",
      option: "dont-build",
    });
    await expect(exportIt()).rejects.toThrow(
      "brief pinned-group cannot be a design asset: decided not to build",
    );
    await briefDecideCommand({
      project,
      slug: "pinned-group",
      option: "context-menu",
    });
    await expect(exportIt()).rejects.toThrow(
      "criteria were written for corner-pin, not the chosen context-menu",
    );
    await recordBriefInput({
      project,
      input: withAssertions([tileHeight], { slug: "replacement" }),
    });
    await recordBriefInput({
      project,
      input: withAssertions([tileHeight], {
        status: "superseded",
        supersededBy: "replacement",
      }),
    });
    await expect(exportIt()).rejects.toThrow(
      "brief pinned-group is superseded",
    );
  });

  test("the leak guard refuses brief text naming the project path and writes nothing", async () => {
    const { project } = await studioProject(directories, ["editor"]);
    await recordBriefInput({
      project,
      input: withAssertions([tileHeight], {
        outOfScope: [`Anything under ${project}`],
      }),
    });
    await briefDecideCommand({
      project,
      slug: "pinned-group",
      option: "corner-pin",
    });
    await storedCapture(project, ["editor"]);
    await expect(
      briefExportCommand({
        project,
        cwd: project,
        slug: "pinned-group",
        out: "out",
      }),
    ).rejects.toThrow("would export an absolute path");
    await expect(access(join(project, "out"))).rejects.toThrow();
  });

  test("a brief with no assertions exports README and criteria only", async () => {
    const { project } = await studioProject(directories, ["editor"]);
    await recordBriefInput({ project, input: { ...fixture, slug: "plain" } });
    await briefDecideCommand({ project, slug: "plain", option: "corner-pin" });
    const exported = await briefExportCommand({
      project,
      cwd: project,
      slug: "plain",
      out: "out",
    });
    expect(exported.files).toEqual(["README.md", "criteria.json"]);
    expect(exported.screenshots).toBe(0);
    const readme = await readFile(join(project, "out", "README.md"), "utf8");
    expect(readme).toContain("Idiom has nothing to verify");
    expect(readme).toContain(
      "Idiom has no assertions to verify for this brief.",
    );
  });
});

/** An `ab` that logs its argv, cwd and the exported files, then answers JSON. */
async function fakeAb(): Promise<{ bin: string; log: string }> {
  const bin = await temporary("idiom-fake-ab-");
  const log = join(bin, "log.txt");
  await writeFile(
    join(bin, "ab"),
    [
      "#!/bin/sh",
      'if [ -n "$AB_FAIL" ]; then echo "ticket file-9 not found" >&2; exit 3; fi',
      'printf "cwd %s\\n" "$(pwd -P)" >> "$AB_LOG"',
      'printf "argv %s\\n" "$*" >> "$AB_LOG"',
      'ls "$5" "$5/screenshots" >> "$AB_LOG"',
      "echo '{\"attached\":true}'",
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "ab"), 0o755);
  return { bin, log };
}

describe("attach", () => {
  async function attachable() {
    const project = await decidedProject();
    await storedCapture(project, ["editor"]);
    await writeFile(join(project, "autobuild.toml"), "[commands]\n");
    const ab = await fakeAb();
    const environment = {
      PATH: `${ab.bin}:/usr/bin:/bin`,
      AB_LOG: ab.log,
    };
    return { project, ab, environment };
  }

  test("exports to a temp directory, runs only ab ticket attach and records the ticket", async () => {
    const { project, ab, environment } = await attachable();
    const before = (await readBrief(project, "pinned-group")).brief;
    const attached = await briefAttachCommand({
      project,
      cwd: project,
      slug: "pinned-group",
      ticket: "file-281",
      dependencies: { environment },
    });
    expect(attached).toMatchObject({
      slug: "pinned-group",
      ticket: "file-281",
      asset: { kind: "design", name: "pinned-group" },
      screenshots: 1,
      states: 1,
      ab: { attached: true },
    });
    const lines = (await readFile(ab.log, "utf8")).trim().split("\n");
    expect(lines[0]).toBe(`cwd ${await realpath(project)}`);
    const argv = lines[1]?.split(" ") ?? [];
    expect(argv.slice(0, 5)).toEqual([
      "argv",
      "ticket",
      "attach",
      "file-281",
      "design",
    ]);
    const exported = argv[5] as string;
    expect(argv.slice(6)).toEqual(["--name", "pinned-group", "--json"]);
    // The export existed while ab ran, and is gone afterwards.
    expect(lines).toContain("README.md");
    expect(lines).toContain("criteria.json");
    expect(lines).toContain("studio-lab--editor--desktop--light.png");
    await expect(access(exported)).rejects.toThrow();

    const after = (await readBrief(project, "pinned-group")).brief;
    expect(after.tickets).toEqual(["file-281"]);
    expect(after.updatedAt).toBe(before.updatedAt);
    const settings = briefSettings(undefined);
    expect(renderBrief(after, settings)).toContain(
      "Autobuild tickets: file-281",
    );
    expect(renderBrief(before, settings)).not.toContain("Autobuild tickets");

    await briefAttachCommand({
      project,
      cwd: project,
      slug: "pinned-group",
      ticket: "file-281",
      dependencies: { environment },
    });
    expect((await readBrief(project, "pinned-group")).brief.tickets).toEqual([
      "file-281",
    ]);
    // Re-deciding keeps the ticket.
    await briefDecideCommand({
      project,
      slug: "pinned-group",
      option: "corner-pin",
    });
    expect((await readBrief(project, "pinned-group")).brief.tickets).toEqual([
      "file-281",
    ]);
  });

  test("refuses without ab, without autobuild.toml or with a bad ticket id, before running ab or exporting", async () => {
    const { project, ab, environment } = await attachable();
    const attempt = (ticket: string, env: NodeJS.ProcessEnv) =>
      briefAttachCommand({
        project,
        cwd: project,
        slug: "pinned-group",
        ticket,
        dependencies: { environment: env },
      });
    await expect(attempt("file 1", environment)).rejects.toThrow(
      'invalid ticket id "file 1"',
    );
    await expect(
      attempt("file-1", { ...environment, PATH: "/usr/bin:/bin" }),
    ).rejects.toThrow(
      "idiom brief attach needs the autobuild CLI (ab) on PATH; export with idiom brief export pinned-group --out <dir> and attach it with ab ticket attach file-1 design <dir>",
    );
    await rm(join(project, "autobuild.toml"));
    await expect(attempt("file-1", environment)).rejects.toThrow(
      "idiom brief attach needs an autobuild project (no autobuild.toml above",
    );
    await expect(access(ab.log)).rejects.toThrow();
    expect(
      (await readBrief(project, "pinned-group")).brief.tickets,
    ).toBeUndefined();
  });

  test("a failing ab reports its stderr and leaves the brief unchanged", async () => {
    const { project, environment } = await attachable();
    await expect(
      briefAttachCommand({
        project,
        cwd: project,
        slug: "pinned-group",
        ticket: "file-9",
        dependencies: { environment: { ...environment, AB_FAIL: "1" } },
      }),
    ).rejects.toThrow(
      "ab ticket attach failed (exit 3): ticket file-9 not found",
    );
    expect(
      (await readBrief(project, "pinned-group")).brief.tickets,
    ).toBeUndefined();
  });

  test("stored briefs reject a malformed ticket list", () => {
    const stored = JSON.parse(
      JSON.stringify({
        version: 1,
        ...withAssertions([tileHeight]),
        rubricVersion: 1,
        createdAt: "2026-11-01T10:00:00.000Z",
        updatedAt: "2026-11-01T10:00:00.000Z",
        tickets: ["../escape"],
      }),
    );
    expect(storedBriefSchema.safeParse(stored).success).toBe(false);
  });
});

/** A criteria.json an Idiom export would write. */
function assetJson(slug: string, assertions: unknown[], title = "Pinned") {
  return {
    format: DESIGN_ASSET_FORMAT,
    version: 1,
    brief: {
      slug,
      title,
      decision: "Where does the pin go?",
      chosenOption: "corner-pin",
      chosenTitle: "Corner pin",
      decidedBy: "requester",
    },
    criteria: [
      {
        index: 0,
        kind: "geometry",
        statement: "tile height unchanged at 56px",
        assertions,
        rules: [],
      },
    ],
    screenshots: [],
  };
}

async function pin(root: string, name: string, json: unknown) {
  const directory = join(root, ".ab", "assets", "design", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "criteria.json"),
    typeof json === "string" ? json : JSON.stringify(json),
  );
}

describe("read back", () => {
  test("walks up to the build root, ignores other design assets and names the source", async () => {
    const root = await temporary("idiom-asset-root-");
    await mkdir(join(root, ".git"));
    const project = join(root, "apps", "web");
    await mkdir(project, { recursive: true });
    await pin(root, "pinned-group", assetJson("pinned-group", [tileHeight]));
    await pin(root, "figma-export", { format: "something-else" });
    await pin(root, "not-json", "<svg/>");
    await mkdir(join(root, ".ab", "assets", "design", "no-criteria"));
    const briefs = await readDesignAssets(project);
    expect(briefs).toEqual([
      expect.objectContaining({
        slug: "pinned-group",
        eligible: true,
        source: { kind: "design-asset", name: "pinned-group" },
      }),
    ]);
    // The walk stops at the first .git, so a parent's assets are not read.
    const outer = await temporary("idiom-asset-outer-");
    await pin(outer, "x", assetJson("x", [tileHeight]));
    const inner = join(outer, "repo");
    await mkdir(join(inner, ".git"), { recursive: true });
    expect(await readDesignAssets(inner)).toEqual([]);
  });

  test("a malformed Idiom export is an error", async () => {
    const root = await temporary("idiom-asset-bad-");
    await mkdir(join(root, ".git"));
    await pin(root, "broken", { ...assetJson("broken", []), version: 2 });
    await expect(readDesignAssets(root)).rejects.toThrow(
      "design asset broken is not a valid Idiom export: version",
    );
  });

  test("loadBriefChecks merges assets; the asset wins on slug", async () => {
    const project = await decidedProject();
    await pin(
      project,
      "pinned-group",
      assetJson("pinned-group", [{ ...tileHeight, height: 64 }], "Asset title"),
    );
    await pin(project, "other", assetJson("only-asset", [tileHeight]));
    const checks = await loadBriefChecks(project);
    expect(
      checks.map((check) => [check.slug, check.title, check.source]),
    ).toEqual([
      ["only-asset", "Pinned", { kind: "design-asset", name: "other" }],
      [
        "pinned-group",
        "Asset title",
        { kind: "design-asset", name: "pinned-group" },
      ],
    ]);
  });
});

function element(selector: string, height: number): ObservedElementV2 {
  return {
    selector,
    tag: "div",
    visible: true,
    ancestorSelectors: [],
    rect: { x: 0, y: 0, width: 100, height },
    styles: {
      opacity: "1",
      visibility: "visible",
      display: "block",
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgba(0, 0, 0, 0)",
    },
  } as unknown as ObservedElementV2;
}

function measuredTuple(height: number): CheckTuple {
  return {
    ...invariantTuple({
      ...invariantObservations(),
      elements: [element(".drawer-item", height)],
      selectorMarks: [
        {
          purpose: "brief",
          selector: ".drawer-item",
          matches: [".drawer-item"],
        },
      ],
    }),
    flow: "studio",
    state: "editor",
  };
}

describe("findings and coverage name the asset", () => {
  const assertion = briefAssertionSchema.parse({
    ...tileHeight,
    flow: "studio",
  });
  const stored: BriefCheck = {
    slug: "pinned-group",
    title: "Pinned group",
    decision: "Corner pin",
    eligible: true,
    criteria: [
      { index: 0, statement: "tile height 56px", assertions: [assertion] },
    ],
  };
  const pinned: BriefCheck = {
    ...stored,
    source: { kind: "design-asset", name: "pinned-group" },
  };
  const candidates = (brief: BriefCheck) =>
    briefMismatchCheck.run({
      tuple: measuredTuple(100),
      narrowViewport: false,
      config: { ...checksConfigFrom(), briefs: [brief] },
    }).candidates;

  test("the explanation names the asset and the rule id is unchanged", () => {
    const [fromStore] = candidates(stored);
    const [fromAsset] = candidates(pinned);
    expect(fromAsset?.rule).toBe(fromStore?.rule);
    expect(fromStore?.explanation).toMatch(
      /^Brief "Pinned group" \(pinned-group\), criterion/,
    );
    expect(fromAsset?.explanation).toMatch(
      /^Brief "Pinned group" \(pinned-group, design asset pinned-group\), criterion/,
    );
  });

  test("coverage lines carry the asset suffix", () => {
    const coverage = computeBriefCoverage(
      [measuredTuple(56)],
      [pinned],
      "studio",
    );
    expect(briefCoverageLines(coverage)[1]).toBe(
      "- Pinned group (pinned-group) · design asset pinned-group: checked; 1 passed, 0 mismatched, 0 unmeasured",
    );
  });

  test("a baseline cannot hide a pinned brief's mismatch", () => {
    const finding = {
      fingerprint: "fp",
      rule: "idiom:brief-mismatch:pinned-group:c0:a0:size:abc",
      flow: "studio",
      state: "editor",
      viewport: "desktop",
    } as unknown as Finding;
    const record = {
      tuples: [
        {
          flow: "studio",
          state: "editor",
          viewport: "desktop",
          findings: [{ fingerprint: "fp", aliases: [] }],
        },
      ],
      configHash: "sha256:x",
    } as never;
    const compare = (alwaysNew?: (finding: Finding) => boolean) =>
      compareToBaseline({
        record,
        currentCandidates: [],
        currentTupleKeys: new Set(),
        liveOccurrences: [finding],
        currentConfigHash: "sha256:x",
        alwaysNew,
      });
    expect(compare().preExisting).toHaveLength(1);
    const pinnedResult = compare(
      (candidate) =>
        candidate.rule?.startsWith("idiom:brief-mismatch:pinned-group:") ===
        true,
    );
    expect(pinnedResult.newFindings).toEqual([finding]);
    expect(pinnedResult.preExisting).toEqual([]);
  });
});

describe("gate", () => {
  test("an asset's states are planned without UI changes, alongside a UI change, and only for its flow", async () => {
    const f = await changedFixture({});
    try {
      await f.write(".gitignore", ".idiom/reports/\n.ab/\naudit.txt\n");
      await f.write(
        ".idiom/flows/other.json",
        JSON.stringify({
          id: "other",
          title: "Other",
          setup: [],
          intent: [],
          states: [{ id: "o0", description: "Other", url: "/r0", expect: {} }],
        }),
      );
      await f.commit("ignore scratch; second flow");
      await f.write("README.md", "# changed\n");
      const assertion = {
        flow: "site",
        state: "s1",
        selector: ".card",
        height: 56,
      };
      await pin(
        f.directory,
        "card-height",
        assetJson("card-height", [assertion]),
      );
      const plan = await planGate({
        project: f.directory,
        dependencies: {
          select: async () => {
            throw new Error("no UI changed; the import graph is not needed");
          },
        },
      });
      if (plan.skipped) throw new Error(plan.line);
      expect(
        plan.states.map((state) => [state.flow, state.state, state.rank]),
      ).toEqual([["site", "s1", "route"]]);
      expect(plan.notes).toContain(
        "design asset card-height: brief card-height asserts site/s1",
      );
      expect(plan.execution.selection.selected).toEqual([
        { flow: "site", state: "s1" },
      ]);

      const elsewhere = await planGate({ project: f.directory, flow: "other" });
      expect(elsewhere.skipped).toBe(true);

      await f.write(
        "app/r0/page.tsx",
        "export default function Page() { return <main><p /></main>; }\n",
      );
      const both = await planGate({ project: f.directory, flow: "site" });
      if (both.skipped) throw new Error(both.line);
      expect(both.states.map((state) => state.state).sort()).toEqual([
        "s0",
        "s1",
      ]);

      await rm(join(f.directory, ".ab"), { recursive: true });
      await f.write(
        "app/r0/page.tsx",
        "export default function Page() { return <main />; }\n",
      );
      expect((await planGate({ project: f.directory })).skipped).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 60_000);
});

async function captureProject(project: string) {
  const path = join(project, ".idiom", "project.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  const port = await freePort();
  config.server = {
    build: "node -e 0",
    start: fixtureCommand(
      join(import.meta.dirname, "fixtures", "capture", "server.mjs"),
    ),
    readyUrl: `http://127.0.0.1:${port}/`,
    port,
    env: { PORT: String(port) },
    startupTimeoutMs: 10000,
  };
  config.colorSchemes = ["light", "dark"];
  config.viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ];
  await writeFile(path, JSON.stringify(config));
  const flowPath = join(project, ".idiom", "flows", "studio-lab.json");
  const flow = JSON.parse(await readFile(flowPath, "utf8"));
  delete flow.viewports;
  await writeFile(flowPath, JSON.stringify(flow));
}

function captureDependencies(
  height: number,
  seen: string[],
  fail = false,
): CaptureDependencies {
  return {
    inheritedEnvironment: { PATH: process.env.PATH },
    snapshotSource: async () => ({ commit: "0123456789abcdef", dirty: false }),
    browserLauncher: async () => ({
      version: "Mock Chromium",
      async capture(tuple) {
        seen.push(
          `${tuple.state.id}/${tuple.viewport.name}/${tuple.colorScheme}`,
        );
        if (fail)
          return {
            ok: false,
            stage: "navigation",
            message: "fixture navigation failed",
            console: [],
            mismatches: [],
            startedAt: "2026-11-01T10:00:00.000Z",
            endedAt: "2026-11-01T10:00:01.000Z",
          };
        const observations = artifactV2("Card");
        const item = observations.elements[2] as ObservedElementV2;
        item.selector = ".drawer-item";
        item.rect.height = height;
        if (observations.version !== 2) throw new Error("V2 fixture required");
        observations.selectorMarks = [
          {
            purpose: "brief",
            selector: ".drawer-item",
            matches: [".drawer-item"],
          },
        ];
        return {
          ok: true,
          status: 200,
          dom: "<html><body>Card</body></html>",
          screenshot: png(),
          console: [],
          axe: { violations: [] },
          observations,
          mismatches: [],
          startedAt: "2026-11-01T10:00:00.000Z",
          endedAt: "2026-11-01T10:00:01.000Z",
        };
      },
      async close() {},
    }),
  };
}

const expectedCaptures = [
  "editor/desktop/light",
  "editor/desktop/dark",
  "editor/mobile/light",
  "editor/mobile/dark",
].sort();

test("--capture exports exactly the asserted states at every viewport and scheme", async () => {
  const project = await decidedProject();
  await captureProject(project);
  const seen: string[] = [];
  const exported = await briefExportCommand({
    project,
    cwd: project,
    slug: "pinned-group",
    out: "fresh",
    capture: true,
    dependencies: { capture: captureDependencies(56, seen) },
  });
  expect(seen.sort()).toEqual(expectedCaptures);
  expect(exported).toMatchObject({ screenshots: 4, states: 1 });
  const asset = designAssetSchema.parse(
    JSON.parse(await readFile(join(exported.out, "criteria.json"), "utf8")),
  );
  expect(asset.screenshots).toHaveLength(4);
  for (const shot of asset.screenshots)
    expect(await readFile(join(exported.out, shot.path))).toEqual(png());
}, 30000);

test("--capture reports a tuple failure and leaves no export", async () => {
  const project = await decidedProject();
  await captureProject(project);
  await expect(
    briefExportCommand({
      project,
      cwd: project,
      slug: "pinned-group",
      out: "failed",
      capture: true,
      dependencies: { capture: captureDependencies(56, [], true) },
    }),
  ).rejects.toThrow("fixture navigation failed");
  await expect(access(join(project, "failed"))).rejects.toThrow();
}, 30000);

test.each([56, 100])(
  "verify reads the asset without embedded findings (height %s)",
  async (height) => {
    const project = await decidedProject();
    await captureProject(project);
    await pin(
      project,
      "frozen-design",
      assetJson("pinned-group", [tileHeight], "Pinned group"),
    );
    await writeFile(join(project, "spec.md"), "# Build the decided design\n");
    const seen: string[] = [];
    const result = await runVerify({
      project,
      flow: "studio-lab",
      spec: "spec.md",
      out: "verification",
      dependencies: { capture: captureDependencies(height, seen) },
    });
    expect(seen.sort()).toEqual(expectedCaptures);
    expect(result).toMatchObject({
      outcome: "no-findings",
      passed: height === 56,
      designAssets: {
        passed: height === 56,
        briefs: [
          {
            slug: "pinned-group",
            asset: "frozen-design",
            mismatched: height === 56 ? 0 : 1,
          },
        ],
      },
    });
    for (const path of [result.reportPath, result.htmlReportPath]) {
      const text = await readFile(path, "utf8");
      expect(text).toContain("Design asset");
      expect(text).toContain("frozen-design");
      expect(text).toContain("pinned-group");
      if (height !== 56) expect(text).toContain("criterion");
    }
    if (height !== 56)
      expect(result.causes.join(" ")).toContain(
        'Brief "Pinned group" (pinned-group, design asset frozen-design), criterion',
      );
    expect(
      JSON.parse(
        await readFile(
          join(result.outputDirectory, "attachments.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ composites: [] });
  },
  30000,
);

test("verify fails an asserted tuple capture instead of passing an unmeasured assertion", async () => {
  const project = await decidedProject();
  await captureProject(project);
  await pin(project, "frozen-design", assetJson("pinned-group", [tileHeight]));
  await writeFile(join(project, "spec.md"), "# Design\n");
  const result = await runVerify({
    project,
    flow: "studio-lab",
    spec: "spec.md",
    out: "verification",
    dependencies: { capture: captureDependencies(56, [], true) },
  });
  expect(result.passed).toBe(false);
  expect(result.causes.join(" ")).toContain("fixture navigation failed");
}, 30000);

test("MCP exposes export and attach, and decide can attach while preserving a failed attachment's decision", async () => {
  const project = await decidedProject();
  await storedCapture(project, ["editor"]);
  await writeFile(join(project, "autobuild.toml"), "[commands]\n");
  const ab = await fakeAb();
  const session = await mcpClient({
    project,
    dependencies: {
      brief: {
        environment: { PATH: `${ab.bin}:/usr/bin:/bin`, AB_LOG: ab.log },
      },
    },
  });
  try {
    const tools = (await session.client.listTools()).tools;
    for (const name of ["idiom_brief_export", "idiom_brief_attach"])
      expect(
        tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint,
      ).toBe(false);
    const exported = toolData(
      await session.client.callTool({
        name: "idiom_brief_export",
        arguments: { slug: "pinned-group", out: "mcp-export" },
      }),
    );
    expect(exported).toMatchObject({ slug: "pinned-group", screenshots: 1 });
    const decided = toolData(
      await session.client.callTool({
        name: "idiom_brief_decide",
        arguments: {
          slug: "pinned-group",
          option: "corner-pin",
          ticket: "file-281",
        },
      }),
    );
    expect(decided).toMatchObject({
      attach: { ticket: "file-281", asset: { name: "pinned-group" } },
    });
    const attached = toolData(
      await session.client.callTool({
        name: "idiom_brief_attach",
        arguments: { slug: "pinned-group", ticket: "file-300" },
      }),
    );
    expect(attached).toMatchObject({ ticket: "file-300" });
    // Non-recommended criteria refuse export, after recording the explicit choice.
    const failure = await session.client.callTool({
      name: "idiom_brief_decide",
      arguments: {
        slug: "pinned-group",
        option: "context-menu",
        ticket: "file-301",
      },
    });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure.content)).toContain(
      "decided; attach failed:",
    );
    expect((await readBrief(project, "pinned-group")).brief).toMatchObject({
      status: "decided",
      chosenOption: "context-menu",
      tickets: ["file-281", "file-300"],
    });
  } finally {
    await session.close();
  }
}, 30000);

test("export resolves a collapsed tuple to its representative's screenshot", async () => {
  const project = await decidedProject();
  const run = await storedCapture(project, [
    "editor",
    "editor.panel-a",
    "editor.panel-b",
  ]);
  for (const [state, value] of [
    ["editor.panel-a", "a"],
    ["editor.panel-b", "b"],
  ]) {
    const path = join(run, state as string, "desktop", "metadata.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    metadata.combination = {
      base: "editor",
      label: `panel=${value}`,
      options: { panel: value },
      equivalent: [],
    };
    if (value === "b") metadata.layoutRepresentative = "editor.panel-a";
    await writeFile(path, JSON.stringify(metadata));
  }
  await rm(join(run, "editor.panel-b", "desktop", "screenshot.png"));
  await writeFile(
    join(run, "combinations.json"),
    JSON.stringify({
      version: 1,
      evidence: "per-combination",
      captured: 2,
      notes: [],
      collapsed: [
        {
          state: "editor.panel-b",
          viewport: "desktop",
          colorScheme: "light",
          colorSchemeAxis: false,
          combination: "panel=b",
          sameAs: { state: "editor.panel-a", combination: "panel=a" },
        },
      ],
    }),
  );
  const exported = await briefExportCommand({
    project,
    cwd: project,
    slug: "pinned-group",
    out: "collapsed",
  });
  expect(exported.screenshots).toBe(3);
  expect(
    await readFile(
      join(
        exported.out,
        "screenshots/studio-lab--editor.panel-b--desktop--light.png",
      ),
    ),
  ).toEqual(
    await readFile(join(run, "editor.panel-a", "desktop", "screenshot.png")),
  );
});

test("export refuses an assertion whose state was removed since the decision", async () => {
  const project = await decidedProject();
  const path = join(project, ".idiom", "flows", "studio-lab.json");
  const flow = JSON.parse(await readFile(path, "utf8"));
  flow.states = flow.states.filter(
    (state: { id: string }) => state.id !== "editor",
  );
  await writeFile(path, JSON.stringify(flow));
  await expect(
    briefExportCommand({
      project,
      cwd: project,
      slug: "pinned-group",
      out: "stale",
    }),
  ).rejects.toThrow(
    "asserts studio-lab/editor, which the flow does not declare",
  );
  await expect(access(join(project, "stale"))).rejects.toThrow();
});

test("CLI dispatches brief export and attach with JSON", async () => {
  const project = await decidedProject();
  await storedCapture(project, ["editor"]);
  await writeFile(join(project, "autobuild.toml"), "[commands]\n");
  const ab = await fakeAb();
  const invoke = async (args: string[]) => {
    let out = "",
      err = "";
    const code = await run(
      ["node", "idiom", "--project", project, "brief", ...args],
      {
        cwd: project,
        stdout: (value) => {
          out += value;
        },
        stderr: (value) => {
          err += value;
        },
        brief: {
          environment: { PATH: `${ab.bin}:/usr/bin:/bin`, AB_LOG: ab.log },
        },
      },
    );
    return { code, out, err };
  };
  const exported = await invoke([
    "export",
    "pinned-group",
    "--out",
    "cli-export",
    "--json",
  ]);
  expect(exported.code).toBe(0);
  expect(JSON.parse(exported.out)).toMatchObject({
    interfaceVersion: 1,
    slug: "pinned-group",
    out: "cli-export",
    screenshots: 1,
  });
  const attached = await invoke([
    "attach",
    "pinned-group",
    "--ticket",
    "file-281",
    "--json",
  ]);
  expect(attached.code).toBe(0);
  expect(JSON.parse(attached.out)).toMatchObject({
    interfaceVersion: 1,
    ticket: "file-281",
    asset: { kind: "design", name: "pinned-group" },
  });
});

test("verify discloses unmeasured assertions without turning them into mismatches", async () => {
  const project = await decidedProject();
  await captureProject(project);
  await pin(
    project,
    "unmeasured",
    assetJson("pinned-group", [{ ...tileHeight, selector: ".not-measured" }]),
  );
  await writeFile(join(project, "spec.md"), "# Design\n");
  const result = await runVerify({
    project,
    flow: "studio-lab",
    spec: "spec.md",
    out: "verification",
    dependencies: { capture: captureDependencies(56, []) },
  });
  expect(result).toMatchObject({
    passed: true,
    designAssets: { briefs: [{ held: 0, mismatched: 0, unmeasured: 1 }] },
  });
  expect(await readFile(result.reportPath, "utf8")).toContain("unmeasured");
}, 30000);
